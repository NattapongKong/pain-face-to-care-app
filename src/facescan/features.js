// Per-frame category intensities, extracted from a MediaPipe FaceLandmarker
// blendshape vector. Pure JS — no Vue/pinia imports. Formulas are spec §5.2 /
// plan Task 3, binding verbatim.

export const CATEGORIES = ['brow', 'eyes', 'noseCheek', 'mouth', 'overall']

function coeff(bs, key) {
  const value = bs[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * @param {Record<string, number>} bs blendshape category name → score, as
 *   produced by landmarker.js's detect(). Missing keys are treated as 0.
 * @returns {{brow:number, eyes:number, noseCheek:number, mouth:number, overall:number}}
 */
export function frameIntensities(bs = {}) {
  const browDownLeft = coeff(bs, 'browDownLeft')
  const browDownRight = coeff(bs, 'browDownRight')

  const eyeSquintLeft = coeff(bs, 'eyeSquintLeft')
  const eyeSquintRight = coeff(bs, 'eyeSquintRight')
  const eyeBlinkLeft = coeff(bs, 'eyeBlinkLeft')
  const eyeBlinkRight = coeff(bs, 'eyeBlinkRight')

  const noseSneerLeft = coeff(bs, 'noseSneerLeft')
  const noseSneerRight = coeff(bs, 'noseSneerRight')
  const cheekSquintLeft = coeff(bs, 'cheekSquintLeft')
  const cheekSquintRight = coeff(bs, 'cheekSquintRight')
  // R25: the shipped face_landmarker.task emits 0.0 for noseSneer*/cheekSquint*
  // even on frames FACS-coded AU9/AU10 >= 2 (measured on UNBC-McMaster frames);
  // mouthUpperUp* is the channel that actually carries the levator (AU10)
  // signal there (pain-frame p90 ≈ 0.79 vs neutral ≈ 0.001). Keep the dead
  // channels in the max in case a future model asset revives them.
  const mouthUpperUpLeft = coeff(bs, 'mouthUpperUpLeft')
  const mouthUpperUpRight = coeff(bs, 'mouthUpperUpRight')

  const mouthPressLeft = coeff(bs, 'mouthPressLeft')
  const mouthPressRight = coeff(bs, 'mouthPressRight')
  const mouthStretchLeft = coeff(bs, 'mouthStretchLeft')
  const mouthStretchRight = coeff(bs, 'mouthStretchRight')
  const mouthFrownLeft = coeff(bs, 'mouthFrownLeft')
  const mouthFrownRight = coeff(bs, 'mouthFrownRight')

  const brow = Math.max(browDownLeft, browDownRight)
  const eyes = Math.max(
    eyeSquintLeft,
    eyeSquintRight,
    0.8 * Math.min(eyeBlinkLeft, eyeBlinkRight),
  )
  const noseCheek = Math.max(
    noseSneerLeft,
    noseSneerRight,
    cheekSquintLeft,
    cheekSquintRight,
    mouthUpperUpLeft,
    mouthUpperUpRight,
  )
  const mouth = Math.max(
    mouthPressLeft,
    mouthPressRight,
    mouthStretchLeft,
    mouthStretchRight,
    mouthFrownLeft,
    mouthFrownRight,
  )
  const overall = 0.3 * brow + 0.25 * eyes + 0.2 * noseCheek + 0.25 * mouth

  return { brow, eyes, noseCheek, mouth, overall }
}
