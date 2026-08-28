<!--
  6-step assessment wizard (spec §7 /assess, ruling R18 reorder). Route:
  `/assess` (new/resumed assessment, lands on step 1 = the facial scan so a
  fresh QR-code entry starts scanning immediately) or `/assess?recordId=…`
  (reassess an existing record, jumps straight to step 6).

  Step order: 1 สังเกตสีหน้า (Step3Facial) → 2 ข้อมูลผู้ป่วย (Step1Patient) →
  3 ความปวด (Step2Reported) → 4 ผลประเมิน → 5 การพยาบาล → 6 ประเมินซ้ำ. Step
  components keep their original filenames (from the form's part numbering)
  — only their position in this switch and the store's `step` values moved.

  Steps are switched with v-if (not v-show) so leaving a step always tears
  it down — this is what guarantees ScanPanel's camera stream is released
  when navigating away from step 1 (the scan step) in either direction,
  without that step needing to know it's being left.

  R41 T5 (spec §6): while patientStore.linked, step 2 ข้อมูลผู้ป่วย
  (Step1Patient) is never entered at all — store.step simply never becomes
  2 for a linked device (Step3Facial's goNext() skips 1->3, this view's
  goBack() skips 3->1, and enterFromRoute()'s bounce-forward guard covers a
  resumed/legacy draft that lands on 2 after the device has since linked).
  The v-if chain below is intentionally unchanged (still keyed on the exact
  store.step value) — that invariant is what makes the omission real rather
  than merely hidden. SectionCard numbers, by contrast, ARE computed fresh
  every render via displayNumbers/visibleSteps below, so they read
  contiguously (1..5) whenever the omitted step's absence would otherwise
  leave a gap.
-->
<template>
  <div class="flex flex-col gap-4">
    <!--
      Wizard context strip (spec §6, ruling R37 fix context; R41 T5 swaps
      the old read-only identity chip for the full PatientContextCard —
      spec §5): visible on EVERY step so a nurse never finishes an
      assessment unaware the device is (or isn't) linked to a patient.
      PatientContextCard self-gates on linked and renders nothing
      otherwise; the amber "not linked" warning is this view's own
      complementary branch (unchanged copy/behavior).

      Ruling R44 (fix round 1 MAJOR 3): hide-unlink — an ออก tap mid-wizard
      would create a record whose draftPatientId gets frozen at draft-start
      per R36/R37, leaving a record that's both unsynced AND excluded from
      every list's visibleRecords() (neither the old nor the new patient
      context matches it) — there is no coherent attribution for it. Rather
      than allow that dead-end, this instance never offers ออก; HomeView's
      card (default hideUnlink=false) is unaffected and remains the one
      place a device actually unlinks.

      Fix round 1 MINOR 6: the card's own mb-4 (built for stacking contexts
      without a gap-based parent) would double up with this row's own
      gap-4, rendering 32px instead of the wizard's 16px rhythm. `-mb-4`
      here (not touched inside PatientContextCard.vue, so every OTHER call
      site keeps its default spacing) cancels exactly that: this flex ROW's
      own gap-4 already supplies the 16px, and since a flex item establishes
      its own block-formatting context, the card's inner mb-4 can't collapse
      out on its own — `-mb-4` on the card's root (landing there via plain
      Vue attribute/class fallthrough, since PatientContextCard has exactly
      one conditional root and no other class of its own on it) cancels the
      redundant 16px the flex gap would otherwise add on top.
    -->
    <PatientContextCard class="-mb-4" hide-unlink />
    <div v-if="!patientStore.linked" class="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
      ยังไม่ได้เชื่อมผู้ป่วย — บันทึกจะเก็บในเครื่องนี้เท่านั้น
    </div>

    <StepProgress :current="currentDisplayNumber" :labels="visibleLabels" />

    <Step3Facial v-if="store.step === 1" :section-number="displayNumbers[1]" />
    <Step1Patient v-else-if="store.step === 2" :section-number="displayNumbers[2]" />
    <Step2Reported v-else-if="store.step === 3" :section-number="displayNumbers[3]" />
    <Step4Result v-else-if="store.step === 4" :section-number="displayNumbers[4]" />
    <Step5Nursing v-else-if="store.step === 5" :section-number="displayNumbers[5]" />
    <Step6Reassess v-else-if="store.step === 6" :section-number="displayNumbers[6]" />

    <!--
      Layout fix (R21 audit): BaseButton's `block` prop maps to daisyUI's
      btn-block, which is `width: 100%` on the <button> itself, not a flex
      weight. Two block buttons as direct siblings in this flex row each
      try to be 100% of the row's width and don't shrink (the .btn reset
      sets flex-shrink: 0), so the second button rendered ~2x the
      available width and was silently clipped past the viewport edge
      (html/body have overflow-x: hidden, so no scrollbar ever showed it
      was happening — confirmed via getBoundingClientRect during the
      Wave-4 audit). Wrapping each BaseButton in a flex-1 min-w-0 div gives
      the 100%-width button a properly bounded containing block to size
      against instead of touching BaseButton.vue (frozen, owned by ui/).
    -->
    <div v-if="showBack || showNext" class="flex gap-3">
      <div v-if="showBack" class="min-w-0 flex-1">
        <BaseButton variant="outline" block @click="goBack">ย้อนกลับ</BaseButton>
      </div>
      <div v-if="showNext" class="min-w-0 flex-1">
        <BaseButton variant="primary" block :disabled="!canGoNext" @click="goNext">ถัดไป</BaseButton>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { BaseButton, StepProgress } from '@/components/ui'
import PatientContextCard from '@/components/PatientContextCard.vue'
import { canAdvanceFromStep, STEP_LABELS, useAssessmentStore } from '@/stores/assessmentStore.js'
import { usePatientStore } from '@/stores/patientStore.js'
import Step1Patient from './Step1Patient.vue'
import Step2Reported from './Step2Reported.vue'
import Step3Facial from './Step3Facial.vue'
import Step4Result from './Step4Result.vue'
import Step5Nursing from './Step5Nursing.vue'
import Step6Reassess from './Step6Reassess.vue'

const route = useRoute()
const store = useAssessmentStore()
const patientStore = usePatientStore()

// R41 T5 (spec §6): the wizard's step order, alongside the assessmentStore
// `step` value that selects each one (those numbers are store-internal —
// canAdvanceFromStep/migrateLegacyStep etc. key off them and are OUT of
// this task's file ownership, so they are never renumbered here). `hidden`
// marks the one step omitted entirely while linked. This single list drives
// both the contiguous SectionCard numbering (displayNumbers below) and the
// forward/back navigation skip (goBack below; Step3Facial.goNext mirrors
// this for the 1->3 forward case).
const STEP_DEFS = [
  { step: 1 },
  { step: 2, hideWhenLinked: true },
  { step: 3 },
  { step: 4 },
  { step: 5 },
  { step: 6 },
]

const visibleSteps = computed(() =>
  STEP_DEFS.filter((s) => !(s.hideWhenLinked && patientStore.linked))
)

// Contiguous 1..N display numbers over whichever steps are ACTUALLY visible
// right now (5 while linked, 6 unlinked — today's numbering, unchanged).
// Recomputed reactively off patientStore.linked, so an ออก tap mid-wizard
// (now reachable from this view's own PatientContextCard) immediately
// renumbers the currently-shown step rather than freezing a stale number —
// the currently rendered step is never actually 2 while linked (see the
// v-if chain / enterFromRoute guard below), so this can only ever grow the
// visible step's number back toward today's unlinked numbering, never leave
// it pointing at a hidden step.
const displayNumbers = computed(() => {
  const map = {}
  visibleSteps.value.forEach((s, i) => {
    map[s.step] = i + 1
  })
  return map
})

// Fix round 1 MINOR 5: StepProgress's breadcrumb must track the SAME
// visibleSteps list as the SectionCard numbers above it — passing the raw
// 6-item STEP_LABELS/store.step pair (today's plain values) would show
// ข้อมูลผู้ป่วย with a checkmark for a step that never existed while linked,
// and numerals that contradict the SectionCard badge the nurse is looking
// at right below it. Fixed at THIS call site (not inside StepProgress.vue
// itself, which stays a dumb/generic breadcrumb) per the review ruling.
const visibleLabels = computed(() => visibleSteps.value.map((s) => STEP_LABELS[s.step - 1]))
const currentDisplayNumber = computed(() => displayNumbers.value[store.step] ?? 1)

// Runs synchronously in setup — NOT onMounted — so a fresh navigation to
// /assess never flashes a stale/resumed draft before this decides what to
// show. Also re-run on every route.query.recordId change: vue-router
// reuses this same AssessView instance for /assess?recordId=A ->
// ?recordId=B (no remount, so onMounted alone would never fire again and
// step 6 would keep pointing at the first record).
function enterFromRoute() {
  const recordId = route.query.recordId
  if (recordId) {
    store.startReassess(String(recordId))
  } else if (!store.resume()) {
    store.startNew()
  }
  // R41 T5 belt-and-braces: a persisted draft (an old-order migration, or a
  // draft simply left on step 2 while unlinked) can restore step 2 on a
  // device that is linked NOW — resume()'s own migration only handles the
  // R18 renumbering, not this view's linked-step omission. Bounce forward
  // immediately (before the first render) rather than rendering nothing.
  if (patientStore.linked && store.step === 2) store.setStep(3)
  // Fix round 1 BLOCKER: unlike startNew(), store.resume() never calls
  // fillPatientFromContext() itself — a linked device resuming a draft
  // whose name/bed are still empty (e.g. an app reload while linked and
  // already resolved, or the unlinked->linked bounce case just above) would
  // otherwise sail through the rest of the wizard and finalize with an
  // empty name/bed even though the context has the answer sitting right
  // there (reviewer probe: a nameless record synced for a real patient).
  // Safe to call unconditionally on every entry: it's a no-op unlinked, and
  // fill-only-when-empty (assessmentStore.fillPatientFromContext) means it
  // never overwrites a name/bed the draft already carries.
  store.fillPatientFromContext()
}

enterFromRoute()

watch(
  () => route.query.recordId,
  (next, prev) => {
    if (next !== prev) enterFromRoute()
  }
)

// spec §6 late-context refill: a QR-link's displayName/bed can resolve
// AFTER this view (and startNew()'s own fillPatientFromContext) already
// ran — most visibly now that step 2 is skipped entirely while linked, so
// Step1Patient's onMounted refill (still there for the unlinked flow) never
// fires to catch a late pull. Same fill-only-when-empty contract as
// startNew()/Step1Patient (see assessmentStore.fillPatientFromContext) —
// a nurse-typed value is never overwritten, and this is a no-op unlinked.
watch(
  () => [patientStore.displayName, patientStore.bed],
  () => {
    if (patientStore.linked) store.fillPatientFromContext()
  }
)

// Steps 1 and 5 drive their own forward action (confirm scores / บันทึกการ
// ประเมิน) and step 6 is a self-contained terminal action (บันทึกผล), so the
// generic footer nav only applies to steps 2, 3 and 4. Step 1 (the scan)
// gates its own advance on facial.source being set — see Step3Facial's
// handleConfirm/goNext — so there is no step-1 branch below.
const showBack = computed(() => store.step > 1 && store.step < 6)
const showNext = computed(() => [2, 3, 4].includes(store.step))

// Gate logic itself lives in the store (canAdvanceFromStep) so it's
// directly unit-testable at the exact step numbers without mounting this
// view — see assessmentStore.js.
const canGoNext = computed(() => canAdvanceFromStep(store.step, store.draft))

function goNext() {
  if (!canGoNext.value) return
  store.setStep(store.step + 1)
}

// R41 T5: steps back to the previous VISIBLE step, not merely store.step-1
// — while linked from step 3 (ความปวด) that is step 1 (the scan), skipping
// the hidden ข้อมูลผู้ป่วย step exactly as forward navigation already does.
// Unlinked, visibleSteps holds all 6 in order so this is identical to
// today's plain `store.step - 1`.
function goBack() {
  const idx = visibleSteps.value.findIndex((s) => s.step === store.step)
  const prevStep = visibleSteps.value[idx - 1]?.step ?? store.step - 1
  // Fix round 1 NIT: clamp — showBack (store.step > 1) already keeps this
  // button from rendering at the first visible step, but goBack() itself
  // must never depend on that as its only guard against landing on step 0.
  store.setStep(Math.max(1, prevStep))
}
</script>
