// Pinia store wrapping the pure calibration engine + the localStorage
// repository, so nurse validations produce real, persisted, immediately-
// effective threshold changes (spec §5.4 / plan Task 3).
//
// R30 (fix round 1, closes 2 blockers): thresholds now carry a per-category
// `.model` field — the calibrated {ge1, ge2} pair from recalibrateModel(),
// or null if not yet calibrated — ADDITIVELY alongside the unchanged {a, s}
// pair. This is folded into the SAME `thresholds` object (not a sibling
// state field) because Step3Facial/Step6Reassess (outside this wave's file
// ownership) call `scoreAll(profiles, calibrationStore.thresholds)` as a
// single argument; scoring.js's scoreCategory() reads `.model` when the
// captured profile is itself model-scored and ignores it otherwise, so
// existing threshold-engine callers are unaffected. See mergeThresholds().

import { defineStore } from 'pinia'
import { CATEGORIES } from '../facescan/features.js'
import { DEFAULT_THRESHOLDS } from '../facescan/scoring.js'
import { recalibrate, recalibrateModel } from '../facescan/calibration.js'
import { loadCalibration, saveCalibration } from '../domain/repository.js'

const SCHEMA_VERSION = 1
const KNOWN_SCORES = new Set([0, 1, 2])

// R43 (lead ruling, from R3-T1's review): one-time model-calibration epoch
// reset. R41's layered serve-time baseline replaced the wizard's phase-A
// "capture the patient's own current face as neutral" with a population-
// neutral default — but every model-mode sample recorded BEFORE R41 was
// scored against that contaminated same-sitting baseline (the incident
// where a patient in pain scores 0/10, spec §1). Cutpoints grid-searched
// from that contamination are invalid supervision: recalibrateModel()
// would silently let them override R41's new population cutpoints on any
// device that already holds model-mode validations (a production device
// already carries 4). Bumping this past any epoch a device could already
// have persisted forces a one-time wipe of model-mode samples (and the
// model thresholds derived from them) on next hydration — see init().
// Threshold-engine samples/thresholds never subtracted a baseline and are
// untouched.
const CURRENT_MODEL_CALIBRATION_EPOCH = 2

function isValidDeciles(deciles) {
  if (!Array.isArray(deciles) || deciles.length !== 11) return false
  for (const v of deciles) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return false
  }
  for (let i = 1; i < deciles.length; i++) {
    if (deciles[i] < deciles[i - 1]) return false
  }
  return true
}

function isValidProfile(profile) {
  return (
    !!profile &&
    typeof profile === 'object' &&
    isValidDeciles(profile.deciles) &&
    typeof profile.mean === 'number' &&
    Number.isFinite(profile.mean)
  )
}

// Validate one labeled sample before it's ever allowed to reach
// recalibrate() — imported datasets are untrusted input, so this must
// reject anything malformed rather than let a bad sample crash grid
// search or silently corrupt thresholds.
function isValidSample(sample) {
  if (!sample || typeof sample !== 'object') return false
  if (typeof sample.at !== 'string' || sample.at.length === 0) return false
  if (!sample.confirmed || typeof sample.confirmed !== 'object') return false

  for (const cat of CATEGORIES) {
    if (cat in sample.confirmed && !KNOWN_SCORES.has(sample.confirmed[cat])) return false
  }

  if (sample.profiles === null || sample.profiles === undefined) {
    return true
  }
  if (typeof sample.profiles !== 'object') return false

  for (const cat of CATEGORIES) {
    if (cat in sample.profiles && !isValidProfile(sample.profiles[cat])) return false
  }

  return true
}

// Collision-proof identity for dedupe: prefer the sample's id (added by
// addValidation going forward); fall back to `at` for legacy samples
// persisted before id existed.
function sampleIdentity(sample) {
  return sample.id ?? sample.at
}

// R43: a sample is "model-mode" iff any of its category profiles carries
// the `.model` marker finishCapture() stamps uniformly across every
// category in model mode (mirrors calibration.js's private isModelProfile
// — duplicated rather than imported because this is a sample-level
// question for epoch hydration, not calibration.js's per-category grid
// search). `.some` rather than `.every` errs toward dropping on any
// partial/malformed marker, which is the safe direction for a wipe. A
// MIXED sample (only SOME categories model-scored — never produced by
// finishCapture(), only reachable via a hand-crafted import) is dropped
// WHOLE, including any threshold-engine categories it also carries:
// calibration.js's relevantThresholdSamples()/relevantModelSamples()
// would split such a sample per-category, but this epoch wipe operates at
// sample granularity, so a rare mixed sample loses its threshold-engine
// categories too rather than being partially salvaged.
function isModelModeSample(sample) {
  if (!sample || typeof sample.profiles !== 'object' || sample.profiles === null) return false
  return CATEGORIES.some((cat) => !!(sample.profiles[cat] && sample.profiles[cat].model))
}

// Merge the threshold-engine {a,s} pair with the model-engine {ge1,ge2}
// pair (or null) into the single per-category object shape `thresholds`
// exposes (see the file header comment). `model: null` — rather than
// omitting the key — reads as "explicitly not calibrated yet" at call
// sites; `toEqual` comparisons in tests ignore undefined-vs-absent but null
// is an actual value, so tests that assert against DEFAULT_THRESHOLDS
// shapes are updated accordingly rather than relying on that quirk.
function mergeThresholds(asThresholds, modelThresholds) {
  const merged = {}
  for (const cat of CATEGORIES) {
    merged[cat] = { ...asThresholds[cat], model: modelThresholds[cat] ?? null }
  }
  return merged
}

export const useCalibrationStore = defineStore('calibration', {
  state: () => ({
    thresholds: mergeThresholds(DEFAULT_THRESHOLDS, {}),
    samples: [],
    // R43: fresh installs (nothing ever persisted) start at the current
    // epoch already — there's nothing pre-R41 to wipe.
    modelCalibrationEpoch: CURRENT_MODEL_CALIBRATION_EPOCH,
  }),

  getters: {
    sampleCount: (state) => state.samples.length,
  },

  actions: {
    // Restore persisted state (called once on app start), validating
    // samples before trusting them, then recalibrating BOTH engines from
    // whatever survives — spec §5.4 explicitly runs recalibration "on app
    // start" too, not just after each new validation. Persisted
    // `thresholds` is never read back directly (was true before R30 too,
    // just less obviously — recalibrate() always ran again right after):
    // samples are the only source of truth, so a corrupted/stale persisted
    // threshold blob can't leave the store in a wrong state.
    init() {
      const persisted = loadCalibration()
      if (persisted) {
        const incomingSamples = Array.isArray(persisted.samples) ? persisted.samples : []
        const validSamples = incomingSamples.filter(isValidSample)
        const persistedEpoch = Number.isFinite(persisted.modelCalibrationEpoch)
          ? persisted.modelCalibrationEpoch
          : 0

        if (persistedEpoch < CURRENT_MODEL_CALIBRATION_EPOCH) {
          // R43: this device predates the epoch-2 reset (no epoch field, or
          // an older one) — drop every model-mode sample (contaminated-
          // baseline supervision, file header comment) but keep
          // threshold-engine samples untouched, recompute (which naturally
          // nulls out any stale calibrated model thresholds since zero
          // model samples now remain), then stamp epoch 2 and persist
          // immediately so this wipe only ever happens once per device.
          this.samples = validSamples.filter((sample) => !isModelModeSample(sample))
          this.modelCalibrationEpoch = CURRENT_MODEL_CALIBRATION_EPOCH
          this._recompute()
          try {
            this._persist()
          } catch {
            // R43 minor: this is the first WRITE on the hydration path
            // (App.vue calls init() bare at root setup), so a thrown
            // QuotaExceededError here must not propagate and white-screen
            // the mount. Swallowing is safe: the wipe already happened in
            // memory for this session, and the wipe is idempotent — if
            // persistence never succeeds, the NEXT init() just re-derives
            // the same wiped result from the still-contaminated disk state
            // and tries again. The epoch is only durably stamped once some
            // future persist() (this one, or a later addValidation() /
            // resetCalibration()) actually succeeds.
          }
          return
        }

        this.samples = validSamples
        this.modelCalibrationEpoch = persistedEpoch
      }
      this._recompute()
    },

    // Record one nurse validation (agree or correct), recalibrate BOTH
    // engines immediately from the full sample set (each only ever sees
    // its own engine's samples — R30 BLOCKER 2), persist, and hand back
    // the thresholds now in effect for the very next scan/re-score.
    addValidation({ profiles, proposed, confirmed }) {
      const sample = {
        id: crypto.randomUUID(),
        profiles,
        proposed,
        confirmed,
        at: new Date().toISOString(),
      }
      this.samples.push(sample)
      this._recompute()
      this._persist()
      return this.thresholds
    },

    exportDataset() {
      return JSON.stringify({
        version: SCHEMA_VERSION,
        thresholds: this.thresholds,
        samples: this.samples,
        // R43 (fix round 1, MAJOR): without this, a backup exported from
        // THIS device (already at epoch 2, so its samples are already
        // clean) round-trips through importDataset() on any device
        // indistinguishably from a pre-R41 export — see the epoch gate
        // below.
        modelCalibrationEpoch: this.modelCalibrationEpoch,
      })
    },

    // Merge samples from another device/session, unique by id (falling
    // back to `at` for legacy samples), then recalibrate against the
    // combined set. Validates every incoming sample before any mutation —
    // a malformed sample is rejected, never merged, and never reaches
    // recalibrate()/recalibrateModel(). If recompute/persist unexpectedly
    // throws after a valid merge, the sample list is rolled back so no
    // half-merged state is ever left behind. A legacy export (no `.model`
    // key on any threshold, no model-scored sample in `samples`) round-
    // trips unchanged — recalibrateModel() just returns null everywhere,
    // same as "not enough model samples yet".
    importDataset(jsonString) {
      let parsed
      try {
        parsed = JSON.parse(jsonString)
      } catch {
        return { added: 0, rejected: 0 }
      }

      if (!parsed || typeof parsed !== 'object') {
        return { added: 0, rejected: 0 }
      }

      if (parsed.version !== undefined && parsed.version !== SCHEMA_VERSION) {
        const rejected = Array.isArray(parsed.samples) ? parsed.samples.length : 0
        return { added: 0, rejected }
      }

      // R43 (fix round 1, MAJOR): this store's own hydration (init()) is
      // not the only way contaminated model-mode samples can reach
      // recalibrateModel() — RecordsView's import button feeds an
      // arbitrary exported blob straight into importDataset(), bypassing
      // init() entirely. A pre-R41 export (or one from a device that
      // never upgraded) carries no `modelCalibrationEpoch` field — same
      // "absent means 0" convention as init() — or an epoch below current;
      // either way its model-mode samples are contaminated-baseline
      // supervision and must never reach recalibrateModel(), so they're
      // dropped BEFORE merging, same as the wipe on hydration.
      const incomingEpoch = Number.isFinite(parsed.modelCalibrationEpoch)
        ? parsed.modelCalibrationEpoch
        : 0
      const dropIncomingModelSamples = incomingEpoch < CURRENT_MODEL_CALIBRATION_EPOCH

      const incoming = Array.isArray(parsed.samples) ? parsed.samples : []
      const existingIds = new Set(this.samples.map(sampleIdentity))

      let added = 0
      let rejected = 0
      const toAdd = []

      for (const sample of incoming) {
        if (!isValidSample(sample)) {
          rejected += 1
          continue
        }
        if (dropIncomingModelSamples && isModelModeSample(sample)) {
          rejected += 1
          continue
        }
        const identity = sampleIdentity(sample)
        if (existingIds.has(identity)) continue
        existingIds.add(identity)
        toAdd.push(sample)
        added += 1
      }

      if (added > 0) {
        const previousSamples = this.samples
        const previousThresholds = this.thresholds
        this.samples = [...this.samples, ...toAdd]
        try {
          this._recompute()
          this._persist()
        } catch (err) {
          this.samples = previousSamples
          this.thresholds = previousThresholds
          throw err
        }
      }

      return { added, rejected }
    },

    resetCalibration() {
      this.samples = []
      this._recompute()
      this._persist()
    },

    // Recompute BOTH engines' thresholds from the current sample set and
    // merge them into the single `thresholds` object callers read (file
    // header comment). Pure/cheap (small grids x 5 categories x however
    // many samples), so recomputing wholesale on every mutation — rather
    // than trying to incrementally patch one engine — is simplest and
    // matches the pre-R30 pattern for the threshold engine.
    _recompute() {
      const asThresholds = recalibrate(this.samples, DEFAULT_THRESHOLDS)
      const modelThresholds = recalibrateModel(this.samples)
      this.thresholds = mergeThresholds(asThresholds, modelThresholds)
    },

    _persist() {
      saveCalibration({
        version: SCHEMA_VERSION,
        thresholds: this.thresholds,
        samples: this.samples,
        // R43: persisted so a device that has already run the epoch-2 wipe
        // (or was never contaminated — fresh install) never re-runs it.
        modelCalibrationEpoch: this.modelCalibrationEpoch,
      })
    },
  },
})
