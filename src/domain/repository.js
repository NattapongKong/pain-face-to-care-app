// Pure localStorage-backed persistence for the PAIN FACE to Care app.
// No Vue / pinia imports — this module is the single seam that would be
// swapped for an API client if multi-device sync is ever needed.

const ASSESSMENTS_KEY = 'painface.assessments.v1'
const CALIBRATION_KEY = 'painface.calibration.v1'
const DRAFT_KEY = 'painface.draft.v1'

function readJson(key, fallback) {
  const raw = globalThis.localStorage.getItem(key)
  if (raw === null || raw === undefined) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  globalThis.localStorage.setItem(key, JSON.stringify(value))
}

// --- Records -----------------------------------------------------------

export function loadRecords() {
  const records = readJson(ASSESSMENTS_KEY, [])
  return Array.isArray(records) ? records : []
}

export function saveRecord(record) {
  const records = loadRecords()
  records.unshift(record)
  writeJson(ASSESSMENTS_KEY, records)
  return record
}

export function updateRecord(id, patch) {
  const records = loadRecords()
  const index = records.findIndex((r) => r.id === id)
  if (index === -1) return null
  const updated = { ...records[index], ...patch }
  records[index] = updated
  writeJson(ASSESSMENTS_KEY, records)
  return updated
}

export function deleteRecord(id) {
  const records = loadRecords().filter((r) => r.id !== id)
  writeJson(ASSESSMENTS_KEY, records)
}

// --- Calibration ---------------------------------------------------------

export function loadCalibration() {
  return readJson(CALIBRATION_KEY, null)
}

export function saveCalibration(calibration) {
  writeJson(CALIBRATION_KEY, calibration)
}

// --- Draft ---------------------------------------------------------------

export function loadDraft() {
  return readJson(DRAFT_KEY, null)
}

export function saveDraft(draft) {
  writeJson(DRAFT_KEY, draft)
}

export function clearDraft() {
  globalThis.localStorage.removeItem(DRAFT_KEY)
}
