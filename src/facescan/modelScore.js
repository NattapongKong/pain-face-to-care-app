// Trained pain-scoring model integration (spec §10.2 item 3, ruling R19;
// R25 dead noseCheek channels; R26 unclamped deltas; R27 same-session
// baseline only; wave-4b). Pure JS + fetch — no Vue imports; the runtime
// orchestration (two-phase capture, live EMA smoothing, wiring into the
// tick loop) lives in useFaceScan.js, which is allowed to import this
// module. Model contract: public/models/painface-scoring.v1.json —
//   { version, featureMode: 'delta', featureNames: string[52],
//     categories: { <cat>: { ge1: {weights, bias}, ge2: {weights, bias},
//                             cutpoints: {ge1, ge2} } }, meta }
// Score of head h on feature vector x: sigmoid(bias + dot(weights, x)).

import { CATEGORIES } from './features.js'

// Fetched relative to the app root, exactly like landmarker.js's
// LOCAL_MODEL_PATH for face_landmarker.task — this file is NOT bundled by
// Vite (it lives under public/), it's a plain runtime fetch.
export const MODEL_URL = '/models/painface-scoring.v1.json'

// --------------------------------------------------------------------------
// Schema validation — anything short of this must fall back to the
// threshold engine (spec R9-style "never a dead scan" / plan item 7) rather
// than half-trust a malformed or partial model file.
// --------------------------------------------------------------------------

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

function isValidHead(head, featureCount) {
  return (
    !!head &&
    typeof head === 'object' &&
    Array.isArray(head.weights) &&
    head.weights.length === featureCount &&
    head.weights.every(isFiniteNumber) &&
    isFiniteNumber(head.bias)
  )
}

function isValidCategoryModel(categoryModel, featureCount) {
  if (!categoryModel || typeof categoryModel !== 'object') return false
  if (!isValidHead(categoryModel.ge1, featureCount)) return false
  if (!isValidHead(categoryModel.ge2, featureCount)) return false
  const cutpoints = categoryModel.cutpoints
  if (!cutpoints || typeof cutpoints !== 'object') return false
  if (!isFiniteNumber(cutpoints.ge1) || !isFiniteNumber(cutpoints.ge2)) return false
  return true
}

/**
 * Validate the painface-scoring.v1.json contract end to end: a non-empty
 * featureNames array of strings, and every one of the five form categories
 * present with ge1/ge2 heads sized to match featureNames plus both
 * cutpoints. Extra/unknown fields (e.g. `meta`) are ignored.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isValidModel(model) {
  if (!model || typeof model !== 'object') return false
  if (!Array.isArray(model.featureNames) || model.featureNames.length === 0) return false
  if (!model.featureNames.every((n) => typeof n === 'string' && n.length > 0)) return false
  if (!model.categories || typeof model.categories !== 'object') return false

  const featureCount = model.featureNames.length
  for (const cat of CATEGORIES) {
    if (!isValidCategoryModel(model.categories[cat], featureCount)) return false
  }
  return true
}

// --------------------------------------------------------------------------
// R41: layered serve-time baseline (spec §2) — the wizard scan's single
// capture never contaminates its own baseline with the patient's current
// (possibly already-in-pain) face. `populationNeutral`/`cutpointsPopulation`
// are OPTIONAL model-JSON fields (backward compatible — isValidModel above
// does not require them); these two pure helpers validate/consume them.
// See useFaceScan.js's beginCapture() for how chooseBaseline() is wired in.
// --------------------------------------------------------------------------

// R41: optional serve-time fields. Malformed optional fields are stripped
// (warn once), never fatal — a legacy model file must stay valid.
export function sanitizePopulationFields(model) {
  const out = model
  const pn = out.populationNeutral
  const pnValid =
    !!pn && typeof pn === 'object' && !Array.isArray(pn) &&
    Object.keys(pn).length > 0 &&
    Object.entries(pn).every(([k, v]) => typeof k === 'string' && isFiniteNumber(v))
  if (pn !== undefined && !pnValid) {
    console.warn('[facescan] populationNeutral malformed — ignoring the field.')
    delete out.populationNeutral
  }
  for (const cat of CATEGORIES) {
    const cp = out.categories?.[cat]?.cutpointsPopulation
    if (cp === undefined) continue
    if (!cp || typeof cp !== 'object' || !isFiniteNumber(cp.ge1) || !isFiniteNumber(cp.ge2)) {
      console.warn(`[facescan] cutpointsPopulation malformed for ${cat} — ignoring.`)
      delete out.categories[cat].cutpointsPopulation
    }
  }
  return out
}

/**
 * R41 layered serve-time baseline. Returns which baseline the capture should
 * subtract and which cutpoint set finishCapture() must embed:
 * {source:'banked', baseline, cutpointsFor(cat)} |
 * {source:'default', ...} | {source:'session'} (legacy two-phase).
 */
export function chooseBaseline(model, bankedBaseline) {
  const banked =
    !!bankedBaseline && typeof bankedBaseline === 'object' &&
    !Array.isArray(bankedBaseline) && Object.keys(bankedBaseline).length > 0
  if (banked) {
    return { source: 'banked', baseline: bankedBaseline,
             cutpointsFor: (cat) => model.categories[cat].cutpoints }
  }
  if (model.populationNeutral) {
    return { source: 'default', baseline: model.populationNeutral,
             cutpointsFor: (cat) =>
               model.categories[cat].cutpointsPopulation ?? model.categories[cat].cutpoints }
  }
  return { source: 'session' }
}

// --------------------------------------------------------------------------
// Fetch
// --------------------------------------------------------------------------

/**
 * Fetch + validate the trained scoring model. Never throws — callers get
 * `null` on any failure (network error, non-OK response, malformed JSON,
 * schema/cutpoints mismatch) and are expected to fall back to the existing
 * threshold engine. Logs once per failed load attempt (not per-frame).
 * @param {string} [url]
 * @returns {Promise<object|null>}
 */
export async function loadModel(url = MODEL_URL) {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(
        `[facescan] scoring model fetch failed (HTTP ${res.status}) — falling back to the threshold engine.`,
      )
      return null
    }
    const model = await res.json()
    if (!isValidModel(model)) {
      console.warn(
        '[facescan] scoring model failed schema validation (missing featureNames/categories/cutpoints) — falling back to the threshold engine.',
      )
      return null
    }
    // R41: strip malformed optional population fields (warn once); the
    // model itself has already passed isValidModel() above so this can
    // never turn a valid load into a null one.
    return sanitizePopulationFields(model)
  } catch (err) {
    console.warn(
      '[facescan] scoring model load threw — falling back to the threshold engine.',
      err,
    )
    return null
  }
}

// --------------------------------------------------------------------------
// Feature projection — R26: UNCLAMPED baseline-relative delta.
// --------------------------------------------------------------------------

/**
 * Project one frame's blendshape map into the model's feature vector, in
 * the JSON's featureNames order. landmarker.js's detect() returns an
 * UNORDERED name->score object — never assume its key order; this always
 * walks featureNames instead. x[i] = frame[name] - baseline[name],
 * deliberately UNCLAMPED (R26 — the exported model is fitted on unclamped
 * baseline-subtracted deltas; flooring negative deltas at 0 here would be
 * train/serve skew: measured unclamped mean ge1 AUROC 0.877 vs clamped
 * 0.865). A name missing from either map contributes 0 for that side.
 * @param {string[]} featureNames
 * @param {Record<string, number>} [frame]
 * @param {Record<string, number>} [baseline]
 * @returns {number[]}
 */
export function buildFeatureVector(featureNames, frame = {}, baseline = {}) {
  return featureNames.map((name) => {
    const frameValue = isFiniteNumber(frame[name]) ? frame[name] : 0
    const baselineValue = isFiniteNumber(baseline[name]) ? baseline[name] : 0
    return frameValue - baselineValue // NOT clamped to >= 0 — see R26 above.
  })
}

/** Standard logistic sigmoid, mapping any real number into (0, 1). */
export function sigmoid(z) {
  return 1 / (1 + Math.exp(-z))
}

function dot(weights, x) {
  let sum = 0
  for (let i = 0; i < weights.length; i++) sum += weights[i] * x[i]
  return sum
}

/**
 * P(head fires) for one logistic head on a feature vector:
 * sigmoid(bias + weights·x).
 * @param {{weights:number[], bias:number}} head
 * @param {number[]} x
 * @returns {number}
 */
export function scoreHead(head, x) {
  return sigmoid(head.bias + dot(head.weights, x))
}

/**
 * Score every category for one frame against a (possibly empty) baseline:
 * just P(ge1) and P(ge2) — the two raw logistic-head probabilities. This
 * does NOT gate them against cutpoints itself (fix round 1, minor c): an
 * earlier revision also returned per-frame `active`/`strong` booleans
 * computed with `>=` against the model's raw exported cutpoints, but
 * nothing ever consumed them — the REAL active/strong gating happens later,
 * in scoring.js's scoreCategory(), via `pAbove()` over the accumulated
 * P(ge1)/P(ge2) decile profiles (spec item 6's "recomputable from the
 * deciles" design, which is also what makes model-threshold RECALIBRATION
 * possible, R30 — a frozen per-frame boolean baked in at capture time
 * against a fixed cutpoint cannot be re-evaluated against a later
 * candidate cutpoint). Shipping both was two competing definitions of
 * "active" (this file's `>=`, profile.js's `pAbove` "strictly above") with
 * one of them dead code; keeping only the one that's actually used removes
 * the divergence entirely rather than reconciling two boundary conventions.
 * Cutpoints (raw or calibrated) are applied by the caller: useFaceScan.js
 * embeds the model's raw cutpoints into the captured profile
 * (`profile.model.cutpoints`), and scoring.js's scoreCategory() reads
 * calibrated model thresholds when available, falling back to those raw
 * ones otherwise.
 * @param {object} model a model that has already passed isValidModel()
 * @param {Record<string, number>} frame
 * @param {Record<string, number>} [baseline]
 * @returns {Record<string, {pGe1:number, pGe2:number}>}
 */
export function scoreFrame(model, frame, baseline = {}) {
  const x = buildFeatureVector(model.featureNames, frame, baseline)
  const result = {}
  for (const cat of CATEGORIES) {
    const categoryModel = model.categories[cat]
    result[cat] = {
      pGe1: scoreHead(categoryModel.ge1, x),
      pGe2: scoreHead(categoryModel.ge2, x),
    }
  }
  return result
}

// --------------------------------------------------------------------------
// Neutral baseline estimator (spec item 4, corrected by the training
// addendum — training/REPORT.md "Known limitations" #8, folded into R27).
// --------------------------------------------------------------------------

const DEFAULT_BASELINE_SAMPLE_EVERY = 4

/**
 * Estimate the neutral baseline vector from frames collected during the
 * two-phase capture's baseline window.
 *
 * Protocol (measured on held-out subjects, training/REPORT.md limitation 8
 * / R27 — an earlier draft of this brief specified median + no spread
 * requirement; the addendum below OVERRIDES that and is what's implemented
 * here):
 *   - sample SPREAD evenly across the whole >=4s baseline window, not one
 *     consecutive burst: 60 consecutive frames from a single ~2s window
 *     scored mean ge1 0.749 (MAE 2.22); the same frame count spread across
 *     the window scored 0.785 (MAE 1.79) — free improvement, pure change in
 *     *when* frames are sampled, not how many.
 *   - aggregate per-channel with the MEAN, not the median. The median was
 *     tested specifically to resist momentary-pose contamination but
 *     measured WORSE: 0.785 -> 0.745 on the spread protocol (noseCheek
 *     0.936 -> 0.837), because blendshape channels are floored at 0 and
 *     heavily right-skewed — for a mostly-inactive channel the median sits
 *     on the floor and discards the tail that carries the person's
 *     characteristic resting activation, which is exactly the offset the
 *     baseline exists to capture.
 *
 * A pure function of the collected frame array so the sampling/aggregation
 * protocol stays swappable without touching the capture loop.
 *
 * @param {Array<Record<string, number>>} frames blendshape maps collected
 *   throughout the ENTIRE baseline window (not just the first N) — sparse
 *   sampling only yields "spread" coverage if the input already spans the
 *   full window; the caller (useFaceScan.js) is responsible for that.
 * @param {{sampleEvery?: number}} [options] take every Nth collected frame
 *   (default every 4th) before averaging.
 * @returns {Record<string, number>} channel name -> mean value. Empty
 *   object for no usable frames (equivalent to an all-zero baseline).
 */
export function estimateBaseline(frames, { sampleEvery = DEFAULT_BASELINE_SAMPLE_EVERY } = {}) {
  const all = Array.isArray(frames) ? frames : []
  if (all.length === 0) return {}

  const step = Math.max(1, Math.floor(sampleEvery))
  const sampled = []
  for (let i = 0; i < all.length; i += step) sampled.push(all[i])
  const usable = sampled.length > 0 ? sampled : all

  const sums = {}
  const counts = {}
  for (const frame of usable) {
    if (!frame || typeof frame !== 'object') continue
    for (const [name, value] of Object.entries(frame)) {
      if (!isFiniteNumber(value)) continue
      sums[name] = (sums[name] ?? 0) + value
      counts[name] = (counts[name] ?? 0) + 1
    }
  }

  const baseline = {}
  for (const name of Object.keys(sums)) {
    baseline[name] = sums[name] / counts[name]
  }
  return baseline
}
