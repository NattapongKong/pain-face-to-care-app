// Pure reassessment-outcome logic. No Vue/pinia imports.

/**
 * Auto-computed outcome comparing pre/post patient-reported pain scores.
 * @param {number} pre
 * @param {number} post
 * @returns {'ลดลง'|'เท่าเดิม'|'เพิ่มขึ้น'}
 */
export function computeOutcome(pre, post) {
  if (post < pre) return 'ลดลง'
  if (post === pre) return 'เท่าเดิม'
  return 'เพิ่มขึ้น'
}
