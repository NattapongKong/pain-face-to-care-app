// Windowed 0/1/2 scoring per form category, from a captured temporal
// profile. Pure JS. Spec §5.3 / plan Task 3, binding verbatim.

import { CATEGORIES } from './features.js'
import { pAbove } from './profile.js'

export const DEFAULT_THRESHOLDS = {
  brow: { a: 0.25, s: 0.5 },
  // R29: eyeSquint idles HIGH on neutral faces — measured on 48,391 UNBC
  // frames with the eyes formula: neutral median 0.441 / p85 ≈ 0.62 / p95
  // 0.686; per-subject neutral idle spans 0.211–0.582. At a=0.25 nearly every
  // neutral face sustained pAbove(a) ≥ 0.65 and was proposed eyes=2. With
  // a=0.62/s=0.72 a median neutral face scores 0 and a high-idler caps at 1.
  // A static threshold cannot do better (per-person offset spread exceeds the
  // pain signal); the model path's neutral-baseline delta is the real fix.
  // Do not "align" these back to 0.25/0.5.
  eyes: { a: 0.62, s: 0.72 },
  // R28: the noseCheek channel (mouthUpperUp*, see R25) runs an order of
  // magnitude lower than the other categories' channels. Measured on 48,391
  // UNBC frames: neutral median 0.0001 / p95 0.017; light pain (AU9/10 at
  // 1-2) median 0.021 / p75 0.19; strong (>=3) median 0.48. The old 0.25/0.5
  // sat 12x above the light-pain median, so light pain always scored 0.
  // Do not "align" these back to 0.25/0.5.
  noseCheek: { a: 0.02, s: 0.3 },
  mouth: { a: 0.25, s: 0.5 },
  overall: { a: 0.25, s: 0.5 },
}

// Shared occasional/continuous -> 0/1/2 classification (spec §5.3, binding
// verbatim): 2 if strong activity is frequent OR plain activity is nearly
// constant ("ชัดเจน/ต่อเนื่อง"); 1 if activity is merely occasional
// ("เป็นบางครั้ง"); else 0. Both the threshold engine and the trained-model
// engine (wave 4b) reduce to this same rule — they only differ in how
// pActive/pStrong are derived from the profile below.
function classify(pActive, pStrong) {
  if (pStrong >= 0.35 || pActive >= 0.65) return 2
  if (pActive >= 0.15) return 1
  return 0
}

/**
 * @param {{deciles:number[], mean:number, model?:{cutpoints:{ge1:number,ge2:number}, ge2Profile:{deciles:number[]}}}} profile
 *   A plain intensity profile (threshold engine) — OR, when captured by the
 *   trained model (wave 4b / spec §10.2 item 3), a profile whose `deciles`
 *   hold the P(ge1) probability series and whose `model` field carries the
 *   P(ge2) probability profile plus the model's own RAW EXPORTED cutpoints
 *   (embedded at capture time, useFaceScan.js's finishCapture()).
 * @param {{a:number, s:number, model?:{ge1:number,ge2:number}|null}} thresholds
 *   For plain (non-model) profiles: activation (a) and strong (s).
 *   For model-scored profiles (R30, fix round 1 BLOCKER 1): `thresholds.model`
 *   — when present — is the CALIBRATED per-category {ge1, ge2} cutpoint pair
 *   (calibrationStore.js's recalibrateModel(), grid-searched from nurse
 *   corrections exactly like the threshold engine's a/s). When absent/null
 *   (not enough model-mode samples yet), falls back to the profile's own
 *   embedded `profile.model.cutpoints` — the model's raw exported values.
 *   Either way this is never a hardcoded 0.5 (spec item 5) and the
 *   calibration loop genuinely changes future proposals (spec §10.2 item 3;
 *   round-1 review found it dead — thresholds.model is the fix).
 * @returns {0|1|2}
 */
export function scoreCategory(profile, thresholds) {
  if (profile && profile.model) {
    const cutpoints = thresholds && thresholds.model ? thresholds.model : profile.model.cutpoints
    const pActive = pAbove(profile, cutpoints.ge1)
    const pStrong = pAbove(profile.model.ge2Profile, cutpoints.ge2)
    return classify(pActive, pStrong)
  }
  const { a, s } = thresholds
  return classify(pAbove(profile, a), pAbove(profile, s))
}

/**
 * @param {Record<string, {deciles:number[]}>} profiles per category
 * @param {Record<string, {a:number, s:number}>} thresholds per category
 * @returns {{scores: Record<string, 0|1|2>, total: number}}
 */
export function scoreAll(profiles, thresholds) {
  const scores = {}
  let total = 0
  for (const cat of CATEGORIES) {
    const score = scoreCategory(profiles[cat], thresholds[cat])
    scores[cat] = score
    total += score
  }
  return { scores, total }
}

/**
 * Maps a raw threshold-engine intensity to a DECISION-RELATIVE display
 * fraction in [0,1], for the live per-category bars (ScanPanel.vue, spec
 * item 8; owner live-test feedback) — never render frameIntensities
 * directly. A neutral face idles well above 0 on some channels (e.g. eyes
 * ~0.35-0.5), so a raw bar reads as "detecting pain" even when it is nowhere
 * near this category's own activation threshold; per-category thresholds
 * also vary widely (e.g. noseCheek a=0.02 vs eyes a=0.62 — R28/R29), so raw
 * magnitudes aren't even comparable across the bars sitting side by side.
 * This makes "half full" mean the same thing everywhere: exactly at the
 * activation threshold `a`, and "full" mean at-or-past the strong threshold
 * `s` — the actual boundaries scoring will use. Piecewise-linear, monotone,
 * clamped to [0,1]. Pure display mapping — does not affect scoreCategory
 * (which still reads the profile/deciles directly).
 *
 *   v <= 0        -> 0
 *   0 <  v <  a   -> 0.5 * v/a           (below activation: first half)
 *   a <= v <  s   -> 0.5 + 0.5*(v-a)/(s-a) (between activation and strong: second half)
 *   v >= s        -> 1
 *
 * @param {number} value raw intensity (or any comparable per-frame signal)
 * @param {{a:number, s:number}} thresholds this category's active a/s pair
 * @returns {number} display fraction in [0,1]
 */
export function displayFraction(value, { a, s }) {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (v <= 0) return 0
  if (v < a) return a > 0 ? 0.5 * (v / a) : 0.5
  if (v < s) return s > a ? 0.5 + 0.5 * ((v - a) / (s - a)) : 1
  return 1
}

/**
 * One-sided decision-relative mapping for MODEL-mode live bars (R30 MAJOR 3
 * — fix round 1; supersedes the earlier "plain P(ge1) is acceptable" call).
 * Real exported cutpoints sit nowhere near 0.5 and vary wildly per category
 * (brow ge1=0.9728, overall ge1=0.455) — rendering raw P(ge1) directly means
 * a brow bar at 90% is still scoring INACTIVE (cutpoint 0.9728) while an
 * overall bar at 50% is already ACTIVE (cutpoint 0.455), the exact opposite
 * of what the bar heights suggest. `activeThreshold` is this category's
 * ACTIVE ge1 cutpoint — the calibrated one if the nurse-validation loop has
 * moved it (calibrationStore.thresholds[cat].model?.ge1), else the model's
 * raw exported one — so "half full" tracks whatever cutpoint scoring will
 * actually use, same intent as displayFraction() above for the threshold
 * engine, just one-sided (there is no separate "strong" bar boundary the
 * live view needs to show).
 *
 *   p < c   -> 0.5 * p/c
 *   p >= c  -> 0.5 + 0.5*(p-c)/(1-c)
 *
 * @param {number} p raw P(ge1) (e.g. the EMA-smoothed live value, [0,1])
 * @param {number} activeThreshold this category's active ge1 cutpoint, in (0,1)
 * @returns {number} display fraction in [0,1]
 */
export function modelDisplayFraction(p, activeThreshold) {
  const value = typeof p === 'number' && Number.isFinite(p) ? p : 0
  const clamped = Math.min(1, Math.max(0, value))
  const c =
    typeof activeThreshold === 'number' &&
    Number.isFinite(activeThreshold) &&
    activeThreshold > 0 &&
    activeThreshold < 1
      ? activeThreshold
      : 0.5 // defensive fallback for a degenerate/missing threshold

  if (clamped < c) return 0.5 * (clamped / c)
  const denom = 1 - c
  return denom > 0 ? Math.min(1, 0.5 + 0.5 * ((clamped - c) / denom)) : 1
}
