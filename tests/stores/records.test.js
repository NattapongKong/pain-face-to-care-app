import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useRecordsStore } from '../../src/stores/recordsStore.js'
import { saveRecord } from '../../src/domain/repository.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

function fakeRecord(id) {
  return {
    id,
    createdAt: '2026-08-24T10:00:00.000Z',
    patient: { name: `ผู้ป่วย ${id}`, bed: '1A', datetime: '2026-08-24T10:00' },
    reported: { painScore: 5, location: '', vitalsChanged: false, vitalsDetail: '' },
    facial: { scores: { brow: 1, eyes: 1, noseCheek: 1, mouth: 1, overall: 1 }, total: 5, source: 'manual', proposed: null },
    result: { reportedSeverity: 'moderate', faceSeverity: 'moderate' },
    nursing: { band: 'moderate', items: [] },
    reassess: null,
    status: 'awaiting-reassess',
  }
}

describe('stores/recordsStore — load / get / remove', () => {
  it('load() populates records from the repository', () => {
    saveRecord(fakeRecord('r1'))
    saveRecord(fakeRecord('r2'))

    const store = useRecordsStore()
    store.load()
    expect(store.records.map((r) => r.id)).toEqual(['r2', 'r1'])
  })

  it('get(id) returns the matching loaded record', () => {
    saveRecord(fakeRecord('r1'))
    const store = useRecordsStore()
    store.load()
    expect(store.get('r1').id).toBe('r1')
    expect(store.get('missing')).toBeNull()
  })

  it('remove(id) deletes from the repository and refreshes state', () => {
    saveRecord(fakeRecord('r1'))
    saveRecord(fakeRecord('r2'))
    const store = useRecordsStore()
    store.load()
    store.remove('r1')
    expect(store.records.map((r) => r.id)).toEqual(['r2'])
  })
})

describe('stores/recordsStore — export', () => {
  it('exportCsv() returns BOM-prefixed CSV text and does not throw without document', () => {
    saveRecord(fakeRecord('r1'))
    const store = useRecordsStore()
    store.load()
    const csv = store.exportCsv()
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('ผู้ป่วย r1')
  })

  it('exportJson() returns JSON text that parses back to the loaded records', () => {
    saveRecord(fakeRecord('r1'))
    const store = useRecordsStore()
    store.load()
    const json = store.exportJson()
    expect(JSON.parse(json)).toEqual(store.records)
  })
})
