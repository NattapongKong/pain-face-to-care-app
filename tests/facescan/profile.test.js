import { describe, it, expect } from 'vitest'
import { buildProfile, pAbove } from '../../src/facescan/profile.js'

describe('facescan/profile — buildProfile', () => {
  it('11 evenly-spaced integer values → deciles equal the sorted series exactly, mean = middle value', () => {
    const series = [7, 3, 1, 9, 5, 11, 2, 4, 10, 6, 8] // 1..11 shuffled
    const { deciles, mean } = buildProfile(series)
    expect(deciles).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(mean).toBe(6)
  })

  it('5 values spanning 0..40 → deciles via linear interpolation (known exact values)', () => {
    const series = [40, 0, 20, 10, 30]
    const { deciles, mean } = buildProfile(series)
    expect(deciles).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40])
    expect(mean).toBe(20)
  })

  it('empty series → 11 zero deciles and mean 0, never throws', () => {
    expect(() => buildProfile([])).not.toThrow()
    expect(buildProfile([])).toEqual({ deciles: Array(11).fill(0), mean: 0 })
  })

  it('single-value series → every decile equals that value', () => {
    const { deciles, mean } = buildProfile([0.42])
    expect(deciles).toEqual(Array(11).fill(0.42))
    expect(mean).toBe(0.42)
  })
})

describe('facescan/profile — pAbove', () => {
  // deciles from the 5-value 0..40 fixture above
  const profile = { deciles: [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40], mean: 20 }

  it('t below the minimum decile → 1 (all samples above it)', () => {
    expect(pAbove(profile, -5)).toBe(1)
  })

  it('t above the maximum decile → 0 (no samples above it)', () => {
    expect(pAbove(profile, 45)).toBe(0)
  })

  it('t at the exact median decile (index 5) → 0.5', () => {
    expect(pAbove(profile, 20)).toBeCloseTo(0.5, 10)
  })

  it('t at decile index 3 (value 12) → 0.7 fraction above', () => {
    expect(pAbove(profile, 12)).toBeCloseTo(0.7, 10)
  })

  it('is clamped to [0, 1] and monotonically non-increasing as t increases', () => {
    const ts = [-10, 0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 50]
    const results = ts.map((t) => pAbove(profile, t))
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeLessThanOrEqual(results[i - 1])
    }
  })
})

describe('facescan/profile — pAbove plateau/tie semantics', () => {
  it('constant series: exactly-at-the-value → 0 (nothing strictly above it); just below → 1', () => {
    const { deciles } = buildProfile([0.3, 0.3, 0.3, 0.3])
    const flat = { deciles }
    expect(pAbove(flat, 0.3)).toBe(0)
    expect(pAbove(flat, 0.29)).toBe(1)
  })

  it('a plateau in the middle of the deciles resolves to its RIGHTMOST segment', () => {
    // deciles[2..4] are all 0.2 — a plateau spanning percentiles 20%-40%.
    // Evaluated exactly at the plateau value, the rightmost matching bin is
    // [deciles[4], deciles[5]] = [0.2, 0.5], anchoring the interpolation at
    // the plateau's right edge (percentile 0.4) rather than its left edge
    // (percentile 0.1, which a leftmost/first-match reading would use).
    const profile = { deciles: [0, 0, 0.2, 0.2, 0.2, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] }
    expect(pAbove(profile, 0.2)).toBeCloseTo(0.6, 10)
  })

  it('duplicate-adjacent deciles at the very top of the range still resolve correctly', () => {
    // deciles[8..10] all 0.9 — evaluating at exactly the plateau value must
    // hit the max-boundary short-circuit (0), not the interpolation branch.
    const profile = { deciles: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.9, 0.9] }
    expect(pAbove(profile, 0.9)).toBe(0)
    expect(pAbove(profile, 0.89)).toBeGreaterThan(0)
  })
})
