// Camera + capture composable: owns the getUserMedia stream, the
// FaceLandmarker rAF detection loop, the two-phase capture window (baseline
// then expression; pausing while no face is detected for >2s), and builds
// per-category temporal profiles on completion. Vue is allowed here (unlike
// the pure facescan modules). Runtime module — not unit-tested; reviewed +
// live-tested at integration. Spec §5.5 / plan Task 3.
//
// Wave 4b (spec §10.2 item 3-4, R19/R26/R27): alongside the camera +
// landmarker, this also loads the trained scoring model (modelScore.js). If
// it loads and validates, capture becomes two-phase — phase A is a >=4s
// neutral-baseline window (spec item 4), auto-advancing into phase B, the
// existing 5s expression window — and per-frame scoring runs the model
// (P(ge1)/P(ge2) against the model's own cutpoints) instead of raw
// intensity thresholds. If the model fails to load/validate, capture stays
// exactly as it was before this wave: a single expression-window capture
// scored by frameIntensities (spec R9-style "never a dead scan" — the
// threshold engine is also the no-model deployment mode, unchanged).
//
// R41 (spec §2, round 3): the two-phase flow above contaminated the
// baseline with the patient's OWN current (possibly already-in-pain) face —
// the 0/10 scoring incident. beginCapture() now asks modelScore.js's
// chooseBaseline() to pick a layered serve-time baseline instead: a banked
// personal baseline (R38, unchanged) beats a population-neutral default
// vector shipped in the model JSON, which beats the legacy two-phase
// in-session capture above — reachable ONLY when the loaded model has no
// usable `populationNeutral` (an old cached model file). Banked/default
// captures are single-phase (straight to the expression window, no baseline
// phase at all); state.baselineSource records which of the three was used.

import { reactive } from 'vue'
import { CATEGORIES, frameIntensities } from './features.js'
import { buildProfile } from './profile.js'
import { createLandmarker } from './landmarker.js'
import { loadModel, scoreFrame, estimateBaseline, chooseBaseline } from './modelScore.js'

const NO_FACE_GRACE_MS = 2000

// Spec item 4: baseline window must be >=4s (training measured the WORST
// protocol was a single ~2s consecutive burst); see modelScore.js's
// estimateBaseline() doc comment for the full spread+mean rationale.
const BASELINE_DURATION_MS = 4000
const BASELINE_SAMPLE_EVERY = 4
// Spec §7 "immediately jumps" fix: every capture entry point (two-phase,
// banked/threshold single-phase, and baseline-only) now opens on a 3s
// wall-clock countdown before any timed window starts collecting frames.
const COUNTDOWN_DURATION_MS = 3000
// EMA smoothing factor for the live per-category bars in model mode (spec
// item 8) — per-frame P(ge1) is noisier than the old windowed intensities,
// so the raw value visibly jitters; not unit-tested (a UI-feel constant,
// like NO_FACE_GRACE_MS), tunable without touching the capture/scoring
// logic above.
const LIVE_EMA_ALPHA = 0.3

function zeroLive() {
  return { brow: 0, eyes: 0, noseCheek: 0, mouth: 0, overall: 0 }
}

function emptySeries() {
  const series = {}
  for (const cat of CATEGORIES) series[cat] = []
  return series
}

// Exponential moving average over a per-category map, one category at a
// time (first sample seeds the average outright). Used only for the live
// preview bars in model mode (spec item 8) — never for the profiles/scores
// that actually get stored or validated, so this is UI feel, not scoring.
function emaUpdate(prev, next, alpha) {
  const result = {}
  for (const cat of CATEGORIES) {
    const prevValue = prev ? prev[cat] : undefined
    const nextValue = next[cat]
    result[cat] = prevValue === undefined ? nextValue : prevValue + alpha * (nextValue - prevValue)
  }
  return result
}

// Heuristic for MAJOR 1's error-kind split: a throw inside the detection
// loop is almost always the landmarker/WASM graph choking on something
// (treated as 'model'), UNLESS the video element itself is visibly the
// problem — its own MediaError is set, or the underlying camera track has
// ended (device unplugged, permission revoked mid-session) — in which case
// it's clearly 'camera'.
function isVideoSourceError(video, mediaStream) {
  if (!video) return true
  if (video.error) return true
  // R4-T5 fix round 1 minor 7: no live stream at all is unambiguously a
  // camera-source problem, not the landmarker/WASM graph — this is exactly
  // the state toggleFacing() puts the module in for the (usually brief)
  // window between stopping the old stream's tracks and the new
  // getUserMedia() call resolving (it sets the module-level `stream` to
  // null synchronously first). A tick() throw landing in that window must
  // report 'camera', not fall through to this function's 'model' default.
  if (!mediaStream) return true
  const track = mediaStream.getVideoTracks?.()[0]
  if (track && track.readyState === 'ended') return true
  return false
}

// R4-T5 fix round 1 minor 3: getUserMedia's `facingMode: { ideal }` is only
// a hint — on a device with no matching camera (e.g. no back camera on a
// laptop webcam), the browser silently resolves with whatever camera it
// already has instead of rejecting. Trusting our own `nextFacing`/
// `previousFacing` guess in that case would make state.facing lie about
// which physical camera is actually live (and wrongly (un)mirror the
// preview) — read back what the browser ACTUALLY gave us via the track's
// own getSettings().facingMode when it reports one, and only fall back to
// our guess when the browser doesn't say (getSettings()/facingMode support
// both vary across browsers).
function reconcileFacing(mediaStream, fallbackFacing) {
  const track = mediaStream.getVideoTracks?.()[0]
  const reported = track?.getSettings?.().facingMode
  return reported || fallbackFacing
}

export function useFaceScan() {
  const state = reactive({
    phase: 'idle', // 'idle'|'loading'|'preview'|'countdown'|'baseline'|'capturing'|'done'|'error'
    errorKind: null, // null|'camera'|'model'
    faceDetected: false,
    live: zeroLive(),
    progress: 0, // 0..1, meaning depends on phase (baseline vs capturing); not used in countdown
    profiles: null,
    modelSource: null, // 'local'|'cdn'|null — the FACE LANDMARKER asset source
    scoringEngine: null, // null|'model-v1'|'threshold' — which engine scored (spec item 9)
    modelCutpoints: null, // null|Record<cat,{ge1,ge2}> — the loaded model's RAW exported
    // cutpoints per category (R30 MAJOR 3): ScanPanel.vue needs this to pick the ACTIVE
    // ge1 threshold for its live-bar mapping (calibrated, from calibrationStore, else this).
    // start() (re)initializes this to the RAW exported set for the preview
    // phase; beginCapture() then overwrites it with whichever cutpoint set
    // chooseBaseline() actually picked for this capture (T1 review minor 2 /
    // R30 intent — see beginCapture() below), so the live bars during
    // countdown/capturing always compare against the same cutpoints scoring
    // will embed into the profile, not always the raw exported ones.
    countdownSeconds: 0, // 3->2->1 while phase==='countdown'; wall-clock, face not required (spec §7)
    countdownNext: null, // null|'baseline'|'capturing' — phase entered when the countdown completes
    baselineResult: null, // object|null — set by beginBaselineCapture() on completion (spec §7)
    // R41: which baseline this capture is subtracting — 'banked' (R38, a
    // previously saved personal baseline), 'default' (population-neutral
    // vector shipped in the model JSON), or 'session' (legacy two-phase
    // capture, only when the loaded model has no usable populationNeutral).
    // Set by beginCapture() in model mode; left null in threshold mode
    // (there is no baseline to subtract against); reset to null by
    // start()/stop().
    baselineSource: null,
    // R4-T5 (new user requirement): front/back camera swap. `facing` is the
    // getUserMedia facingMode this session is currently using — deliberately
    // NOT reset by start()/stop() (it persists across starts within the
    // life of this composable instance; never written to localStorage, so a
    // fresh page load always starts back on 'user'). `canSwapCamera` is
    // recomputed on every successful start() (see updateCanSwapCamera()
    // below) and reset to false by both start() and stop() — it reflects
    // whether THIS device currently exposes more than one camera, which
    // start()/stop() can't assume stays true across a teardown.
    facing: 'user', // 'user'|'environment'
    canSwapCamera: false,
    // R4-T5 fix round 1 minor 4/5: true for the duration of an in-flight
    // toggleFacing() acquisition (from the moment its guards pass to the
    // moment its own getUserMedia()/revert settles) — mirrors the
    // module-local `swapInFlight` below 1:1, so the UI can disable the swap
    // button (no dead taps while a device's camera handoff can take
    // seconds) and beginCapture()/beginBaselineCapture() can refuse to
    // start a new countdown into a stream that is mid-restart. Reset to
    // false by both start() and stop().
    swapInFlight: false,
  })

  let videoEl = null
  let stream = null
  let landmarker = null
  let rafId = null
  // R4-T5 fix round 1 minor 4: mirrors state.swapInFlight — kept as its own
  // module-local (rather than reading state.swapInFlight everywhere) so
  // beginCapture()/beginBaselineCapture() read it the same synchronous way
  // they already read every other module-local guard condition in this
  // file (running, scoringModelData, etc.), not the reactive proxy.
  let swapInFlight = false
  let running = false
  let sessionId = 0

  let scoringModelData = null // validated painface-scoring.v1.json, or null (threshold fallback)
  let liveEma = null // Record<string, number>|null — smoothed P(ge1) per category (model mode)

  let series = emptySeries() // threshold engine: raw per-category intensities
  let ge1Series = emptySeries() // model engine: per-category P(ge1) over the expression window
  let ge2Series = emptySeries() // model engine: per-category P(ge2) over the expression window
  let baselineFrames = [] // raw blendshape maps collected during the baseline phase
  let baselineVector = {} // estimateBaseline() output; {} == effectively a zero baseline
  // R41: the ACTIVE cutpoint accessor for whichever baseline chooseBaseline()
  // picked this capture — finishCapture() embeds cutpointsFor(cat) into the
  // profile instead of always reading the model's raw exported cutpoints, so
  // a population-baseline capture embeds cutpointsPopulation (or its
  // cutpoints fallback) rather than the personal-delta cutpoints. Set by
  // beginCapture() whenever scoringModelData is present; never set (stays
  // null) on the beginBaselineCapture() path, which never reaches
  // finishCapture().
  let activeCutpointsFor = null

  let captureDurationMs = 5000 // expression-window duration (phase B)
  let accumulatedMs = 0
  let noFaceStreakMs = 0
  let lastFrameMs = null

  // Countdown bookkeeping (spec §7) — deliberately separate from
  // accumulatedMs/noFaceStreakMs/lastFrameMs above: those belong to
  // whichever timed phase (baseline/capturing) is entered NEXT, and must
  // still reset "exactly as the current phase entries do" when the
  // countdown completes, so the countdown needs its own clock.
  let countdownElapsedMs = 0
  let countdownLastFrameMs = null
  // Which timed window beginBaselineCapture()'s countdown->baseline leads
  // into on completion: 'expression' (default, two-phase beginCapture()
  // flow) advances into a SECOND countdown->capturing; 'done' (set only by
  // beginBaselineCapture()) stops at the baseline estimate itself.
  let baselineOnlyCapture = false
  // Overridable baseline-phase window length: BASELINE_DURATION_MS for the
  // ordinary two-phase beginCapture() flow, or beginBaselineCapture()'s own
  // durationMs argument when banking a baseline standalone.
  let baselineDurationMs = BASELINE_DURATION_MS

  function releaseStream() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
    if (videoEl) videoEl.srcObject = null
  }

  function closeLandmarker() {
    if (landmarker && typeof landmarker.close === 'function') {
      try {
        landmarker.close()
      } catch {
        // Best-effort — nothing more we can do about an already-broken
        // WASM graph, but we must not let this throw block teardown.
      }
    }
    landmarker = null
  }

  // R4-T5: recomputes state.canSwapCamera after a successful camera
  // start() by asking the browser how many video input devices actually
  // exist — swapping is only meaningful with >1. Guarded both ways per
  // spec: enumerateDevices() is missing entirely in some odd browsers (left
  // at its default false, same as loadModel()'s "never a dead scan"
  // stance), and its promise can reject (caught, also left false) — neither
  // must ever break start(), so this is fire-and-forget from its one call
  // site there, never awaited inline. `mySession` guards against a
  // stop()/start() superseding THIS call while enumerateDevices() is in
  // flight — mirrors every other mySession/sessionId check in this file.
  //
  // R4-T5 fix round 1 minor 6 (correction): this function is called ONLY
  // from start() — toggleFacing() does NOT call it, and canSwapCamera is
  // left as whatever start() last computed across a swap. Concurrent
  // toggleFacing() calls are also NOT guarded by mySession (sessionId never
  // changes across two overlapping toggleFacing() calls in the same
  // session, so mySession would be identical for both) — the real guard
  // against a second toggleFacing() call while one is already in flight is
  // toggleFacing()'s own `!stream` precondition, load-bearing together with
  // `stream = null` being set SYNCHRONOUSLY, before that function's first
  // await: a second call made before the first one's getUserMedia()
  // resolves sees `stream === null` and returns immediately as a no-op.
  async function updateCanSwapCamera(mySession) {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      if (mySession !== sessionId) return
      state.canSwapCamera = devices.filter((d) => d.kind === 'videoinput').length > 1
    } catch {
      // Never let this promise rejection break the scan — canSwapCamera
      // just stays at its safe default (false).
    }
  }

  // Full teardown of the live session: stops the rAF loop, releases the
  // MediaStream, and closes the landmarker's WASM graph. Shared by stop()
  // and the tick() error path (MAJOR 1/2/5) so there is never more than one
  // rAF loop or an orphaned stream/landmarker across start/stop/error/
  // re-scan cycles.
  function teardown() {
    running = false
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    releaseStream()
    closeLandmarker()
    videoEl = null
  }

  // Builds the final per-category profiles handed to the caller via the
  // 'done' event/state.profiles. Model mode (spec §10.2 item 3, R19):
  // profile.deciles/mean hold the P(ge1) decile profile (a PROBABILITY
  // series, always in [0,1] — required by calibrationStore's
  // isValidDeciles, spec item 6), and profile.model carries the P(ge2)
  // profile plus the model's own cutpoints, so scoring.js's scoreCategory()
  // (unmodified call sites in Step3Facial/Step6Reassess) can classify
  // 0/1/2 from cutpoints instead of the searched a/s thresholds — see
  // scoring.js's scoreCategory() doc comment. Threshold mode is untouched:
  // exactly the original buildProfile(series[cat]) path.
  function finishCapture() {
    const profiles = {}
    if (scoringModelData) {
      for (const cat of CATEGORIES) {
        const ge1Profile = buildProfile(ge1Series[cat])
        const ge2Profile = buildProfile(ge2Series[cat])
        profiles[cat] = {
          deciles: ge1Profile.deciles,
          mean: ge1Profile.mean,
          model: {
            // R41: embed whichever cutpoint set was ACTIVE for this capture
            // (chooseBaseline()'s cutpointsFor, set in beginCapture()) — a
            // population-default capture embeds cutpointsPopulation (falling
            // back to the exported cutpoints per category), a banked/legacy
            // capture embeds the exported cutpoints as before. The direct
            // scoringModelData fallback covers only the (never-reached-here)
            // case where activeCutpointsFor is still null.
            cutpoints: activeCutpointsFor
              ? activeCutpointsFor(cat)
              : scoringModelData.categories[cat].cutpoints,
            ge2Profile: { deciles: ge2Profile.deciles, mean: ge2Profile.mean },
          },
        }
      }
    } else {
      for (const cat of CATEGORIES) {
        profiles[cat] = buildProfile(series[cat])
      }
    }
    state.profiles = profiles
    state.progress = 1
    state.phase = 'done'
  }

  // Neutral-baseline phase A complete (spec item 4): estimate the baseline
  // vector from whatever frames were collected across the whole window
  // (modelScore.js's estimateBaseline — spread sampling + mean, per the
  // training addendum). Two callers, two outcomes (spec §7):
  // beginCapture()'s two-phase flow auto-advances into a pre-expression
  // countdown then phase B; beginBaselineCapture() stops here, publishing
  // the estimate as state.baselineResult with phase 'done' and no
  // expression window at all.
  function finishBaseline() {
    baselineVector = estimateBaseline(baselineFrames, { sampleEvery: BASELINE_SAMPLE_EVERY })
    // Fix round 1 minor (d): the ~240 collected blendshape maps (52 keys
    // each) are no longer needed once the estimate is computed — release
    // them promptly rather than holding them for the rest of the session.
    baselineFrames = []
    if (baselineOnlyCapture) {
      state.baselineResult = baselineVector
      state.profiles = null
      state.progress = 1
      state.phase = 'done'
    } else {
      startCountdown('capturing')
    }
  }

  // Wall-clock 3s countdown shared by every capture entry point (spec §7).
  // `next` names the phase to enter once it completes; face detection is
  // irrelevant to advancing it (frames still update faceDetected/live via
  // the ordinary detection block in tick(), but nothing is pushed into
  // baselineFrames/series while phase is 'countdown').
  function startCountdown(next) {
    state.countdownNext = next
    state.countdownSeconds = 3
    countdownElapsedMs = 0
    countdownLastFrameMs = null
    state.progress = 0
    state.profiles = null
    state.phase = 'countdown'
  }

  function advanceCountdown(dtMs) {
    countdownElapsedMs += dtMs
    state.countdownSeconds = Math.max(1, Math.ceil((COUNTDOWN_DURATION_MS - countdownElapsedMs) / 1000))
    if (countdownElapsedMs >= COUNTDOWN_DURATION_MS) {
      if (state.countdownNext === 'baseline') {
        startBaselinePhase()
      } else {
        startExpressionPhase()
      }
    }
  }

  // Shared timer/pause logic for BOTH capture phases (baseline and
  // expression) — behaviorally identical to the original advanceCapture:
  // brief no-face drop-outs (<= grace period) still count toward the
  // window; sustained absence pauses the countdown until the face returns.
  function advancePhase(dtMs, totalMs, onComplete) {
    if (state.faceDetected) {
      noFaceStreakMs = 0
      accumulatedMs += dtMs
    } else {
      noFaceStreakMs += dtMs
      if (noFaceStreakMs <= NO_FACE_GRACE_MS) {
        accumulatedMs += dtMs
      }
    }

    state.progress = Math.min(1, accumulatedMs / totalMs)
    if (accumulatedMs >= totalMs) {
      onComplete()
    }
  }

  function tick(tsMs) {
    if (!running || !landmarker || !videoEl) return

    try {
      // Skip frames until the <video> actually has decoded dimensions —
      // detectForVideo on an unready element is undefined behavior in the
      // underlying WASM graph. Just reschedule and try again next frame.
      if (videoEl.readyState < 2 || videoEl.videoWidth === 0) {
        rafId = requestAnimationFrame(tick)
        return
      }

      const blendshapes = landmarker.detect(videoEl, tsMs)
      if (blendshapes) {
        state.faceDetected = true

        if (scoringModelData) {
          // Model mode (spec item 8): live bars show P(ge1) per category,
          // EMA-smoothed for stability (raw per-frame probability jitters
          // more than the old windowed intensities did). Before the
          // baseline phase finishes, baselineVector is still {} — an
          // effectively-zero baseline — so this is a rough live indicator
          // only; the real baseline is applied to the frames actually
          // accumulated during phase B, below.
          const modelScores = scoreFrame(scoringModelData, blendshapes, baselineVector)
          const rawLive = {}
          for (const cat of CATEGORIES) rawLive[cat] = modelScores[cat].pGe1
          liveEma = emaUpdate(liveEma, rawLive, LIVE_EMA_ALPHA)
          state.live = liveEma

          if (state.phase === 'baseline') {
            baselineFrames.push(blendshapes)
          } else if (state.phase === 'capturing') {
            for (const cat of CATEGORIES) {
              ge1Series[cat].push(modelScores[cat].pGe1)
              ge2Series[cat].push(modelScores[cat].pGe2)
            }
          }
        } else {
          const intensities = frameIntensities(blendshapes)
          state.live = intensities
          if (state.phase === 'capturing') {
            for (const cat of CATEGORIES) {
              series[cat].push(intensities[cat])
            }
          }
        }
      } else {
        state.faceDetected = false
        state.live = zeroLive()
      }

      if (state.phase === 'countdown') {
        if (countdownLastFrameMs === null) countdownLastFrameMs = tsMs
        const dt = tsMs - countdownLastFrameMs
        countdownLastFrameMs = tsMs
        advanceCountdown(dt)
      } else if (state.phase === 'baseline') {
        if (lastFrameMs === null) lastFrameMs = tsMs
        const dt = tsMs - lastFrameMs
        lastFrameMs = tsMs
        advancePhase(dt, baselineDurationMs, finishBaseline)
      } else if (state.phase === 'capturing') {
        if (lastFrameMs === null) lastFrameMs = tsMs
        const dt = tsMs - lastFrameMs
        lastFrameMs = tsMs
        advancePhase(dt, captureDurationMs, finishCapture)
      }
    } catch {
      // A throw mid-loop must never leave the UI stuck on 'capturing' —
      // tear down cleanly and surface it as an error so the caller falls
      // back to manual scoring (spec R9).
      const errorKind = isVideoSourceError(videoEl, stream) ? 'camera' : 'model'
      teardown()
      state.phase = 'error'
      state.errorKind = errorKind
      state.faceDetected = false
      state.live = zeroLive()
      return
    }

    if (running) {
      rafId = requestAnimationFrame(tick)
    }
  }

  async function start(video) {
    // Re-entrancy guard: a live (or in-flight) session must be fully torn
    // down before a new one starts, so there is never more than one rAF
    // loop or an orphaned MediaStream/landmarker.
    if (running || stream || landmarker) {
      stop()
    }

    const mySession = ++sessionId

    videoEl = video
    state.phase = 'loading'
    state.errorKind = null
    state.faceDetected = false
    state.live = zeroLive()
    state.progress = 0
    state.profiles = null
    state.scoringEngine = null
    state.modelCutpoints = null
    state.countdownSeconds = 0
    state.countdownNext = null
    state.baselineResult = null
    state.baselineSource = null // R41: fresh session, no capture chosen a baseline yet
    // R4-T5: canSwapCamera is recomputed below once the camera is actually
    // live — reset to the safe default here so a UI reading it during
    // 'loading' never sees a stale true from a previous session. state.facing
    // is deliberately NOT reset here — it persists across starts within this
    // composable instance's lifetime (spec: never carried to localStorage,
    // but a swap made in an earlier start() of the SAME session should
    // survive an internal restart).
    state.canSwapCamera = false
    // R4-T5 fix round 1 minor 4/5: a fresh session starts with no swap in
    // flight — matters even though stop() (above, when this session
    // superseded a live one) already resets this, because start() can also
    // run without ever calling stop() (the very first start() of this
    // composable instance's life).
    swapInFlight = false
    state.swapInFlight = false
    liveEma = null
    countdownElapsedMs = 0
    countdownLastFrameMs = null
    baselineOnlyCapture = false
    baselineDurationMs = BASELINE_DURATION_MS
    // Fix round 1 minor (d): reset by construction, not by relying on
    // `running` staying false to keep a stale reference inert. Every path
    // out of this function from here either reassigns scoringModelData to
    // THIS session's resolved model, or returns early leaving it null — it
    // can never carry a previous session's model into a session that
    // failed before reaching the end of start().
    scoringModelData = null
    // T1 review minor 3: the tick() error path tears down without stop(),
    // so start() must also reset these two module-locals itself — otherwise
    // the next session's PREVIEW live bars would subtract the previous
    // session's banked/population vector until beginCapture() reassigns it.
    baselineVector = {}
    activeCutpointsFor = null

    // Kick off the scoring-model fetch in parallel with the camera/
    // landmarker setup below (independent network request; loadModel()
    // never throws — a failed/invalid model just resolves to null and this
    // session falls back to the threshold engine, spec R9-style "never a
    // dead scan"). Awaited further down, once we already know this session
    // survived the camera+landmarker chain, so a slow model fetch never
    // delays showing the camera preview beyond that chain's own latency.
    const modelPromise = loadModel()

    let acquiredStream
    try {
      // R4-T5: built from state.facing (not a hardcoded 'user') so the
      // camera chosen by an earlier toggleFacing() in this session survives
      // an internal restart, if any.
      acquiredStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facing } })
    } catch {
      if (mySession === sessionId) {
        state.phase = 'error'
        state.errorKind = 'camera'
      }
      return
    }

    // A newer start() call superseded this one while we were awaiting the
    // camera prompt — release what we just acquired instead of leaking it,
    // and let the newer session own all shared state from here on.
    if (mySession !== sessionId) {
      for (const track of acquiredStream.getTracks()) track.stop()
      return
    }
    stream = acquiredStream
    // R4-T5: fire-and-forget — never awaited here, so a slow/rejecting
    // enumerateDevices() call can never delay showing the camera preview
    // (see updateCanSwapCamera()'s own doc comment for the guard details).
    updateCanSwapCamera(mySession)

    videoEl.srcObject = stream
    try {
      await videoEl.play()
    } catch {
      // Some browsers reject play() outside a user gesture; frames still
      // flow once the video actually starts, so this is non-fatal.
    }

    let createdLandmarker
    try {
      createdLandmarker = await createLandmarker()
    } catch {
      if (mySession === sessionId) {
        state.phase = 'error'
        state.errorKind = 'model'
        releaseStream()
      }
      return
    }

    // Wait for the scoring-model fetch that was kicked off at the very top
    // of start() (an independent, already-in-flight promise — loadModel()
    // never throws). By now the camera+landmarker chain above has already
    // taken far longer than a ~12KB JSON fetch, so in practice this
    // resolves immediately; it's awaited here (rather than left to settle
    // on its own) so the session check right below covers it too.
    const resolvedModel = await modelPromise

    if (mySession !== sessionId) {
      // Do NOT call releaseStream() here. By this point a newer session
      // already owns the module-level `stream`/`videoEl` (it either
      // acquired its own stream, or is still awaiting one) — releaseStream
      // would stop the NEW session's camera tracks and clear its
      // srcObject, not this superseded one's. This session's own stream,
      // if it ever assigned one, was already released by the stop() call
      // that bumped sessionId in the first place. Only close the
      // landmarker we just created (it's a local, unshared value) so its
      // WASM graph doesn't leak.
      if (typeof createdLandmarker.close === 'function') {
        try {
          createdLandmarker.close()
        } catch {
          // best-effort
        }
      }
      return
    }

    landmarker = createdLandmarker
    state.modelSource = landmarker.source
    scoringModelData = resolvedModel
    state.scoringEngine = resolvedModel ? 'model-v1' : 'threshold'
    // R30 MAJOR 3: surface the model's raw exported ge1/ge2 cutpoints per
    // category so ScanPanel.vue can pick the right ACTIVE threshold for its
    // live-bar mapping (calibrated, from calibrationStore, else this).
    state.modelCutpoints = resolvedModel
      ? Object.fromEntries(CATEGORIES.map((cat) => [cat, resolvedModel.categories[cat].cutpoints]))
      : null
    state.phase = 'preview'
    running = true
    rafId = requestAnimationFrame(tick)
  }

  // Entry point for the ordinary scan flow. Every path opens on the 3s
  // countdown (spec §7 "immediately jumps" fix) before any timed window
  // starts. R41: the wizard scan is now single-phase — chooseBaseline()
  // (modelScore.js) picks the subtraction baseline by priority (banked >
  // population-default > legacy session capture) so a patient already in
  // pain is never asked to fake a normal face first (the 0/10 incident).
  // `bankedBaseline` (R38): a non-empty object, in model mode, deliberately
  // crosses sessions — it becomes the subtraction baseline straight away.
  // It is never mutated and never persisted from here; only BaselineView's
  // explicit save writes to the bank. Threshold mode is unchanged in shape
  // (still a single timed window, no baseline at all) but keeps the
  // pre-capture countdown.
  function beginCapture(durationMs = 5000, { bankedBaseline } = {}) {
    if (state.phase !== 'preview' && state.phase !== 'done') return
    // R4-T5 fix round 1 minor 4: a toggleFacing() acquisition can take
    // seconds on some devices while state.phase never leaves 'preview' —
    // without this, a tap landing in that window would start a countdown
    // whose baseline/capturing phase the swap's eventual srcObject rebind
    // would then land frames into mid-window, corrupting the profile.
    if (swapInFlight) return
    captureDurationMs = durationMs
    baselineOnlyCapture = false
    if (scoringModelData) {
      const choice = chooseBaseline(scoringModelData, bankedBaseline)
      state.baselineSource = choice.source
      if (choice.source === 'session') {
        // legacy model file without populationNeutral — old two-phase flow
        baselineDurationMs = BASELINE_DURATION_MS
        activeCutpointsFor = (cat) => scoringModelData.categories[cat].cutpoints
        startCountdown('baseline')
      } else {
        baselineVector = choice.baseline
        activeCutpointsFor = choice.cutpointsFor
        startCountdown('capturing')
      }
      // T1 review minor 2 / R30 intent: live bars must map against the
      // cutpoints scoring will ACTUALLY use for this capture, not always the
      // raw exported set start() initialized state.modelCutpoints to — a
      // population-default capture's bars would otherwise compare P(ge1)
      // against the personal-delta cutpoint (0.5-ish) instead of the much
      // higher population one (0.99-ish), reading as saturated long before
      // scoring would actually call the category active. Re-derive per
      // category from the now-chosen activeCutpointsFor so ScanPanel's
      // existing state.modelCutpoints read (with the calibrated override)
      // just works without any change on that side.
      state.modelCutpoints = Object.fromEntries(
        CATEGORIES.map((cat) => [cat, activeCutpointsFor(cat)]),
      )
    } else {
      state.baselineSource = null
      startCountdown('capturing')
    }
  }

  // Standalone baseline banking (spec §7, BaselineView): model mode only —
  // threshold-mode deployments have no per-frame model score to subtract a
  // baseline from, so this is a no-op there. Valid only from 'preview' (not
  // 'done' — this isn't a re-scan action). Runs the same countdown ->
  // baseline sequence as phase A, but finishBaseline() (via
  // baselineOnlyCapture) stops at the estimate instead of continuing into
  // an expression phase.
  function beginBaselineCapture(durationMs = 4000) {
    if (state.phase !== 'preview') return { ok: false, reason: 'invalid-phase' }
    // R4-T5 fix round 1 minor 4: same race as beginCapture() above — refuse
    // to start a countdown while toggleFacing()'s acquisition is still in
    // flight (state.phase stays 'preview' throughout that window).
    if (swapInFlight) return { ok: false, reason: 'swap-in-flight' }
    if (!scoringModelData) return { ok: false, reason: 'no-model' }
    baselineOnlyCapture = true
    baselineDurationMs = durationMs
    startCountdown('baseline')
    return { ok: true }
  }

  // R4-T5 (new user requirement): swap between the front ('user') and back
  // ('environment') camera without leaving the preview. GUARDED here, not
  // just in the UI — only acts while the camera is actually running AND
  // state.phase === 'preview'; a mid-capture stream restart (baseline or
  // capturing) would corrupt whichever frame profile is already being
  // accumulated. `mySession` freezes this call to the session that was
  // active when it was invoked — if a stop()/start() bumps sessionId while
  // a getUserMedia() call below is in flight, every subsequent step here
  // becomes a no-op (releasing whatever stream it just acquired) instead of
  // clobbering the newer session's videoEl/stream. A SECOND overlapping
  // toggleFacing() call is a separate concern, guarded below by `!stream`
  // rather than by mySession (see that guard's own comment).
  async function toggleFacing() {
    // R4-T5 fix round 1 minor 6: `!stream` is the load-bearing re-entrancy
    // guard against a second toggleFacing() call landing while this one is
    // already in flight — `stream` is set to null SYNCHRONOUSLY below,
    // before this function's first `await`, so a second call made before
    // the first one's getUserMedia() resolves always observes `stream ===
    // null` here and returns immediately as a no-op. mySession cannot serve
    // this purpose: sessionId never changes across two overlapping
    // toggleFacing() calls in the same session (only stop()/start() bump
    // it), so it would be identical for both.
    if (!running || state.phase !== 'preview' || !videoEl || !stream) return

    const mySession = sessionId
    const previousFacing = state.facing
    const nextFacing = previousFacing === 'user' ? 'environment' : 'user'
    state.facing = nextFacing
    // R4-T5 fix round 1 minor 4/5: mark the swap in flight for the whole
    // acquisition (through either a clean success or a full revert) so
    // beginCapture()/beginBaselineCapture() refuse to start a countdown
    // into a stream that is mid-restart, and the UI can disable/dim the
    // swap button meanwhile. Cleared on every path that owns this session's
    // state when it settles — see the matching resets below.
    swapInFlight = true
    state.swapInFlight = true

    // Stop the CURRENT stream's tracks before requesting the new camera —
    // most devices (especially mobile) only allow one active camera stream
    // at a time, so requesting the new one first would often fail outright.
    for (const track of stream.getTracks()) track.stop()
    stream = null
    videoEl.srcObject = null

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: nextFacing } },
      })
      if (mySession !== sessionId) {
        // A newer session already owns videoEl/stream by the time this
        // resolved (and already reset swapInFlight itself as part of its
        // own start()/stop()) — release what was just acquired instead of
        // leaking it or clobbering the newer session.
        for (const track of newStream.getTracks()) track.stop()
        return
      }
      stream = newStream
      // R4-T5 fix round 1 minor 3: don't just trust our own `nextFacing`
      // guess — a device with no matching camera can resolve `{ ideal }`
      // with the SAME camera it already had, which would otherwise make
      // state.facing (and the mirror it drives) lie.
      state.facing = reconcileFacing(newStream, nextFacing)
      videoEl.srcObject = newStream
      try {
        await videoEl.play()
      } catch {
        // Some browsers reject play() outside a user gesture; frames still
        // flow once the video actually starts, same as start()'s own
        // videoEl.play() call — non-fatal.
      }
      swapInFlight = false
      state.swapInFlight = false
    } catch (err) {
      if (mySession !== sessionId) return
      // Revert: try to restore the camera we had before this call, since
      // its tracks were already stopped above and can't simply be reused.
      state.facing = previousFacing
      try {
        const revertStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: previousFacing } },
        })
        if (mySession !== sessionId) {
          for (const track of revertStream.getTracks()) track.stop()
          return
        }
        stream = revertStream
        state.facing = reconcileFacing(revertStream, previousFacing) // minor 3, revert path too
        videoEl.srcObject = revertStream
        try {
          await videoEl.play()
        } catch {
          // non-fatal, see above
        }
        // Fix round 2 optional nit: log the RECONCILED value (state.facing,
        // just set above), not the naive previousFacing guess — reconcileFacing()
        // may have overridden it from the browser's own getSettings() report.
        console.warn(
          `[useFaceScan] toggleFacing: switching to "${nextFacing}" failed, silently reverted to "${state.facing}"`,
          err,
        )
        swapInFlight = false
        state.swapInFlight = false
      } catch (revertErr) {
        // Restoring the previous camera ALSO failed — there is no live
        // camera left to fall back to, so route into the module's existing
        // camera-error path (same shape as the tick() error path/start()'s
        // own getUserMedia catch) rather than leaving the UI on a dead
        // preview.
        if (mySession === sessionId) {
          teardown()
          state.phase = 'error'
          state.errorKind = 'camera'
          state.faceDetected = false
          state.live = zeroLive()
          swapInFlight = false
          state.swapInFlight = false
          console.warn(
            `[useFaceScan] toggleFacing: reverting to "${previousFacing}" also failed — camera lost`,
            revertErr,
          )
        }
      }
    }
  }

  function startBaselinePhase() {
    baselineFrames = []
    baselineVector = {}
    accumulatedMs = 0
    noFaceStreakMs = 0
    lastFrameMs = null
    state.progress = 0
    state.profiles = null
    state.phase = 'baseline'
  }

  // Phase B, the expression window — identical in shape to the original
  // (pre-wave-4b) single-phase capture: reset the relevant series, run for
  // captureDurationMs, and let tick()/advancePhase() drive it to
  // finishCapture(). Reachable either right after startBaselinePhase()
  // auto-advances (model mode) or directly from beginCapture() (threshold
  // mode, or 'done' -> re-scan in either mode).
  function startExpressionPhase() {
    series = emptySeries()
    ge1Series = emptySeries()
    ge2Series = emptySeries()
    accumulatedMs = 0
    noFaceStreakMs = 0
    lastFrameMs = null
    state.progress = 0
    state.profiles = null
    state.phase = 'capturing'
  }

  function stop() {
    sessionId += 1 // invalidate any in-flight start() for this instance
    teardown()
    state.phase = 'idle'
    state.faceDetected = false
    state.live = zeroLive()
    state.progress = 0
    // Fix round 1 minor (d): a stopped session must not leave stale public
    // state behind — `state.scoringEngine`/`state.modelCutpoints` used to
    // survive stop() untouched, so a UI reading them right after stop()
    // (e.g. the cancel-affordance flow below) would see the PREVIOUS
    // session's engine/cutpoints for a moment.
    state.scoringEngine = null
    state.modelCutpoints = null
    // A stopped session must not leave a stray baseline-only result behind
    // either — cancelling mid-countdown/mid-baseline, or simply stopping
    // after a 'done' baseline-only capture, must not let a UI read a stale
    // baselineResult (spec §7 binding note).
    state.countdownSeconds = 0
    state.countdownNext = null
    state.baselineResult = null
    state.baselineSource = null // R41: same stale-state hygiene as scoringEngine/modelCutpoints above
    // R4-T5: same stale-state hygiene — a stopped session must not leave a
    // stray "camera can swap" true behind for a UI to read before the next
    // start() recomputes it. state.facing is deliberately left untouched
    // (persists across stop()/start() within this composable instance).
    state.canSwapCamera = false
    // R4-T5 fix round 1 minor 4/5: if a toggleFacing() was in flight when
    // stop() ran, its own eventual settlement will find mySession !==
    // sessionId and skip touching this flag (same as every other piece of
    // session-owned state it guards) — so stop() must clear it itself here,
    // or a stop() mid-swap would leave state.swapInFlight stuck true
    // forever, wrongly blocking every future beginCapture() call.
    swapInFlight = false
    state.swapInFlight = false
    // Hygiene: nothing reads these before the next beginCapture()/start()
    // resets them anyway, but a stopped session shouldn't hold onto a
    // scoring model reference or an in-memory baseline a moment longer than
    // it has to (R27 — baseline is per-session, never carried forward).
    scoringModelData = null
    liveEma = null
    baselineFrames = []
    baselineVector = {}
    activeCutpointsFor = null
    countdownElapsedMs = 0
    countdownLastFrameMs = null
    baselineOnlyCapture = false
    baselineDurationMs = BASELINE_DURATION_MS
  }

  return { state, start, beginCapture, beginBaselineCapture, stop, toggleFacing }
}
