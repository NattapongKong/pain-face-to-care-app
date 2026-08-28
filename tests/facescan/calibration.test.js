import { describe, it, expect } from 'vitest'
import { recalibrate, recalibrateModel } from '../../src/facescan/calibration.js'
import { DEFAULT_THRESHOLDS, scoreCategory } from '../../src/facescan/scoring.js'
import { CATEGORIES } from '../../src/facescan/features.js'

// A linear-ramp profile: intensity rises from 0 to `peak` across the series,
// so deciles[i] = peak * i/10. Lets us hand-place a category's activity at
// any given peak without depending on buildProfile.
function rampProfile(peak) {
  return { deciles: Array.from({ length: 11 }, (_, i) => (peak * i) / 10), mean: peak / 2 }
}

describe('facescan/calibration — recalibrate', () => {
  it('fewer than 3 samples for a category → keeps that category at defaults', () => {
    const samples = [
      { profiles: { brow: rampProfile(0.9) }, confirmed: { brow: 2 } },
      { profiles: { brow: rampProfile(0.9) }, confirmed: { brow: 2 } },
    ]
    const thresholds = recalibrate(samples)
    expect(thresholds.brow).toEqual(DEFAULT_THRESHOLDS.brow)
    // categories with zero samples also stay at defaults
    for (const cat of CATEGORIES) {
      if (cat !== 'brow') expect(thresholds[cat]).toEqual(DEFAULT_THRESHOLDS[cat])
    }
  })

  it('recovers thresholds close to planted (a:0.4, s:0.6) and beats the default error rate', () => {
    const planted = { a: 0.4, s: 0.6 }
    // A spread of peaks labeled by the planted rule — the ground truth a
    // recalibration pass has to reverse-engineer without knowing `planted`.
    const peaks = []
    for (let p = 5; p <= 100; p += 5) peaks.push(p / 100)

    const samples = peaks.map((peak) => {
      const profile = rampProfile(peak)
      return {
        profiles: { brow: profile },
        confirmed: { brow: scoreCategory(profile, planted) },
      }
    })

    const thresholds = recalibrate(samples)
    const found = thresholds.brow

    expect(Math.abs(found.a - planted.a)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(found.s - planted.s)).toBeLessThanOrEqual(0.05)

    const errorsWith = (t) =>
      samples.filter((s) => scoreCategory(s.profiles.brow, t) !== s.confirmed.brow).length

    expect(errorsWith(found)).toBe(0)
    expect(errorsWith(found)).toBeLessThan(errorsWith(DEFAULT_THRESHOLDS.brow))
  })

  it('tie-break: among equally-good thresholds, picks the one closest to defaults', () => {
    // A flat profile at 0.5 for every sample: any (a,s) with a<=0.5 or s<=0.5
    // scores 2 (since pAbove of anything <= the flat value is 1); a>0.5 AND
    // s>0.5 scores 0. Confirmed=2 for all → the exact default {a:0.25,s:0.5}
    // is itself a zero-error grid point (a<=0.5 → score 2 regardless of s),
    // and it has zero distance from defaults, so it must win the tie-break.
    // Uses brow because its defaults are still 0.25/0.5 (eyes moved by R29).
    const profile = { deciles: Array(11).fill(0.5), mean: 0.5 }
    const samples = [
      { profiles: { brow: profile }, confirmed: { brow: 2 } },
      { profiles: { brow: profile }, confirmed: { brow: 2 } },
      { profiles: { brow: profile }, confirmed: { brow: 2 } },
    ]
    const thresholds = recalibrate(samples)
    expect(thresholds.brow).toEqual({ a: 0.25, s: 0.5 })
  })

  it('accepts a custom defaults argument', () => {
    const customDefaults = {
      brow: { a: 0.3, s: 0.55 },
      eyes: { a: 0.3, s: 0.55 },
      noseCheek: { a: 0.3, s: 0.55 },
      mouth: { a: 0.3, s: 0.55 },
      overall: { a: 0.3, s: 0.55 },
    }
    const thresholds = recalibrate([], customDefaults)
    for (const cat of CATEGORIES) {
      expect(thresholds[cat]).toEqual(customDefaults[cat])
    }
  })

  it('R30 BLOCKER 2: a model-scored sample is invisible to recalibrate() — no poisoning even with only model samples present', () => {
    // Same shape as the flat-model-profile helper below; a category with
    // ONLY model-mode samples (however many, however consistent) must stay
    // at defaults for the THRESHOLD engine — there's nothing else valid to
    // calibrate from.
    const modelProfile = {
      deciles: Array(11).fill(0.85),
      mean: 0.85,
      model: {
        cutpoints: { ge1: 0.95, ge2: 0.9 },
        ge2Profile: { deciles: Array(11).fill(0.05), mean: 0.05 },
      },
    }
    const samples = Array(10).fill({ profiles: { noseCheek: modelProfile }, confirmed: { noseCheek: 2 } })
    const thresholds = recalibrate(samples)
    expect(thresholds.noseCheek).toEqual(DEFAULT_THRESHOLDS.noseCheek)
  })
})

// R30 BLOCKER 1 (fix round 1) — model-engine calibration. Uses FLAT
// (constant) ge1/ge2 series throughout: pAbove() on a flat profile is a
// clean step function (0 or 1, no interpolation), so every assertion below
// is exact with zero floating-point boundary risk.
describe('facescan/calibration — recalibrateModel (R30)', () => {
  function flatModelProfile(ge1Value, ge2Value, cutpoints) {
    return {
      deciles: Array(11).fill(ge1Value),
      mean: ge1Value,
      model: {
        cutpoints,
        ge2Profile: { deciles: Array(11).fill(ge2Value), mean: ge2Value },
      },
    }
  }

  it('fewer than 3 model samples for a category -> null (fallback to the profile\'s own raw exported cutpoints)', () => {
    const cutpoints = { ge1: 0.9, ge2: 0.8 }
    const samples = [
      { profiles: { brow: flatModelProfile(0.5, 0.1, cutpoints) }, confirmed: { brow: 2 } },
      { profiles: { brow: flatModelProfile(0.5, 0.1, cutpoints) }, confirmed: { brow: 2 } },
    ]
    expect(recalibrateModel(samples).brow).toBeNull()
    // categories with zero model samples also stay null
    for (const cat of CATEGORIES) {
      if (cat !== 'brow') expect(recalibrateModel(samples)[cat]).toBeNull()
    }
  })

  it('grid is bounded to exportedCutpoint +/- 0.25, clamped to [0.01, 0.99] near the floor', () => {
    const cutpoints = { ge1: 0.05, ge2: 0.5 } // ge1 near the floor
    const profile = flatModelProfile(0.5, 0.5, cutpoints)
    const confirmed = scoreCategory(profile, { model: cutpoints })
    const samples = Array(3).fill({ profiles: { eyes: profile }, confirmed: { eyes: confirmed } })
    const result = recalibrateModel(samples).eyes
    expect(result).not.toBeNull()
    expect(result.ge1).toBeGreaterThanOrEqual(0.01)
    expect(result.ge1).toBeLessThanOrEqual(0.3) // 0.05 + 0.25
  })

  it('grid is bounded to exportedCutpoint +/- 0.25, clamped to [0.01, 0.99] near the ceiling', () => {
    const cutpoints = { ge1: 0.5, ge2: 0.9 } // ge2 near the ceiling (0.9+0.25=1.15 -> clamp 0.99)
    const profile = flatModelProfile(0.5, 0.5, cutpoints)
    const confirmed = scoreCategory(profile, { model: cutpoints })
    const samples = Array(3).fill({ profiles: { mouth: profile }, confirmed: { mouth: confirmed } })
    const result = recalibrateModel(samples).mouth
    expect(result).not.toBeNull()
    expect(result.ge2).toBeGreaterThanOrEqual(0.65) // 0.9 - 0.25
    expect(result.ge2).toBeLessThanOrEqual(0.99) // never overshoots the clamp
  })

  it('NO s>a / ge2>ge1 constraint: an inverted exported pair (ge2 < ge1, as 4 of 5 real model heads ship) round-trips without reordering', () => {
    // Real brow-shaped values: ge1=0.90, ge2=0.80 (ge2 < ge1). A flat
    // profile at 0.5 makes the exported pair itself the unique zero-error
    // tie-anchor (every grid point ties at 0 errors here, so the tie-break
    // settles exactly on the exported values) — proving the function
    // neither rejects nor reorders an inverted pair.
    const cutpoints = { ge1: 0.9, ge2: 0.8 }
    const profile = flatModelProfile(0.5, 0.5, cutpoints)
    const confirmed = scoreCategory(profile, { model: cutpoints }) // 0: 0.5 is below both cutpoints
    expect(confirmed).toBe(0)
    const samples = Array(3).fill({ profiles: { brow: profile }, confirmed: { brow: confirmed } })

    const result = recalibrateModel(samples).brow
    expect(result).toEqual({ ge1: 0.9, ge2: 0.8 })
    expect(result.ge2).toBeLessThan(result.ge1) // inversion preserved, never clamped/reordered
  })

  it('tie-break: among equally-good candidates, picks the one nearest the EXPORTED cutpoints (not a fixed default)', () => {
    // Same construction as the inversion test above — the flat profile at
    // exactly the exported values makes every grid point tie at 0 errors,
    // so ANY tie-break bug (e.g. defaulting toward 0.5/0.5 like the
    // threshold engine's DEFAULT_THRESHOLDS) would visibly drag the result
    // away from the exported (0.97, 0.95)-shaped pair used here.
    const cutpoints = { ge1: 0.97, ge2: 0.95 }
    const profile = flatModelProfile(0.5, 0.5, cutpoints)
    const confirmed = scoreCategory(profile, { model: cutpoints })
    const samples = Array(3).fill({ profiles: { overall: profile }, confirmed: { overall: confirmed } })

    const result = recalibrateModel(samples).overall
    expect(result.ge1).toBeCloseTo(0.97, 5)
    expect(result.ge2).toBeCloseTo(0.95, 5)
  })

  it('unanimous agreement reproduces the exported cutpoints EXACTLY, even non-round ones (re-review round 2: grid is center-anchored and includes the unrounded export — no information-free drift)', () => {
    // Brow's real exported values — not 0.05-multiples. Flat 0.5 series ties
    // every candidate at zero errors, so the L1 tie-break must land on the
    // exact exported pair; a lower-bound-anchored or cent-rounded-only grid
    // would drift to 0.97/0.95.
    const cutpoints = { ge1: 0.9728, ge2: 0.9507 }
    const profile = flatModelProfile(0.5, 0.5, cutpoints)
    const confirmed = scoreCategory(profile, { model: cutpoints })
    const samples = Array(3).fill({ profiles: { brow: profile }, confirmed: { brow: confirmed } })
    expect(recalibrateModel(samples).brow).toEqual({ ge1: 0.9728, ge2: 0.9507 })
  })

  it('a high exported cutpoint can be corrected UPWARD to the 0.99 clamp (re-review round 2: brow was one-directional under the lower-bound-anchored grid)', () => {
    // ge1 series flat at 0.98 — above the exported 0.9728, so the export
    // proposes active; the nurse insists 0 every time. Only a candidate
    // ABOVE 0.98 (i.e. the 0.99 clamp rung) yields zero errors; ge2 series
    // at 0.05 keeps pStrong at 0 for every candidate.
    const cutpoints = { ge1: 0.9728, ge2: 0.9507 }
    const samples = Array(3).fill({
      profiles: { brow: flatModelProfile(0.98, 0.05, cutpoints) },
      confirmed: { brow: 0 },
    })
    const result = recalibrateModel(samples).brow
    expect(result).not.toBeNull()
    expect(result.ge1).toBeGreaterThan(0.98)
  })

  it('a genuine correction actually moves the calibrated ge1 cutpoint (liveness at the pure-function level)', () => {
    // exported ge2=0.90 (not 0.05!) is deliberate: it keeps the ENTIRE ge2
    // grid ([0.65, 0.99]) comfortably above the flat ge2 series (0.05), so
    // pStrong is 0 for every candidate ge2 and the "strong" clause can
    // never independently satisfy confirmed=2 — the fix is isolating the
    // ge1/active path as the ONLY route to a zero-error match, so the
    // winning ge1 is unambiguous (an earlier draft of this test used
    // ge2=0.05 and the search legitimately found a *cheaper* zero-error
    // solution via ge2=0.01 forcing pStrong active without moving ge1 at
    // all — correct behavior, wrong test).
    const cutpoints = { ge1: 0.95, ge2: 0.90 }
    // ge1 flat at 0.85 (below the exported cutpoint -> exported reads as
    // inactive); nurse insists this should be strong-active (2) every time.
    const samples = Array(3).fill({
      profiles: { mouth: flatModelProfile(0.85, 0.05, cutpoints) },
      confirmed: { mouth: 2 },
    })
    const result = recalibrateModel(samples).mouth
    expect(result).not.toBeNull()
    expect(result.ge1).toBeLessThan(0.85) // moved below the capture's own value
  })
})
