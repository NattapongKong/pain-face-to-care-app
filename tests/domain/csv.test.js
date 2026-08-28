import { describe, it, expect } from 'vitest'
import { recordsToCsv, recordsToJson, downloadFile } from '../../src/domain/csv.js'

const HEADER = [
  'ชื่อผู้ป่วย',
  'เตียง',
  'วันที่/เวลา',
  'Pain Score',
  'ตำแหน่ง',
  'สัญญาณชีพ',
  'Face Pain Scale',
  'คิ้ว',
  'ตา',
  'จมูก/แก้ม',
  'ปาก',
  'โดยรวม',
  'ระดับ(ผู้ป่วย)',
  'ระดับ(สีหน้า)',
  'การพยาบาล(เลือก)',
  'ยา',
  'เวลาประเมินซ้ำ',
  'Pain หลัง',
  'Face หลัง',
  'ผลลัพธ์',
  'สถานะ',
]

function sampleRecord(overrides = {}) {
  return {
    id: 'r1',
    createdAt: '2026-08-24T10:00:00.000Z',
    patient: { name: 'สมชาย ใจดี', bed: '5A', datetime: '2026-08-24T10:00' },
    reported: { painScore: 6, location: 'หลัง', vitalsChanged: false, vitalsDetail: '' },
    facial: { scores: { brow: 1, eyes: 2, noseCheek: 1, mouth: 1, overall: 1 }, total: 6, source: 'manual', proposed: null },
    result: { reportedSeverity: 'moderate', faceSeverity: 'moderate' },
    nursing: {
      band: 'moderate',
      items: [
        { key: 'position', label: 'จัดท่าให้สุขสบาย', checked: true },
        { key: 'medicate', label: 'ให้ยาตามแผนการรักษา', checked: true, detail: 'paracetamol 500mg' },
      ],
    },
    reassess: null,
    status: 'awaiting-reassess',
    ...overrides,
  }
}

describe('domain/csv — recordsToCsv', () => {
  it('starts with a UTF-8 BOM', () => {
    const csv = recordsToCsv([sampleRecord()])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
  })

  it('header row matches the required Thai columns', () => {
    const csv = recordsToCsv([sampleRecord()])
    const withoutBom = csv.replace(/^﻿/, '')
    const firstLine = withoutBom.split(/\r\n|\n/)[0]
    expect(firstLine.split(',')).toEqual(HEADER)
  })

  it('one record produces exactly one data row with matching column count', () => {
    const csv = recordsToCsv([sampleRecord()])
    const lines = csv.replace(/^﻿/, '').split(/\r\n|\n/).filter(Boolean)
    expect(lines).toHaveLength(2)
  })

  it('header and data row have the same column count (comma/newline-free record)', () => {
    const csv = recordsToCsv([sampleRecord()])
    const lines = csv.replace(/^﻿/, '').split(/\r\n|\n/).filter(Boolean)
    expect(lines[0].split(',')).toHaveLength(HEADER.length)
    expect(lines[1].split(',')).toHaveLength(HEADER.length)
  })

  it('escapes values containing commas, quotes, and newlines', () => {
    const rec = sampleRecord({ reported: { painScore: 6, location: 'หลัง, สะโพก "ซ้าย"\nและขา', vitalsChanged: false, vitalsDetail: '' } })
    const csv = recordsToCsv([rec]).replace(/^﻿/, '')
    expect(csv).toContain('"หลัง, สะโพก ""ซ้าย""\nและขา"')
  })

  it('empty records array still yields just the header line', () => {
    const csv = recordsToCsv([])
    const lines = csv.replace(/^﻿/, '').split(/\r\n|\n/).filter(Boolean)
    expect(lines).toHaveLength(1)
  })

  it('vitalsChanged: false renders "ไม่"; null/undefined render an empty cell (not "ไม่")', () => {
    const explicitFalse = sampleRecord({ reported: { painScore: 6, location: 'หลัง', vitalsChanged: false, vitalsDetail: '' } })
    const withNull = sampleRecord({ reported: { painScore: 6, location: 'หลัง', vitalsChanged: null, vitalsDetail: '' } })
    const withUndefined = sampleRecord({ reported: { painScore: 6, location: 'หลัง' } })

    const rowOf = (rec) => recordsToCsv([rec]).replace(/^﻿/, '').split(/\r\n|\n/).filter(Boolean)[1]

    expect(rowOf(explicitFalse).split(',')).toContain('ไม่')
    // vitalsChanged is the 6th column (index 5); confirm it's the empty string, not 'ไม่'.
    expect(rowOf(withNull).split(',')[5]).toBe('')
    expect(rowOf(withUndefined).split(',')[5]).toBe('')
  })
})

describe('domain/csv — recordsToJson', () => {
  it('round-trips records through JSON.parse', () => {
    const rec = sampleRecord()
    const json = recordsToJson([rec])
    expect(JSON.parse(json)).toEqual([rec])
  })
})

describe('domain/csv — downloadFile', () => {
  it('no-ops safely when document is undefined', () => {
    expect(typeof document).toBe('undefined')
    expect(() => downloadFile('test.csv', 'a,b,c', 'text/csv')).not.toThrow()
  })
})
