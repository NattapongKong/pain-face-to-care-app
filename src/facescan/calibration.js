// Real improvement loop: grid-search recalibration of per-category
// thresholds against nurse-confirmed labeled samples. Pure JS, no raw
// frames needed — only the compact decile profiles. Spec §5.4 / plan Task
// 3, extended by R30 (fix round 1) with a SEPARATE model-engine calibration
// path (recalibrateModel) — see its doc comment.

import { CATEGORIES } from './features.js'
import { DEFAULT_THRESHOLDS, scoreCategory } from './scoring.js'

const MIN_SAMPLES = 3

function round2(x) {
  return Math.round(x * 100) / 100
}

// A sample's profile for category `cat` is model-scored iff it carries the
// `.model` marker useFaceScan.js's finishCapture() stamps on every category
// uniformly in model mode (see scoring.js's scoreCategory doc comment) —
// this is the "key off the .model marker already present" reading of R30's
// engine-tag requirement: it's already reliably embedded per-category in
// every sample this app produces, so no separate persisted `engine` field
// is needed, and ValidatePanel.vue (outside this wave's ownership) never
// has to be touched to add one.
function isModelProfile(profile) {
  return !!(profile && profile.model)
}

// R30 BLOCKER 2 fix: only THRESHOLD-engine profiles for `cat` are relevant
// here — a model-scored sample is structurally useless to this grid search
// anyway (scoreCategory() ignores {a,s} whenever profile.model is set, so
// every grid point predicts identically and the flattened error surface
// degenerates to the distance tie-break, silently dragging (a,s) toward
// whichever corner is nearest default — this is exactly how 3 agreeing
// model-mode validations rewrote R28's noseCheek 0.02 -> 0.10 with zero
// actual information). Excluding them here closes that poisoning route at
// the source: model-mode samples never reach bestThresholdFor at all.
function relevantThresholdSamples(samples, cat) {
  return samples.filter(
    (sample) =>
      sample &&
      sample.profiles &&
      sample.profiles[cat] &&
      !isModelProfile(sample.profiles[cat]) &&
      sample.confirmed &&
      sample.confirmed[cat] !== undefined &&
      sample.confirmed[cat] !== null,
  )
}

function bestThresholdFor(cat, samples, def) {
  let best = null

  for (let aCents = 10; aCents <= 60; aCents += 5) {
    const a = round2(aCents / 100)
    for (let sCents = aCents + 10; sCents <= 80; sCents += 5) {
      const s = round2(sCents / 100)

      let errors = 0
      for (const sample of samples) {
        const predicted = scoreCategory(sample.profiles[cat], { a, s })
        if (predicted !== sample.confirmed[cat]) errors += 1
      }

      const distance = Math.abs(a - def.a) + Math.abs(s - def.s)

      if (
        best === null ||
        errors < best.errors ||
        (errors === best.errors && distance < best.distance)
      ) {
        best = { a, s, errors, distance }
      }
    }
  }

  return { a: best.a, s: best.s }
}

/**
 * Threshold-engine (non-model) recalibration — UNCHANGED behavior from
 * before R30, except its sample filter now excludes model-scored samples
 * (BLOCKER 2 above) so it can never be poisoned by them.
 * @param {Array<{profiles: Record<string, {deciles:number[]}>, confirmed: Record<string, 0|1|2>}>} samples
 * @param {Record<string, {a:number, s:number}>} [defaults]
 * @returns {Record<string, {a:number, s:number}>}
 */
export function recalibrate(samples = [], defaults = DEFAULT_THRESHOLDS) {
  const thresholds = {}

  for (const cat of CATEGORIES) {
    const relevant = relevantThresholdSamples(samples, cat)
    if (relevant.length < MIN_SAMPLES) {
      thresholds[cat] = { ...defaults[cat] }
      continue
    }
    thresholds[cat] = bestThresholdFor(cat, relevant, defaults[cat])
  }

  return thresholds
}

// --------------------------------------------------------------------------
// R30 BLOCKER 1 — model-engine calibration (fix round 1).
//
// The threshold engine's (a,s) grid search cannot calibrate model-scored
// captures: scoreCategory() ignores {a,s} whenever profile.model is set, so
// every one of the 121 grid points predicts the SAME class for a model-mode
// sample — 10 nurse corrections leave the proposal byte-identical. This is
// a SEPARATE grid search over the (ge1Cutpoint, ge2Cutpoint) pair that
// scoreCategory()'s model branch actually reads (via thresholds.model).
// --------------------------------------------------------------------------

const MODEL_GRID_RADIUS = 0.25
const MODEL_GRID_STEP = 0.05
const MODEL_CUT_MIN = 0.01
const MODEL_CUT_MAX = 0.99

// Only MODEL-scored profiles for `cat` (mirror image of
// relevantThresholdSamples above — BLOCKER 2's other half: threshold-mode
// samples must never move a model threshold either).
function relevantModelSamples(samples, cat) {
  return samples.filter(
    (sample) =>
      sample &&
      sample.profiles &&
      isModelProfile(sample.profiles[cat]) &&
      sample.confirmed &&
      sample.confirmed[cat] !== undefined &&
      sample.confirmed[cat] !== null,
  )
}

// Grid of candidate cutpoints centered on `center` (an exported cutpoint),
// spanning +/- MODEL_GRID_RADIUS in MODEL_GRID_STEP increments, clamped to
// [MODEL_CUT_MIN, MODEL_CUT_MAX] — R30's exact bounds. Cent-based stepping
// (like bestThresholdFor's a/s loop) avoids float-accumulation drift.
// Anchored ON the center, not on the clamped lower bound (re-review round 2):
// stepping from the clamped `lo` meant the exported cutpoint itself was never
// a candidate unless it happened to be a 0.05-multiple away — so 3 AGREEING
// validations still drifted every cutpoint, and brow (exported ge1 0.9728)
// got a grid living entirely BELOW its cutpoint: the weakest-precision head
// could only ever be made MORE trigger-happy, never less. k=0 now guarantees
// the exported value is always a candidate, and the clamp still bounds both
// ends; clamp-collapsed duplicates at the edges are deduped.
function gridAround(center) {
  const centerCents = Math.round(center * 100)
  const stepCents = Math.round(MODEL_GRID_STEP * 100)
  const radiusSteps = Math.round(MODEL_GRID_RADIUS / MODEL_GRID_STEP)
  const loCents = Math.round(MODEL_CUT_MIN * 100)
  const hiCents = Math.round(MODEL_CUT_MAX * 100)

  const values = []
  for (let k = -radiusSteps; k <= radiusSteps; k += 1) {
    const c = Math.min(hiCents, Math.max(loCents, centerCents + k * stepCents))
    const value = round2(c / 100)
    if (!values.includes(value)) values.push(value)
  }
  // The UNROUNDED exported cutpoint is always a candidate too (cent-stepping
  // rounds 0.9728 → 0.97, which would still drift a fully-agreeing category
  // by up to half a cent): with the L1-nearest-exported tie-break, unanimous
  // agreement now reproduces the exported value exactly.
  const exact = Math.min(MODEL_CUT_MAX, Math.max(MODEL_CUT_MIN, center))
  if (!values.includes(exact)) values.push(exact)
  return values
}

// Deliberately NO s>a / ge2>ge1 ordering constraint (R30) — the ge1 and ge2
// heads are independent logistic regressions with independently-chosen
// cutpoints; 4 of the 5 exported ge2 cutpoints already sit BELOW their
// paired ge1 (e.g. brow ge1=0.9728 vs ge2=0.9507). The two grids are
// searched as a full cross product with no cross-constraint.
function bestModelCutpointsFor(cat, samples, exportedCutpoints) {
  const ge1Grid = gridAround(exportedCutpoints.ge1)
  const ge2Grid = gridAround(exportedCutpoints.ge2)

  let best = null
  for (const ge1 of ge1Grid) {
    for (const ge2 of ge2Grid) {
      let errors = 0
      for (const sample of samples) {
        const predicted = scoreCategory(sample.profiles[cat], { model: { ge1, ge2 } })
        if (predicted !== sample.confirmed[cat]) errors += 1
      }

      // Tie-break nearest the EXPORTED cutpoints (not DEFAULT_THRESHOLDS —
      // there is no meaningful "default" for a probability cutpoint outside
      // what the model itself shipped with).
      const distance = Math.abs(ge1 - exportedCutpoints.ge1) + Math.abs(ge2 - exportedCutpoints.ge2)

      if (
        best === null ||
        errors < best.errors ||
        (errors === best.errors && distance < best.distance)
      ) {
        best = { ge1, ge2, errors, distance }
      }
    }
  }

  return { ge1: best.ge1, ge2: best.ge2 }
}

/**
 * Model-engine recalibration (R30 BLOCKER 1 fix). Per category, grid-
 * searches (ge1Cutpoint, ge2Cutpoint) independently within +/-0.25 of that
 * category's EXPORTED cutpoint (embedded in the relevant samples'
 * `profile.model.cutpoints` — every model-mode sample carries it, so no
 * separate model reference needs to be threaded in here), step 0.05,
 * clamped to [0.01, 0.99], no ordering constraint between ge1/ge2,
 * tie-broken toward the exported cutpoints. Same min-3-samples floor as
 * the threshold engine.
 * @param {Array<{profiles: Record<string, object>, confirmed: Record<string, 0|1|2>}>} samples
 * @returns {Record<string, {ge1:number, ge2:number}|null>} per category —
 *   `null` means "fewer than 3 model-mode samples for this category yet";
 *   scoring.js's scoreCategory() falls back to the profile's own raw
 *   exported cutpoints in that case (spec R9-style graceful default).
 */
export function recalibrateModel(samples = []) {
  const thresholds = {}

  for (const cat of CATEGORIES) {
    const relevant = relevantModelSamples(samples, cat)
    if (relevant.length < MIN_SAMPLES) {
      thresholds[cat] = null
      continue
    }
    // Post-R41 (layered serve-time baseline) relevant samples do NOT all
    // necessarily carry identical embedded cutpoints — a capture embeds
    // whichever set was active for it (the model's exported/personal-delta
    // cutpoints, or R41's population-baseline set), and R43's epoch reset
    // only guarantees every surviving model-mode sample postdates R41, not
    // that they all used the same source. The most recent sample's
    // embedded cutpoints are still used as the grid anchor — a reasonable
    // reference point, not a claim of uniformity.
    const exportedCutpoints = relevant[relevant.length - 1].profiles[cat].model.cutpoints
    thresholds[cat] = bestModelCutpointsFor(cat, relevant, exportedCutpoints)
  }

  return thresholds
}
