import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadRecords,
  saveRecord,
  updateRecord,
  deleteRecord,
  loadCalibration,
  saveCalibration,
  loadDraft,
  saveDraft,
  clearDraft,
} from '../../src/domain/repository.js'

const ASSESSMENTS_KEY = 'painface.assessments.v1'
const CALIBRATION_KEY = 'painface.calibration.v1'
const DRAFT_KEY = 'painface.draft.v1'

describe('domain/repository — records', () => {
  it('loadRecords returns [] when nothing is stored', () => {
    expect(loadRecords()).toEqual([])
  })

  it('saveRecord returns the record and persists it', () => {
    const rec = { id: 'r1', patient: { name: 'สมชาย' } }
    const result = saveRecord(rec)
    expect(result).toEqual(rec)
    expect(loadRecords()).toEqual([rec])
  })

  it('saveRecord unshifts — newest record is first', () => {
    saveRecord({ id: 'r1' })
    saveRecord({ id: 'r2' })
    saveRecord({ id: 'r3' })
    expect(loadRecords().map((r) => r.id)).toEqual(['r3', 'r2', 'r1'])
  })

  it('updateRecord shallow-merges a patch into the matching record and returns it', () => {
    saveRecord({ id: 'r1', status: 'awaiting-reassess', patient: { name: 'A' } })
    const updated = updateRecord('r1', { status: 'complete' })
    expect(updated).toEqual({ id: 'r1', status: 'complete', patient: { name: 'A' } })
    expect(loadRecords()[0]).toEqual({ id: 'r1', status: 'complete', patient: { name: 'A' } })
  })

  it('updateRecord returns null when the id does not exist', () => {
    saveRecord({ id: 'r1' })
    expect(updateRecord('missing', { status: 'complete' })).toBeNull()
  })

  it('deleteRecord removes the matching record', () => {
    saveRecord({ id: 'r1' })
    saveRecord({ id: 'r2' })
    deleteRecord('r1')
    expect(loadRecords().map((r) => r.id)).toEqual(['r2'])
  })

  it('corrupt JSON under the assessments key yields [] and never throws', () => {
    globalThis.localStorage.setItem(ASSESSMENTS_KEY, '{not valid json')
    expect(() => loadRecords()).not.toThrow()
    expect(loadRecords()).toEqual([])
  })
})

describe('domain/repository — calibration', () => {
  it('loadCalibration returns null when nothing is stored', () => {
    expect(loadCalibration()).toBeNull()
  })

  it('saveCalibration then loadCalibration round-trips {thresholds, samples}', () => {
    const cal = { thresholds: { brow: { a: 0.25, s: 0.5 } }, samples: [{ at: '2026-01-01' }] }
    saveCalibration(cal)
    expect(loadCalibration()).toEqual(cal)
  })

  it('corrupt JSON under the calibration key yields null and never throws', () => {
    globalThis.localStorage.setItem(CALIBRATION_KEY, 'not json{{')
    expect(() => loadCalibration()).not.toThrow()
    expect(loadCalibration()).toBeNull()
  })
})

describe('domain/repository — draft', () => {
  it('loadDraft returns null when nothing is stored', () => {
    expect(loadDraft()).toBeNull()
  })

  it('saveDraft then loadDraft round-trips the draft object', () => {
    const draft = { patient: { name: 'สมหญิง', bed: '5A' }, step: 2 }
    saveDraft(draft)
    expect(loadDraft()).toEqual(draft)
  })

  it('clearDraft removes the stored draft', () => {
    saveDraft({ step: 1 })
    clearDraft()
    expect(loadDraft()).toBeNull()
  })

  it('corrupt JSON under the draft key yields null and never throws', () => {
    globalThis.localStorage.setItem(DRAFT_KEY, '{{{')
    expect(() => loadDraft()).not.toThrow()
    expect(loadDraft()).toBeNull()
  })
})
