import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CATEGORIES } from '../../src/facescan/features.js'
import {
  isValidModel,
  loadModel,
  buildFeatureVector,
  sigmoid,
  scoreHead,
  scoreFrame,
  estimateBaseline,
  sanitizePopulationFields,
  chooseBaseline,
} from '../../src/facescan/modelScore.js'

// A tiny, hand-computable 2-3 feature fixture model, honoring the real
// painface-scoring.v1.json contract (all five form categories, ge1/ge2
// heads sized to featureNames, cutpoints per category). Each test overrides
// only the pieces it needs via `overrides` (usually just one category).
function makeModel(featureNames, overrides = {}) {
  const n = featureNames.length
  const defaultHead = () => ({ weights: Array(n).fill(0), bias: 0 })
  const categories = {}
  for (const cat of CATEGORIES) {
    categories[cat] = {
      ge1: defaultHead(),
      ge2: defaultHead(),
      cutpoints: { ge1: 0.5, ge2: 0.5 },
      ...(overrides[cat] ?? {}),
    }
  }
  return { version: 1, featureMode: 'delta', featureNames, categories }
}

describe('modelScore — isValidModel', () => {
  it('accepts a well-formed tiny fixture model', () => {
    expect(isValidModel(makeModel(['a', 'b']))).toBe(true)
  })

  it('rejects non-objects and null', () => {
    expect(isValidModel(null)).toBe(false)
    expect(isValidModel(undefined)).toBe(false)
    expect(isValidModel('not a model')).toBe(false)
    expect(isValidModel(42)).toBe(false)
  })

  it('rejects a missing/empty featureNames array', () => {
    const model = makeModel(['a', 'b'])
    delete model.featureNames
    expect(isValidModel(model)).toBe(false)
    expect(isValidModel({ ...model, featureNames: [] })).toBe(false)
  })

  it('rejects a head whose weights length does not match featureNames', () => {
    const model = makeModel(['a', 'b', 'c'])
    model.categories.brow.ge1.weights = [1, 2] // only 2, featureNames has 3
    expect(isValidModel(model)).toBe(false)
  })

  it('rejects a category missing its ge2 head', () => {
    const model = makeModel(['a', 'b'])
    delete model.categories.eyes.ge2
    expect(isValidModel(model)).toBe(false)
  })

  it('rejects a category missing the cutpoints field entirely', () => {
    const model = makeModel(['a', 'b'])
    delete model.categories.mouth.cutpoints
    expect(isValidModel(model)).toBe(false)
  })

  it('rejects a category with only one of the two cutpoints', () => {
    const model = makeModel(['a', 'b'])
    model.categories.overall.cutpoints = { ge1: 0.5 } // ge2 missing
    expect(isValidModel(model)).toBe(false)
  })

  it('rejects a non-finite weight or bias', () => {
    const model = makeModel(['a', 'b'])
    model.categories.brow.ge1.weights = [1, NaN]
    expect(isValidModel(model)).toBe(false)
  })

  it('rejects a model missing an entire required category (noseCheek)', () => {
    const model = makeModel(['a', 'b'])
    delete model.categories.noseCheek
    expect(isValidModel(model)).toBe(false)
  })
})

describe('modelScore — loadModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the parsed model on a valid fetch', async () => {
    const model = makeModel(['a', 'b'])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => model })),
    )
    const result = await loadModel('/models/x.json')
    expect(result).toEqual(model)
  })

  it('falls back to null on a non-OK HTTP response (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    )
    await expect(loadModel('/missing.json')).resolves.toBeNull()
  })

  it('falls back to null when the fetch itself rejects (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    await expect(loadModel('/models/x.json')).resolves.toBeNull()
  })

  it('falls back to null when the body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      })),
    )
    await expect(loadModel('/models/x.json')).resolves.toBeNull()
  })

  it('falls back to null when the JSON parses but fails schema validation (missing cutpoints)', async () => {
    const model = makeModel(['a', 'b'])
    delete model.categories.brow.cutpoints
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => model })),
    )
    await expect(loadModel('/models/x.json')).resolves.toBeNull()
  })

  // R41: loadModel() runs sanitizePopulationFields() on every model that
  // passes isValidModel() — a malformed optional field must not survive
  // into the model the caller actually starts scoring against.
  it('sanitizes a malformed populationNeutral on the fetched model (schema-valid model, garbage optional field)', async () => {
    const model = makeModel(['a', 'b'])
    model.populationNeutral = 'not an object'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => model })),
    )
    const result = await loadModel('/models/x.json')
    expect(result).not.toBeNull()
    expect(result.populationNeutral).toBeUndefined()
  })
})

describe('modelScore — buildFeatureVector (projection order, R25/R26)', () => {
  const featureNames = ['browDownLeft', 'eyeSquintLeft', 'mouthPressLeft']

  it('projects strictly by featureNames order, ignoring the object key insertion order', () => {
    // Deliberately shuffled/reordered keys relative to featureNames, plus an
    // extra unknown key thrown in — landmarker.js's detect() returns an
    // unordered map and this must never assume its iteration order.
    const shuffledFrame = {
      mouthPressLeft: 0.9,
      unknownChannel: 0.42,
      browDownLeft: 0.4,
      eyeSquintLeft: 0.1,
    }
    const x = buildFeatureVector(featureNames, shuffledFrame, {})
    expect(x).toEqual([0.4, 0.1, 0.9])
  })

  it('a name missing from the frame contributes 0 for that slot', () => {
    const x = buildFeatureVector(featureNames, { browDownLeft: 0.4 }, {})
    expect(x).toEqual([0.4, 0, 0])
  })

  it('a name missing from the baseline contributes 0 baseline for that slot', () => {
    const x = buildFeatureVector(featureNames, { browDownLeft: 0.4 }, { eyeSquintLeft: 0.3 })
    expect(x).toEqual([0.4, -0.3, 0])
  })

  it('R26: delta is UNCLAMPED — a frame value below baseline stays negative', () => {
    const x = buildFeatureVector(['a'], { a: 0.1 }, { a: 0.5 })
    expect(x).toEqual([-0.4]) // NOT clamped to 0
  })
})

describe('modelScore — sigmoid/scoreHead/scoreFrame', () => {
  it('sigmoid(0) = 0.5, and output always stays within (0, 1) at extremes', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10)
    expect(sigmoid(1000)).toBeLessThanOrEqual(1)
    expect(sigmoid(1000)).toBeGreaterThan(0.999)
    expect(sigmoid(-1000)).toBeGreaterThanOrEqual(0)
    expect(sigmoid(-1000)).toBeLessThan(0.001)
  })

  it('scoreHead computes sigmoid(bias + weights.x)', () => {
    const head = { weights: [2, -1], bias: 0.5 }
    const x = [1, 1] // 2*1 + -1*1 = 1; + bias 0.5 = 1.5
    expect(scoreHead(head, x)).toBeCloseTo(sigmoid(1.5), 10)
  })

  it('R26 (adversarial): an unclamped NEGATIVE delta changes the score — a negative weight on a negative delta must INCREASE P, not sit at the clamped-zero value', () => {
    const model = makeModel(['a'], {
      brow: { ge1: { weights: [-5], bias: 0 }, cutpoints: { ge1: 0.5, ge2: 0.5 } },
    })
    // frame below baseline -> delta = -0.4 (negative, unclamped)
    const belowBaseline = scoreFrame(model, { a: 0.1 }, { a: 0.5 }).brow.pGe1
    // control: frame at baseline -> delta = 0
    const atBaseline = scoreFrame(model, { a: 0.1 }, { a: 0.1 }).brow.pGe1
    expect(belowBaseline).not.toBeCloseTo(atBaseline, 5)
    // sigmoid(0 + (-5)*(-0.4)) = sigmoid(2); sigmoid(0 + (-5)*0) = sigmoid(0) = 0.5
    expect(belowBaseline).toBeCloseTo(sigmoid(2), 10)
    expect(atBaseline).toBeCloseTo(0.5, 10)
    // A clamped-at-zero implementation would have floored the -0.4 delta to
    // 0 and produced the SAME 0.5 as the at-baseline control — this must not
    // happen.
    expect(belowBaseline).not.toBeCloseTo(0.5, 5)
  })

  // Fix round 1 minor (c): scoreFrame used to also return `active`/`strong`
  // booleans gated with `>=` against the raw cutpoints, but nothing
  // consumed them (useFaceScan.js only ever read pGe1/pGe2) and their
  // boundary convention diverged from pAbove's "strictly above" — the
  // definition that actually drives scoring. The cutpoint-not-0.5 contract
  // itself is still pinned, just one layer up now: scoring.test.js's
  // "uses the model cutpoints, not the (irrelevant...) thresholds argument"
  // exercises the SAME 0.6-probability-under-a-0.9-cutpoint shape through
  // scoreCategory(), which is what's actually reachable from a real capture.

  it('every category is present in scoreFrame output, exactly {pGe1, pGe2} — no other keys', () => {
    const model = makeModel(['a', 'b'])
    const result = scoreFrame(model, { a: 0.1, b: 0.2 }, {})
    for (const cat of CATEGORIES) {
      expect(Object.keys(result[cat]).sort()).toEqual(['pGe1', 'pGe2'])
    }
  })

  it('probabilities stay within [0,1] even for extreme deltas (spec item 6 invariant)', () => {
    const model = makeModel(['a'], {
      brow: { ge1: { weights: [1e6], bias: 0 }, ge2: { weights: [-1e6], bias: 0 } },
    })
    const result = scoreFrame(model, { a: 1000 }, { a: -1000 }).brow // delta = 2000
    expect(result.pGe1).toBeGreaterThanOrEqual(0)
    expect(result.pGe1).toBeLessThanOrEqual(1)
    expect(result.pGe2).toBeGreaterThanOrEqual(0)
    expect(result.pGe2).toBeLessThanOrEqual(1)
  })
})

describe('modelScore — estimateBaseline (spread sampling + MEAN, training addendum)', () => {
  it('empty input -> {}', () => {
    expect(estimateBaseline([])).toEqual({})
    expect(estimateBaseline(undefined)).toEqual({})
  })

  it('uses the MEAN, not the median — a single outlier shifts the baseline proportionally', () => {
    const frames = [{ a: 0.1 }, { a: 0.1 }, { a: 0.1 }, { a: 0.9 }]
    const baseline = estimateBaseline(frames, { sampleEvery: 1 })
    // mean = (0.1+0.1+0.1+0.9)/4 = 0.3; the median (0.1) must NOT be what
    // comes out — the training addendum measured median as actively worse.
    expect(baseline.a).toBeCloseTo(0.3, 10)
    expect(baseline.a).not.toBeCloseTo(0.1, 5)
  })

  it('samples SPREAD across the whole window (every Nth frame), not the first N consecutive', () => {
    // 12 frames: only indices 0, 4, 8 (sampleEvery=4) carry the real signal;
    // every other index is a wild outlier that a "first-3-consecutive"
    // estimator would wrongly include (indices 1 and 2).
    const frames = Array.from({ length: 12 }, (_, i) => ({ a: 1000 }))
    frames[0] = { a: 10 }
    frames[4] = { a: 20 }
    frames[8] = { a: 30 }
    const baseline = estimateBaseline(frames, { sampleEvery: 4 })
    expect(baseline.a).toBeCloseTo(20, 10) // mean(10, 20, 30)
    expect(baseline.a).not.toBeCloseTo(1000, 0)
  })

  it('averages independently per channel, ignoring non-finite/missing values', () => {
    const frames = [
      { a: 0.2, b: 0.4 },
      { a: 0.4 }, // b missing this frame
      { a: 0.6, b: Number.NaN }, // b non-finite this frame
    ]
    const baseline = estimateBaseline(frames, { sampleEvery: 1 })
    expect(baseline.a).toBeCloseTo(0.4, 10) // mean(0.2, 0.4, 0.6)
    expect(baseline.b).toBeCloseTo(0.4, 10) // only the one valid b contributes
  })
})

// R41: sanitizePopulationFields() — the optional populationNeutral /
// cutpointsPopulation fields must be stripped (with a console.warn) rather
// than fatal when malformed, so a corrupted optional field degrades to the
// legacy 'session' baseline path (chooseBaseline below) instead of ever
// invalidating the whole model file.
describe('modelScore — sanitizePopulationFields (R41)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a legacy model with neither field is left untouched and stays valid', () => {
    const model = makeModel(['a', 'b'])
    const result = sanitizePopulationFields(model)
    expect(result.populationNeutral).toBeUndefined()
    expect(result.categories.brow.cutpointsPopulation).toBeUndefined()
    expect(isValidModel(result)).toBe(true)
  })

  it('keeps a well-formed populationNeutral and per-category cutpointsPopulation', () => {
    const model = makeModel(['a', 'b'], {
      brow: { cutpointsPopulation: { ge1: 0.6, ge2: 0.8 } },
    })
    model.populationNeutral = { a: 0.2, b: 0.3 }
    const result = sanitizePopulationFields(model)
    expect(result.populationNeutral).toEqual({ a: 0.2, b: 0.3 })
    expect(result.categories.brow.cutpointsPopulation).toEqual({ ge1: 0.6, ge2: 0.8 })
    expect(isValidModel(result)).toBe(true)
  })

  it('strips a non-object populationNeutral, warns once, model still valid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const model = makeModel(['a', 'b'])
    model.populationNeutral = 'garbage'
    const result = sanitizePopulationFields(model)
    expect(result.populationNeutral).toBeUndefined()
    expect(isValidModel(result)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('strips a populationNeutral containing a non-finite channel value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const model = makeModel(['a', 'b'])
    model.populationNeutral = { a: Number.NaN }
    const result = sanitizePopulationFields(model)
    expect(result.populationNeutral).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('strips an empty-object populationNeutral (no channels)', () => {
    const model = makeModel(['a', 'b'])
    model.populationNeutral = {}
    const result = sanitizePopulationFields(model)
    expect(result.populationNeutral).toBeUndefined()
  })

  it('strips cutpointsPopulation for one category only, leaving the model otherwise valid and other categories untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const model = makeModel(['a', 'b'], {
      brow: { cutpointsPopulation: { ge1: 0.6 } }, // ge2 missing -> malformed
      eyes: { cutpointsPopulation: { ge1: 0.5488, ge2: 0.99 } }, // well-formed
    })
    const result = sanitizePopulationFields(model)
    expect(result.categories.brow.cutpointsPopulation).toBeUndefined()
    expect(result.categories.eyes.cutpointsPopulation).toEqual({ ge1: 0.5488, ge2: 0.99 })
    expect(isValidModel(result)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

// R41 layered serve-time baseline (spec §2): banked personal baseline beats
// the population-neutral default, which beats the legacy same-session
// capture — only reachable when the model has no usable populationNeutral.
describe('modelScore — chooseBaseline (R41)', () => {
  it('legacy model (no populationNeutral), no banked baseline -> session', () => {
    const model = makeModel(['a', 'b'])
    expect(isValidModel(model)).toBe(true)
    expect(chooseBaseline(model, null)).toEqual({ source: 'session' })
    expect(chooseBaseline(model, undefined)).toEqual({ source: 'session' })
    expect(chooseBaseline(model, {})).toEqual({ source: 'session' }) // empty banked == absent
  })

  it('banked baseline beats the population default even when both are available', () => {
    const model = makeModel(['a', 'b'])
    model.populationNeutral = { a: 0.2, b: 0.3 }
    const banked = { a: 0.1, b: 0.15 }
    const choice = chooseBaseline(model, banked)
    expect(choice.source).toBe('banked')
    expect(choice.baseline).toBe(banked)
    // banked capture uses the model's ORIGINAL exported (personal-delta)
    // cutpoints, per category, regardless of any cutpointsPopulation.
    expect(choice.cutpointsFor('brow')).toEqual(model.categories.brow.cutpoints)
  })

  it('population default picked when no banked baseline, using cutpointsPopulation per category when present', () => {
    const model = makeModel(['a', 'b'], {
      brow: { cutpointsPopulation: { ge1: 0.99, ge2: 0.99 } },
    })
    model.populationNeutral = { a: 0.2, b: 0.3 }
    const choice = chooseBaseline(model, null)
    expect(choice.source).toBe('default')
    expect(choice.baseline).toBe(model.populationNeutral)
    expect(choice.cutpointsFor('brow')).toEqual({ ge1: 0.99, ge2: 0.99 })
  })

  it('population default falls back to the exported cutpoints for a category lacking cutpointsPopulation', () => {
    const model = makeModel(['a', 'b'])
    model.populationNeutral = { a: 0.2, b: 0.3 } // no category carries cutpointsPopulation
    const choice = chooseBaseline(model, null)
    expect(choice.source).toBe('default')
    expect(choice.cutpointsFor('eyes')).toEqual(model.categories.eyes.cutpoints)
  })
})

// Fix round 1 minor (a): every other test in this file uses a synthetic
// fixture — nothing previously asserted the REAL committed model file still
// satisfies isValidModel(). A schema drift there degrades the whole wave to
// the threshold-engine fallback silently (loadModel() logs a warning but
// the app "just works" in the demo, so this is exactly the kind of
// regression that survives to a live nurse-facing session unnoticed).
describe('modelScore — the real committed model file', () => {
  const REAL_MODEL_PATH = fileURLToPath(
    new URL('../../public/models/painface-scoring.v1.json', import.meta.url),
  )

  it('public/models/painface-scoring.v1.json passes isValidModel() and has all 52 features', () => {
    const model = JSON.parse(readFileSync(REAL_MODEL_PATH, 'utf-8'))
    expect(isValidModel(model)).toBe(true)
    expect(model.featureNames).toHaveLength(52)
  })

  // R41: the real shipped file already carries populationNeutral +
  // cutpointsPopulation (training/export_population_fields.py) — sanitize
  // must keep BOTH intact (not just tolerate their absence), and
  // chooseBaseline() must actually pick the 'default' path off it.
  it('sanitizePopulationFields keeps populationNeutral and cutpointsPopulation from the real file, model still valid', () => {
    const model = JSON.parse(readFileSync(REAL_MODEL_PATH, 'utf-8'))
    const result = sanitizePopulationFields(model)
    expect(isValidModel(result)).toBe(true)
    expect(result.populationNeutral).toBeTruthy()
    expect(Object.keys(result.populationNeutral).length).toBeGreaterThan(0)
    for (const cat of CATEGORIES) {
      expect(result.categories[cat].cutpointsPopulation).toBeTruthy()
    }
    const choice = chooseBaseline(result, null)
    expect(choice.source).toBe('default')
  })
})
