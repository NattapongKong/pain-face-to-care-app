import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { canAdvanceFromStep, STEP_LABELS, useAssessmentStore } from '../../src/stores/assessmentStore.js'
import { usePatientStore } from '../../src/stores/patientStore.js'
import { loadRecords, loadDraft, saveDraft } from '../../src/domain/repository.js'

/** A confirmed manual facial score — the minimum that satisfies the R22 gate. */
function confirmedFacial() {
  return {
    scores: { brow: 0, eyes: 0, noseCheek: 0, mouth: 0, overall: 0 },
    total: 0,
    source: 'manual',
    proposed: null,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('stores/assessmentStore — startNew / resume / setStep', () => {
  it('startNew resets draft to a fresh shape at step 1 and persists it', () => {
    const store = useAssessmentStore()
    store.startNew()
    expect(store.step).toBe(1)
    expect(store.activeRecordId).toBeNull()
    expect(store.draft.reported.painScore).toBeNull()
    expect(store.draft.patient.datetime).toEqual(expect.any(String))
    expect(loadDraft()).not.toBeNull()
  })

  it('resume returns false when nothing is persisted', () => {
    const store = useAssessmentStore()
    expect(store.resume()).toBe(false)
  })

  it('resume restores draft + step from a persisted draft in a later session', () => {
    const store1 = useAssessmentStore()
    store1.startNew()
    // R22: step 3 is past the facial gate (steps 2-5), so the draft needs a
    // confirmed facial score or resume() below would clamp it back to 1.
    store1.updateFacial(confirmedFacial())
    store1.setStep(3)
    store1.updatePatient({ name: 'สมชาย', bed: '5A' })

    setActivePinia(createPinia())
    const store2 = useAssessmentStore()
    expect(store2.resume()).toBe(true)
    expect(store2.step).toBe(3)
    expect(store2.draft.patient.name).toBe('สมชาย')
    expect(store2.draft.patient.bed).toBe('5A')
  })
})

// Ruling R18 (Wave-4): the wizard reordered to 1 สังเกตสีหน้า -> 2 ข้อมูลผู้ป่วย
// -> 3 ความปวด -> 4 ผลประเมิน -> 5 การพยาบาล -> 6 ประเมินซ้ำ. Drafts persisted
// under the OLD order (1 ข้อมูลผู้ป่วย, 2 ความปวด, 3 สังเกตสีหน้า) must resume
// at the equivalent NEW step. These tests write a raw legacy draft straight
// via repository.saveDraft (bypassing the store's persist(), which always
// stamps the current schema) to simulate a draft written before this
// reorder shipped.
//
// Ruling R22 (review fix): resume() also clamps any step in 2-5 back to 1
// when the draft has no confirmed facial.source, since those steps are
// past the R18 "scan or manual entry first" gate. legacyDraftWithFacial is
// used everywhere the *positional* remap (old -> new step number) is what's
// under test, so that R22's gate isn't what's producing the observed step —
// R22 itself gets its own dedicated tests below with the facial-less draft.
describe('stores/assessmentStore — legacy step migration on resume (ruling R18)', () => {
  const legacyDraft = { patient: { name: 'สมชาย', bed: '5A', datetime: '2026-08-24T09:00' } }
  const legacyDraftWithFacial = { ...legacyDraft, facial: confirmedFacial() }

  it('maps legacy step 1 (old ข้อมูลผู้ป่วย) to new step 2', () => {
    saveDraft({ draft: legacyDraftWithFacial, step: 1, activeRecordId: null })
    const store = useAssessmentStore()
    expect(store.resume()).toBe(true)
    expect(store.step).toBe(2)
  })

  it('maps legacy step 2 (old ความปวด) to new step 3', () => {
    saveDraft({ draft: legacyDraftWithFacial, step: 2, activeRecordId: null })
    const store = useAssessmentStore()
    expect(store.resume()).toBe(true)
    expect(store.step).toBe(3)
  })

  it('maps legacy step 3 (old สังเกตสีหน้า) to new step 1 (no facial needed: step 1 IS the facial step)', () => {
    saveDraft({ draft: legacyDraft, step: 3, activeRecordId: null })
    const store = useAssessmentStore()
    expect(store.resume()).toBe(true)
    expect(store.step).toBe(1)
  })

  it('leaves legacy steps 4-6 unchanged (unaffected by the reorder)', () => {
    for (const step of [4, 5, 6]) {
      setActivePinia(createPinia())
      saveDraft({ draft: legacyDraftWithFacial, step, activeRecordId: null })
      const store = useAssessmentStore()
      expect(store.resume()).toBe(true)
      expect(store.step).toBe(step)
    }
  })

  it('falls back to step 1 for an out-of-range legacy step', () => {
    saveDraft({ draft: legacyDraft, step: 99, activeRecordId: null })
    const store = useAssessmentStore()
    expect(store.resume()).toBe(true)
    expect(store.step).toBe(1)
  })

  it('falls back to step 1 when the legacy draft has no step at all', () => {
    saveDraft({ draft: legacyDraft, activeRecordId: null })
    const store = useAssessmentStore()
    expect(store.resume()).toBe(true)
    expect(store.step).toBe(1)
  })

  it('a draft already stamped with the current step schema resumes at its saved step unmodified', () => {
    const store1 = useAssessmentStore()
    store1.startNew()
    store1.updateFacial(confirmedFacial()) // R22 gate for landing on step 2
    store1.setStep(2) // new-order step 2 = ข้อมูลผู้ป่วย

    setActivePinia(createPinia())
    const store2 = useAssessmentStore()
    expect(store2.resume()).toBe(true)
    expect(store2.step).toBe(2)
  })
})

// Ruling R22 (Wave-4 review fix, lead ruling): the positional remap above
// can land a draft on steps 2-5 whose facial.source was never confirmed —
// walking straight past the R18 "scan or manual entry first" gate. resume()
// re-clamps to step 1 in that case, regardless of whether the step came
// from the legacy-migration branch or the current-schema branch.
describe('stores/assessmentStore — R22 gate clamp on resume', () => {
  const legacyDraft = { patient: { name: 'สมชาย', bed: '5A', datetime: '2026-08-24T09:00' } }

  it('a legacy step 1 draft without a confirmed facial score resumes at step 1, not the positionally-migrated step 2', () => {
    saveDraft({ draft: legacyDraft, step: 1, activeRecordId: null })
    const store = useAssessmentStore()
    expect(store.resume()).toBe(true)
    expect(store.step).toBe(1)
  })

  it('a legacy step 2 draft without a confirmed facial score resumes at step 1, not the positionally-migrated step 3', () => {
    saveDraft({ draft: legacyDraft, step: 2, activeRecordId: null })
    const store = useAssessmentStore()
    expect(store.resume()).toBe(true)
    expect(store.step).toBe(1)
  })

  it('a current-schema draft without a confirmed facial score also clamps to step 1 (not just legacy drafts)', () => {
    const store1 = useAssessmentStore()
    store1.startNew()
    store1.setStep(4) // raw setStep bypasses the wizard's own gates
    expect(store1.draft.facial.source).toBeNull()

    setActivePinia(createPinia())
    const store2 = useAssessmentStore()
    expect(store2.resume()).toBe(true)
    expect(store2.step).toBe(1)
  })

  // The R22 clamp condition is `migrated > 1 && migrated < 6 && !facial.source`
  // — step 6 is deliberately exempt. This is the real reachable path:
  // startReassess() persists exactly this blob (an emptyDraft-shaped draft,
  // since finalize() already reset the draft; facial.source is null) at
  // step 6, stamped with the current step schema. A later resume() of that
  // blob must land on step 6, not get clamped to 1 — mutating the guard
  // from `< 6` to `<= 6` would break this and previously passed unnoticed.
  it('a current-schema step 6 draft without a confirmed facial score resumes at step 6, unaffected by the gate clamp', () => {
    const reassessDraft = {
      patient: { name: '', bed: '', datetime: '2026-08-24T09:00' },
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
    saveDraft({ draft: reassessDraft, step: 6, activeRecordId: 'some-id', stepSchema: 2 })

    const store = useAssessmentStore()
    expect(store.resume()).toBe(true)
    expect(store.step).toBe(6)
  })
})

describe('stores/assessmentStore — STEP_LABELS + canAdvanceFromStep (pin ruling R18)', () => {
  it('STEP_LABELS is the exact scan-first 6-label order', () => {
    expect(STEP_LABELS).toEqual([
      'สังเกตสีหน้า',
      'ข้อมูลผู้ป่วย',
      'ความปวด',
      'ผลประเมิน',
      'การพยาบาล',
      'ประเมินซ้ำ',
    ])
  })

  it('gates step 2 (ข้อมูลผู้ป่วย) on patient name + bed both being present', () => {
    const draft = {
      patient: { name: '', bed: '' },
      reported: { painScore: null, vitalsChanged: null, vitalsDetail: '' },
    }
    expect(canAdvanceFromStep(2, draft)).toBe(false)

    draft.patient.name = 'สมชาย'
    expect(canAdvanceFromStep(2, draft)).toBe(false) // bed still empty

    draft.patient.bed = '5A'
    expect(canAdvanceFromStep(2, draft)).toBe(true)
  })

  it('gates step 3 (ความปวด) on painScore plus the vitals-changed detail rule', () => {
    const draft = {
      patient: { name: 'สมชาย', bed: '5A' },
      reported: { painScore: null, vitalsChanged: null, vitalsDetail: '' },
    }
    expect(canAdvanceFromStep(3, draft)).toBe(false)

    draft.reported.painScore = 5
    expect(canAdvanceFromStep(3, draft)).toBe(true)

    draft.reported.vitalsChanged = true
    expect(canAdvanceFromStep(3, draft)).toBe(false) // detail required once vitalsChanged is true

    draft.reported.vitalsDetail = 'BP สูงขึ้น'
    expect(canAdvanceFromStep(3, draft)).toBe(true)
  })

  it('does not gate steps 1, 4, 5, 6 — a silent revert of the R18 gate step numbers would fail this', () => {
    const bareDraft = {
      patient: { name: '', bed: '' },
      reported: { painScore: null, vitalsChanged: null, vitalsDetail: '' },
    }
    for (const step of [1, 4, 5, 6]) {
      expect(canAdvanceFromStep(step, bareDraft)).toBe(true)
    }
  })
})

// Plan Task 5 / spec §6: a nurse-QR-linked device never types the patient's
// name/room again. startNew() prefills draft.patient.name/bed from the live
// patientStore ONLY when the corresponding draft field is still empty —
// fillPatientFromContext() is the shared fill-if-empty primitive; Step1Patient
// calls it again on mount (untested here — component-level, out of this
// task's `tests/stores` scope) to cover a pull that resolves AFTER startNew()
// already ran.
describe('stores/assessmentStore — startNew patient context prefill (spec §6)', () => {
  it('prefills name and bed from the patient context when linked', () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })
    patientStore.applyServerInfo({ displayName: 'สมชาย', bed: '5A', baseline: null })

    const store = useAssessmentStore()
    store.startNew()

    expect(store.draft.patient.name).toBe('สมชาย')
    expect(store.draft.patient.bed).toBe('5A')
  })

  it('leaves name/bed empty when unlinked', () => {
    const store = useAssessmentStore()
    store.startNew()

    expect(store.draft.patient.name).toBe('')
    expect(store.draft.patient.bed).toBe('')
  })

  it('fillPatientFromContext never overwrites an already non-empty field (e.g. a nurse-typed name, or a bed already prefilled)', () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })
    patientStore.applyServerInfo({ displayName: 'สมชาย', bed: '5A', baseline: null })

    const store = useAssessmentStore()
    store.startNew() // prefilled to สมชาย / 5A
    store.updatePatient({ name: 'ชื่อที่พยาบาลพิมพ์เอง' }) // nurse edits the name afterwards

    // Simulate a late pull resolving with DIFFERENT server values and
    // Step1Patient's mount-time re-fill firing again — must not clobber the
    // nurse's typed name, nor the bed already filled by startNew().
    patientStore.applyServerInfo({ displayName: 'ชื่ออื่น', bed: '9Z', baseline: null })
    store.fillPatientFromContext()

    expect(store.draft.patient.name).toBe('ชื่อที่พยาบาลพิมพ์เอง')
    expect(store.draft.patient.bed).toBe('5A')
  })
})

// R3-T7 (spec §3, T2 review follow-up): baselineSource rides along on
// draft.facial as a plain open-merge field (updateFacial does
// `{ ...this.draft.facial, ...partial }`, no whitelist) — no store-schema
// change was needed. These tests pin the two hydration-safety halves: (a)
// a value written via updateFacial survives a resume() in a fresh session,
// and (b) a draft persisted before this field existed (no baselineSource
// key on facial at all) resumes cleanly with the field simply absent/
// undefined, never throwing and never getting stripped.
describe('stores/assessmentStore — facial.baselineSource hydration (R3-T7)', () => {
  it('a baselineSource written via updateFacial round-trips through persist -> resume in a later session', () => {
    const store1 = useAssessmentStore()
    store1.startNew()
    store1.updateFacial({ ...confirmedFacial(), baselineSource: 'default' })
    store1.setStep(3)

    setActivePinia(createPinia())
    const store2 = useAssessmentStore()
    expect(store2.resume()).toBe(true)
    expect(store2.draft.facial.baselineSource).toBe('default')
  })

  it('a legacy draft with no baselineSource key on facial resumes cleanly with the field undefined, not stripped/thrown', () => {
    const legacyFacial = confirmedFacial() // no baselineSource key at all
    saveDraft({
      draft: { patient: { name: 'สมชาย', bed: '5A', datetime: '2026-08-24T09:00' }, facial: legacyFacial },
      step: 3,
      activeRecordId: null,
      stepSchema: 2,
    })

    const store = useAssessmentStore()
    expect(store.resume()).toBe(true)
    expect(store.step).toBe(3)
    expect(store.draft.facial.baselineSource).toBeUndefined()
    expect(store.draft.facial.total).toBe(0) // rest of the legacy shape still intact
  })
})

describe('stores/assessmentStore — update actions', () => {
  it('updatePatient/updateReported/updateFacial/updateNursing merge partials and persist', () => {
    const store = useAssessmentStore()
    store.startNew()

    store.updateReported({ painScore: 6, location: 'หลัง' })
    expect(store.draft.reported.painScore).toBe(6)
    expect(store.draft.reported.location).toBe('หลัง')

    store.updateFacial({ scores: { brow: 1, eyes: 1, noseCheek: 0, mouth: 1, overall: 1 }, total: 4 })
    expect(store.draft.facial.total).toBe(4)
    expect(store.draft.facial.scores.brow).toBe(1)

    store.updateNursing({ items: [{ key: 'position', label: 'จัดท่าให้สุขสบาย', checked: true }] })
    expect(store.draft.nursing.items).toHaveLength(1)

    const persisted = loadDraft()
    expect(persisted.draft.reported.painScore).toBe(6)
    expect(persisted.draft.facial.total).toBe(4)
  })
})

describe('stores/assessmentStore — finalize', () => {
  it('builds a record with severities, R7 nursing band from facial.total, saves it, and clears the draft', () => {
    const store = useAssessmentStore()
    store.startNew()
    store.updatePatient({ name: 'สมชาย', bed: '5A' })
    store.updateReported({ painScore: 8, location: 'หลัง', vitalsChanged: false, vitalsDetail: '' })
    store.updateFacial({
      scores: { brow: 1, eyes: 1, noseCheek: 0, mouth: 0, overall: 1 },
      total: 3,
      source: 'manual',
      proposed: null,
    })
    // finalize() is invoked from Step5Nursing in the real flow, so the
    // wizard is on step 5 at the moment of the call.
    store.setStep(5)

    const record = store.finalize()

    expect(record.id).toEqual(expect.any(String))
    expect(record.id.length).toBeGreaterThan(0)
    expect(record.createdAt).toEqual(expect.any(String))
    expect(record.status).toBe('awaiting-reassess')
    expect(record.reassess).toBeNull()

    // patient-reported pain (8) is severe; facial total (3) is mild — must not be conflated
    expect(record.result.reportedSeverity).toBe('severe')
    expect(record.result.faceSeverity).toBe('mild')

    // R7: nursing band is derived from facial.total, not from reported pain
    expect(record.nursing.band).toBe('mild')

    expect(loadRecords()[0]).toEqual(record)
    expect(loadDraft()).toBeNull()

    // R24: finalize() no longer force-resets step to 1 — every wizard entry
    // path sets step explicitly, so leaving it as-is avoids remounting the
    // camera-bearing Step 1 during the navigation-away teardown window.
    expect(store.step).toBe(5)
    expect(store.activeRecordId).toBeNull()

    // The entry-path guarantee: a subsequent startNew() is what actually
    // sends the wizard back to step 1 for the next assessment.
    store.startNew()
    expect(store.step).toBe(1)
  })

  it('a facial total of 0 yields a null nursing band (no-pain note path)', () => {
    const store = useAssessmentStore()
    store.startNew()
    store.updatePatient({ name: 'A', bed: '1' })
    store.updateReported({ painScore: 0, location: '', vitalsChanged: false, vitalsDetail: '' })
    store.updateFacial({
      scores: { brow: 0, eyes: 0, noseCheek: 0, mouth: 0, overall: 0 },
      total: 0,
      source: 'manual',
      proposed: null,
    })

    const record = store.finalize()
    expect(record.nursing.band).toBeNull()
  })
})

describe('stores/assessmentStore — reassessment', () => {
  it('startReassess loads the record id and jumps to step 6; completeReassess persists the outcome', () => {
    const store = useAssessmentStore()
    store.startNew()
    store.updatePatient({ name: 'สมหญิง', bed: '2B' })
    store.updateReported({ painScore: 7, location: '', vitalsChanged: false, vitalsDetail: '' })
    store.updateFacial({
      scores: { brow: 2, eyes: 2, noseCheek: 1, mouth: 2, overall: 2 },
      total: 9,
      source: 'manual',
      proposed: null,
    })
    const record = store.finalize()

    store.startReassess(record.id)
    expect(store.activeRecordId).toBe(record.id)
    expect(store.step).toBe(6)

    const updated = store.completeReassess({
      time: '14:30',
      painScore: 3,
      facialTotal: 2,
      outcome: 'ลดลง',
      overridden: false,
    })

    expect(updated.status).toBe('complete')
    expect(updated.reassess).toEqual({
      time: '14:30',
      painScore: 3,
      facialTotal: 2,
      outcome: 'ลดลง',
      overridden: false,
    })
    expect(loadRecords().find((r) => r.id === record.id).status).toBe('complete')
  })

  it('completeReassess clears the persisted draft state so a later resume() never lands in step 6 of a completed record', () => {
    const store = useAssessmentStore()
    store.startNew()
    store.updatePatient({ name: 'สมหญิง', bed: '2B' })
    store.updateReported({ painScore: 7, location: '', vitalsChanged: false, vitalsDetail: '' })
    store.updateFacial({
      scores: { brow: 2, eyes: 2, noseCheek: 1, mouth: 2, overall: 2 },
      total: 9,
      source: 'manual',
      proposed: null,
    })
    const record = store.finalize()

    store.startReassess(record.id)
    store.completeReassess({
      time: '14:30',
      painScore: 3,
      facialTotal: 2,
      outcome: 'ลดลง',
      overridden: false,
    })

    expect(loadDraft()).toBeNull()
    // R24: completeReassess() no longer force-resets step to 1 — it stays
    // at the step startReassess() put it on (6). The draft/activeRecordId
    // clearing above is what actually prevents a stale re-entry.
    expect(store.step).toBe(6)
    expect(store.activeRecordId).toBeNull()

    // A fresh session resuming afterwards must not land back in step 6.
    setActivePinia(createPinia())
    const store2 = useAssessmentStore()
    expect(store2.resume()).toBe(false)
  })
})
