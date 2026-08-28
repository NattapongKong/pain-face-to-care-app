import { describe, it, expect } from 'vitest'
import {
  DEFAULT_THRESHOLDS,
  scoreCategory,
  scoreAll,
  displayFraction,
  modelDisplayFraction,
} from '../../src/facescan/scoring.js'
import { CATEGORIES } from '../../src/facescan/features.js'
import { pAbove, buildProfile } from '../../src/facescan/profile.js'

describe('facescan/scoring — DEFAULT_THRESHOLDS', () => {
  it('is {a:0.25, s:0.5} for every category except noseCheek and eyes', () => {
    for (const cat of CATEGORIES) {
      if (cat === 'noseCheek' || cat === 'eyes') continue
      expect(DEFAULT_THRESHOLDS[cat]).toEqual({ a: 0.25, s: 0.5 })
    }
  })

  it('noseCheek is {a:0.02, s:0.3} (R28 — channel runs ~10x lower; 0.25 sat 12x above the light-pain median, do not align back)', () => {
    expect(DEFAULT_THRESHOLDS.noseCheek).toEqual({ a: 0.02, s: 0.3 })
  })

  it('eyes is {a:0.62, s:0.72} (R29 — neutral faces idle at median 0.441, a=0.25 proposed eyes=2 on neutral faces; do not align back)', () => {
    expect(DEFAULT_THRESHOLDS.eyes).toEqual({ a: 0.62, s: 0.72 })
  })
})

describe('facescan/scoring — scoreCategory', () => {
  const thresholds = { a: 0.25, s: 0.5 }

  it('branch → 0: activity never reaches even the activation threshold', () => {
    // max value in the whole series is 0.1, well under a=0.25
    const profile = { deciles: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1], mean: 0.01 }
    expect(scoreCategory(profile, thresholds)).toBe(0)
  })

  it('branch → 1: pActive >= 0.15 but pStrong < 0.35 and pActive < 0.65 ("เป็นบางครั้ง")', () => {
    const profile = { deciles: [0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.35, 0.4], mean: 0.1 }
    expect(scoreCategory(profile, thresholds)).toBe(1)
  })

  it('branch → 2 via the strong-threshold clause: pStrong >= 0.35', () => {
    // fully saturated at 0.6 for every decile → pAbove(s=0.5) = 1
    const profile = { deciles: Array(11).fill(0.6), mean: 0.6 }
    expect(scoreCategory(profile, thresholds)).toBe(2)
  })

  it('branch → 2 via the activation-only clause: pStrong < 0.35 but pActive >= 0.65 ("ต่อเนื่อง")', () => {
    const profile = { deciles: [0, 0, 0, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3], mean: 0.25 }
    expect(scoreCategory(profile, thresholds)).toBe(2)
  })

  it('branch → 2 via the strong-only clause: pStrong >= 0.35 while pActive stays < 0.65', () => {
    // Crafted so pAbove(s=0.5) = 0.35 exactly and pAbove(a=0.25) = 0.54 —
    // isolates the pStrong clause as the SOLE trigger (removing it would
    // flip this to score 0, since pActive never reaches the 1-branch
    // territory of 0.65). Distinct from the "strong-threshold clause" test
    // above, which had pActive also >= 0.65 and so didn't prove the s-only
    // path independently.
    const profile = {
      deciles: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.4, 0.6, 0.6, 0.6, 0.6],
      mean: 0.3,
    }
    expect(pAbove(profile, thresholds.s)).toBeCloseTo(0.35, 10)
    expect(pAbove(profile, thresholds.a)).toBeLessThan(0.65)
    expect(scoreCategory(profile, thresholds)).toBe(2)
  })

  it('inclusive boundary: pActive exactly 0.15 → score 1 (>= is satisfied, not just >)', () => {
    const profile = {
      deciles: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.3, 0.3],
      mean: 0.14,
    }
    expect(pAbove(profile, thresholds.a)).toBeCloseTo(0.15, 10)
    expect(pAbove(profile, thresholds.s)).toBe(0)
    expect(scoreCategory(profile, thresholds)).toBe(1)
  })

  it('inclusive boundary: pActive exactly 0.65 → score 2 via the activation clause', () => {
    const profile = {
      deciles: [0.2, 0.2, 0.2, 0.2, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3],
      mean: 0.25,
    }
    expect(pAbove(profile, thresholds.a)).toBeCloseTo(0.65, 10)
    expect(pAbove(profile, thresholds.s)).toBe(0)
    expect(scoreCategory(profile, thresholds)).toBe(2)
  })

  it('inclusive boundary: pStrong exactly 0.35 → score 2 via the strong clause', () => {
    const profile = {
      deciles: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.4, 0.6, 0.6, 0.6, 0.6],
      mean: 0.3,
    }
    expect(pAbove(profile, thresholds.s)).toBeCloseTo(0.35, 10)
    expect(scoreCategory(profile, thresholds)).toBe(2)
  })
})

describe('facescan/scoring — scoreAll', () => {
  it('scores every category and sums to total (0..10)', () => {
    const thresholds = {
      brow: DEFAULT_THRESHOLDS.brow,
      eyes: DEFAULT_THRESHOLDS.eyes,
      noseCheek: DEFAULT_THRESHOLDS.noseCheek,
      mouth: DEFAULT_THRESHOLDS.mouth,
      overall: DEFAULT_THRESHOLDS.overall,
    }
    const zeroProfile = { deciles: Array(11).fill(0), mean: 0 } // → 0
    const oneProfile = { deciles: [0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.35, 0.4], mean: 0.1 } // → 1
    const twoProfile = { deciles: Array(11).fill(0.6), mean: 0.6 } // → 2
    // eyes needs its own → 1 profile under the R29 thresholds (a=0.62, s=0.72):
    // pAbove(0.62) = 3/11 ≈ 0.27 (≥ 0.15, < 0.65), pAbove(0.72) = 0.
    const oneProfileEyes = { deciles: [0, 0, 0, 0, 0, 0, 0, 0, 0.65, 0.66, 0.67], mean: 0.18 } // → 1

    const profiles = {
      brow: zeroProfile,
      eyes: oneProfileEyes,
      noseCheek: twoProfile,
      mouth: twoProfile,
      overall: oneProfile,
    }

    const { scores, total } = scoreAll(profiles, thresholds)
    expect(scores).toEqual({ brow: 0, eyes: 1, noseCheek: 2, mouth: 2, overall: 1 })
    expect(total).toBe(6)
  })

  it('all-zero profiles → total 0; all-saturated profiles → total 10', () => {
    const zeroProfile = { deciles: Array(11).fill(0), mean: 0 }
    const satProfile = { deciles: Array(11).fill(0.9), mean: 0.9 }

    const zeroProfiles = Object.fromEntries(CATEGORIES.map((c) => [c, zeroProfile]))
    const satProfiles = Object.fromEntries(CATEGORIES.map((c) => [c, satProfile]))

    expect(scoreAll(zeroProfiles, DEFAULT_THRESHOLDS).total).toBe(0)
    expect(scoreAll(satProfiles, DEFAULT_THRESHOLDS).total).toBe(10)
  })
})

// Wave 4b (spec §10.2 item 3, R19/R26/R27): scoreCategory grows a
// model-scored branch. These pin the CONTRACT end to end — a profile
// carrying `.model` is classified from the model's own cutpoints, entirely
// ignoring the `thresholds` (a/s) argument the threshold-engine profiles
// use — without touching a single existing test above (regression proof
// that plain profiles are completely unaffected).
describe('facescan/scoring — scoreCategory (model-scored profiles, wave 4b)', () => {
  // profiles built the same way finishCapture() in useFaceScan.js does:
  // deciles/mean hold the P(ge1) series, profile.model holds the P(ge2)
  // profile + this category's cutpoints.
  function modelProfile(ge1Series, ge2Series, cutpoints) {
    const ge1Profile = buildProfile(ge1Series)
    const ge2Profile = buildProfile(ge2Series)
    return {
      deciles: ge1Profile.deciles,
      mean: ge1Profile.mean,
      model: { cutpoints, ge2Profile: { deciles: ge2Profile.deciles, mean: ge2Profile.mean } },
    }
  }

  it('falls back to the profile\'s own (raw exported) cutpoints when thresholds has no .model — ignores the irrelevant a/s pair entirely', () => {
    // pGe1 constant 0.6 across the window; cutpoints.ge1 = 0.9 -> pActive = 0
    // regardless of what nonsense plain `thresholds` is passed.
    const profile = modelProfile(Array(20).fill(0.6), Array(20).fill(0.1), { ge1: 0.9, ge2: 0.9 })
    const nonsenseThresholds = { a: 0.01, s: 0.02 } // would force score=2 under the OLD engine
    expect(scoreCategory(profile, nonsenseThresholds)).toBe(0)
  })

  it('R30 BLOCKER 1: thresholds.model (calibrated) OVERRIDES the profile\'s raw exported cutpoints when present', () => {
    // Same capture as above (pGe1=0.6 constant, exported cutpoints.ge1=0.9
    // -> exported reading is inactive/0). A calibrated model threshold of
    // 0.5 for this category must flip the classification, proving
    // scoreCategory() actually reads it rather than always trusting
    // whatever cutpoints were baked in at capture time.
    const profile = modelProfile(Array(20).fill(0.6), Array(20).fill(0.1), { ge1: 0.9, ge2: 0.9 })
    const uncalibrated = { a: 0.25, s: 0.5, model: null }
    const calibrated = { a: 0.25, s: 0.5, model: { ge1: 0.5, ge2: 0.5 } }
    expect(scoreCategory(profile, uncalibrated)).toBe(0) // falls back to exported 0.9 -> inactive
    expect(scoreCategory(profile, calibrated)).toBe(2) // 0.6 >= calibrated 0.5 -> pActive=1 -> active
  })

  it('ge1 series above cutpoints.ge1 on every frame -> pActive=1 -> score >= 1', () => {
    const profile = modelProfile(Array(20).fill(0.95), Array(20).fill(0.1), {
      ge1: 0.9,
      ge2: 0.95,
    })
    expect(scoreCategory(profile, { a: 0.25, s: 0.5 })).toBe(2) // pActive=1 >= 0.65
  })

  it('ge2 series above cutpoints.ge2 drives score=2 via the strong clause, independent of the ge1 series', () => {
    // ge1 series sits just above cutpoints.ge1 occasionally (pActive small);
    // ge2 series is saturated above cutpoints.ge2 on every frame (pStrong=1).
    const ge1Series = [...Array(18).fill(0), ...Array(2).fill(0.95)] // pActive = 2/20 = 0.1 (< 0.15)
    const ge2Series = Array(20).fill(0.99)
    const profile = modelProfile(ge1Series, ge2Series, { ge1: 0.9, ge2: 0.95 })
    expect(scoreCategory(profile, { a: 0.25, s: 0.5 })).toBe(2)
  })

  // Retitled (fix round 1, minor b): this only pins the [0,1] decile-shape
  // invariant, NOT that the calibration LOOP stays alive after nurse
  // corrections — that end-to-end liveness (plus the poisoning regression)
  // is now covered through the real Pinia store in
  // tests/stores/calibrationStore.test.js, which is where R30's review
  // asked for it.
  it('decile-shape invariant: a model profile built purely from sigmoid outputs stays within [0,1] (matches calibrationStore.isValidDeciles bounds, independent of any calibration behavior)', () => {
    const profile = modelProfile(Array(11).fill(0.42), Array(11).fill(0.07), {
      ge1: 0.5,
      ge2: 0.5,
    })
    for (const d of profile.deciles) {
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(1)
    }
    expect(profile.mean).toBeGreaterThanOrEqual(0)
    expect(profile.mean).toBeLessThanOrEqual(1)
  })

  it('scoreAll works transparently over a mix of model-scored and plain profiles', () => {
    const modelBrow = modelProfile(Array(20).fill(0.95), Array(20).fill(0.99), {
      ge1: 0.9,
      ge2: 0.95,
    }) // -> 2
    const plainEyes = { deciles: Array(11).fill(0), mean: 0 } // -> 0 under DEFAULT_THRESHOLDS.eyes
    const { scores } = scoreAll(
      {
        brow: modelBrow,
        eyes: plainEyes,
        noseCheek: plainEyes,
        mouth: plainEyes,
        overall: plainEyes,
      },
      DEFAULT_THRESHOLDS,
    )
    expect(scores.brow).toBe(2)
    expect(scores.eyes).toBe(0)
  })
})

// Owner live-test feedback: the live scan bars must show a DECISION-relative
// level (relative to this category's own a/s thresholds), never a raw
// magnitude — a neutral face idling above 0 on some channels otherwise
// misreads as "detecting pain" before any threshold is close to being met.
describe('facescan/scoring — displayFraction', () => {
  const thresholds = { a: 0.25, s: 0.5 }

  it('0 at v=0 (and below)', () => {
    expect(displayFraction(0, thresholds)).toBe(0)
    expect(displayFraction(-1, thresholds)).toBe(0)
  })

  it('exactly 0.5 at v=a (the activation threshold)', () => {
    expect(displayFraction(0.25, thresholds)).toBeCloseTo(0.5, 10)
  })

  it('exactly 1 at v=s (the strong threshold), and capped at 1 beyond it', () => {
    expect(displayFraction(0.5, thresholds)).toBe(1)
    expect(displayFraction(0.9, thresholds)).toBe(1)
    expect(displayFraction(100, thresholds)).toBe(1)
  })

  it('is monotonically non-decreasing across the full range', () => {
    const values = [-1, 0, 0.05, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 1, 5]
    const results = values.map((v) => displayFraction(v, thresholds))
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1])
    }
  })

  it('tracks the per-category thresholds, not a fixed midpoint — a category with a tiny `a` reaches 0.5 much sooner (noseCheek R28)', () => {
    const noseCheekThresholds = { a: 0.02, s: 0.3 }
    expect(displayFraction(0.02, noseCheekThresholds)).toBeCloseTo(0.5, 10)
    // The same raw value 0.02 is nowhere near half under the default a=0.25.
    expect(displayFraction(0.02, thresholds)).toBeLessThan(0.05)
  })

  it('a neutral-idling eyes value (R29: median 0.441, below its a=0.62) still reads well under half', () => {
    const eyesThresholds = { a: 0.62, s: 0.72 }
    expect(displayFraction(0.441, eyesThresholds)).toBeLessThan(0.5)
  })
})

// R30 MAJOR 3 (fix round 1) — model-mode live bars need their OWN
// decision-relative mapping: plain P(ge1) is not comparable across
// categories once the real exported cutpoints are this spread out (brow
// ge1=0.9728 vs overall ge1=0.455) — the earlier "plain P(ge1) is
// acceptable" call is retracted.
describe('facescan/scoring — modelDisplayFraction', () => {
  it('0 at p=0, for any threshold', () => {
    expect(modelDisplayFraction(0, 0.9728)).toBe(0)
    expect(modelDisplayFraction(0, 0.455)).toBe(0)
  })

  it('1 at p=1, for any threshold', () => {
    expect(modelDisplayFraction(1, 0.9728)).toBeCloseTo(1, 10)
    expect(modelDisplayFraction(1, 0.455)).toBeCloseTo(1, 10)
  })

  it('exactly 0.5 at p = the active threshold itself', () => {
    expect(modelDisplayFraction(0.9728, 0.9728)).toBeCloseTo(0.5, 10)
    expect(modelDisplayFraction(0.455, 0.455)).toBeCloseTo(0.5, 10)
  })

  it('is monotonically non-decreasing across [0,1] for a high real cutpoint (brow ge1=0.9728)', () => {
    const ps = [0, 0.2, 0.5, 0.8, 0.9, 0.95, 0.9728, 0.98, 0.99, 1]
    const results = ps.map((p) => modelDisplayFraction(p, 0.9728))
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1])
    }
  })

  it('is monotonically non-decreasing across [0,1] for a low real cutpoint (overall ge1=0.455)', () => {
    const ps = [0, 0.1, 0.3, 0.455, 0.6, 0.8, 1]
    const results = ps.map((p) => modelDisplayFraction(p, 0.455))
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1])
    }
  })

  it('reproduces the exact failure MAJOR 3 reported: brow@90% (below its 0.9728 cutpoint) reads under half; overall@50% (above its 0.455 cutpoint) reads over half', () => {
    expect(modelDisplayFraction(0.9, 0.9728)).toBeLessThan(0.5) // still inactive — must not look "almost full"
    expect(modelDisplayFraction(0.5, 0.455)).toBeGreaterThan(0.5) // already active — must not look "half"
  })

  it('clamps out-of-range p and defends against a degenerate threshold', () => {
    expect(modelDisplayFraction(-1, 0.9)).toBe(0)
    expect(modelDisplayFraction(2, 0.9)).toBeCloseTo(1, 10)
    expect(() => modelDisplayFraction(0.5, 0)).not.toThrow()
    expect(() => modelDisplayFraction(0.5, 1)).not.toThrow()
    expect(() => modelDisplayFraction(0.5, undefined)).not.toThrow()
  })
})
