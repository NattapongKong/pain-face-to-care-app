<!--
  Camera preview + 5-second capture UI (spec §5.5, redesigned per spec §7/§8:
  mild-oval guide overlay + progress arc — R5-T1 round 0 replaced the
  original too-elongated oval + linear text-only progress with a pure
  circle + separate ring; round 1 (owner: "does not match face shape")
  walked the circle back to a mild oval and fixed a ring rendering bug;
  round 2 (owner: "the progress ring is awkward") deleted the separate
  ring in favor of a progress arc painted directly on the guide's own path
  — big in-video phase labels, pre-capture countdown, banked-baseline
  wiring). Wraps useFaceScan end-to-end: acquires the camera on mount, runs
  the live detection loop, and always releases the
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

      <!-- Mild-oval face guide (R5-T1 round 1: owner feedback on the live
           deploy called a pure circle "does not match face shape"; wants a
           MILD oval — old ellipse was ~1:1.69 height:width, far too
           elongated; target ~1:1.2). Dark scrim with an elliptical cutout,
           plus an outline that reads success-green once a face is
           detected, plus (round 2) a progress arc painted DIRECTLY ON the
           guide's own path — no separate concentric ring. Shown during
           preview/countdown/baseline/capturing — i.e. whenever the
           FAB/status label are also shown.

           viewBox stays "0 0 75 100" (matches the video's own aspect-[3/4]
           container exactly, so user units ARE on-screen proportions — no
           further distortion math needed): rx=21 ry=25.5 -> ry/rx = 1.214,
           i.e. the guide renders ~1.2x taller than wide on screen, the
           mild-oval target. Scrim opacity/mask mechanism/pointer-events-none
           untouched.

           R5-T1 round 2 (owner: "the progress ring is awkward" — a
           screenshot at 70% showed a thick translucent gray band + a fat
           red arc riding offset from the guide, i.e. three competing rings
           including the green guide outline). Round 1's separate
           concentric track+arc ellipses (rx24/ry28.5) are DELETED — no gap
           ring, no gray band. The progress arc below instead shares the
           guide's own cx/cy/rx/ry, so it visibly paints over the guide
           outline as it sweeps rather than existing as a second ring. Two
           stacked paths, same pathLength="100" technique as round 1 (still
           no vector-effect on either — that combination was round 1's own
           root-cause bug, see the R5-T1 round-1 commit for the mechanism):
           a wider, translucent dark stroke first (contrast halo, so the
           white arc stays legible over both the dark scrim and bright
           video/skin at the boundary), then the white arc on top. Both
           share one dasharray computed value so they move in perfect
           lockstep (round 3 changed what drives the animation — see below
           — but this pairing is unchanged). Stroke widths are tuned in
           USER units per this viewBox's own CTM scale (this container
           renders around ~700px wide, giving a scale factor of ~700/75 ≈
           9.3x) to land at ~4-5 real device px for the arc: 0.5 user units
           × 9.3 ≈ 4.7px; the halo is 0.7 user units (~6.5px) so it peeks
           out ~2px around the arc. -->
      <svg
        v-if="ACTIVE_PHASES.has(state.phase)"
        class="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 75 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <mask id="scanpanel-face-mask">
            <rect x="0" y="0" width="75" height="100" fill="white" />
            <ellipse cx="37.5" cy="44" rx="21" ry="25.5" fill="black" />
          </mask>
        </defs>
        <rect x="0" y="0" width="75" height="100" fill="black" fill-opacity="0.55" mask="url(#scanpanel-face-mask)" />
        <ellipse
          cx="37.5"
          cy="44"
          rx="21"
          ry="25.5"
          fill="none"
          :stroke="state.faceDetected ? '#16a34a' : '#e2e8f0'"
          stroke-width="1.2"
          vector-effect="non-scaling-stroke"
          data-testid="face-guide"
        />
        <!-- Progress arc (R5-T1 round 3 — owner: "ring misorientation"):
             drawn ON the guide's own ellipse path (identical cx/cy/rx/ry to
             the guide above), v-if-gated to isTimedPhase so neither path
             exists outside baseline/capturing — provably absent, not just
             visually zeroed. pathLength="100" ties dash units to a
             percentage of the real rendered path.

             ROOT CAUSE of round 2's "ring misorientation" bug: round 2 used
             transform="rotate(-90 cx cy)" to relocate the dash start to 12
             o'clock. That trick only relocates the dash start on a CIRCLE
             — on an ELLIPSE (rx != ry) it rotates the WHOLE SHAPE and
             SWAPS ITS AXES, so the arc/halo traced a landscape ellipse
             (25.5x21 effective here) over this portrait guide (21x25.5),
             crossing it at four points instead of riding it.

             FIX: NO transform at all — these two paths are pixel-identical
             ellipses to the guide. Relocate the dash start with dash math
             instead. An SVG <ellipse>'s equivalent path starts at the
             RIGHT point (cx+rx, cy) and proceeds CLOCKWISE on screen (SVG2
             spec traversal order: right -> bottom -> left -> top -> back to
             right). Independently verified for this exact rx/ry pair (not
             just angularly, by true arc-length integration — an
             axis-aligned ellipse's mirror symmetry across both axes forces
             its 4 quadrants to have EXACTLY equal arc length regardless of
             eccentricity) that with pathLength="100" the top point sits at
             path position EXACTLY 75. A point at path distance s is
             "on" (painted) iff (s + stroke-dashoffset) mod 100 < dash1 (the
             first dasharray value). With the constant stroke-dashoffset="25"
             below and dasharray="{L} {100-L}" (L = progress*100): solving
             (s+25) mod 100 = 0 gives s=75 as the on-region's start, and
             increasing s from 75 moves toward s=100(=0, the right point)
             next — clockwise on screen, exactly the SVG traversal
             direction. Verified numerically (not just by hand) by
             simulating the actual on/off decision across progress
             0/0.25/0.5/0.75/1: the visible arc always starts at s=75 and
             grows forward by exactly L units, for both this view's rx/ry
             and BaselineView's. dashoffset is now a plain CONSTANT (not
             progress-driven) — dasharray is what animates progress, so the
             CSS transition moved from stroke-dashoffset to stroke-dasharray
             (a two-value list whose values always sum to 100 across the
             whole animation — a stable, well-behaved case for CSS
             transitions, unlike list-length-mismatch scenarios that are
             the usual source of dasharray-transition quirks). Left
             UNSUPPRESSED at progress 0 ("0 100" dasharray + round linecap):
             this renders as a small round dot at the 12-o'clock start
             point rather than nothing — accepted as a legitimate, ~5px
             "start marker" rather than adding a v-if="progress > 0" that
             would just relocate a pop-in/out flicker to a different
             threshold. -->
        <template v-if="isTimedPhase">
          <ellipse
            cx="37.5"
            cy="44"
            rx="21"
            ry="25.5"
            fill="none"
            stroke="#000000"
            stroke-opacity="0.35"
            stroke-width="0.7"
            stroke-linecap="round"
            pathLength="100"
            stroke-dashoffset="25"
            :stroke-dasharray="faceArcDasharray"
            class="transition-[stroke-dasharray] duration-150 ease-linear"
            data-testid="face-progress-arc-shadow"
          />
          <ellipse
            cx="37.5"
            cy="44"
            rx="21"
            ry="25.5"
            fill="none"
            stroke="#ffffff"
            stroke-opacity="0.95"
            stroke-width="0.5"
            stroke-linecap="round"
            pathLength="100"
            stroke-dashoffset="25"
            :stroke-dasharray="faceArcDasharray"
            class="transition-[stroke-dasharray] duration-150 ease-linear"
            data-testid="face-progress-arc"
          />
        </template>
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
           Fix round 1 MAJOR 1: placed AFTER the face-guide scrim SVG above (not
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

      <!-- Status label above the face guide (spec §8) — replaces the old corner
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

// Phases where the face-guide overlay, status label, banked-baseline chip and the
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

// Face-guide progress arc (R5-T1 round 3 — owner: "ring misorientation"):
// painted directly on the guide ellipse's own path in the video overlay
// SVG above, NOT the FAB ring above/below this one — a separate element,
// same reactive source (state.progress). Round 2 used a constant
// dasharray="100" plus a progress-driven dashoffset and a
// transform="rotate(-90 cx cy)" to relocate the dash start to 12 o'clock —
// but rotating an ELLIPSE (unlike a circle) swaps its rx/ry, so the arc
// traced the wrong shape entirely (see the template's own root-cause
// comment for the full derivation, independently re-verified by both
// arc-length integration and a dash on/off simulation). Round 3 drops the
// rotate transform completely and instead uses a CONSTANT
// stroke-dashoffset="25" (a plain template attribute, not driven from
// here) paired with a progress-driven two-value dasharray computed below —
// dasharray is now what animates, not offset. Still pathLength="100"
// normalization, still no vector-effect on the dashed paths (that
// combination was round 1's own root-cause bug). The template's
// `v-if="isTimedPhase"` wrapping both the shadow and arc paths (not
// present here) is the other half of the fix: neither element exists
// outside baseline/capturing, so this computed only ever needs to be
// correct while isTimedPhase is already true. No navy/red phase-color
// split for this arc (round 2 ruling: plain white + dark contrast halo
// instead) — the FAB ring below keeps its own inline navy/red split
// untouched.
const faceArcDasharray = computed(() => {
  const filled = state.progress * 100
  return `${filled} ${100 - filled}`
})

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
