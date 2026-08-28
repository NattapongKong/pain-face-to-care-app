// useFaceScan.js — countdown phase, banked-baseline capture, and
// baseline-only capture (plan Task 3 / spec §7, ruling R38). Drives the
// module's rAF loop manually: requestAnimationFrame/cancelAnimationFrame are
// stubbed to capture the scheduled tick() callback so each simulated video
// frame is fired by hand with a controlled tsMs, exactly like the loop would
// be driven in a browser but without a real camera/landmarker/model.
//
// landmarker.js and modelScore.js are mocked — this file exercises only
// useFaceScan.js's own orchestration (phase sequencing, timing, wiring),
// never a real WASM graph or the trained model's math (those are covered by
// their own test files).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFaceScan } from '../../src/facescan/useFaceScan.js'
import { createLandmarker } from '../../src/facescan/landmarker.js'
import { loadModel, scoreFrame, estimateBaseline } from '../../src/facescan/modelScore.js'
import { CATEGORIES } from '../../src/facescan/features.js'

vi.mock('../../src/facescan/landmarker.js', () => ({
  createLandmarker: vi.fn(),
}))

// R41: loadModel/scoreFrame/estimateBaseline stay fully mocked (network/
// timer/aggregation behavior this file's tests drive by hand, frame by
// frame) — but chooseBaseline() is a pure, dependency-free selection
// function over whatever model fixture a test hands in, so it runs for
// REAL here via importOriginal (its own decision logic is exhaustively
// unit-tested in modelScore.test.js). This also means every pre-R41 test
// below that never mentions populationNeutral still exercises the exact
// same 'session'/'banked' behavior it always did, unmodified.
vi.mock('../../src/facescan/modelScore.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    loadModel: vi.fn(),
    scoreFrame: vi.fn(),
    estimateBaseline: vi.fn(),
  }
})

// Legacy-shaped fixture: no populationNeutral -> chooseBaseline() (real
// implementation, see the mock above) falls through to the 'session'
// (two-phase, in-session baseline capture) path.
function makeModelFixture() {
  const categories = {}
  for (const cat of CATEGORIES) {
    categories[cat] = { cutpoints: { ge1: 0.5, ge2: 0.7 } }
  }
  return { categories }
}

// R41 fixture: carries a populationNeutral vector and a cutpointsPopulation
// per category, distinct from `cutpoints` so tests can tell which set
// finishCapture() actually embedded.
function makeModelFixtureWithPopulation() {
  const categories = {}
  for (const cat of CATEGORIES) {
    categories[cat] = {
      cutpoints: { ge1: 0.5, ge2: 0.7 },
      cutpointsPopulation: { ge1: 0.99, ge2: 0.99 },
    }
  }
  return { categories, populationNeutral: { browDownLeft: 0.05, browDownRight: 0.05 } }
}

function makeVideo() {
  return {
    readyState: 2,
    videoWidth: 640,
    videoHeight: 480,
    srcObject: null,
    error: null,
    play: vi.fn().mockResolvedValue(undefined),
  }
}

// R4-T5 fix round 1 MAJOR 2/minor 3: `facingMode` is optional and only used
// by the toggleFacing() reconciliation tests below — every pre-existing
// call site still calls makeStream() with no argument, and the resulting
// track's getSettings() just reports nothing, exactly as before this round
// (no getSettings() call at all existed on this fixture previously).
function makeStream(facingMode) {
  const track = {
    stop: vi.fn(),
    readyState: 'live',
    getSettings: () => (facingMode ? { facingMode } : {}),
  }
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    _track: track,
  }
}

const FACE = { browDownLeft: 0.4, browDownRight: 0.4 }

let rafCallback
let rafHandle
let detectMock

beforeEach(() => {
  rafHandle = 0
  rafCallback = null

  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb) => {
      rafCallback = cb
      return ++rafHandle
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn(() => {
      rafCallback = null
    }),
  )
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue(makeStream()),
    },
  })

  detectMock = vi.fn()
  createLandmarker.mockReset().mockResolvedValue({
    source: 'local',
    detect: detectMock,
    close: vi.fn(),
  })
  loadModel.mockReset().mockResolvedValue(null)
  scoreFrame.mockReset().mockReturnValue(
    Object.fromEntries(CATEGORIES.map((cat) => [cat, { pGe1: 0.1, pGe2: 0.05 }])),
  )
  estimateBaseline.mockReset().mockReturnValue({ browDownLeft: 0.1 })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function startScan({ model = null } = {}) {
  loadModel.mockResolvedValue(model)
  const scan = useFaceScan()
  const video = makeVideo()
  await scan.start(video)
  return scan
}

// Fires one simulated video frame: configures what the (mocked) landmarker
// detects on this frame, then invokes the currently-scheduled rAF callback
// with tsMs. tick() reschedules itself via the same stub, so calling this
// repeatedly drives the loop frame by frame.
function fireFrame(tsMs, blendshapes) {
  detectMock.mockReturnValueOnce(blendshapes)
  const cb = rafCallback
  rafCallback = null
  cb(tsMs)
}

// Drives N frames spaced dtMs apart starting from `startTs`, returns the
// last tsMs used. The very first frame after any phase entry always primes
// that phase's internal clock (dt=0 against it) per the existing
// advancePhase idiom — callers account for that when picking frame counts.
function driveFrames(startTs, count, dtMs, blendshapes) {
  let ts = startTs
  for (let i = 0; i < count; i++) {
    fireFrame(ts, blendshapes)
    ts += dtMs
  }
  return ts
}

describe('useFaceScan — countdown + banked/baseline-only capture', () => {
  it('two-phase model mode: countdown(3) -> baseline -> countdown(3) -> capturing -> done, frames not collected during either countdown', async () => {
    const scan = await startScan({ model: makeModelFixture() })
    expect(scan.state.scoringEngine).toBe('model-v1')

    scan.beginCapture(5000)
    expect(scan.state.phase).toBe('countdown')
    expect(scan.state.countdownNext).toBe('baseline')
    expect(scan.state.countdownSeconds).toBe(3)

    let ts = 0
    // Prime (dt=0, still 3) then three 1000ms steps: 3 -> 2 -> 1 -> transition.
    fireFrame(ts, FACE)
    expect(scan.state.countdownSeconds).toBe(3)
    ts += 1000
    fireFrame(ts, FACE)
    expect(scan.state.countdownSeconds).toBe(2)
    expect(scan.state.faceDetected).toBe(true) // countdown frames still update faceDetected
    ts += 1000
    fireFrame(ts, FACE)
    expect(scan.state.countdownSeconds).toBe(1)
    ts += 1000
    fireFrame(ts, FACE) // elapsed hits 3000 -> completes into 'baseline'
    expect(scan.state.phase).toBe('baseline')
    // R41: a legacy model (no populationNeutral) takes the 'session' path —
    // the only case where the wizard still runs the two-phase in-session
    // baseline capture.
    expect(scan.state.baselineSource).toBe('session')

    // Baseline phase must not have seen any of the 4 countdown frames.
    expect(estimateBaseline).not.toHaveBeenCalled()

    // Drive the 4s baseline window: prime + four 1000ms steps.
    ts = driveFrames(ts + 1000, 5, 1000, FACE)
    expect(estimateBaseline).toHaveBeenCalledTimes(1)
    // Exactly the 5 baseline-phase frames were collected — none from countdown.
    expect(estimateBaseline.mock.calls[0][0]).toHaveLength(5)

    // Baseline completion enters a SECOND countdown, not capturing directly.
    expect(scan.state.phase).toBe('countdown')
    expect(scan.state.countdownNext).toBe('capturing')
    expect(scan.state.countdownSeconds).toBe(3)

    ts = driveFrames(ts, 4, 1000, FACE)
    expect(scan.state.phase).toBe('capturing')

    ts = driveFrames(ts, 6, 1000, FACE) // prime + five 1000ms steps = 5000ms
    expect(scan.state.phase).toBe('done')
    expect(scan.state.profiles).not.toBeNull()
    for (const cat of CATEGORIES) {
      expect(scan.state.profiles[cat].model.cutpoints).toEqual({ ge1: 0.5, ge2: 0.7 })
    }
  })

  it('countdown advances to completion even when no face is detected', async () => {
    const scan = await startScan({ model: null }) // threshold engine
    scan.beginCapture(5000)
    expect(scan.state.phase).toBe('countdown')

    let ts = 0
    fireFrame(ts, null) // prime
    expect(scan.state.faceDetected).toBe(false)
    ts += 1000
    fireFrame(ts, null)
    expect(scan.state.countdownSeconds).toBe(2)
    ts += 1000
    fireFrame(ts, null)
    expect(scan.state.countdownSeconds).toBe(1)
    ts += 1000
    fireFrame(ts, null)
    expect(scan.state.phase).toBe('capturing') // advanced with zero face detections
  })

  it('threshold mode: beginCapture still runs a countdown, never enters baseline, reaches done', async () => {
    const scan = await startScan({ model: null })
    expect(scan.state.scoringEngine).toBe('threshold')

    scan.beginCapture(5000)
    expect(scan.state.phase).toBe('countdown')
    expect(scan.state.countdownNext).toBe('capturing')
    expect(scan.state.baselineSource).toBeNull() // no model -> baselineSource stays null

    let ts = driveFrames(0, 4, 1000, FACE)
    expect(scan.state.phase).toBe('capturing')
    expect(estimateBaseline).not.toHaveBeenCalled()

    driveFrames(ts, 6, 1000, FACE)
    expect(scan.state.phase).toBe('done')
    expect(scan.state.profiles).not.toBeNull()
    // Threshold engine's profile shape (no .model key).
    expect(scan.state.profiles.brow.model).toBeUndefined()
  })

  it('banked baseline: skips phase A, single countdown straight to capturing, banked vector used as the subtraction baseline', async () => {
    const scan = await startScan({ model: makeModelFixture() })
    const bankedBaseline = { browDownLeft: 0.33 }

    scan.beginCapture(5000, { bankedBaseline })
    expect(scan.state.phase).toBe('countdown')
    expect(scan.state.countdownNext).toBe('capturing') // baseline phase skipped entirely
    expect(scan.state.baselineSource).toBe('banked')

    let ts = 0
    fireFrame(ts, FACE) // prime — also proves scoreFrame runs during countdown
    expect(scoreFrame).toHaveBeenLastCalledWith(expect.anything(), FACE, bankedBaseline)

    ts = driveFrames(ts + 1000, 3, 1000, FACE)
    expect(scan.state.phase).toBe('capturing')
    expect(estimateBaseline).not.toHaveBeenCalled() // phase A never ran

    fireFrame(ts, FACE)
    expect(scoreFrame).toHaveBeenLastCalledWith(expect.anything(), FACE, bankedBaseline)

    driveFrames(ts + 1000, 5, 1000, FACE)
    expect(scan.state.phase).toBe('done')
  })

  it('a banked baseline is ignored in threshold mode (no model to subtract against)', async () => {
    const scan = await startScan({ model: null })
    scan.beginCapture(5000, { bankedBaseline: { browDownLeft: 0.9 } })
    expect(scan.state.phase).toBe('countdown')
    expect(scan.state.countdownNext).toBe('capturing')
    expect(scan.state.baselineSource).toBeNull() // no model -> no baseline source at all
    driveFrames(0, 4, 1000, FACE)
    expect(scan.state.phase).toBe('capturing')
    expect(scoreFrame).not.toHaveBeenCalled() // threshold engine never calls the model scorer
  })

  it('beginBaselineCapture (model mode): countdown -> baseline -> done with baselineResult set, no expression phase', async () => {
    const scan = await startScan({ model: makeModelFixture() })
    const result = scan.beginBaselineCapture(4000)
    expect(result).toEqual({ ok: true })
    expect(scan.state.phase).toBe('countdown')
    expect(scan.state.countdownNext).toBe('baseline')

    let ts = driveFrames(0, 4, 1000, FACE)
    expect(scan.state.phase).toBe('baseline')

    driveFrames(ts, 5, 1000, FACE) // 4000ms window (prime + four 1000ms steps)
    expect(scan.state.phase).toBe('done')
    expect(scan.state.baselineResult).toEqual({ browDownLeft: 0.1 })
    expect(scan.state.profiles).toBeNull() // no expression phase ever ran
  })

  it('beginBaselineCapture rejects threshold mode and stays in preview', async () => {
    const scan = await startScan({ model: null })
    const result = scan.beginBaselineCapture(4000)
    expect(result).toEqual({ ok: false, reason: 'no-model' })
    expect(scan.state.phase).toBe('preview')
    expect(scan.state.baselineResult).toBeNull()
  })

  it('beginBaselineCapture rejects when not called from preview', async () => {
    const scan = await startScan({ model: makeModelFixture() })
    scan.beginCapture(5000) // now in 'countdown', not 'preview'
    const result = scan.beginBaselineCapture(4000)
    expect(result).toEqual({ ok: false, reason: 'invalid-phase' })
    // The in-flight beginCapture countdown is untouched.
    expect(scan.state.countdownNext).toBe('baseline')
  })

  it('stop() clears baselineResult and returns to idle', async () => {
    const scan = await startScan({ model: makeModelFixture() })
    scan.beginBaselineCapture(4000)
    let ts = driveFrames(0, 4, 1000, FACE)
    driveFrames(ts, 5, 1000, FACE)
    expect(scan.state.phase).toBe('done')
    expect(scan.state.baselineResult).not.toBeNull()

    scan.stop()
    expect(scan.state.phase).toBe('idle')
    expect(scan.state.baselineResult).toBeNull()
  })

  it('cancel (stop) during countdown tears down cleanly', async () => {
    const scan = await startScan({ model: makeModelFixture() })
    scan.beginCapture(5000)
    fireFrame(0, FACE)
    expect(scan.state.phase).toBe('countdown')

    expect(() => scan.stop()).not.toThrow()
    expect(scan.state.phase).toBe('idle')
    expect(scan.state.faceDetected).toBe(false)
  })

  it('start() resets the new state fields for a fresh session', async () => {
    // Leave a prior session with baselineResult/countdownNext set.
    const scan = await startScan({ model: makeModelFixture() })
    scan.beginBaselineCapture(4000)
    let ts = driveFrames(0, 4, 1000, FACE)
    driveFrames(ts, 5, 1000, FACE)
    expect(scan.state.baselineResult).not.toBeNull()

    const video = makeVideo()
    const startPromise = scan.start(video)
    // Synchronous prefix of start() runs before the first await settles.
    expect(scan.state.countdownSeconds).toBe(0)
    expect(scan.state.countdownNext).toBeNull()
    expect(scan.state.baselineResult).toBeNull()
    await startPromise
    expect(scan.state.phase).toBe('preview')
  })

  // R41 (spec §2): the population-neutral default baseline makes the wizard
  // scan single-phase for the common case — no banked baseline yet, but the
  // model still carries a usable populationNeutral — so a patient already
  // in pain is never asked to hold a fake normal face first.
  describe('R41: population-default single-phase baseline', () => {
    it('model with populationNeutral, no banked baseline: single countdown straight to capturing, baselineSource "default"', async () => {
      const scan = await startScan({ model: makeModelFixtureWithPopulation() })

      scan.beginCapture(5000)
      expect(scan.state.phase).toBe('countdown')
      expect(scan.state.countdownNext).toBe('capturing') // no baseline phase at all
      expect(scan.state.baselineSource).toBe('default')

      const ts = driveFrames(0, 4, 1000, FACE)
      expect(scan.state.phase).toBe('capturing')
      expect(estimateBaseline).not.toHaveBeenCalled() // phase A never ran

      driveFrames(ts, 6, 1000, FACE)
      expect(scan.state.phase).toBe('done')
      // finishCapture() must embed the POPULATION cutpoints (0.99/0.99),
      // not the model's personal-delta exported cutpoints (0.5/0.7).
      for (const cat of CATEGORIES) {
        expect(scan.state.profiles[cat].model.cutpoints).toEqual({ ge1: 0.99, ge2: 0.99 })
      }
    })

    it('scoreFrame is called with the populationNeutral vector as the subtraction baseline, from the very first frame', async () => {
      const scan = await startScan({ model: makeModelFixtureWithPopulation() })
      scan.beginCapture(5000)

      fireFrame(0, FACE) // prime frame, still in countdown
      expect(scoreFrame).toHaveBeenLastCalledWith(
        expect.anything(),
        FACE,
        { browDownLeft: 0.05, browDownRight: 0.05 },
      )
    })

    it('a banked baseline still wins over populationNeutral when both are available (baselineSource "banked", exported cutpoints embedded)', async () => {
      const scan = await startScan({ model: makeModelFixtureWithPopulation() })
      const bankedBaseline = { browDownLeft: 0.33 }

      scan.beginCapture(5000, { bankedBaseline })
      expect(scan.state.phase).toBe('countdown')
      expect(scan.state.countdownNext).toBe('capturing')
      expect(scan.state.baselineSource).toBe('banked')

      const ts = driveFrames(0, 4, 1000, FACE)
      driveFrames(ts, 6, 1000, FACE)
      expect(scan.state.phase).toBe('done')
      // Banked capture embeds the model's ORIGINAL exported cutpoints
      // (0.5/0.7), not cutpointsPopulation, even though the model has both.
      for (const cat of CATEGORIES) {
        expect(scan.state.profiles[cat].model.cutpoints).toEqual({ ge1: 0.5, ge2: 0.7 })
      }
    })

    it('stop() resets baselineSource to null', async () => {
      const scan = await startScan({ model: makeModelFixtureWithPopulation() })
      scan.beginCapture(5000)
      expect(scan.state.baselineSource).toBe('default')

      scan.stop()
      expect(scan.state.phase).toBe('idle')
      expect(scan.state.baselineSource).toBeNull()
    })

    it('start() resets baselineSource for a fresh session', async () => {
      const scan = await startScan({ model: makeModelFixtureWithPopulation() })
      scan.beginCapture(5000)
      expect(scan.state.baselineSource).toBe('default')

      const video = makeVideo()
      const startPromise = scan.start(video)
      // Synchronous prefix of start() runs before the first await settles.
      expect(scan.state.baselineSource).toBeNull()
      await startPromise
      expect(scan.state.phase).toBe('preview')
    })
  })

  // T1 review minor 2 / R30 intent (lead ruling, folded in T2): the live
  // bars (ScanPanel.vue's barFraction, reading state.modelCutpoints) must
  // compare against the cutpoints scoring will ACTUALLY use for this
  // capture, not always the raw exported set — a population-default
  // capture's bars would otherwise be read against the wrong (much lower)
  // personal-delta cutpoint. start() still initializes modelCutpoints to
  // the raw exported set for the plain preview phase (unchanged); only
  // beginCapture() re-maps it once chooseBaseline() has actually decided.
  describe('T1 review minor 2 / R30 intent: modelCutpoints tracks the ACTIVE cutpoints', () => {
    it('no banked baseline, populationNeutral model: modelCutpoints flips from the exported set to cutpointsPopulation', async () => {
      const scan = await startScan({ model: makeModelFixtureWithPopulation() })
      // start()'s preview-phase initialization: the raw exported set.
      expect(scan.state.modelCutpoints.mouth).toEqual({ ge1: 0.5, ge2: 0.7 })

      scan.beginCapture(5000)
      expect(scan.state.baselineSource).toBe('default')
      // beginCapture() re-maps every category to the ACTIVE (population)
      // cutpoints the moment chooseBaseline() picks the default baseline —
      // this is what finishCapture() will also embed into the profile.
      for (const cat of CATEGORIES) {
        expect(scan.state.modelCutpoints[cat]).toEqual({ ge1: 0.99, ge2: 0.99 })
      }
    })

    it('re-scan source flip: a banked baseline arriving on a later capture returns modelCutpoints to the exported set (and finishCapture embeds it)', async () => {
      const scan = await startScan({ model: makeModelFixtureWithPopulation() })

      // First capture: no banked baseline yet -> population-default.
      scan.beginCapture(5000)
      expect(scan.state.baselineSource).toBe('default')
      expect(scan.state.modelCutpoints.mouth).toEqual({ ge1: 0.99, ge2: 0.99 })

      let ts = driveFrames(0, 4, 1000, FACE)
      driveFrames(ts, 6, 1000, FACE)
      expect(scan.state.phase).toBe('done')

      // Re-scan from 'done' — a banked baseline is now supplied (e.g. the
      // nurse saved one via BaselineView in between scans).
      const bankedBaseline = { browDownLeft: 0.33 }
      scan.beginCapture(5000, { bankedBaseline })
      expect(scan.state.baselineSource).toBe('banked')
      for (const cat of CATEGORIES) {
        expect(scan.state.modelCutpoints[cat]).toEqual({ ge1: 0.5, ge2: 0.7 })
      }

      ts = driveFrames(0, 4, 1000, FACE)
      driveFrames(ts, 6, 1000, FACE)
      expect(scan.state.phase).toBe('done')
      for (const cat of CATEGORIES) {
        expect(scan.state.profiles[cat].model.cutpoints).toEqual({ ge1: 0.5, ge2: 0.7 })
      }
    })
  })
})

// R4-T5 fix round 1 (MAJOR 2 / minor 3/4): toggleFacing()'s async branches
// had zero unit coverage — this drives them directly against a mocked
// navigator.mediaDevices.getUserMedia (queued per call via
// mockResolvedValueOnce/mockRejectedValueOnce/mockImplementationOnce, on
// top of the shared beforeEach's default resolved stream), the same
// approach the rest of this file already takes for start().
describe('useFaceScan — toggleFacing (R4-T5 fix round 1)', () => {
  // Local variant of the shared startScan() helper (above) that also hands
  // back the <video> stub, needed here to assert srcObject rebinding —
  // startScan() itself only returns `scan`, and every existing call site
  // destructures just that, so it's left untouched rather than changing its
  // shape for these tests alone.
  async function startScanWithVideo({ model = null } = {}) {
    loadModel.mockResolvedValue(model)
    const scan = useFaceScan()
    const video = makeVideo()
    await scan.start(video)
    return { scan, video }
  }

  it('(a) happy swap: stops the old stream\'s tracks, rebinds srcObject to the new stream, flips state.facing', async () => {
    const streamA = makeStream('user')
    const streamB = makeStream('environment')
    navigator.mediaDevices.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(streamA) // start()
      .mockResolvedValueOnce(streamB) // toggleFacing()

    const { scan, video } = await startScanWithVideo({ model: null })
    expect(scan.state.phase).toBe('preview')
    expect(scan.state.facing).toBe('user')

    await scan.toggleFacing()

    expect(streamA._track.stop).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBe(streamB)
    expect(scan.state.facing).toBe('environment')
    expect(scan.state.phase).toBe('preview') // never left preview
    expect(scan.state.swapInFlight).toBe(false)
  })

  it('(b) new-facing getUserMedia rejects: reverts state.facing and re-acquires the previous facing', async () => {
    const streamA = makeStream()
    const revertStream = makeStream()
    navigator.mediaDevices.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(streamA) // start()
      .mockRejectedValueOnce(new Error('no back camera')) // toggleFacing() primary attempt
      .mockResolvedValueOnce(revertStream) // toggleFacing() revert re-acquire

    const { scan, video } = await startScanWithVideo({ model: null })
    expect(scan.state.facing).toBe('user')

    await scan.toggleFacing()

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(3)
    expect(scan.state.facing).toBe('user') // reverted back
    expect(video.srcObject).toBe(revertStream)
    expect(scan.state.phase).toBe('preview') // capture flow untouched
    expect(scan.state.errorKind).toBeNull()
    expect(scan.state.swapInFlight).toBe(false)
  })

  it('(c) revert also rejects: phase becomes error/camera and the rAF loop is cancelled', async () => {
    const streamA = makeStream()
    navigator.mediaDevices.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(streamA) // start()
      .mockRejectedValueOnce(new Error('primary swap failed'))
      .mockRejectedValueOnce(new Error('revert also failed'))

    const { scan } = await startScanWithVideo({ model: null })

    await scan.toggleFacing()

    expect(scan.state.phase).toBe('error')
    expect(scan.state.errorKind).toBe('camera')
    expect(scan.state.faceDetected).toBe(false)
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(scan.state.swapInFlight).toBe(false)
  })

  it('(d) a second toggleFacing() call while one is already in flight is a no-op', async () => {
    let resolveSwap
    const swapPromise = new Promise((resolve) => {
      resolveSwap = resolve
    })
    navigator.mediaDevices.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(makeStream()) // start()
      .mockImplementationOnce(() => swapPromise) // toggleFacing() #1, held open

    const { scan } = await startScanWithVideo({ model: null })

    const firstToggle = scan.toggleFacing() // not awaited — leave it in flight
    expect(scan.state.swapInFlight).toBe(true)
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2)

    const secondToggle = scan.toggleFacing() // guarded by `!stream` — no-op
    await secondToggle
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2) // no new call made

    resolveSwap(makeStream('environment'))
    await firstToggle

    expect(scan.state.facing).toBe('environment')
    expect(scan.state.swapInFlight).toBe(false)
  })

  // Fix round 1 minor 3: `{ ideal }` is only a hint — a device with no
  // matching camera can silently resolve with the SAME camera it already
  // had instead of rejecting. state.facing must reflect what the browser
  // actually reports (getSettings().facingMode), not our own guess.
  it('minor 3: reconciles state.facing from the new stream\'s reported facingMode (device has no back camera)', async () => {
    const streamA = makeStream('user')
    // No back camera: { ideal: 'environment' } resolves with the SAME
    // front camera, whose getSettings() honestly still reports 'user'.
    const streamB = makeStream('user')
    navigator.mediaDevices.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(streamA)
      .mockResolvedValueOnce(streamB)

    const { scan } = await startScanWithVideo({ model: null })
    expect(scan.state.facing).toBe('user')

    await scan.toggleFacing()

    // Without reconciliation this would naively read 'environment' (our own
    // guess, never actually granted) and wrongly un-mirror the preview.
    expect(scan.state.facing).toBe('user')
  })

  it('minor 3: also reconciles on the revert path, trusting the browser-reported facingMode over the naive previousFacing guess', async () => {
    const streamA = makeStream()
    // Contrived but exercises the same reconciliation code path on revert:
    // the browser reports something other than the previousFacing guess.
    const revertStream = makeStream('environment')
    navigator.mediaDevices.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(streamA)
      .mockRejectedValueOnce(new Error('no back camera'))
      .mockResolvedValueOnce(revertStream)

    const { scan } = await startScanWithVideo({ model: null })

    await scan.toggleFacing()

    expect(scan.state.facing).toBe('environment')
  })

  // Fix round 1 minor 4: closes the window where a slow (>3s) acquire could
  // land the srcObject rebind inside an already-running countdown/baseline/
  // capturing window — state.phase stays 'preview' for the WHOLE swap, so
  // without this guard the FAB's "start capture" tap would still work.
  it('minor 4: beginCapture() is a no-op while a toggleFacing() swap is in flight, and works again once it settles', async () => {
    let resolveSwap
    const swapPromise = new Promise((resolve) => {
      resolveSwap = resolve
    })
    navigator.mediaDevices.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(makeStream()) // start()
      .mockImplementationOnce(() => swapPromise) // toggleFacing(), held open

    const { scan } = await startScanWithVideo({ model: null })
    const togglePromise = scan.toggleFacing()
    expect(scan.state.swapInFlight).toBe(true)

    scan.beginCapture(5000)
    expect(scan.state.phase).toBe('preview') // refused: no countdown started mid-swap

    resolveSwap(makeStream())
    await togglePromise
    expect(scan.state.swapInFlight).toBe(false)

    // Once the swap has settled the guard lifts — beginCapture() works
    // normally again.
    scan.beginCapture(5000)
    expect(scan.state.phase).toBe('countdown')
  })

  it('minor 4: beginBaselineCapture() also refuses ({ reason: "swap-in-flight" }) while a swap is in flight', async () => {
    let resolveSwap
    const swapPromise = new Promise((resolve) => {
      resolveSwap = resolve
    })
    navigator.mediaDevices.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(makeStream()) // start()
      .mockImplementationOnce(() => swapPromise) // toggleFacing(), held open

    const { scan } = await startScanWithVideo({ model: makeModelFixture() })
    const togglePromise = scan.toggleFacing()
    expect(scan.state.swapInFlight).toBe(true)

    const result = scan.beginBaselineCapture(4000)
    expect(result).toEqual({ ok: false, reason: 'swap-in-flight' })
    expect(scan.state.phase).toBe('preview')

    resolveSwap(makeStream())
    await togglePromise
  })

  it('stop() mid-swap clears swapInFlight so it never gets stuck true', async () => {
    let resolveSwap
    const swapPromise = new Promise((resolve) => {
      resolveSwap = resolve
    })
    navigator.mediaDevices.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(makeStream()) // start()
      .mockImplementationOnce(() => swapPromise) // toggleFacing(), held open

    const { scan } = await startScanWithVideo({ model: null })
    const togglePromise = scan.toggleFacing()
    expect(scan.state.swapInFlight).toBe(true)

    scan.stop()
    expect(scan.state.swapInFlight).toBe(false)
    expect(scan.state.phase).toBe('idle')

    // The orphaned toggle's own eventual settlement must not resurrect
    // stale state belonging to a session that no longer exists.
    resolveSwap(makeStream())
    await togglePromise
    expect(scan.state.phase).toBe('idle')
    expect(scan.state.swapInFlight).toBe(false)
  })
})
