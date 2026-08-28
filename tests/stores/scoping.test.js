// Pins spec §8, the no-leak scoping core: recordsStore.visibleRecords()
// both directions, scoped export content, and the assessmentStore
// finalize()/completeReassess() patientId stamping + sync-enqueue wiring
// that feeds it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useRecordsStore } from '../../src/stores/recordsStore.js'
import { useAssessmentStore } from '../../src/stores/assessmentStore.js'
import { usePatientStore } from '../../src/stores/patientStore.js'
import { useSyncStore } from '../../src/stores/syncStore.js'
import { saveRecord, saveDraft, updateRecord } from '../../src/domain/repository.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

function fakeRecord(id, patientId, overrides = {}) {
  return {
    id,
    createdAt: '2026-08-25T10:00:00.000Z',
    patientId: patientId ?? null,
    synced: false,
    patient: { name: `ผู้ป่วย ${id}`, bed: '1A', datetime: '2026-08-25T10:00' },
    reported: { painScore: 5, location: '', vitalsChanged: false, vitalsDetail: '' },
    facial: {
      scores: { brow: 1, eyes: 1, noseCheek: 1, mouth: 1, overall: 1 },
      total: 5,
      source: 'manual',
      proposed: null,
    },
    result: { reportedSeverity: 'moderate', faceSeverity: 'moderate' },
    nursing: { band: 'moderate', items: [] },
    reassess: null,
    status: 'awaiting-reassess',
    ...overrides,
  }
}

/** Pre-existing record with no patientId field at all (spec §8/§9: absent counts as null). */
function legacyRecord(id) {
  const record = fakeRecord(id, null)
  delete record.patientId
  return record
}

describe('recordsStore.visibleRecords — the §8 no-leak visibility filter', () => {
  it("linked to A: shows only A's local records — B's and legacy(null) records are hidden", () => {
    saveRecord(fakeRecord('a1', 'A'))
    saveRecord(fakeRecord('b1', 'B'))
    saveRecord(legacyRecord('n1'))
    const store = useRecordsStore()
    store.load()

    expect(store.visibleRecords('A').map((r) => r.id)).toEqual(['a1'])
  })

  it('unlinked (contextId null): shows only legacy/null records — every patient-owned record is hidden', () => {
    saveRecord(fakeRecord('a1', 'A'))
    saveRecord(fakeRecord('b1', 'B'))
    saveRecord(legacyRecord('n1'))
    const store = useRecordsStore()
    store.load()

    expect(store.visibleRecords(null).map((r) => r.id)).toEqual(['n1'])
  })

  it('sorts the visible list newest-first by createdAt', () => {
    saveRecord(fakeRecord('a1', 'A', { createdAt: '2026-08-20T09:00:00.000Z' }))
    saveRecord(fakeRecord('a2', 'A', { createdAt: '2026-08-25T09:00:00.000Z' }))
    const store = useRecordsStore()
    store.load()

    expect(store.visibleRecords('A').map((r) => r.id)).toEqual(['a2', 'a1'])
  })

  it('linked mode merges server-only records, flags them serverOnly, and the local copy always wins on an id collision', () => {
    saveRecord(fakeRecord('a1', 'A'))
    const store = useRecordsStore()
    store.load()

    const syncStore = useSyncStore()
    syncStore.serverRecords = [
      { id: 'a1', patientId: 'A', createdAt: '2026-08-01T00:00:00.000Z', patient: { name: 'stale-server-copy' } },
      { id: 'a2', patientId: 'A', createdAt: '2026-08-26T00:00:00.000Z', patient: { name: 'server-only' } },
    ]

    const visible = store.visibleRecords('A')
    expect(visible.map((r) => r.id).sort()).toEqual(['a1', 'a2'])

    const local = visible.find((r) => r.id === 'a1')
    const serverOnly = visible.find((r) => r.id === 'a2')
    expect(local.patient.name).toBe('ผู้ป่วย a1') // local wins, not the stale server copy
    expect(local.serverOnly).toBeUndefined()
    expect(serverOnly.serverOnly).toBe(true)
  })

  it('never merges server records when unlinked, even if serverRecords happens to be populated', () => {
    saveRecord(legacyRecord('n1'))
    const store = useRecordsStore()
    store.load()

    const syncStore = useSyncStore()
    syncStore.serverRecords = [{ id: 'leaked', patientId: 'A', createdAt: '2026-08-26T00:00:00.000Z' }]

    expect(store.visibleRecords(null).map((r) => r.id)).toEqual(['n1'])
  })
})

describe('recordsStore.visibleRecords — review round 1 BLOCKER 1(b): stale/foreign serverRecords never leak by patientId', () => {
  it("the reviewer's exact probe: A's rows present in syncStore.serverRecords while contextId is 'B' -> visibleRecords('B') is empty and exportJson('B') is free of them", () => {
    const store = useRecordsStore()
    store.load() // no local records at all

    const syncStore = useSyncStore()
    syncStore.serverRecords = [
      { id: 'a1', patientId: 'A', createdAt: '2026-08-20T00:00:00.000Z', patient: { name: 'ผู้ป่วย a1' } },
      { id: 'a2', patientId: 'A', createdAt: '2026-08-21T00:00:00.000Z', patient: { name: 'ผู้ป่วย a2' } },
    ]

    expect(store.visibleRecords('B')).toEqual([])

    const exported = JSON.parse(store.exportJson('B'))
    expect(exported).toEqual([])
  })

  it("A's server-only rows are excluded from B's context even alongside B's OWN local/server records", () => {
    saveRecord(fakeRecord('b-local', 'B'))
    const store = useRecordsStore()
    store.load()

    const syncStore = useSyncStore()
    syncStore.serverRecords = [
      { id: 'a1', patientId: 'A', createdAt: '2026-08-20T00:00:00.000Z' },
      { id: 'b-server-only', patientId: 'B', createdAt: '2026-08-21T00:00:00.000Z' },
    ]

    const visible = store.visibleRecords('B')
    expect(visible.map((r) => r.id).sort()).toEqual(['b-local', 'b-server-only'])
    expect(visible.some((r) => r.patientId === 'A')).toBe(false)
  })

  it('a server record with no patientId field (legacy/malformed) never leaks into a linked context either', () => {
    const store = useRecordsStore()
    store.load()

    const syncStore = useSyncStore()
    syncStore.serverRecords = [{ id: 'orphan', createdAt: '2026-08-20T00:00:00.000Z' }] // no patientId at all

    expect(store.visibleRecords('A')).toEqual([])
  })
})

describe('recordsStore.exportCsv / exportJson — export exactly the visible scoped list', () => {
  it('an A-linked export contains no B or legacy(null) rows', () => {
    saveRecord(fakeRecord('a1', 'A'))
    saveRecord(fakeRecord('b1', 'B'))
    saveRecord(legacyRecord('n1'))
    const store = useRecordsStore()
    store.load()

    expect(JSON.parse(store.exportJson('A')).map((r) => r.id)).toEqual(['a1'])

    const csv = store.exportCsv('A')
    expect(csv).toContain('ผู้ป่วย a1')
    expect(csv).not.toContain('ผู้ป่วย b1')
  })

  it('an unlinked export contains only legacy(null) rows', () => {
    saveRecord(fakeRecord('a1', 'A'))
    saveRecord(legacyRecord('n1'))
    const store = useRecordsStore()
    store.load()

    expect(JSON.parse(store.exportJson(null)).map((r) => r.id)).toEqual(['n1'])
    const csv = store.exportCsv(null)
    expect(csv).toContain('ผู้ป่วย n1')
    expect(csv).not.toContain('ผู้ป่วย a1')
  })

  // Fix round MAJOR 2: RecordsView now surfaces a "ไม่ได้ผูกกับผู้ป่วยรายใด"
  // navigation-only group of stranded (patientId:null) local records while
  // linked, so a nurse can still reach the rescue action after leaving the
  // detail view. That group must NEVER widen what gets exported — exports
  // stay exactly the active context's visibleRecords() list, unchanged from
  // every test above. This pins that explicitly: a stranded record showing
  // up in the UI's stranded group is still absent from a linked export.
  it('a linked export excludes stranded (patientId:null) records even though RecordsView now lists them in a separate navigation-only group', () => {
    saveRecord(fakeRecord('a1', 'A'))
    saveRecord(legacyRecord('n1')) // stranded while linked to A
    const store = useRecordsStore()
    store.load()

    expect(JSON.parse(store.exportJson('A')).map((r) => r.id)).toEqual(['a1'])
    const csv = store.exportCsv('A')
    expect(csv).not.toContain('ผู้ป่วย n1')
  })
})

describe('assessmentStore.finalize — patientId stamping (spec §8/§9)', () => {
  it('stamps the active patient id (and synced:false) when linked', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })

    const store = useAssessmentStore()
    store.startNew()
    store.updatePatient({ name: 'สมชาย', bed: '5A' })
    const record = store.finalize()

    expect(record.patientId).toBe('A')
    expect(record.synced).toBe(false)
  })

  it('stamps null when unlinked — the record is local-only forever', () => {
    const store = useAssessmentStore()
    store.startNew()
    store.updatePatient({ name: 'สมชาย', bed: '5A' })
    const record = store.finalize()

    expect(record.patientId).toBeNull()
  })

  it('enqueues the finalized record via syncStore when linked', () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })
    const syncStore = useSyncStore()
    const enqueueSpy = vi.spyOn(syncStore, 'enqueueRecord').mockResolvedValue(undefined)

    const store = useAssessmentStore()
    store.startNew()
    const record = store.finalize()

    expect(enqueueSpy).toHaveBeenCalledWith({ patientId: 'A', token: 'tok-a' }, record)
  })

  it('never enqueues when unlinked', () => {
    const syncStore = useSyncStore()
    const enqueueSpy = vi.spyOn(syncStore, 'enqueueRecord').mockResolvedValue(undefined)

    const store = useAssessmentStore()
    store.startNew()
    store.finalize()

    expect(enqueueSpy).not.toHaveBeenCalled()
  })
})

// Plan Task 5 / spec §6, ruling R37 (amends R36): a draft begun while
// UNLINKED is stamped patientId:null at startNew() time and is NEVER
// silently reattributed. But a nurse who links AFTER starting the draft can
// now EXPLICITLY choose, at finalize() time, to adopt the current patient —
// finalize({adoptCurrentPatient:true}) stamps patientStore.patientId ONLY
// when linked AND draftPatientId is still null; it can never re-attribute a
// draft already stamped (own patient OR a different one).
describe('assessmentStore.finalize — adoptCurrentPatient (ruling R37, amends R36)', () => {
  it('adopts the current patient id when linked and the draft started unlinked (draftPatientId null), then enqueues it', () => {
    const store = useAssessmentStore()
    store.startNew() // unlinked -> draftPatientId: null
    store.updatePatient({ name: 'สมชาย', bed: '5A' })

    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' }) // links AFTER the draft started

    const syncStore = useSyncStore()
    const enqueueSpy = vi.spyOn(syncStore, 'enqueueRecord').mockResolvedValue(undefined)

    const record = store.finalize({ adoptCurrentPatient: true })

    expect(record.patientId).toBe('A')
    expect(enqueueSpy).toHaveBeenCalledWith({ patientId: 'A', token: 'tok-a' }, record)
  })

  it('ignores adoptCurrentPatient when the draft already has a stamped patientId — never re-attributes', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store = useAssessmentStore()
    store.startNew() // draftPatientId: 'A'

    usePatientStore().setContext({ patientId: 'B', token: 'tok-b' }) // relinked to someone else before finalize

    const record = store.finalize({ adoptCurrentPatient: true })

    expect(record.patientId).toBe('A') // never re-attributed to B
  })

  it('ignores adoptCurrentPatient when unlinked — nothing to adopt into', () => {
    const store = useAssessmentStore()
    store.startNew() // unlinked -> draftPatientId: null

    const syncStore = useSyncStore()
    const enqueueSpy = vi.spyOn(syncStore, 'enqueueRecord').mockResolvedValue(undefined)

    const record = store.finalize({ adoptCurrentPatient: true })

    expect(record.patientId).toBeNull()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })
})

// Plan Task 5 / spec §6, ruling R37b: the rescue action (RecordDetailView.vue)
// attributes a stranded LOCAL record (patientId:null) to the currently
// linked patient by calling repository.updateRecord + syncStore.enqueueRecord
// directly — no new store method backs it. This test pins the underlying
// visibility-filter flip the rescue button's click handler relies on.
//
// Fix round MAJOR 3(a): the previous version of this test only linked to A
// right BEFORE calling updateRecord, so it never actually asserted the
// state the rescue button needs to render FROM — a device already linked to
// A, BEFORE rescue, with visibleRecords('A') still excluding the stranded
// record. Asserting that first is what makes this a real pre/post flip
// instead of a single post-hoc snapshot. The end-to-end button-click ->
// repository-write -> syncStore.enqueueRecord-with-the-updated-record wiring
// itself is now covered by a real component mount in
// tests/ui/recordDetailView.test.js (replacing the old test here that just
// re-invoked syncStore.enqueueRecord by hand — tautological, since it never
// exercised RecordDetailView's own click handler at all).
describe('Rescue (ruling R37b) — visibility flips from the unlinked view into the patient view', () => {
  it("while ALREADY linked to A, the stranded record is excluded from visibleRecords('A') and present in visibleRecords(null) BEFORE rescue; both flip AFTER repository.updateRecord attributes it", () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    saveRecord(fakeRecord('r1', null)) // stranded local-only record
    const recordsStore = useRecordsStore()
    recordsStore.load()

    // Pre-rescue, while linked: this is the exact state the rescue button
    // must be reachable from — not merely "unlinked, then later linked".
    expect(recordsStore.visibleRecords('A').map((r) => r.id)).not.toContain('r1')
    expect(recordsStore.visibleRecords(null).map((r) => r.id)).toContain('r1')

    updateRecord('r1', { patientId: 'A' })
    recordsStore.load()

    // Post-rescue: flipped.
    expect(recordsStore.visibleRecords('A').map((r) => r.id)).toContain('r1')
    expect(recordsStore.visibleRecords(null).map((r) => r.id)).not.toContain('r1')
  })
})

describe('assessmentStore.completeReassess — re-enqueues the full updated record', () => {
  it('re-enqueues the full updated record when linked', () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })
    const syncStore = useSyncStore()
    const enqueueSpy = vi.spyOn(syncStore, 'enqueueRecord').mockResolvedValue(undefined)

    const store = useAssessmentStore()
    store.startNew()
    const record = store.finalize()
    enqueueSpy.mockClear() // isolate from finalize()'s own enqueue call

    store.startReassess(record.id)
    const updated = store.completeReassess({
      time: '14:30',
      painScore: 3,
      facialTotal: 2,
      outcome: 'ลดลง',
      overridden: false,
    })

    expect(updated.status).toBe('complete')
    expect(enqueueSpy).toHaveBeenCalledWith({ patientId: 'A', token: 'tok-a' }, updated)
  })

  it('never re-enqueues a record created unlinked, even if the device later links to a patient', () => {
    const store = useAssessmentStore()
    store.startNew()
    const record = store.finalize() // created unlinked -> patientId: null, permanent (spec §9)

    // Device links to a patient AFTER the record already exists.
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })
    const syncStore = useSyncStore()
    const enqueueSpy = vi.spyOn(syncStore, 'enqueueRecord').mockResolvedValue(undefined)

    store.startReassess(record.id)
    store.completeReassess({ time: '14:30', painScore: 3, facialTotal: 2, outcome: 'ลดลง', overridden: false })

    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('never re-enqueues when the record belongs to a DIFFERENT patient than the one currently linked', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store = useAssessmentStore()
    store.startNew()
    const record = store.finalize() // patientId: 'A'

    // Device is now linked to a DIFFERENT patient (e.g. handed off/relinked).
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'B', token: 'tok-b' })
    const syncStore = useSyncStore()
    const enqueueSpy = vi.spyOn(syncStore, 'enqueueRecord').mockResolvedValue(undefined)

    // review round 1 BLOCKER 2 strengthens this further upstream: startReassess()
    // itself now refuses (activeRecordId stays null) for a foreign-patient
    // record, so completeReassess() below can't even find/mutate it.
    store.startReassess(record.id)
    expect(store.activeRecordId).toBeNull()

    const updated = store.completeReassess({ time: '14:30', painScore: 3, facialTotal: 2, outcome: 'ลดลง', overridden: false })

    expect(updated).toBeNull() // nothing to update: activeRecordId was refused to null
    expect(enqueueSpy).not.toHaveBeenCalled()
  })
})

describe('assessmentStore.startReassess — scoping (spec §8, review round 1 BLOCKER 2)', () => {
  it('refuses (activeRecordId stays null) a foreign record id under a DIFFERENT currently-linked patient', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store = useAssessmentStore()
    store.startNew()
    const record = store.finalize() // patientId: 'A'

    usePatientStore().setContext({ patientId: 'B', token: 'tok-b' })
    store.startReassess(record.id)

    expect(store.activeRecordId).toBeNull()
    expect(store.step).toBe(6) // Step6Reassess still mounts and renders "ไม่พบข้อมูล..."
  })

  it('still works for a record matching the currently linked patient', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store = useAssessmentStore()
    store.startNew()
    const record = store.finalize()

    store.startReassess(record.id)

    expect(store.activeRecordId).toBe(record.id)
    expect(store.step).toBe(6)
  })

  it('still works for a local(null) record while unlinked', () => {
    const store = useAssessmentStore()
    store.startNew()
    const record = store.finalize() // patientId: null

    store.startReassess(record.id)

    expect(store.activeRecordId).toBe(record.id)
  })

  it('refuses a local(null) record once the device becomes linked (it must stay local-only forever)', () => {
    const store = useAssessmentStore()
    store.startNew()
    const record = store.finalize() // patientId: null

    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    store.startReassess(record.id)

    expect(store.activeRecordId).toBeNull()
  })

  it('a nonexistent record id while unlinked is unaffected by the scoping guard (record?.patientId??null === null trivially) — the "not found" UI still comes from Step6Reassess\'s own separate lookup, unchanged from before this fix', () => {
    const store = useAssessmentStore()
    store.startReassess('no-such-id')

    expect(store.activeRecordId).toBe('no-such-id')
    expect(store.step).toBe(6)
  })

  it('a nonexistent record id while LINKED is refused (no record can match a real patient id)', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store = useAssessmentStore()
    store.startReassess('no-such-id')

    expect(store.activeRecordId).toBeNull()
  })
})

describe('assessmentStore.resume — reassess gate re-check (review round 2 BLOCKER 2b, probe-proven)', () => {
  it('an abandoned step-6 draft naming a record now foreign to the live context refuses on resume: activeRecordId null AND step clamped to 1', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store1 = useAssessmentStore()
    store1.startNew()
    const record = store1.finalize() // patientId: 'A'
    store1.startReassess(record.id) // activeRecordId=record.id, step=6, persisted -- then abandoned

    // Device gets rescanned to B before the reassess was ever completed.
    setActivePinia(createPinia())
    usePatientStore().setContext({ patientId: 'B', token: 'tok-b' })
    const store2 = useAssessmentStore()
    expect(store2.resume()).toBe(true)

    expect(store2.activeRecordId).toBeNull()
    expect(store2.step).toBe(1) // never strand the nurse on the "ไม่พบข้อมูล" panel
  })

  it('the SAME persisted draft resumes normally under the record\'s own (A) context: step 6 with the id intact', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store1 = useAssessmentStore()
    store1.startNew()
    const record = store1.finalize()
    store1.startReassess(record.id)

    setActivePinia(createPinia())
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' }) // same patient, a later "session"
    const store2 = useAssessmentStore()
    expect(store2.resume()).toBe(true)

    expect(store2.activeRecordId).toBe(record.id)
    expect(store2.step).toBe(6)
  })

  it('an abandoned step-6 draft resumed while UNLINKED (a record scoped to A is foreign to null too) is refused the same way', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store1 = useAssessmentStore()
    store1.startNew()
    const record = store1.finalize()
    store1.startReassess(record.id)

    setActivePinia(createPinia())
    usePatientStore().clear() // explicit ออกจากผู้ป่วย -> unlinked (patientStore otherwise
    // persists to real localStorage, so a fresh pinia container alone would
    // just rehydrate the SAME 'A' context, not exercise the unlinked case)
    const store2 = useAssessmentStore()
    expect(store2.resume()).toBe(true)

    expect(store2.activeRecordId).toBeNull()
    expect(store2.step).toBe(1)
  })

  it("R22's own clamp (steps 2-5 without a confirmed facial score) is untouched by this fix", () => {
    const store1 = useAssessmentStore()
    store1.startNew()
    store1.setStep(4) // raw setStep bypasses the wizard's own gates; facial.source stays null

    setActivePinia(createPinia())
    const store2 = useAssessmentStore()
    expect(store2.resume()).toBe(true)

    expect(store2.step).toBe(1) // R22's clamp, unrelated to activeRecordId entirely
    expect(store2.activeRecordId).toBeNull()
  })
})

describe('assessmentStore.finalize — draft attribution across a context switch (review round 1 MAJOR 4)', () => {
  it('a draft begun under A stays attributed to A even if the context switches to B before finalize()', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store = useAssessmentStore()
    store.startNew() // stamps draftPatientId: 'A'
    store.updatePatient({ name: 'สมชาย', bed: '5A' })

    usePatientStore().setContext({ patientId: 'B', token: 'tok-b' }) // mid-draft context switch

    const syncStore = useSyncStore()
    const enqueueSpy = vi.spyOn(syncStore, 'enqueueRecord').mockResolvedValue(undefined)

    const record = store.finalize()

    expect(record.patientId).toBe('A') // attributed to its TRUE patient, not the live context
    expect(enqueueSpy).not.toHaveBeenCalled() // B's token must never write a row stamped A
  })

  it('a fresh draft started under B (after the switch) is correctly attributed to B and enqueued', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store = useAssessmentStore()
    store.startNew()
    store.updatePatient({ name: 'สมชาย', bed: '5A' })

    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'B', token: 'tok-b' })
    store.startNew() // a NEW draft, re-stamped from the NOW-current context

    const syncStore = useSyncStore()
    const enqueueSpy = vi.spyOn(syncStore, 'enqueueRecord').mockResolvedValue(undefined)

    const record = store.finalize()

    expect(record.patientId).toBe('B')
    expect(enqueueSpy).toHaveBeenCalledWith({ patientId: 'B', token: 'tok-b' }, record)
  })

  it('resume() restores draftPatientId from the PERSISTED draft, not the live context at resume time', () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    const store1 = useAssessmentStore()
    store1.startNew()
    store1.updatePatient({ name: 'สมชาย', bed: '5A' })

    setActivePinia(createPinia()) // simulate a fresh session (new pinia container)
    usePatientStore().setContext({ patientId: 'B', token: 'tok-b' }) // different context this "session"
    const store2 = useAssessmentStore()
    expect(store2.resume()).toBe(true)

    const record = store2.finalize()
    expect(record.patientId).toBe('A')
  })

  it('a legacy persisted draft with no draftPatientId stamp resumes as null (local-only) — never guessed', () => {
    saveDraft({
      draft: {
        patient: { name: 'สมชาย', bed: '5A', datetime: '2026-08-25T09:00' },
        reported: { painScore: null, location: '', vitalsChanged: null, vitalsDetail: '' },
        facial: {
          scores: { brow: 0, eyes: 0, noseCheek: 0, mouth: 0, overall: 0 },
          total: 0,
          source: 'manual',
          proposed: null,
        },
        result: { reportedSeverity: null, faceSeverity: null },
        nursing: { band: null, items: [] },
        reassess: null,
      },
      step: 2,
      activeRecordId: null,
      stepSchema: 2,
      // no draftPatientId key at all — simulates a draft saved before this field existed.
    })

    const store = useAssessmentStore()
    expect(store.resume()).toBe(true)
    expect(store.draftPatientId).toBeNull()
  })
})
