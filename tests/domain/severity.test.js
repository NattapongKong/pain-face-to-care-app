import { describe, it, expect } from 'vitest'
import { severityBand, SEVERITY_META } from '../../src/domain/severity.js'

describe('domain/severity — severityBand', () => {
  it('returns null for 0', () => {
    expect(severityBand(0)).toBeNull()
  })

  it('returns null for null/undefined', () => {
    expect(severityBand(null)).toBeNull()
    expect(severityBand(undefined)).toBeNull()
  })

  it('returns mild for 1-3', () => {
    expect(severityBand(1)).toBe('mild')
    expect(severityBand(2)).toBe('mild')
    expect(severityBand(3)).toBe('mild')
  })

  it('returns moderate for 4-6', () => {
    expect(severityBand(4)).toBe('moderate')
    expect(severityBand(5)).toBe('moderate')
    expect(severityBand(6)).toBe('moderate')
  })

  it('returns severe for 7-10', () => {
    expect(severityBand(7)).toBe('severe')
    expect(severityBand(8)).toBe('severe')
    expect(severityBand(10)).toBe('severe')
  })
})

describe('domain/severity — SEVERITY_META', () => {
  it('has the three bands with label/range/tone', () => {
    expect(SEVERITY_META.mild).toEqual({ label: 'ปวดน้อย', range: '1–3', tone: 'success' })
    expect(SEVERITY_META.moderate).toEqual({ label: 'ปวดปานกลาง', range: '4–6', tone: 'warning' })
    expect(SEVERITY_META.severe).toEqual({ label: 'ปวดมาก', range: '7–10', tone: 'error' })
  })
})
