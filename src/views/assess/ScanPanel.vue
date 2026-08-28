<!--
  Camera preview + 5-second capture UI (spec §5.5, redesigned per spec §7/§8:
  oval guide overlay, big in-video phase labels, pre-capture countdown,
  banked-baseline wiring). Wraps useFaceScan end-to-end: acquires the camera
  on mount, runs the live detection loop, and always releases the
  stream/landmarker on unmount (also covers "leaving [wizard] step 1", since
  the parent step unmounts this via v-if on step change).

  Reused by both Step3Facial (wizard step 1, form part 3 "สังเกตสีหน้า" —
  ruling R18) and Step6Reassess ("สแกนซ้ำ" for the post-care facial
  re-check) — this component has no knowledge of which flow it's in, it
  just detects + captures and reports back via events.
-->
<template>
  <div class="flex flex-col gap-3">
    <div class="relative overflow-hidden rounded-2xl bg-primary-900">
      <video
        ref="videoRef"
        :class="['aspect-[3/4] w-full object-cover', state.facing === 'user' ? '-scale-x-100' : '']"
        muted
        playsinline
        autoplay
      ></video>

      <!-- Oval guide (spec §8): dark scrim with an elliptical cutout,
           plus an outline that reads success-green once a face is
           detected. Shown during preview/countdown/baseline/capturing —
           i.e. whenever the FAB/status label are also shown. -->
      <svg
        v-if="ACTIVE_PHASES.has(state.phase)"
        class="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <mask id="scanpanel-oval-mask">
            <rect x="0" y="0" width="100" height="100" fill="white" />
            <ellipse cx="50" cy="46" rx="30" ry="38" fill="black" />
          </mask>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="black" fill-opacity="0.55" mask="url(#scanpanel-oval-mask)" />
        <ellipse
          cx="50"
          cy="46"
          rx="30"
          ry="38"
          fill="none"
          :stroke="state.faceDetected ? '#16a34a' : '#e2e8f0'"
          stroke-width="1.2"
          vector-effect="non-scaling-stroke"
        />
      </svg>

      <!-- Front/back camera swap (R4-T5, new user requirement): hand-drawn
           inline SVG (no icon library, per binding design) — a small camera
           glyph with two arrows circling it to read as "flip camera" at a
           glance. Visible only while the camera is actually idle-and-ready
           for a tap (preview) AND the device genuinely has >1 camera to
           swap to; useFaceScan.toggleFacing() itself re-guards on
           state.phase === 'preview' too (spec: guard lives in the
           composable, not just here), so this v-if is belt-and-braces, not
           the only thing standing between a tap and a mid-capture restart.
           Fix round 1 MAJOR 1: placed AFTER the oval scrim SVG above (not
           before it) — every other in-video overlay in this file is
           deliberately ordered this way too, so later-painted absolute
           siblings don't composite underneath the scrim's fill-opacity and
           read dimmed/disabled. Fix round 1 minor 5: disabled + swapped for
           a spinner while state.swapInFlight (the acquisition can take
           seconds on some devices) so there is never a dead tap mid-swap. -->
      <button
        v-if="state.canSwapCamera && state.phase === 'preview'"
        type="button"
        class="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/55 active:bg-black/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-black/40 disabled:active:bg-black/40"
        :disabled="state.swapInFlight"
        aria-label="สลับกล้องหน้า/หลัง"
        title="สลับกล้องหน้า/หลัง"
        @click="toggleFacing"
      >
        <span v-if="state.swapInFlight" class="loading loading-spinner loading-sm" aria-hidden="true"></span>
        <svg
          v-else
          viewBox="0 0 24 24"
          class="h-6 w-6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M4.5 10 A8 8 0 0 1 16.3 3.3" />
          <path d="M13.4 2.4 L16.3 3.3 L15.5 6.3" />
          <path d="M19.5 14 A8 8 0 0 1 7.7 20.7" />
          <path d="M10.6 21.6 L7.7 20.7 L8.5 17.7" />
          <rect x="8" y="8.6" width="8" height="6" rx="1.4" />
          <path d="M10.1 8.6 L10.9 7.3 L13.1 7.3 L13.9 8.6" />
          <circle cx="12" cy="11.6" r="1.7" />
        </svg>
      </button>

      <!-- Status label above the oval (spec §8) — replaces the old corner
           badge; same detected/undetected color semantics. -->
      <div
        v-if="ACTIVE_PHASES.has(state.phase)"
        class="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3"
      >
        <span
          :class="[
            'badge gap-1.5 border-none text-xs text-white',
            state.faceDetected ? 'badge-success' : 'badge-warning',
          ]"
        >
          {{ state.faceDetected ? 'ตรวจพบใบหน้า' : 'จัดใบหน้าให้อยู่ในกรอบ' }}
        </span>
      </div>

      <!-- Baseline-source chip (spec §3/R41): which baseline this capture
           is subtracting — banked (existing "ใช้หน้าปกติที่บันทึกไว้" chip,
           copy unchanged) or the model's population-neutral default
           ("ใช้หน้าอ้างอิงมาตรฐาน"). Only while a scan is actually running
           (not during the plain preview, and never for the legacy
           in-session baseline capture — baselineChipLabel is empty for
           baselineSource 'session'/null, so the legacy path shows no chip
           at all, exactly as before this round). -->
      <div
        v-if="baselineChipLabel && ACTIVE_PHASES.has(state.phase) && state.phase !== 'preview'"
        class="absolute left-2 top-2"
      >
        <span class="badge badge-outline gap-1 border-white/50 bg-black/30 text-[10px] text-white">
          {{ baselineChipLabel }}
        </span>
      </div>

      <div v-if="state.phase === 'loading'" class="absolute inset-0 flex items-center justify-center bg-primary-900/70">
        <div class="flex flex-col items-center gap-2 text-white">
          <span class="loading loading-spinner loading-lg" aria-hidden="true"></span>
          <span class="text-sm">กำลังเปิดกล้องและโหลดโมเดล…</span>
        </div>
      </div>

      <!-- Big bottom in-video phase label (spec §8): the primary label now
           lives inside the video on a scrim; the small caption below the
           video keeps only the engine label. Countdown is gated strictly on
           state.phase === 'countdown' — countdownSeconds/countdownNext hold
           stale values outside that phase and must never be rendered then. -->
      <div
        v-if="ACTIVE_PHASES.has(state.phase)"
        class="pointer-events-none absolute inset-x-0 bottom-16 flex justify-center px-4"
      >
        <div class="flex flex-col items-center gap-1 rounded-xl bg-black/40 px-4 py-2 text-center text-white">
          <template v-if="state.phase === 'countdown'">
            <span class="text-6xl font-bold leading-none drop-shadow">{{ state.countdownSeconds }}</span>
            <span class="text-sm">{{ countdownNextLabel }}</span>
          </template>
          <span v-else class="text-lg font-semibold drop-shadow">{{ bigLabel }}</span>
        </div>
      </div>

      <!-- Fix round 2 R2 (minor): beginCapture() already refuses silently
           while a swap is in flight (R1-T5 minor 4) — without this the FAB
           stays tappable with no visible signal. Safe to gate on
           state.swapInFlight alone: it is only ever true during 'preview'
           (toggleFacing()'s own guard), so this never disables the FAB's
           cancel role during countdown/baseline/capturing. -->
      <button
        v-if="ACTIVE_PHASES.has(state.phase)"
        type="button"
        class="absolute bottom-3 right-3 flex h-16 w-16 items-center justify-center rounded-full bg-white/90 shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="state.swapInFlight"
        :aria-label="fabLabel"
        @click="onFabClick"
      >
        <svg viewBox="0 0 44 44" class="h-14 w-14 -rotate-90">
          <circle cx="22" cy="22" r="19" fill="none" stroke="#e2e8f0" stroke-width="4" />
          <circle
            cx="22"
            cy="22"
            r="19"
            fill="none"
            :stroke="state.phase === 'baseline' ? '#1e3a5f' : '#dc2626'"
            stroke-width="4"
            stroke-linecap="round"
            :stroke-dasharray="ringCircumference"
            :stroke-dashoffset="ringOffset"
          />
        </svg>
        <!-- Fix round 1 UX ask: the FAB doubles as the cancel affordance
             during countdown and either timed phase (camera glyph while
             waiting to start, close/X glyph once a capture is running) —
             previously disabled during 'baseline'/'capturing' with no way
             out short of leaving the wizard step entirely. -->
        <Icon
          :name="isCapturePhase ? 'close' : 'camera'"
          :size="20"
          class="absolute text-primary-700"
        />
      </button>
    </div>

    <p v-if="engineLabel" class="text-center text-[11px] text-slate-400">{{ engineLabel }}</p>

    <div class="flex flex-col gap-1.5">
      <div v-for="cat in FACIAL_CATALOG" :key="cat.key" class="flex items-center gap-2">
        <span class="w-24 shrink-0 text-xs text-slate-600">{{ cat.title }}</span>
        <div class="h-2 flex-1 overflow-hidden rounded-full bg-base-200">
          <div
            class="h-full rounded-full bg-primary transition-[width] duration-100"
            :style="{ width: `${Math.round(barFraction(cat.key) * 100)}%` }"
          ></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Icon } from '@/components/ui'
import { useFaceScan } from '@/facescan/useFaceScan.js'
import { DEFAULT_THRESHOLDS, displayFraction, modelDisplayFraction } from '@/facescan/scoring.js'
import { FACIAL_CATALOG } from '@/domain/facialCatalog.js'
import { useCalibrationStore } from '@/stores/calibrationStore.js'
import { usePatientStore } from '@/stores/patientStore.js'

const emit = defineEmits(['done', 'error'])

const { state, start, beginCapture, stop, toggleFacing } = useFaceScan()
const calibrationStore = useCalibrationStore()
const patientStore = usePatientStore()

// Phases where the oval overlay, status label, banked-baseline chip and the
// capture FAB are all shown — preview (waiting for the tap), the pre-capture
// countdown (spec §7 "immediately jumps" fix — the numeral IS the countdown's
// indicator, and the face badge/cancel affordance must stay present here so
// there is never a dead 3s frame), and both capture phases (baseline
// auto-advances into capturing without another tap, spec item 8).
const ACTIVE_PHASES = new Set(['preview', 'countdown', 'baseline', 'capturing'])

const videoRef = ref(null)

// Whether a capture flow (countdown through either timed phase) is running —
// governs the FAB's cancel affordance (icon/label/click routing). Kept
// separate from isTimedPhase below: the ring itself must NOT drain during
// countdown (the big numeral is that phase's indicator), only during the
// actual timed windows.
const isCapturePhase = computed(
  () => state.phase === 'countdown' || state.phase === 'baseline' || state.phase === 'capturing'
)
const isTimedPhase = computed(() => state.phase === 'baseline' || state.phase === 'capturing')

// Decision-relative live bar (owner live-test feedback, R30 MAJOR 3 for the
// model-mode half — the earlier "plain P(ge1) is acceptable" call is
// retracted): a raw frameIntensities value idles well above 0 on some
// channels (e.g. eyes ~0.35-0.5 on a neutral face), and raw P(ge1) is
// nowhere near comparable across categories either (brow's real cutpoint is
// 0.9728, overall's is 0.455 — a bar at 90% is still INACTIVE for brow but
// already ACTIVE for overall at 50%). Both engines now map through a
// decision-relative function against the SAME threshold scoring will
// actually use (calibrated if the nurse has validated enough samples, else
// the model's raw exported cutpoint / this app's static default), so "half
// full" means "at this category's own active threshold" everywhere.
function barFraction(catKey) {
  const raw = state.live[catKey] ?? 0
  if (state.scoringEngine === 'model-v1') {
    const calibrated = calibrationStore.thresholds[catKey]?.model?.ge1
    const exported = state.modelCutpoints?.[catKey]?.ge1
    const activeThreshold = calibrated ?? exported ?? 0.5
    return modelDisplayFraction(raw, activeThreshold)
  }
  const thresholds = calibrationStore.thresholds[catKey] ?? DEFAULT_THRESHOLDS[catKey]
  return displayFraction(raw, thresholds)
}

const engineLabel = computed(() => {
  if (state.scoringEngine === 'model-v1') return 'ให้คะแนนโดยโมเดลที่ฝึกแล้ว (v1)'
  if (state.scoringEngine === 'threshold') return 'ให้คะแนนด้วยเกณฑ์อ้างอิง'
  return ''
})

const RADIUS = 19
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const ringCircumference = `${CIRCUMFERENCE}`
// Ring drains during EITHER timed phase only (baseline then capturing —
// spec item 8's two-phase capture), never during countdown (spec §7/§8: the
// numeral is the countdown's own indicator). Its color switches (navy for
// baseline, red for capturing, see the template) so the two phases still
// read as visually distinct despite sharing this one ring element.
const ringOffset = computed(
  () => `${CIRCUMFERENCE * (1 - (isTimedPhase.value ? state.progress : 0))}`
)

// Big in-video phase label (spec §8) — owner copy verbatim for
// baseline/capturing. Never reads countdownSeconds/countdownNext (the
// template handles 'countdown' in its own branch, gated strictly on
// state.phase === 'countdown').
const bigLabel = computed(() => {
  if (state.phase === 'preview') return 'แตะปุ่มเพื่อเริ่มสแกน'
  // Phase A (spec item 4/8): neutral-baseline window, model mode only —
  // useFaceScan.beginCapture() skips straight to 'capturing' when there is
  // no scoring model (or a banked baseline is supplied), so threshold mode
  // and banked scans never show this phase.
  if (state.phase === 'baseline') return `โปรดทำใบหน้าปรกติสักครู่ ${Math.round(state.progress * 100)}%`
  if (state.phase === 'capturing') return `กำลัง Scan สีหน้า ${Math.round(state.progress * 100)}%`
  return ''
})

// The "what comes next" line under the countdown numeral — chosen by
// countdownNext, which is only meaningful while state.phase === 'countdown'
// (the template never reads this outside that phase). R41/spec §3: the
// wizard scan is single-phase now, so the ONLY countdown a nurse normally
// sees leads straight into 'capturing' — its label is the new owner copy
// "เตรียมพร้อม", replacing the old "เตรียมแสดงสีหน้า" everywhere countdownNext
// is 'capturing' (that includes the legacy 'session' path's SECOND
// countdown, baseline->capturing — only its baseline-phase labels below are
// grandfathered, not this one). The 'baseline' branch is reachable only via
// that legacy path and keeps its existing copy untouched.
const countdownNextLabel = computed(() => {
  if (state.countdownNext === 'baseline') return 'เตรียมทำใบหน้าปรกติ'
  if (state.countdownNext === 'capturing') return 'เตรียมพร้อม'
  return ''
})

const fabLabel = computed(() =>
  isCapturePhase.value ? 'ยกเลิกและกลับไปเตรียมกล้อง' : bigLabel.value
)

// Baseline-source chip copy (spec §3/R41), keyed straight off T1's
// state.baselineSource rather than a separately-latched ref: beginCapture()
// sets it synchronously the moment a capture starts, and start()/stop()
// reset it to null, so this already "latches" for the lifetime of one
// capture and clears the instant the panel returns to a fresh preview —
// exactly the semantics the old hand-rolled usingBankedBaseline ref existed
// to provide, now for free. 'session' (legacy in-session baseline capture)
// and null (no capture started yet / threshold mode) both render no chip.
const baselineChipLabel = computed(() => {
  if (state.baselineSource === 'banked') return 'ใช้หน้าปกติที่บันทึกไว้'
  if (state.baselineSource === 'default') return 'ใช้หน้าอ้างอิงมาตรฐาน'
  return ''
})

function onCaptureClick() {
  beginCapture(5000, { bankedBaseline: patientStore.baseline })
}

// Fix round 1 UX ask: give the nurse a way out of a running capture instead
// of being stuck until it finishes or the whole wizard step is abandoned.
// Reuses the composable's OWN stop()/start() re-entrancy machinery — the
// exact path every other start/stop cycle in useFaceScan.js already goes
// through (session-counter guarded, full teardown then a fresh acquire) —
// rather than inventing a separate cancel-teardown path. stop() already
// clears the in-memory baseline (R27: never carried across sessions), so
// re-entering 'baseline'/'countdown' after a cancel starts a genuinely fresh
// capture. Also works during 'countdown' itself (spec §7 binding note).
function onCancelClick() {
  stop()
  start(videoRef.value)
}

function onFabClick() {
  if (isCapturePhase.value) {
    onCancelClick()
  } else {
    onCaptureClick()
  }
}

// Deferred one animation frame rather than started synchronously on mount:
// finalize()/completeReassess() reset the wizard step to 1 as part of
// saving, which transiently mounts Step3Facial -> ScanPanel *before*
// router.push(...) actually navigates away to the saved record. Starting
// getUserMedia synchronously on mount would flash the camera (and possibly
// prompt for permission) on top of the record page the nurse is about to
// land on. That transient mount's unmount (onUnmounted below) happens
// within the same frame, before this callback would ever fire, so
// deferring start() this way means getUserMedia is never actually issued
// for it — only a "real" mount that survives a frame starts the camera.
let startHandle = null
onMounted(() => {
  startHandle = requestAnimationFrame(() => start(videoRef.value))
})

// Report done/error transitions to the parent, which decides what to do
// with the result (score it, fall back to manual, etc). `done`'s second
// argument (spec item 9 — which engine scored this capture, plus R3-T7's
// baselineSource) is additive: it started as `{ scoringEngine }` only,
// Step3Facial/Step6Reassess's handlers destructured just the first
// positional arg for a while, so extending this object stays backward
// compatible with any caller that still ignores it.
//
// R3-T7 (lead ruling, T2 review): the done-state "บันทึกหน้าปกติ" hint used
// to live here, gated on `state.phase === 'done' && state.baselineSource
// === 'default' && patientStore.linked` — but both parents swap this panel
// out for ValidatePanel synchronously on THIS SAME emit, so that hint's
// render condition could never actually paint a frame; it was dead UI.
// Moved to Step4Result (the results screen), fed by baselineSource
// travelling through this emit -> Step3Facial's scanResult ->
// store.draft.facial.baselineSource. patientStore is therefore no longer
// read for gating a template branch in this file (still used below by
// onCaptureClick for the banked-baseline lookup).
watch(
  () => state.phase,
  (phase) => {
    if (phase === 'done') {
      emit('done', state.profiles, { scoringEngine: state.scoringEngine, baselineSource: state.baselineSource })
    }
    if (phase === 'error') emit('error', state.errorKind)
  }
)

// Always release the camera stream + landmarker when this panel goes away —
// covers both "unmount" and "leaving [wizard] step 1" (the parent renders
// steps with v-if, so switching steps unmounts this component). Cancelling
// the deferred start() first is what makes the transient-mount case above
// actually skip getUserMedia instead of merely stopping it a frame late.
onUnmounted(() => {
  cancelAnimationFrame(startHandle)
  stop()
})
</script>
