<!--
  Baseline banking view (spec §7, plan Task 6). Captures a neutral-face
  vector at a pain-free moment (e.g. แรกรับ/หลังได้รับยา) and banks it via
  saveBaselineRemote so every later scan can subtract a patient-specific
  baseline instead of assuming a population-average neutral face.

  Owns its OWN useFaceScan() instance — never shared with ScanPanel.vue
  (Task 4's file). Per the engine review note, state.baselineResult is not
  cleared by beginCapture(); a shared instance could leak a stale baseline
  result across the two features, so each view gets a fresh composable
  call instead.

  The mild-oval guide/progress-arc/label overlay is a deliberately
  lightweight LOCAL duplicate of spec §8's look (ScanPanel is Task 4's file
  — this view never touches it), reduced to only what a baseline-only
  capture actually needs: no live per-category bars (there is no expression
  phase here to feed them). R5-T1 (owner request) swapped the guide's old
  elliptical cutout for a progress ring + a milder ellipse, mirroring
  ScanPanel.vue's own R5-T1 change by hand (still no shared component). R5-T1
  round 1 (owner feedback on the live deploy) walked the intermediate pure
  circle back to a mild oval and fixed a progress-ring rendering bug. R5-T1
  round 2 (owner: "the progress ring is awkward") deleted that separate
  concentric ring entirely in favor of a progress ARC painted directly on
  the guide's own path — see the overlay SVG's own comment below for all
  three rounds.
-->
<script>
// Pure save-flow logic, extracted per plan Task 6 so
// tests/stores/baselineView.test.js can drive the happy/failed/retry
// transitions without mounting this view (no camera/composable/router
// involved at all). Vue SFC compiler merges a plain `<script>` block and a
// `<script setup>` block into ONE module — bindings declared here are
// visible to `<script setup>` below as if imported, and this named export
// rides alongside the component's default export from the SAME file, so no
// extra file is needed under this task's strict ownership list.
//
// Unconfigured sync (no syncUrl) is deliberately routed through the SAME
// branch as a thrown SyncError/network failure (plan Task 6 step 4): from
// the patient's perspective both mean "couldn't reach the central DB right
// now", and the local write-through must never depend on whether a syncUrl
// happens to be configured — banking a baseline must never be a dead
// button just because sync isn't set up on this device.
//
// Fix round MAJOR: `linked` is checked FIRST, before anything else — a
// direct/typed/bookmarked #/baseline visit while unlinked (or an unlink
// that lands between capture and this call, e.g. ออกจากผู้ป่วย in another
// tab) must refuse outright: no POST with null patientId/token, and no
// patientStore.setBaseline() call either, since that write skips
// persistence when unlinked anyway (usePatientStore.setBaseline) — calling
// it here would only leave an in-memory value paired with copy claiming a
// local save that never actually happened. The distinct `reason: 'unlinked'`
// return lets the view render an honest message instead of the generic
// "saved locally" warning, which would be false in this state.
export async function saveBaselineFlow({ linked, syncUrl, patientId, token, baseline, saveBaselineRemote, setBaseline }) {
  if (!linked) return { ok: false, reason: 'unlinked' }
  if (syncUrl) {
    try {
      await saveBaselineRemote(syncUrl, { patientId, token, baseline })
      setBaseline(baseline)
      return { ok: true }
    } catch {
      setBaseline(baseline)
      return { ok: false }
    }
  }
  setBaseline(baseline)
  return { ok: false }
}
</script>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { usePatientStore } from '../stores/patientStore.js'
import { useSyncStore } from '../stores/syncStore.js'
import { useFaceScan } from '../facescan/useFaceScan.js'
import { saveBaselineRemote } from '../sync/client.js'
import { BaseButton, Icon } from '../components/ui'
import PatientContextCard from '../components/PatientContextCard.vue'

const router = useRouter()
const patientStore = usePatientStore()
const syncStore = useSyncStore()
const { state, start, beginBaselineCapture, stop, toggleFacing } = useFaceScan()

const videoRef = ref(null)
const saveStatus = ref(null) // null|'saving'|'success'|'failed'|'unlinked'
const capturedVector = ref(null)

async function runSave(vector) {
  capturedVector.value = vector
  saveStatus.value = 'saving'
  // `linked` is read fresh at call time (not cached from mount) — the
  // fix-round belt-and-braces check: an unlink that lands between capture
  // completing and this call running must still be caught here, even
  // though the template's own top-level unlinked gate (below) already
  // covers the ordinary in-app case.
  const result = await saveBaselineFlow({
    linked: patientStore.linked,
    syncUrl: syncStore.syncUrl,
    patientId: patientStore.patientId,
    token: patientStore.token,
    baseline: vector,
    saveBaselineRemote,
    setBaseline: patientStore.setBaseline,
  })
  saveStatus.value = result.ok ? 'success' : result.reason === 'unlinked' ? 'unlinked' : 'failed'
}

function onStartCapture() {
  beginBaselineCapture(4000)
}

function onRetry() {
  if (capturedVector.value) runSave(capturedVector.value)
}

function goHome() {
  router.push('/')
}

const statusLabel = computed(() => (state.faceDetected ? 'ตรวจพบใบหน้า' : 'จัดใบหน้าให้อยู่ในกรอบ'))

// Face-guide progress arc (R5-T1 round 3 — owner: "ring misorientation"):
// painted directly on the guide ellipse's own path in the video overlay SVG
// above. Round 2 used a constant dasharray="100" plus a progress-driven
// dashoffset and a transform="rotate(-90 cx cy)" to relocate the dash start
// to 12 o'clock — but rotating an ELLIPSE swaps its rx/ry, so the arc
// traced the wrong shape (see the template's own root-cause comment for the
// full derivation). Round 3 drops the rotate transform completely and
// instead uses a CONSTANT stroke-dashoffset="25" (a plain template
// attribute, not driven from here) paired with a progress-driven two-value
// dasharray computed below — dasharray is now what animates, not offset.
// Still pathLength="100" normalization. The template's
// `v-if="state.phase === 'baseline'"` wrapping both the shadow and arc
// paths (not this computed) is the other half of the fix — neither element
// exists outside that one timed phase, so this computed only ever needs to
// be correct while it's already true; kept as a hand-duplicated computed
// here per this view's existing "no shared component" stance, mirroring
// ScanPanel.vue's own face-guide arc by hand.
const faceArcDasharray = computed(() => {
  const filled = state.progress * 100
  return `${filled} ${100 - filled}`
})

// Countdown numeral must NEVER render outside phase 'countdown' (a stale
// 3/2/1 lingering into 'baseline' would read as the capture stalling) — the
// template below gates every branch on state.phase directly rather than on
// a derived boolean, so there is exactly one condition to keep in sync.

// Deferred one animation frame rather than started synchronously on mount
// (mirrors ScanPanel.vue's own pattern) — guards the same transient-mount
// case: a route change away from this view within the same frame must
// never actually issue getUserMedia.
// Fix round MAJOR: a direct/typed/bookmarked #/baseline visit while
// UNLINKED must never open the camera at all — there is no patient to bank
// a baseline against, so getUserMedia would be pure noise (and a real
// permission prompt) ahead of a view that's about to tell the nurse to go
// back anyway.
let startHandle = null
onMounted(() => {
  if (!patientStore.linked) return
  startHandle = requestAnimationFrame(() => start(videoRef.value))
})

onUnmounted(() => {
  cancelAnimationFrame(startHandle)
  stop()
})

watch(
  () => state.phase,
  (phase) => {
    if (phase === 'done' && state.baselineResult) {
      runSave(state.baselineResult)
    }
  }
)

// Fix round 1 MAJOR 2: tapping ออก (now reachable from this view's own
// PatientContextCard, above) while the camera preview is live must release
// it. patientStore.linked flipping false only swaps this view's OWN
// v-if/v-else TEMPLATE branch back to the "please link" panel — this
// component itself stays mounted the whole time (same route, same
// instance), so onUnmounted()'s stop() never fires on its own. Without this
// watch the MediaStream tracks stay live and the rAF detection loop keeps
// running against a now-detached <video>, camera light on, output ignored.
watch(
  () => patientStore.linked,
  (linked) => {
    if (!linked) stop()
  }
)
</script>

<template>
  <div>
    <!-- Fix round MAJOR: a direct/typed/bookmarked #/baseline visit while
         UNLINKED shows this INSTEAD of everything else below — there is no
         patient to bank a baseline against, so neither the camera nor the
         capture flow are ever reachable in this state. -->
    <div v-if="!patientStore.linked" class="flex flex-col items-center gap-3 rounded-2xl bg-white p-6 text-center shadow-md">
      <Icon name="info" :size="28" class="text-primary-700" />
      <p class="text-sm text-gray-600">
        การบันทึกหน้าปกติทำได้เฉพาะเมื่อเชื่อมกับผู้ป่วยแล้ว กรุณาสแกน QR ของผู้ป่วยจากหน้าหลักก่อน
      </p>
      <BaseButton variant="outline" @click="goHome">กลับหน้าหลัก</BaseButton>
    </div>

    <template v-else>
      <BaseButton variant="ghost" size="md" class="mb-3" @click="goHome">
        <Icon name="chevron-left" :size="16" /> กลับหน้าหลัก
      </BaseButton>

      <!-- R41 T5 (spec §5): same self-gating card as every other linked
           surface — reachable here since this branch only ever renders
           while linked already. -->
      <PatientContextCard />

      <section class="rounded-2xl bg-white p-4 shadow-md">
        <h3 class="mb-2 text-base font-semibold text-primary-700">บันทึกหน้าปกติ</h3>
      <p class="mb-4 text-sm text-gray-600">
        ถ่ายภาพหน้าปกติในช่วงที่ผู้ป่วยไม่มีอาการปวด เช่น ตอนแรกรับหรือหลังได้รับยาแก้ปวดแล้ว
        เพื่อใช้เป็นค่าอ้างอิงเปรียบเทียบกับสีหน้าขณะปวดในการประเมินครั้งถัดไป — ทำเพียงครั้งเดียวแล้วใช้ซ้ำได้ทุกครั้งที่สแกน
      </p>

      <div v-if="state.phase === 'idle' || state.phase === 'loading'" class="flex flex-col items-center gap-2 py-10 text-slate-500">
        <span class="loading loading-spinner loading-lg" aria-hidden="true"></span>
        <span class="text-sm">กำลังเปิดกล้องและโหลดโมเดล…</span>
      </div>

      <div v-else-if="state.phase === 'error'" class="flex flex-col items-center gap-3 py-6 text-center">
        <Icon name="alert-circle" :size="28" class="text-error" />
        <p class="text-sm text-gray-600">
          {{
            state.errorKind === 'camera'
              ? 'เปิดกล้องไม่สำเร็จ กรุณาอนุญาตการใช้กล้องแล้วลองใหม่อีกครั้ง'
              : 'โหลดโมเดลตรวจจับใบหน้าไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
          }}
        </p>
        <BaseButton variant="outline" @click="goHome">กลับหน้าหลัก</BaseButton>
      </div>

      <!-- Baseline banking is model-mode only (same as phase A today) — a
           threshold-fallback deployment has no per-frame model score to
           subtract a baseline from, so this explains why and sends the
           nurse back rather than showing a capture button that can never
           complete (owner directive: no dead features). -->
      <div v-else-if="state.phase === 'preview' && state.scoringEngine === 'threshold'" class="flex flex-col items-center gap-3 py-6 text-center">
        <Icon name="info" :size="28" class="text-primary-700" />
        <p class="text-sm text-gray-600">
          การบันทึกหน้าปกติต้องใช้โมเดลที่ผ่านการฝึกแล้ว แต่อุปกรณ์นี้ยังไม่พบโมเดลดังกล่าว จึงยังบันทึกหน้าปกติไม่ได้ในขณะนี้
        </p>
        <BaseButton variant="outline" @click="goHome">กลับหน้าหลัก</BaseButton>
      </div>

      <div v-else-if="state.phase === 'done'" class="flex flex-col items-center gap-3 py-6 text-center">
        <template v-if="saveStatus === 'saving'">
          <span class="loading loading-spinner loading-lg" aria-hidden="true"></span>
          <span class="text-sm text-gray-500">กำลังบันทึก…</span>
        </template>
        <template v-else-if="saveStatus === 'success'">
          <Icon name="success" :size="32" class="text-success" />
          <p class="text-sm font-medium text-gray-700">บันทึกหน้าปกติสำเร็จ</p>
          <BaseButton variant="primary" @click="goHome">กลับหน้าหลัก</BaseButton>
        </template>
        <template v-else-if="saveStatus === 'failed'">
          <Icon name="alert-triangle" :size="32" class="text-warning" />
          <p class="text-sm text-gray-700">
            บันทึกในเครื่องแล้ว แต่ยังส่งเข้าระบบกลางไม่สำเร็จ — อุปกรณ์อื่นจะยังไม่มีหน้าปกตินี้
          </p>
          <div class="flex flex-wrap justify-center gap-2">
            <BaseButton variant="primary" @click="onRetry">ลองอีกครั้ง</BaseButton>
            <BaseButton variant="ghost" @click="goHome">กลับหน้าหลัก</BaseButton>
          </div>
        </template>
        <!-- Fix round MAJOR belt-and-braces: distinct from 'failed' on
             purpose — an unlink that lands between capture and save must
             never show the "saved locally" copy, since setBaseline() was
             never called for it (it also skips persistence when unlinked). -->
        <template v-else-if="saveStatus === 'unlinked'">
          <Icon name="alert-triangle" :size="32" class="text-warning" />
          <p class="text-sm text-gray-700">
            อุปกรณ์นี้ไม่ได้เชื่อมกับผู้ป่วยแล้ว จึงไม่ได้บันทึกหน้าปกตินี้ กรุณาเชื่อมผู้ป่วยใหม่แล้วลองอีกครั้ง
          </p>
          <BaseButton variant="outline" @click="goHome">กลับหน้าหลัก</BaseButton>
        </template>
      </div>

      <!-- Production-blocker fix (spec §4): the <video> element MUST exist
           at mount time. onMounted() defers start(videoRef.value) by one
           requestAnimationFrame while phase is still 'idle'/'loading'; if
           the camera container were still gated behind a v-if/v-else chain
           (rendering only once phase reaches 'preview'), that rAF callback
           would read a null videoRef.value, start() would receive null,
           getUserMedia would still succeed (camera light on), and
           `videoEl.srcObject = stream` would then throw on null deep in the
           async path — camera light on, spinner forever, no error shown.
           So this container is now ALWAYS in the DOM for EVERY phase of the
           linked flow (including 'done'/'error'/threshold-preview, where a
           v-if section above shows instead and this stays hidden)
           and only its VISIBILITY is toggled with v-show — never removed
           from the DOM by the phase transitions this bug lived in. The
           spinner/error/threshold-notice/done sections above remain v-if
           overlays; while one of them is showing, this container is simply
           hidden (v-show), not unmounted. -->
      <div
        v-show="['preview', 'countdown', 'baseline', 'capturing'].includes(state.phase) && state.scoringEngine !== 'threshold'"
        class="flex flex-col gap-3"
      >
        <div class="relative overflow-hidden rounded-2xl bg-primary-900">
          <video
            ref="videoRef"
            :class="['aspect-[3/4] w-full object-cover', state.facing === 'user' ? '-scale-x-100' : '']"
            muted
            playsinline
            autoplay
          ></video>

          <!-- Mild-oval face guide (R5-T1 round 1: owner feedback called a
               pure circle "does not match face shape"; wants a MILD oval —
               old ellipse was ~1:1.69 height:width, far too elongated;
               target ~1:1.2). This viewBox (0 0 300 400) already matches
               the video's own aspect-[3/4] container exactly, so user
               units ARE on-screen proportions — no distortion math needed
               (unlike ScanPanel.vue's sibling overlay, which had to
               recalibrate its own square viewBox first — see that file's
               comment). rx=98 ry=118 -> ry/rx = 1.204, ~1.2x taller than
               wide on screen, the mild-oval target; rx=98 also keeps
               roughly the same horizontal reach as the old ellipse's rx
               (105).

               R5-T1 round 2 (owner: "the progress ring is awkward" — a
               screenshot at 70% showed a thick translucent gray band + a
               fat red arc riding offset from the guide, i.e. three
               competing rings including the green guide outline). Round
               1's separate concentric track+arc ellipses (rx111/ry131) are
               DELETED — no gap ring, no gray band. The progress arc below
               instead shares the guide's own cx/cy/rx/ry, so it visibly
               paints over the guide outline as it sweeps rather than
               existing as a second ring. Two stacked paths: a wider,
               translucent dark stroke first (contrast halo, so the white
               arc stays legible over both the dark scrim and bright
               video/skin at the boundary), then the white arc on top.
               Stroke widths tuned in USER units for this viewBox's own CTM
               scale (this container renders around ~675px wide, scale
               ~675/300 = 2.25x) to land at ~4-5 real device px for the
               arc: 2 user units × 2.25 = 4.5px; the halo is 3 user units
               (~6.75px) so it peeks out ~2px around the arc. Dropped the
               round-1 navy/red baseline color for this arc (plain white +
               dark halo instead) — this view only ever has one timed
               phase anyway, so there was never a real split to lose.

               R5-T1 round 3 (owner: "ring misorientation"). ROOT CAUSE of
               round 2's bug: transform="rotate(-90 cx cy)" only relocates
               the dash start on a CIRCLE — on an ELLIPSE (rx != ry) it
               rotates the WHOLE SHAPE and SWAPS ITS AXES, so the arc/halo
               traced a landscape ellipse (118x98 effective) over this
               portrait guide (98x118), crossing it at four points instead
               of riding it.

               FIX: NO transform at all — these two paths are pixel-
               identical ellipses to the guide. Relocate the dash start
               with dash math instead. An SVG <ellipse>'s equivalent path
               starts at the RIGHT point (cx+rx, cy) and proceeds CLOCKWISE
               on screen (SVG2 spec traversal order: right -> bottom ->
               left -> top -> back to right). Independently verified for
               this exact rx/ry pair by true arc-length integration (an
               axis-aligned ellipse's mirror symmetry across both axes
               forces its 4 quadrants to have EXACTLY equal arc length
               regardless of eccentricity) that with pathLength="100" the
               top point sits at path position EXACTLY 75. A point at path
               distance s is "on" (painted) iff (s + stroke-dashoffset) mod
               100 < dash1 (the first dasharray value). With the constant
               stroke-dashoffset="25" below and dasharray="{L} {100-L}" (L
               = progress*100): solving (s+25) mod 100 = 0 gives s=75 as
               the on-region's start, and increasing s from 75 moves
               toward s=100(=0, the right point) next — clockwise on
               screen, exactly the SVG traversal direction. Verified
               numerically (not just by hand) by simulating the actual
               on/off decision across progress 0/0.25/0.5/0.75/1: the
               visible arc always starts at s=75 and grows forward by
               exactly L units. dashoffset is now a plain CONSTANT — the
               CSS transition moved from stroke-dashoffset to
               stroke-dasharray (a two-value list summing to 100
               throughout, a stable case for CSS transitions). Left
               UNSUPPRESSED at progress 0 ("0 100" + round linecap): a
               small round ~5px dot at the 12-o'clock start point, accepted
               as a legitimate start marker rather than adding a
               v-if="progress > 0" that would just relocate the pop-in/out
               flicker to a different threshold. -->
          <svg viewBox="0 0 300 400" class="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <mask id="baseline-face-mask">
                <rect x="0" y="0" width="300" height="400" fill="white" />
                <ellipse cx="150" cy="190" rx="98" ry="118" fill="black" />
              </mask>
            </defs>
            <rect x="0" y="0" width="300" height="400" fill="black" fill-opacity="0.55" mask="url(#baseline-face-mask)" />
            <ellipse
              cx="150"
              cy="190"
              rx="98"
              ry="118"
              fill="none"
              :stroke="state.faceDetected ? '#16a34a' : '#e2e8f0'"
              stroke-width="4"
              data-testid="face-guide"
            />
            <!-- Progress arc (R5-T1 round 3): drawn ON the guide's own
                 ellipse path (identical cx/cy/rx/ry to the guide above),
                 v-if-gated to state.phase === 'baseline' — this view's only
                 timed capture phase (beginBaselineCapture() never enters
                 'capturing'; see useFaceScan.js) — so neither path exists
                 outside it. pathLength="100" + a constant
                 stroke-dashoffset="25" + a progress-driven two-value
                 dasharray (see the overlay's own comment above for the
                 full start-point/direction derivation) fills clockwise
                 from 12 o'clock with NO transform. -->
            <template v-if="state.phase === 'baseline'">
              <ellipse
                cx="150"
                cy="190"
                rx="98"
                ry="118"
                fill="none"
                stroke="#000000"
                stroke-opacity="0.35"
                stroke-width="3"
                stroke-linecap="round"
                pathLength="100"
                stroke-dashoffset="25"
                :stroke-dasharray="faceArcDasharray"
                class="transition-[stroke-dasharray] duration-150 ease-linear"
                data-testid="face-progress-arc-shadow"
              />
              <ellipse
                cx="150"
                cy="190"
                rx="98"
                ry="118"
                fill="none"
                stroke="#ffffff"
                stroke-opacity="0.95"
                stroke-width="2"
                stroke-linecap="round"
                pathLength="100"
                stroke-dashoffset="25"
                :stroke-dasharray="faceArcDasharray"
                class="transition-[stroke-dasharray] duration-150 ease-linear"
                data-testid="face-progress-arc"
              />
            </template>
          </svg>

          <!-- Front/back camera swap (R4-T5, new user requirement): same
               hand-drawn inline SVG as ScanPanel.vue (no shared component —
               out of this task's file-ownership list; kept visually
               identical by hand). toggleFacing() itself re-guards on
               state.phase === 'preview' (spec: guard lives in the
               composable), so this v-if is belt-and-braces.
               Fix round 1 MAJOR 1: placed AFTER the face-guide scrim SVG above —
               it used to sit before it, so the scrim's fill-opacity
               composited OVER the button and it read dimmed/disabled. Fix
               round 1 minor 5: disabled + swapped for a spinner while
               state.swapInFlight, mirroring ScanPanel.vue. -->
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

          <!-- Fix round 2 R1 (MAJOR): pointer-events-none is LOAD-BEARING
               here — this div is a LATER absolute sibling than the swap
               button above (top-right, 44x44px) and its top edge overlaps
               the badge's own top-2 row; without this class the badge
               (non-interactive itself) would still swallow clicks over the
               top ~20px of the button's tap target. Matches ScanPanel.vue's
               equivalent status-label wrapper, which already has it. -->
          <div class="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
            <span class="badge gap-1.5 border-none text-xs text-white" :class="state.faceDetected ? 'badge-success' : 'badge-warning'">
              {{ statusLabel }}
            </span>
          </div>

          <div class="absolute inset-x-0 bottom-3 flex flex-col items-center gap-1 px-4 text-center text-white">
            <template v-if="state.phase === 'countdown'">
              <span class="text-6xl font-bold leading-none">{{ state.countdownSeconds }}</span>
              <span class="text-sm">เตรียมทำใบหน้าปรกติ</span>
            </template>
            <template v-else-if="state.phase === 'baseline'">
              <span class="text-lg font-semibold">โปรดทำใบหน้าปรกติสักครู่</span>
              <span class="text-sm">{{ Math.round(state.progress * 100) }}%</span>
            </template>
            <template v-else>
              <span class="text-base">แตะปุ่มด้านล่างเพื่อเริ่มบันทึกหน้าปกติ</span>
            </template>
          </div>
        </div>

        <!-- Fix round 2 R2 (minor): beginBaselineCapture() already refuses
             silently while a swap is in flight (R1-T5 minor 4) — without
             this the button stays tappable with no visible signal that the
             tap did nothing. -->
        <BaseButton
          v-if="state.phase === 'preview'"
          variant="primary"
          size="lg"
          block
          :disabled="state.swapInFlight"
          @click="onStartCapture"
        >
          เริ่มถ่ายภาพหน้าปกติ
        </BaseButton>
      </div>
      </section>
    </template>
  </div>
</template>
