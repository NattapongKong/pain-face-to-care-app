// Pure severity-band logic shared by patient-reported pain and the Face Pain
// Scale total. No Vue/pinia imports.

/**
 * @param {number|null|undefined} score - 0-10
 * @returns {null|'mild'|'moderate'|'severe'}
 */
export function severityBand(score) {
  if (score === null || score === undefined) return null
  if (score === 0) return null
  if (score >= 1 && score <= 3) return 'mild'
  if (score >= 4 && score <= 6) return 'moderate'
  if (score >= 7 && score <= 10) return 'severe'
  return null
}

export const SEVERITY_META = {
  mild: { label: 'ปวดน้อย', range: '1–3', tone: 'success' },
  moderate: { label: 'ปวดปานกลาง', range: '4–6', tone: 'warning' },
  severe: { label: 'ปวดมาก', range: '7–10', tone: 'error' },
}
