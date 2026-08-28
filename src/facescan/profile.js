// Compact temporal profile of an intensity series (deciles + mean), and the
// inverse-interpolation that recovers "fraction of frames above threshold t"
// from that profile without keeping raw frames. Pure JS. Spec §5.3.

/**
 * @param {number[]} series per-frame intensity values captured during a scan.
 * @returns {{deciles:number[], mean:number}} deciles[i] = the (i*10)th
 *   percentile value (i = 0..10), by sorted linear interpolation.
 */
export function buildProfile(series) {
  const values = Array.isArray(series) ? series : []
  const n = values.length

  if (n === 0) {
    return { deciles: Array(11).fill(0), mean: 0 }
  }

  const sorted = [...values].sort((a, b) => a - b)
  const deciles = []
  for (let i = 0; i <= 10; i++) {
    const q = i / 10
    const pos = q * (n - 1)
    const lower = Math.floor(pos)
    const upper = Math.ceil(pos)
    if (lower === upper) {
      deciles.push(sorted[lower])
    } else {
      const frac = pos - lower
      deciles.push(sorted[lower] + (sorted[upper] - sorted[lower]) * frac)
    }
  }

  const mean = values.reduce((sum, v) => sum + v, 0) / n

  return { deciles, mean }
}

/**
 * Fraction of the original series that was strictly above threshold `t`,
 * recovered from the decile profile by inverse linear interpolation.
 * Clamped to [0, 1].
 *
 * Ties/plateaus (repeated decile values) resolve to the RIGHTMOST segment
 * containing `t` — scanning from the top decile down and returning the
 * first (i.e. highest-index) matching bin — so that:
 *   - a constant-series profile evaluated at exactly its constant value
 *     yields 0 (nothing is *strictly* above it), matching the max-decile
 *     check below rather than the min-decile check.
 *   - a plateau of repeated values in the middle of the profile is treated
 *     as "not strictly above t" for its full width, using the plateau's
 *     right edge as the interpolation anchor instead of its left edge.
 *
 * @param {{deciles:number[]}} profile
 * @param {number} t
 * @returns {number}
 */
export function pAbove(profile, t) {
  const { deciles } = profile
  const min = deciles[0]
  const max = deciles[10]

  // Order matters when min === max (a fully flat profile): checking the
  // max-boundary first makes "t equals the flat value" resolve to 0.
  if (t >= max) return 0
  if (t <= min) return 1

  for (let i = 9; i >= 0; i--) {
    const lo = deciles[i]
    const hi = deciles[i + 1]
    if (t >= lo && t <= hi) {
      const frac = hi === lo ? 0 : (t - lo) / (hi - lo)
      const percentile = (i + frac) / 10
      return Math.min(1, Math.max(0, 1 - percentile))
    }
  }

  return 0
}
