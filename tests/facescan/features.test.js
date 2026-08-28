import { describe, it, expect } from 'vitest'
import { CATEGORIES, frameIntensities } from '../../src/facescan/features.js'

describe('facescan/features — CATEGORIES', () => {
  it('exposes the five form categories in order', () => {
    expect(CATEGORIES).toEqual(['brow', 'eyes', 'noseCheek', 'mouth', 'overall'])
  })
})

describe('facescan/features — frameIntensities', () => {
  it('returns all-zero intensities for an empty blendshape map', () => {
    expect(frameIntensities({})).toEqual({ brow: 0, eyes: 0, noseCheek: 0, mouth: 0, overall: 0 })
  })

  it('missing keys are treated as 0 (partial blendshape map)', () => {
    const result = frameIntensities({ browDownLeft: 0.4 })
    expect(result.brow).toBe(0.4)
    expect(result.eyes).toBe(0)
    expect(result.noseCheek).toBe(0)
    expect(result.mouth).toBe(0)
  })

  it('brow = max(browDownLeft, browDownRight) — right dominates', () => {
    expect(frameIntensities({ browDownLeft: 0.2, browDownRight: 0.6 }).brow).toBe(0.6)
  })

  it('brow = max(browDownLeft, browDownRight) — left dominates', () => {
    expect(frameIntensities({ browDownLeft: 0.7, browDownRight: 0.1 }).brow).toBe(0.7)
  })

  it('eyes: squint dominates over the blink term', () => {
    const result = frameIntensities({
      eyeSquintLeft: 0.9,
      eyeSquintRight: 0.1,
      eyeBlinkLeft: 0.1,
      eyeBlinkRight: 0.1,
    })
    // 0.8 * min(0.1, 0.1) = 0.08 < 0.9
    expect(result.eyes).toBe(0.9)
  })

  it('eyes: sustained blink (0.8 * min(blinkLeft, blinkRight)) dominates over squint', () => {
    const result = frameIntensities({
      eyeSquintLeft: 0.4,
      eyeSquintRight: 0.2,
      eyeBlinkLeft: 0.9,
      eyeBlinkRight: 0.9,
    })
    // 0.8 * min(0.9, 0.9) = 0.72 > 0.4
    expect(result.eyes).toBeCloseTo(0.72, 10)
  })

  it('eyes: blink term uses MIN of left/right, not max (a single wink does not count)', () => {
    const result = frameIntensities({
      eyeSquintLeft: 0,
      eyeSquintRight: 0,
      eyeBlinkLeft: 0.9,
      eyeBlinkRight: 0.1,
    })
    // 0.8 * min(0.9, 0.1) = 0.08
    expect(result.eyes).toBeCloseTo(0.08, 10)
  })

  it('noseCheek = max over sneer, cheekSquint and mouthUpperUp channels', () => {
    expect(
      frameIntensities({
        noseSneerLeft: 0.5,
        noseSneerRight: 0.2,
        cheekSquintLeft: 0.3,
        cheekSquintRight: 0.7,
        mouthUpperUpLeft: 0.1,
        mouthUpperUpRight: 0.6,
      }).noseCheek,
    ).toBe(0.7)
  })

  it('noseCheek: mouthUpperUp alone drives the category (R25 — sneer/cheekSquint are dead in the shipped model, do not remove)', () => {
    expect(
      frameIntensities({
        noseSneerLeft: 0,
        noseSneerRight: 0,
        cheekSquintLeft: 0,
        cheekSquintRight: 0,
        mouthUpperUpLeft: 0.2,
        mouthUpperUpRight: 0.75,
      }).noseCheek,
    ).toBe(0.75)
  })

  it('mouth = max of press/stretch/frown, left and right', () => {
    expect(
      frameIntensities({
        mouthPressLeft: 0.1,
        mouthPressRight: 0.2,
        mouthStretchLeft: 0.3,
        mouthStretchRight: 0.4,
        mouthFrownLeft: 0.65,
        mouthFrownRight: 0.5,
      }).mouth,
    ).toBe(0.65)
  })

  it('overall = 0.3*brow + 0.25*eyes + 0.2*noseCheek + 0.25*mouth (exact weighted sum)', () => {
    // Construct a blendshape map that yields brow=0.4, eyes=0.2, noseCheek=0.6, mouth=0.8
    // via single dominant components, so each category's value is unambiguous.
    const bs = {
      browDownLeft: 0.4,
      browDownRight: 0,
      eyeSquintLeft: 0.2,
      eyeSquintRight: 0,
      eyeBlinkLeft: 0,
      eyeBlinkRight: 0,
      noseSneerLeft: 0.6,
      cheekSquintLeft: 0,
      mouthFrownLeft: 0.8,
    }
    const result = frameIntensities(bs)
    expect(result.brow).toBe(0.4)
    expect(result.eyes).toBe(0.2)
    expect(result.noseCheek).toBe(0.6)
    expect(result.mouth).toBe(0.8)
    // 0.3*0.4 + 0.25*0.2 + 0.2*0.6 + 0.25*0.8 = 0.12 + 0.05 + 0.12 + 0.2 = 0.49
    expect(result.overall).toBeCloseTo(0.49, 10)
  })
})
