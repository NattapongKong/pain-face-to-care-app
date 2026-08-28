import { describe, it, expect } from 'vitest'
import { computeOutcome } from '../../src/domain/outcome.js'

describe('domain/outcome — computeOutcome', () => {
  it('returns ลดลง when post < pre', () => {
    expect(computeOutcome(8, 3)).toBe('ลดลง')
  })

  it('returns เท่าเดิม when post === pre', () => {
    expect(computeOutcome(5, 5)).toBe('เท่าเดิม')
  })

  it('returns เพิ่มขึ้น when post > pre', () => {
    expect(computeOutcome(2, 6)).toBe('เพิ่มขึ้น')
  })
})
