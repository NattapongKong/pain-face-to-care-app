import { defineStore } from 'pinia'
import * as repository from '../domain/repository.js'
import { severityBand } from '../domain/severity.js'
import { usePatientStore } from './patientStore.js'
import { useSyncStore } from './syncStore.js'

function pad(n) {
  return String(n).padStart(2, '0')
}

/** Local (not UTC) ISO-minutes timestamp, e.g. "2026-08-24T14:05". */
function nowLocalIsoMinutes() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Wizard step order (ruling R18, Wave-4): 1 สังเกตสีหน้า → 2 ข้อมูลผู้ป่วย →
// 3 ความปวด → 4 ผลประเมิน → 5 การพยาบาล → 6 ประเมินซ้ำ. Steps 4-6 kept their
// numbers; only 1-3 rotated relative to the original form-part order
// (old 1 ข้อมูลผู้ป่วย, old 2 ความปวด, old 3 สังเกตสีหน้า).
//
// Exported (not a local AssessView constant) so tests can pin the exact
// label order directly — a silent revert of R18 should fail the suite.
export const STEP_LABELS = ['สังเกตสีหน้า', 'ข้อมูลผู้ป่วย', 'ความปวด', 'ผลประเมิน', 'การพยาบาล', 'ประเมินซ้ำ']
//
// Drafts persisted before this reorder shipped encode `step` under the OLD
// numbering. `persist()` stamps every draft it writes with the current
// STEP_SCHEMA_VERSION; `resume()` only applies the legacy remap when that
// stamp is missing/stale, so a draft written under the new order round-trips
// unchanged while an old one gets translated once.
const STEP_SCHEMA_VERSION = 2
const LEGACY_STEP_MIGRATION = { 1: 2, 2: 3, 3: 1, 4: 4, 5: 5, 6: 6 }

function migrateLegacyStep(step) {
  return LEGACY_STEP_MIGRATION[step] ?? 1
}

function sanitizeCurrentStep(step) {
  return Number.isInteger(step) && step >= 1 && step <= 6 ? step : 1
}

/**
 * Enqueues `record` for server sync when (a) the device is currently linked
 * AND (b) that patient's id matches the record's OWN stamped patientId. (b)
 * is what actually enforces spec §9's "unlinked records are local-only by
 * default": a record created while unlinked keeps patientId:null unless an
 * explicit, one-time action says otherwise — relinking the SAME device to
 * some patient afterwards must never SILENTLY/retroactively attribute it to
 * whoever happens to be active now. Rulings R37/R37b carve out the two
 * explicit-consent exceptions to that default, both of which stamp
 * record.patientId themselves BEFORE this function ever runs, so it needs
 * no special-casing for either: R37 is finalize({adoptCurrentPatient:true})
 * (Step5Nursing's save-time attribution prompt, gated on the draft's own
 * stamp still being null) and R37b is the rescue action
 * (RecordDetailView.vue, via repository.updateRecord + a direct
 * syncStore.enqueueRecord call — not this function, since rescue attributes
 * an already-finalized record long after finalize() has returned).
 * syncStore.enqueueRecord() is already a safe no-op when sync isn't
 * configured (or the ctx is incomplete), so that guard isn't duplicated
 * here — this is the ONE place finalize()/completeReassess() decide whether
 * a record is even eligible to reach it.
 * @param {object} record
 */
function syncIfLinked(record) {
  if (!record.patientId) return
  const patientStore = usePatientStore()
  if (!patientStore.linked || patientStore.patientId !== record.patientId) return
  useSyncStore().enqueueRecord({ patientId: patientStore.patientId, token: patientStore.token }, record)
}

/**
 * Whether the wizard's generic footer "ถัดไป" gate is satisfied for the
 * given step, given the current draft. Pure + exported so tests can pin
 * ruling R18's gate step numbers directly: step 2 = ข้อมูลผู้ป่วย
 * (patient name+bed required), step 3 = ความปวด (painScore required, plus
 * the vitals-changed detail rule). Every other step gates true here — the
 * self-driving steps (1 scan, 5 nursing, 6 reassess) never call this;
 * AssessView's showNext only wires it into steps 2-4 (see
 * AssessView.vue's canGoNext/showNext).
 * @param {number} step
 * @param {object} draft
 * @returns {boolean}
 */
export function canAdvanceFromStep(step, draft) {
  if (step === 2) {
    return Boolean(draft.patient.name?.trim()) && Boolean(draft.patient.bed?.trim())
  }
  if (step === 3) {
    if (draft.reported.painScore === null) return false
    if (draft.reported.vitalsChanged === true && !draft.reported.vitalsDetail?.trim()) {
      return false
    }
    return true
  }
  return true
}

/** Fresh draft — spec §6 record shape minus id/createdAt/status. */
function emptyDraft() {
  return {
    patient: { name: '', bed: '', datetime: nowLocalIsoMinutes() },
    reported: { painScore: null, location: '', vitalsChanged: null, vitalsDetail: '' },
    facial: {
      scores: { brow: null, eyes: null, noseCheek: null, mouth: null, overall: null },
      total: 0,
      source: null,
      proposed: null,
    },
    result: { reportedSeverity: null, faceSeverity: null },
    nursing: { band: null, items: [] },
    reassess: null,
  }
}

export const useAssessmentStore = defineStore('assessment', {
  state: () => ({
    draft: emptyDraft(),
    step: 1,
    activeRecordId: null,
    // review round 1 MAJOR 4: the patient this draft is FOR, stamped once
    // at startNew()/resume() time — NOT re-read from the live context at
    // finalize() time. Without this, starting a draft while linked to A,
    // then switching context to B mid-draft (a real device-handoff
    // scenario, not just theoretical), would silently attribute the
    // finished record to B. null = local-only (unlinked when the draft
    // began, or a legacy draft persisted before this field existed).
    draftPatientId: null,
  }),

  actions: {
    /** Persists {draft, step, activeRecordId, draftPatientId, stepSchema} as the single opaque draft blob. */
    persist() {
      repository.saveDraft({
        draft: this.draft,
        step: this.step,
        activeRecordId: this.activeRecordId,
        draftPatientId: this.draftPatientId,
        stepSchema: STEP_SCHEMA_VERSION,
      })
    },

    startNew() {
      const patientStore = usePatientStore()
      this.draft = emptyDraft()
      this.step = 1
      this.activeRecordId = null
      this.draftPatientId = patientStore.linked ? patientStore.patientId : null
      this.fillPatientFromContext()
      this.persist()
    },

    /**
     * Fill-if-empty prefill from the live patient context (spec §6): a
     * nurse-QR-linked device never types the patient's name/room again.
     * Copies patientStore.displayName/bed into draft.patient.name/bed ONLY
     * for a field that is (a) still an empty string AND (b) has something
     * non-empty to offer from the context — never clobbers text the nurse
     * has since typed, and never writes an empty string over an empty
     * string (which would be a no-op persist anyway, just a wasted one).
     * A no-op entirely when unlinked. Called once from startNew() (right
     * after a fresh empty draft, so it always applies there when linked)
     * and again from Step1Patient's onMounted hook — covers a pull that
     * resolves displayName/bed AFTER startNew() already ran.
     */
    fillPatientFromContext() {
      const patientStore = usePatientStore()
      if (!patientStore.linked) return
      const patch = {}
      if (!this.draft.patient.name && patientStore.displayName) patch.name = patientStore.displayName
      if (!this.draft.patient.bed && patientStore.bed) patch.bed = patientStore.bed
      if (Object.keys(patch).length > 0) this.updatePatient(patch)
    },

    /** @returns {boolean} whether a persisted draft was found and restored */
    resume() {
      const saved = repository.loadDraft()
      if (!saved || !saved.draft) return false
      this.draft = saved.draft
      // Legacy drafts persisted before this field existed carry no stamp —
      // treat exactly like an unlinked draft (local-only), never guess.
      this.draftPatientId = saved.draftPatientId ?? null

      // Intentionally not re-persisted here even though it recomputes the
      // migration every time: resume() is a pure function of the saved
      // blob, so calling it repeatedly on the same unstamped legacy draft
      // always re-derives the identical step — safe/idempotent with no
      // stamp yet written. The stepSchema stamp lands the first time any
      // store action calls persist() afterwards (setStep, updatePatient,
      // ...), which is also the point a *positional* re-migration would
      // become wrong, so persist() (not resume()) owning the stamp is load
      // bearing, not an oversight.
      const migrated =
        saved.stepSchema === STEP_SCHEMA_VERSION
          ? sanitizeCurrentStep(saved.step)
          : migrateLegacyStep(saved.step)

      // Ruling R22: the positional remap above can land a draft on steps
      // 2-5 (patient info through nursing) whose facial.source was never
      // set — e.g. an old-order draft saved mid ข้อมูลผู้ป่วย/ความปวด
      // migrates straight to new step 2/3, walking past the R18 "scan or
      // manual entry first" gate that AssessView/Step3Facial only enforce
      // going forward through the wizard, not on a resumed jump. Re-clamp
      // to step 1 whenever that's the case so the nurse always
      // confirms/backfills the facial score before continuing.
      this.step = migrated > 1 && migrated < 6 && !this.draft.facial?.source ? 1 : migrated

      // review round 2 BLOCKER 2b: startReassess() already refuses to enter
      // reassess mode for a record scoped to a DIFFERENT patient than the
      // one currently active (round 1 BLOCKER 2) — but resume() was
      // restoring activeRecordId straight from the persisted blob with NO
      // such check, so an ABANDONED step-6 draft (nurse started
      // reassessing A's record, then the device got rescanned to B before
      // finishing) reopened the exact gate startReassess() closes, the
      // moment /assess is next entered. Apply the identical scoping
      // formula here.
      const savedActive = saved.activeRecordId ?? null
      const patientStore = usePatientStore()
      const ctxId = patientStore.linked ? patientStore.patientId : null
      const rec = savedActive ? (repository.loadRecords().find((r) => r.id === savedActive) ?? null) : null
      const activeAllowed = savedActive && (rec?.patientId ?? null) === ctxId
      this.activeRecordId = activeAllowed ? savedActive : null

      // A refused step-6 resume must not strand the nurse on
      // Step6Reassess's "ไม่พบข้อมูล" panel forever — clamp back to step 1,
      // the normal wizard entry. Scoped tightly to "the saved step really
      // was 6 AND activeRecordId got refused" so R22's own clamp above
      // (steps 2-5, unrelated to activeRecordId entirely) is untouched.
      if (this.step === 6 && savedActive && !activeAllowed) {
        this.step = 1
      }

      return true
    },

    setStep(n) {
      this.step = n
      this.persist()
    },

    updatePatient(partial) {
      this.draft.patient = { ...this.draft.patient, ...partial }
      this.persist()
    },

    updateReported(partial) {
      this.draft.reported = { ...this.draft.reported, ...partial }
      this.persist()
    },

    updateFacial(partial) {
      this.draft.facial = { ...this.draft.facial, ...partial }
      this.persist()
    },

    updateNursing(partial) {
      this.draft.nursing = { ...this.draft.nursing, ...partial }
      this.persist()
    },

    /**
     * Builds the final record from the draft, saves it, clears the draft,
     * and resets local state for the next assessment.
     * Ruling R7: the nursing band is derived from facial.total, never from
     * the patient-reported pain score.
     * @param {{adoptCurrentPatient?:boolean}} [options]
     * @returns {object} the saved record
     */
    finalize({ adoptCurrentPatient = false } = {}) {
      const patientStore = usePatientStore()
      // Ruling R37 (amends R36 — see the bug context in spec §0): attribution
      // is still frozen at draft creation and NEVER changed silently. But
      // R36's blanket freeze is what stranded a draft begun while UNLINKED
      // forever local-only, even after the nurse later links the device
      // BEFORE finishing it — a real, repro'd data-loss bug (the owner's own
      // test assessment never reached the Sheet). R37's fix: an EXPLICIT,
      // one-time escape hatch — the caller (Step5Nursing's save handler,
      // after the nurse confirms an attribution prompt) may pass
      // `adoptCurrentPatient:true` to stamp the CURRENTLY linked patient
      // instead of the frozen null, but ONLY when (a) the device is linked
      // right now AND (b) this draft's own stamp is still null. Condition
      // (b) is load-bearing: it guarantees this can never re-attribute a
      // draft already stamped for SOME patient (its own, or — after a
      // mid-draft relink — a different one) to whoever the device happens
      // to be linked to now. `completeReassess` is untouched by this: it
      // always operates on an existing record's own already-decided
      // patientId, never the live context.
      const shouldAdopt = adoptCurrentPatient === true && patientStore.linked && this.draftPatientId === null
      const patientId = shouldAdopt ? patientStore.patientId : (this.draftPatientId ?? null)

      const nursingBand = severityBand(this.draft.facial.total)
      const record = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        // spec §8/§9 + review round 1 MAJOR 4 + ruling R37: stamped from the
        // DRAFT's own patientId (captured once, at startNew()/resume() time)
        // — NOT re-read from the live context here — UNLESS the explicit
        // adoption above applies (see shouldAdopt just above). A context
        // switch mid-draft must not silently reattribute an in-progress
        // assessment to whoever the device happens to be linked to at
        // finalize() time; syncIfLinked()'s record-vs-current-context guard
        // below then correctly declines to sync a record whose true patient
        // no longer matches the live context (it stays local, attributed
        // correctly).
        patientId,
        synced: false,
        patient: { ...this.draft.patient },
        reported: { ...this.draft.reported },
        facial: { ...this.draft.facial },
        result: {
          reportedSeverity: severityBand(this.draft.reported.painScore),
          faceSeverity: severityBand(this.draft.facial.total),
        },
        nursing: { ...this.draft.nursing, band: nursingBand },
        reassess: null,
        status: 'awaiting-reassess',
      }

      repository.saveRecord(record)
      repository.clearDraft()

      this.draft = emptyDraft()
      // R24: no `this.step = 1` reset here — every wizard entry path
      // (startNew / resume / startReassess) sets step explicitly, so this
      // was belt-and-braces, and it was the mechanism that remounted the
      // camera-bearing Step 1 (ScanPanel → getUserMedia) during the
      // navigation-away teardown window on a cold lazy-route chunk.
      this.activeRecordId = null
      // Belt-and-braces alongside the draft/activeRecordId reset above: the
      // very next draft always goes through startNew()/resume() first
      // (finalize() -> clearDraft() means resume() finds nothing), which
      // re-stamps this from the live context — but clearing it here too
      // means no leftover value from THIS finished draft can ever leak
      // into some future defensive read.
      this.draftPatientId = null

      syncIfLinked(record)

      return record
    },

    /**
     * Enters reassess mode for `recordId`. Refuses — the existing "record
     * not found" shape (activeRecordId stays null; Step6Reassess renders
     * "ไม่พบข้อมูลสำหรับการประเมินซ้ำ") — when the record exists but belongs
     * to a DIFFERENT patient than the one currently active (review round 1
     * BLOCKER 2): without this, a device linked to B could still open and
     * complete a reassess of a record scoped to A merely by knowing/guessing
     * its id, since Step6Reassess reads straight from the repository by id.
     * Reads the repository directly (not recordsStore's possibly-stale
     * in-memory `records`) so the check is correct even when entered via a
     * fresh navigation that never called recordsStore.load() first.
     * @param {string} recordId
     */
    startReassess(recordId) {
      const patientStore = usePatientStore()
      const contextId = patientStore.linked ? patientStore.patientId : null
      const record = repository.loadRecords().find((r) => r.id === recordId) ?? null

      this.activeRecordId = (record?.patientId ?? null) === contextId ? recordId : null
      this.step = 6
      this.persist()
    },

    /**
     * @param {{time:string, painScore:number, facialTotal:number, outcome:string, overridden:boolean}} result
     * @returns {object|null} the updated record
     */
    completeReassess({ time, painScore, facialTotal, outcome, overridden }) {
      const record = repository.updateRecord(this.activeRecordId, {
        reassess: { time, painScore, facialTotal, outcome, overridden },
        status: 'complete',
      })

      if (record) {
        // Mirror finalize(): clear the persisted draft/step/activeRecordId so
        // a later resume() never lands back in step 6 of a now-complete
        // record. (Single-draft model: any half-filled parallel draft was
        // already superseded when startReassess() entered reassess mode.)
        repository.clearDraft()
        this.draft = emptyDraft()
        // R24: no `this.step = 1` reset here — see finalize() for rationale.
        this.activeRecordId = null

        // Reassessment completion re-enqueues the FULL updated record (an
        // upsert per spec §5) — the server row must reflect the same object
        // a locally-synced device would see, reassess section included.
        syncIfLinked(record)
      }

      return record
    },
  },
})
