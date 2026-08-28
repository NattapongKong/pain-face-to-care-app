import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCalibrationStore } from '../../src/stores/calibrationStore.js'
import { DEFAULT_THRESHOLDS, scoreCategory } from '../../src/facescan/scoring.js'
import { loadCalibration, saveCalibration } from '../../src/domain/repository.js'

function flatProfile(value) {
  return { deciles: Array(11).fill(value), mean: value }
}

// R30 (fix round 1): store.thresholds is DEFAULT_THRESHOLDS enriched with a
// per-category `.model` field (null until model-mode samples calibrate it —
// see calibrationStore.js's mergeThresholds()). Tests that assert the
// store's thresholds against the bare DEFAULT_THRESHOLDS shape go through
// this so they stay honest about that extra field rather than leaning on
// toEqual's undefined-vs-absent leniency.
function withNullModel(thresholds) {
  const out = {}
  for (const cat of Object.keys(thresholds)) out[cat] = { ...thresholds[cat], model: null }
  return out
}

// A well-formed, id-less "legacy" sample shape (as persisted before the id
// field existed) — used to exercise the `at`-fallback dedupe path.
function legacySample(at, confirmedBrow = 0) {
  return {
    profiles: { brow: flatProfile(0.55) },
    proposed: { brow: 2 },
    confirmed: { brow: confirmedBrow },
    at,
  }
}

// Model-scored flat profile — mirrors exactly what useFaceScan.js's
// finishCapture() embeds in model mode: deciles/mean hold the P(ge1)
// series, `.model` carries the P(ge2) profile + this capture's (exported)
// cutpoints. A FLAT series makes pAbove() a clean step function (0 or 1,
// no interpolation), so tests built on it are exact — no floating-point
// boundary risk.
function flatModelProfile(ge1Value, ge2Value, cutpoints) {
  return {
    deciles: Array(11).fill(ge1Value),
    mean: ge1Value,
    model: {
      cutpoints,
      ge2Profile: { deciles: Array(11).fill(ge2Value), mean: ge2Value },
    },
  }
}

// A full model-mode sample (as init() would load it from a persisted
// blob) built around flatModelProfile — used by the R43 epoch-reset tests
// below to simulate pre-R41 contaminated-baseline validations.
function modelSample(at, ge1Value, confirmedBrow, cutpoints) {
  return {
    id: `model-${at}`,
    profiles: { brow: flatModelProfile(ge1Value, 0.05, cutpoints) },
    proposed: { brow: 0 },
    confirmed: { brow: confirmedBrow },
    at,
  }
}

describe('stores/calibrationStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('initial state: default thresholds (model uncalibrated), zero samples', () => {
    const store = useCalibrationStore()
    expect(store.thresholds).toEqual(withNullModel(DEFAULT_THRESHOLDS))
    expect(store.samples).toEqual([])
    expect(store.sampleCount).toBe(0)
  })

  it('init() with nothing persisted leaves defaults untouched', () => {
    const store = useCalibrationStore()
    store.init()
    expect(store.thresholds).toEqual(withNullModel(DEFAULT_THRESHOLDS))
    expect(store.sampleCount).toBe(0)
  })

  it('init() recalibrates from persisted valid samples on app start (spec §5.4), not just from whatever was persisted as thresholds', () => {
    // Persisted thresholds are deliberately bogus/unrelated — init() must
    // not just trust them; it must re-derive thresholds by recalibrating
    // against the persisted samples, same as spec §5.4 "and on app start".
    saveCalibration({
      version: 1,
      thresholds: DEFAULT_THRESHOLDS,
      samples: [legacySample('2026-01-01T00:00:00.000Z'), legacySample('2026-01-01T00:00:01.000Z'), legacySample('2026-01-01T00:00:02.000Z')],
    })
    const store = useCalibrationStore()
    store.init()
    expect(store.sampleCount).toBe(3)
    expect(store.thresholds.brow).not.toEqual(DEFAULT_THRESHOLDS.brow)
    expect(store.thresholds.brow.a).toBeGreaterThan(DEFAULT_THRESHOLDS.brow.a)
  })

  it('init() ignores a corrupt persisted thresholds shape entirely — thresholds are always recomputed from samples, never trusted from disk', () => {
    saveCalibration({
      version: 1,
      thresholds: { brow: { a: 1.5, s: -0.2 } }, // missing categories, out-of-range values
      samples: [],
    })
    const store = useCalibrationStore()
    expect(() => store.init()).not.toThrow()
    expect(store.thresholds).toEqual(withNullModel(DEFAULT_THRESHOLDS))
  })

  it('init() drops malformed persisted samples (schema validation) before recalibrating', () => {
    saveCalibration({
      version: 1,
      thresholds: DEFAULT_THRESHOLDS,
      samples: [
        legacySample('2026-01-01T00:00:00.000Z'),
        legacySample('2026-01-01T00:00:01.000Z'),
        legacySample('2026-01-01T00:00:02.000Z'),
        { profiles: {}, confirmed: { brow: 5 }, at: '2026-01-01T00:00:03.000Z' }, // invalid score
        { profiles: {}, confirmed: { brow: 0 } }, // missing `at`
      ],
    })
    const store = useCalibrationStore()
    store.init()
    expect(store.sampleCount).toBe(3)
  })

  it('addValidation pushes a labeled sample with a real id, persists via the repository (versioned), and returns thresholds', () => {
    const store = useCalibrationStore()
    const returned = store.addValidation({
      profiles: { brow: flatProfile(0.55) },
      proposed: { brow: 2 },
      confirmed: { brow: 0 },
    })

    expect(store.sampleCount).toBe(1)
    expect(store.samples[0]).toMatchObject({
      proposed: { brow: 2 },
      confirmed: { brow: 0 },
    })
    expect(typeof store.samples[0].id).toBe('string')
    expect(store.samples[0].id.length).toBeGreaterThan(0)
    expect(typeof store.samples[0].at).toBe('string')
    expect(returned).toBe(store.thresholds)

    const persisted = loadCalibration()
    expect(persisted.version).toBe(1)
    expect(persisted.samples.length).toBe(1)
    expect(persisted.thresholds).toEqual(store.thresholds)
  })

  it('3 planted disagreement samples move a category off defaults (real recalibration, not decorative)', () => {
    const store = useCalibrationStore()
    for (let i = 0; i < 3; i++) {
      store.addValidation({
        profiles: { brow: flatProfile(0.55) },
        proposed: { brow: 2 },
        confirmed: { brow: 0 },
      })
    }
    expect(store.sampleCount).toBe(3)
    expect(store.thresholds.brow).not.toEqual(DEFAULT_THRESHOLDS.brow)
    expect(store.thresholds.brow.a).toBeGreaterThan(DEFAULT_THRESHOLDS.brow.a)
  })

  it('exportDataset → importDataset into a FRESH store round-trips sample count and thresholds', () => {
    const storeA = useCalibrationStore()
    for (let i = 0; i < 3; i++) {
      storeA.addValidation({
        profiles: { brow: flatProfile(0.55) },
        proposed: { brow: 2 },
        confirmed: { brow: 0 },
      })
    }
    const exported = storeA.exportDataset()

    setActivePinia(createPinia())
    const storeB = useCalibrationStore()
    const result = storeB.importDataset(exported)

    expect(result).toEqual({ added: 3, rejected: 0 })
    expect(storeB.sampleCount).toBe(storeA.sampleCount)
    expect(storeB.thresholds).toEqual(storeA.thresholds)
  })

  it('importDataset dedupes by id when the incoming sample already carries one', () => {
    const store = useCalibrationStore()
    store.addValidation({
      profiles: { brow: flatProfile(0.55) },
      proposed: { brow: 2 },
      confirmed: { brow: 0 },
    })
    const existingSample = store.samples[0]

    // Re-importing the exact same (id-bearing) sample plus one genuinely new
    // one must only add the new one.
    const incoming = JSON.stringify({
      version: 1,
      samples: [existingSample, legacySample('2099-01-01T00:00:00.000Z')],
    })

    const result = store.importDataset(incoming)
    expect(result).toEqual({ added: 1, rejected: 0 })
    expect(store.sampleCount).toBe(2)
  })

  it('importDataset falls back to `at` for legacy (id-less) samples', () => {
    saveCalibration({
      version: 1,
      thresholds: DEFAULT_THRESHOLDS,
      samples: [legacySample('2020-01-01T00:00:00.000Z')],
    })
    const store = useCalibrationStore()
    store.init()
    expect(store.sampleCount).toBe(1)

    const incoming = JSON.stringify({
      version: 1,
      samples: [
        legacySample('2020-01-01T00:00:00.000Z'), // same `at`, no id → duplicate
        legacySample('2021-01-01T00:00:00.000Z'), // new
      ],
    })

    const result = store.importDataset(incoming)
    expect(result).toEqual({ added: 1, rejected: 0 })
    expect(store.sampleCount).toBe(2)
  })

  it('importDataset validates before merging: malformed samples are rejected, never reach recalibrate, and do not corrupt state', () => {
    const store = useCalibrationStore()
    const incoming = JSON.stringify({
      version: 1,
      samples: [
        legacySample('2026-02-01T00:00:00.000Z'), // valid
        { profiles: {}, confirmed: { brow: 9 }, at: '2026-02-01T00:00:01.000Z' }, // bad score
        { profiles: {}, confirmed: { brow: 0 } }, // missing at
        { confirmed: { brow: 0 }, at: '2026-02-01T00:00:02.000Z' }, // profiles wrong type is fine (missing key ok) but let's also try a bad profile
        {
          profiles: { brow: { deciles: [0, 1], mean: 0.5 } }, // wrong-length deciles
          confirmed: { brow: 0 },
          at: '2026-02-01T00:00:03.000Z',
        },
      ],
    })

    const result = store.importDataset(incoming)
    expect(result.added).toBe(2) // the first valid one + the "missing profiles key" one
    expect(result.rejected).toBe(3)
    expect(store.sampleCount).toBe(2)
    // recalibrate must have run cleanly against only the valid merged samples
    expect(store.thresholds).toBeDefined()
  })

  it('importDataset with malformed JSON adds/rejects nothing and does not throw', () => {
    const store = useCalibrationStore()
    expect(() => store.importDataset('not json{{')).not.toThrow()
    expect(store.importDataset('not json{{')).toEqual({ added: 0, rejected: 0 })
    expect(store.sampleCount).toBe(0)
  })

  it('importDataset rejects an unknown schema version wholesale', () => {
    const store = useCalibrationStore()
    const incoming = JSON.stringify({
      version: 2,
      samples: [legacySample('2026-01-01T00:00:00.000Z'), legacySample('2026-01-01T00:00:01.000Z')],
    })
    const result = store.importDataset(incoming)
    expect(result).toEqual({ added: 0, rejected: 2 })
    expect(store.sampleCount).toBe(0)
  })

  it('resetCalibration restores defaults and clears samples, persisted too (versioned)', () => {
    const store = useCalibrationStore()
    store.addValidation({
      profiles: { brow: flatProfile(0.55) },
      proposed: { brow: 2 },
      confirmed: { brow: 0 },
    })
    store.resetCalibration()
    expect(store.thresholds).toEqual(withNullModel(DEFAULT_THRESHOLDS))
    expect(store.samples).toEqual([])
    expect(loadCalibration()).toEqual({
      version: 1,
      thresholds: withNullModel(DEFAULT_THRESHOLDS),
      samples: [],
      // R43: every persist round stamps the current epoch.
      modelCalibrationEpoch: 2,
    })
  })

  // ------------------------------------------------------------------
  // R30 (fix round 1) — model-mode calibration liveness + engine
  // separation, through the REAL Pinia store (not just the pure
  // calibration.js functions — this is what the review flagged as dead).
  // ------------------------------------------------------------------

  it('R30 BLOCKER 1: model-mode nurse corrections are genuinely alive — the SAME capture re-scores differently after calibration', () => {
    const store = useCalibrationStore()
    const cutpoints = { ge1: 0.95, ge2: 0.90 }
    // The capture under test: ge1 flat at 0.85 (below the exported 0.95
    // cutpoint -> proposes inactive/0), ge2 flat at 0.05 (never strong).
    const capture = flatModelProfile(0.85, 0.05, cutpoints)

    // Before any calibration: scoreCategory falls back to the profile's own
    // embedded (exported) cutpoints.
    expect(scoreCategory(capture, store.thresholds.brow)).toBe(0)

    // The nurse consistently corrects this exact shape upward to "2" three
    // times (the min-samples floor).
    for (let i = 0; i < 3; i++) {
      store.addValidation({
        profiles: { brow: flatModelProfile(0.85, 0.05, cutpoints) },
        proposed: { brow: 0 },
        confirmed: { brow: 2 },
      })
    }

    expect(store.thresholds.brow.model).not.toBeNull()
    // The calibrated ge1 cutpoint must have moved BELOW 0.85 (only then
    // does pAbove(capture, ge1) flip from 0 to 1, satisfying confirmed=2).
    expect(store.thresholds.brow.model.ge1).toBeLessThan(0.85)

    // Re-scoring the EXACT SAME capture with the now-calibrated thresholds
    // must produce a DIFFERENT proposal — this is the liveness the round-1
    // review found dead (10 corrections left the proposal byte-identical).
    expect(scoreCategory(capture, store.thresholds.brow)).toBe(2)
  })

  it('R30 BLOCKER 2: model-mode samples never move the threshold-engine (a,s) grid — no poisoning', () => {
    const store = useCalibrationStore()
    const cutpoints = { ge1: 0.95, ge2: 0.90 }
    // 3 model-mode validations, all AGREEING with a non-zero proposal —
    // exactly the "3 agreeing validations" shape the live regression
    // report described for R28's noseCheek 0.02 -> 0.10 poisoning.
    for (let i = 0; i < 3; i++) {
      store.addValidation({
        profiles: { noseCheek: flatModelProfile(0.85, 0.05, cutpoints) },
        proposed: { noseCheek: 2 },
        confirmed: { noseCheek: 2 },
      })
    }
    // R28's data-grounded noseCheek (a,s) must be untouched.
    expect(store.thresholds.noseCheek.a).toBe(DEFAULT_THRESHOLDS.noseCheek.a)
    expect(store.thresholds.noseCheek.s).toBe(DEFAULT_THRESHOLDS.noseCheek.s)
    // The model side, meanwhile, DID calibrate from these same samples —
    // proving the split is a real routing decision, not just "model
    // samples are silently dropped everywhere".
    expect(store.thresholds.noseCheek.model).not.toBeNull()
  })

  it('R30: threshold-mode samples never move a model threshold either (separation is two-way)', () => {
    const store = useCalibrationStore()
    for (let i = 0; i < 3; i++) {
      store.addValidation({
        profiles: { brow: flatProfile(0.55) }, // plain threshold-engine profile, no .model
        proposed: { brow: 2 },
        confirmed: { brow: 0 },
      })
    }
    // The (a,s) pair DID move (existing behavior, unaffected by R30 — same
    // shape as the "3 planted disagreement samples" test above).
    expect(store.thresholds.brow.a).toBeGreaterThan(DEFAULT_THRESHOLDS.brow.a)
    // But brow's model threshold must still read as uncalibrated — zero
    // model-scored samples exist for it.
    expect(store.thresholds.brow.model).toBeNull()
  })

  // ------------------------------------------------------------------
  // R43 (lead ruling, from R3-T1's review) — one-time model-calibration
  // epoch reset. Every pre-R41 model-mode sample was captured against a
  // CONTAMINATED baseline (the patient's own current face — the incident
  // where everything scored ~0), so cutpoints learned from them are
  // invalid supervision that must not silently override R41's population
  // cutpoints. Threshold-engine calibration never subtracted a baseline
  // and must be preserved untouched.
  // ------------------------------------------------------------------

  describe('R43: one-time model-calibration epoch reset', () => {
    const cutpoints = { ge1: 0.95, ge2: 0.9 }

    it('hydrating a pre-epoch persisted state (no epoch field) drops model-mode samples + calibrated model thresholds, keeps threshold-engine samples and their EXACT calibrated (a,s) untouched, and stamps epoch 2', () => {
      // Ground truth: what the threshold engine actually calibrates to
      // from 3 real disagreement samples, computed in an independent store
      // BEFORE the migration runs — so the post-migration assertion below
      // is against real calibrated values (fix round 1, MINOR 5), not just
      // "moved off default". A single below-MIN_SAMPLES survivor (the
      // original version of this test) never exercised the threshold half
      // of the preservation claim at all.
      const referenceStore = useCalibrationStore()
      for (let i = 0; i < 3; i++) {
        referenceStore.addValidation({
          profiles: { brow: flatProfile(0.55) },
          proposed: { brow: 2 },
          confirmed: { brow: 0 },
        })
      }
      const expectedBrowA = referenceStore.thresholds.brow.a
      const expectedBrowS = referenceStore.thresholds.brow.s
      expect(expectedBrowA).toBeGreaterThan(DEFAULT_THRESHOLDS.brow.a) // sanity: it actually moved
      const survivingThresholdSamples = referenceStore.samples

      const staleModelSamples = [
        modelSample('2026-01-01T00:00:00.000Z', 0.85, 2, cutpoints),
        modelSample('2026-01-01T00:00:01.000Z', 0.85, 2, cutpoints),
        modelSample('2026-01-01T00:00:02.000Z', 0.85, 2, cutpoints),
      ]

      setActivePinia(createPinia())
      saveCalibration({
        version: 1,
        thresholds: {
          ...withNullModel(DEFAULT_THRESHOLDS),
          brow: { ...DEFAULT_THRESHOLDS.brow, model: { ge1: 0.6, ge2: 0.5 } },
        },
        samples: [...staleModelSamples, ...survivingThresholdSamples],
        // no modelCalibrationEpoch field — pre-R43 device
      })

      const store = useCalibrationStore()
      store.init()

      // The 3 model-mode samples are gone; the 3 threshold-engine samples
      // survive untouched.
      expect(store.sampleCount).toBe(3)
      expect(store.samples.map((s) => s.at)).toEqual(survivingThresholdSamples.map((s) => s.at))

      // The stale calibrated model threshold is wiped — recompute() now
      // has zero model samples to work from.
      expect(store.thresholds.brow.model).toBeNull()
      expect(store.modelCalibrationEpoch).toBe(2)

      // The threshold-engine (a,s) calibration survives EXACTLY — the
      // migration only ever touches model-mode samples/thresholds.
      expect(store.thresholds.brow.a).toBe(expectedBrowA)
      expect(store.thresholds.brow.s).toBe(expectedBrowS)

      // The wipe was persisted immediately, not just held in memory, so
      // it only ever happens once per device.
      const persisted = loadCalibration()
      expect(persisted.modelCalibrationEpoch).toBe(2)
      expect(persisted.samples.length).toBe(3)
      expect(persisted.thresholds.brow.model).toBeNull()
      expect(persisted.thresholds.brow.a).toBe(expectedBrowA)
    })

    it('hydrating an already epoch-2 persisted state is unchanged — model-mode samples and their calibrated thresholds survive', () => {
      const modelSamples = [
        modelSample('2026-02-01T00:00:00.000Z', 0.85, 2, cutpoints),
        modelSample('2026-02-01T00:00:01.000Z', 0.85, 2, cutpoints),
        modelSample('2026-02-01T00:00:02.000Z', 0.85, 2, cutpoints),
      ]
      saveCalibration({
        version: 1,
        thresholds: withNullModel(DEFAULT_THRESHOLDS),
        samples: modelSamples,
        modelCalibrationEpoch: 2,
      })

      const store = useCalibrationStore()
      store.init()

      expect(store.sampleCount).toBe(3)
      expect(store.modelCalibrationEpoch).toBe(2)
      // Recomputed fresh from the surviving samples (thresholds are never
      // trusted from disk either way) — non-null because 3 agreeing
      // model-mode samples clear MIN_SAMPLES.
      expect(store.thresholds.brow.model).not.toBeNull()
    })

    it('fresh install (nothing persisted) starts at epoch 2 without dropping or persisting anything', () => {
      const store = useCalibrationStore()
      store.init()

      expect(store.modelCalibrationEpoch).toBe(2)
      expect(store.sampleCount).toBe(0)
      expect(store.thresholds).toEqual(withNullModel(DEFAULT_THRESHOLDS))
      // No forced write on hydration when there was nothing to migrate —
      // matches the pre-existing "init() with nothing persisted" behavior.
      expect(loadCalibration()).toBeNull()
    })

    it('hydrating a FUTURE epoch (3) does not wipe anything and preserves the epoch verbatim, not clamped down to 2', () => {
      const modelSamples = [
        modelSample('2026-03-01T00:00:00.000Z', 0.85, 2, cutpoints),
        modelSample('2026-03-01T00:00:01.000Z', 0.85, 2, cutpoints),
        modelSample('2026-03-01T00:00:02.000Z', 0.85, 2, cutpoints),
      ]
      saveCalibration({
        version: 1,
        thresholds: withNullModel(DEFAULT_THRESHOLDS),
        samples: modelSamples,
        modelCalibrationEpoch: 3,
      })

      const store = useCalibrationStore()
      store.init()

      expect(store.sampleCount).toBe(3)
      expect(store.modelCalibrationEpoch).toBe(3)
      expect(store.thresholds.brow.model).not.toBeNull()
    })

    it.each([
      ['non-numeric string', '2'],
      ['NaN', NaN],
      ['negative', -5],
    ])('a garbage persisted epoch (%s) is treated as pre-epoch and migrates safely', (_label, garbageEpoch) => {
      const staleModelSamples = [
        modelSample('2026-04-01T00:00:00.000Z', 0.85, 2, cutpoints),
        modelSample('2026-04-01T00:00:01.000Z', 0.85, 2, cutpoints),
        modelSample('2026-04-01T00:00:02.000Z', 0.85, 2, cutpoints),
      ]
      const survivor = legacySample('2026-04-01T00:00:03.000Z')

      saveCalibration({
        version: 1,
        thresholds: withNullModel(DEFAULT_THRESHOLDS),
        samples: [...staleModelSamples, survivor],
        modelCalibrationEpoch: garbageEpoch,
      })

      const store = useCalibrationStore()
      expect(() => store.init()).not.toThrow()

      expect(store.sampleCount).toBe(1)
      expect(store.samples[0].at).toBe(survivor.at)
      expect(store.thresholds.brow.model).toBeNull()
      expect(store.modelCalibrationEpoch).toBe(2)
    })

    it('recalibration after the wipe starts from zero model samples — needs 3 NEW ones before model thresholds reappear', () => {
      saveCalibration({
        version: 1,
        thresholds: {
          ...withNullModel(DEFAULT_THRESHOLDS),
          brow: { ...DEFAULT_THRESHOLDS.brow, model: { ge1: 0.6, ge2: 0.5 } },
        },
        samples: [
          modelSample('2026-01-01T00:00:00.000Z', 0.85, 2, cutpoints),
          modelSample('2026-01-01T00:00:01.000Z', 0.85, 2, cutpoints),
          modelSample('2026-01-01T00:00:02.000Z', 0.85, 2, cutpoints),
        ],
        // no modelCalibrationEpoch field — pre-R43 device
      })

      const store = useCalibrationStore()
      store.init()
      expect(store.sampleCount).toBe(0)
      expect(store.thresholds.brow.model).toBeNull()

      // First 2 fresh validations post-wipe: still below MIN_SAMPLES (3).
      store.addValidation({
        profiles: { brow: flatModelProfile(0.85, 0.05, cutpoints) },
        proposed: { brow: 0 },
        confirmed: { brow: 2 },
      })
      expect(store.thresholds.brow.model).toBeNull()

      store.addValidation({
        profiles: { brow: flatModelProfile(0.85, 0.05, cutpoints) },
        proposed: { brow: 0 },
        confirmed: { brow: 2 },
      })
      expect(store.thresholds.brow.model).toBeNull()

      // 3rd fresh validation clears MIN_SAMPLES — thresholds reappear,
      // derived purely from post-wipe evidence.
      store.addValidation({
        profiles: { brow: flatModelProfile(0.85, 0.05, cutpoints) },
        proposed: { brow: 0 },
        confirmed: { brow: 2 },
      })
      expect(store.thresholds.brow.model).not.toBeNull()
      expect(store.sampleCount).toBe(3)
    })

    // ----------------------------------------------------------------
    // R43 fix round 1, MAJOR — the export/import backup path is a second
    // route into recalibrateModel() that bypasses init() entirely
    // (RecordsView's import button). It needs the exact same epoch gate.
    // ----------------------------------------------------------------

    it('importDataset treats a pre-epoch (no-epoch) payload as contaminated: model-mode samples are rejected, threshold-engine samples are merged, and thresholds.*.model stays null', () => {
      const store = useCalibrationStore()
      const incoming = JSON.stringify({
        version: 1,
        // no modelCalibrationEpoch — pre-R41/R43 export
        samples: [
          // 3 model-mode samples — would clear MIN_SAMPLES if let through.
          modelSample('2026-05-01T00:00:00.000Z', 0.85, 2, cutpoints),
          modelSample('2026-05-01T00:00:01.000Z', 0.85, 2, cutpoints),
          modelSample('2026-05-01T00:00:02.000Z', 0.85, 2, cutpoints),
          // 3 legitimate threshold-engine samples — must merge normally.
          legacySample('2026-05-01T00:00:03.000Z'),
          legacySample('2026-05-01T00:00:04.000Z'),
          legacySample('2026-05-01T00:00:05.000Z'),
        ],
      })

      const result = store.importDataset(incoming)

      expect(result.added).toBe(3) // only the threshold-engine samples
      expect(result.rejected).toBe(3) // the 3 model-mode samples
      expect(store.sampleCount).toBe(3)
      expect(store.samples.every((s) => !s.profiles.brow?.model)).toBe(true)
      // No model-mode sample ever reached recalibrateModel() — never had a
      // chance to relearn contaminated cutpoints.
      expect(store.thresholds.brow.model).toBeNull()
    })

    it('post-fix export stamps the epoch, and importing it into a fresh epoch-2 store drops nothing', () => {
      const storeA = useCalibrationStore()
      for (let i = 0; i < 3; i++) {
        storeA.addValidation({
          profiles: { brow: flatModelProfile(0.85, 0.05, cutpoints) },
          proposed: { brow: 0 },
          confirmed: { brow: 2 },
        })
      }
      expect(storeA.thresholds.brow.model).not.toBeNull() // sanity: real calibration happened

      const exported = storeA.exportDataset()
      expect(JSON.parse(exported).modelCalibrationEpoch).toBe(2)

      setActivePinia(createPinia())
      const storeB = useCalibrationStore()
      const result = storeB.importDataset(exported)

      expect(result).toEqual({ added: 3, rejected: 0 })
      expect(storeB.sampleCount).toBe(3)
      expect(storeB.thresholds).toEqual(storeA.thresholds)
    })
  })
})
