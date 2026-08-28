// CSV/JSON export for assessment records. UTF-8 BOM so Thai opens correctly
// in Excel. downloadFile is a no-op when `document` is unavailable (test
// environment), so tests never touch the DOM. No Vue/pinia imports.

const BOM = '﻿'

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

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function vitalsColumn(reported) {
  if (!reported) return ''
  if (reported.vitalsChanged === true) {
    return reported.vitalsDetail ? `ใช่ ${reported.vitalsDetail}` : 'ใช่'
  }
  if (reported.vitalsChanged === false) return 'ไม่'
  return ''
}

function nursingItemsColumn(nursing) {
  if (!nursing || !Array.isArray(nursing.items)) return ''
  return nursing.items
    .filter((item) => item.checked)
    .map((item) => item.label)
    .join('; ')
}

function medicationColumn(nursing) {
  if (!nursing || !Array.isArray(nursing.items)) return ''
  const med = nursing.items.find((item) => item.key === 'medicate' && item.checked)
  return med?.detail ?? ''
}

function recordToRow(record) {
  const patient = record.patient ?? {}
  const reported = record.reported ?? {}
  const facial = record.facial ?? {}
  const scores = facial.scores ?? {}
  const result = record.result ?? {}
  const reassess = record.reassess ?? null

  return [
    patient.name,
    patient.bed,
    patient.datetime,
    reported.painScore,
    reported.location,
    vitalsColumn(reported),
    facial.total,
    scores.brow,
    scores.eyes,
    scores.noseCheek,
    scores.mouth,
    scores.overall,
    result.reportedSeverity,
    result.faceSeverity,
    nursingItemsColumn(record.nursing),
    medicationColumn(record.nursing),
    reassess?.time,
    reassess?.painScore,
    reassess?.facialTotal,
    reassess?.outcome,
    record.status,
  ]
}

/**
 * @param {Array<object>} records
 * @returns {string} BOM-prefixed, CRLF-delimited CSV text
 */
export function recordsToCsv(records) {
  const lines = [HEADER.map(csvEscape).join(',')]
  for (const record of records) {
    lines.push(recordToRow(record).map(csvEscape).join(','))
  }
  return BOM + lines.join('\r\n')
}

/**
 * @param {Array<object>} records
 * @returns {string} pretty-printed JSON
 */
export function recordsToJson(records) {
  return JSON.stringify(records, null, 2)
}

/**
 * Triggers a browser download via a Blob URL. Safe no-op outside a DOM
 * environment (e.g. under vitest's 'node' environment) so tests never touch
 * the DOM.
 * @param {string} filename
 * @param {string} content
 * @param {string} mime
 */
export function downloadFile(filename, content, mime) {
  if (typeof document === 'undefined') return

  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
