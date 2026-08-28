<!--
  Part 6 "ประเมินหลังการพยาบาล" — spec §2 part 6, §7, ruling R8. Entered only
  via assessmentStore.startReassess(recordId) (AssessView, route query
  `recordId`), so it reads the original record straight from recordsStore
  rather than the (unrelated) in-progress draft.
-->
<template>
  <SectionCard :number="sectionNumber" title="ประเมินหลังการพยาบาล">
    <div v-if="!record" class="flex flex-col gap-3">
      <p class="text-sm text-slate-600">ไม่พบข้อมูลสำหรับการประเมินซ้ำ</p>
      <BaseButton variant="outline" block @click="router.push('/records')">กลับไปหน้าประวัติ</BaseButton>
    </div>

    <div v-else class="flex flex-col gap-4">
      <div class="rounded-xl bg-base-200 p-3">
        <h4 class="mb-2 text-xs font-semibold uppercase text-slate-500">ผลก่อนการพยาบาล (อ่านอย่างเดียว)</h4>
        <div class="flex items-center justify-between text-sm">
          <span class="text-slate-600">Pain Score จากผู้ป่วย</span>
          <span class="font-medium text-primary-700">{{ record.reported.painScore ?? '—' }}/10</span>
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-slate-600">Face Pain Scale</span>
          <span class="font-medium text-primary-700">{{ record.facial.total }}/10</span>
        </div>
      </div>

      <BaseInput v-model="reassessTime" label="เวลาประเมินซ้ำ" type="time" />

      <div>
        <h4 class="mb-2 text-sm font-semibold text-primary-700">Pain Score หลังการพยาบาล (0–10)</h4>
        <PainScalePicker v-model="postPainScore" :labels="PAIN_SCALE_LABELS" />
      </div>

      <div>
        <div class="mb-2 flex items-center justify-between">
          <h4 class="text-sm font-semibold text-primary-700">Face Pain Scale หลังการพยาบาล</h4>
          <button type="button" class="text-xs font-medium text-primary underline" @click="toggleFacialMode">
            {{ facialMode === 'quick' ? 'สแกนซ้ำ' : 'กรอกตัวเลขแทน' }}
          </button>
        </div>

        <!-- Hoisted outside the mode branch: toggleFacialMode/handleRescanError
             both switch facialMode back to 'quick' on failure, which would
             tear down a notice placed inside the 'scan' branch before the
             nurse ever saw it. -->
        <p v-if="rescanError" class="mb-2 text-sm text-error">{{ rescanError }}</p>

        <template v-if="facialMode === 'quick'">
          <!--
            Not BaseInput type="number": a focused native number input
            changes value on mouse-wheel scroll (this is what silently
            changed the facial total during the live demo). Using
            type="text" + inputmode="numeric" gives the same mobile numeric
            keypad without that browser default — BaseInput's root element
            is the <label>, not the <input>, so an inputmode/wheel-guard
            passed as an attr to <BaseInput> would land on the wrong
            element; hand-rolling the input here (styled to match
            BaseInput) is what actually gets inputmode onto the <input>.

            Genuinely controlled (see onFacialTotalInput): a plain
            v-model="someComputedWithASetter" is not enough here, because
            when a keystroke produces something the setter would reject
            (e.g. Number.isFinite fails), the ref never changes — and Vue's
            patcher only rewrites the DOM when the bound value differs from
            what it last wrote, so a rejected/garbage keystroke would sit
            on screen forever while the store silently kept the last-good
            value. onFacialTotalInput instead sanitizes and re-writes
            event.target.value itself on every input, so the element is
            never out of sync with the store.
          -->
          <label class="form-control w-full">
            <span class="label pb-1 pt-0">
              <span class="label-text text-sm font-medium text-primary-700">คะแนนรวม (0–10)</span>
            </span>
            <input
              :value="postFacialTotalDisplay"
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              class="input input-bordered w-full min-h-[44px]"
              @input="onFacialTotalInput"
            />
          </label>
        </template>

        <template v-else>
          <ScanPanel v-if="!rescanResult" @done="handleRescanDone" @error="handleRescanError" />
          <template v-else>
            <ValidatePanel
              :initial-scores="rescanResult.proposed"
              :proposed="rescanResult.proposed"
              :profiles="rescanResult.profiles"
              @confirm="handleRescanConfirm"
            />
            <BaseButton variant="ghost" size="md" block @click="resetRescan">สแกนใหม่</BaseButton>
          </template>
        </template>
      </div>

      <div v-if="postPainScore !== null" class="flex flex-col gap-2">
        <span class="badge badge-info gap-1.5 border-none text-white">
          ระบบคำนวณผลลัพธ์: {{ autoOutcome }}
        </span>
        <div class="flex flex-col gap-2">
          <label v-for="opt in OUTCOME_OPTIONS" :key="opt" class="flex items-center gap-2 min-h-[44px] cursor-pointer">
            <input
              type="radio"
              name="reassess-outcome"
              class="radio radio-primary"
              :checked="selectedOutcome === opt"
              @change="selectOutcome(opt)"
            />
            <span class="text-sm">{{ opt }}</span>
          </label>
        </div>
      </div>

      <BaseButton variant="primary" size="lg" block :disabled="postPainScore === null" @click="onSave">
        บันทึกผล
      </BaseButton>
    </div>
  </SectionCard>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { BaseButton, BaseInput, PainScalePicker, SectionCard, useToast } from '@/components/ui'
import { PAIN_SCALE_LABELS } from '@/domain/painScaleLabels.js'
import { computeOutcome } from '@/domain/outcome.js'
import { scoreAll } from '@/facescan/index.js'
import { useAssessmentStore } from '@/stores/assessmentStore.js'
import { useCalibrationStore } from '@/stores/calibrationStore.js'
import { useRecordsStore } from '@/stores/recordsStore.js'
import ScanPanel from './ScanPanel.vue'
import ValidatePanel from './ValidatePanel.vue'

const OUTCOME_OPTIONS = ['ลดลง', 'เท่าเดิม', 'เพิ่มขึ้น']

// spec §6: display number bound by AssessView, default is today's literal
// (this step is always last, so always '6' either way, but still a prop
// per T5's uniform contract across every step component).
defineProps({
  sectionNumber: { type: [String, Number], default: '6' },
})

const store = useAssessmentStore()
const calibrationStore = useCalibrationStore()
const recordsStore = useRecordsStore()
const router = useRouter()
const { toast } = useToast()

function pad(n) {
  return String(n).padStart(2, '0')
}
function nowHm() {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Loaded once in setup (runs before first render); `record` itself is a
// computed over activeRecordId + the loaded records so it stays correct if
// AssessView re-enters this component with a different recordId (route
// query change reusing the same instance) instead of resolving once and
// going stale.
recordsStore.load()
const record = computed(() => (store.activeRecordId ? recordsStore.get(store.activeRecordId) : null))

const reassessTime = ref(nowHm())
const postPainScore = ref(null)
// null = "not measured yet" (spec part 6: post-care facial re-check is
// optional) — distinct from 0, which is a real "no pain from face" score.
const postFacialTotal = ref(null)

// Display string derived from the stored number. postFacialTotal (not the
// input element) is the single source of truth — see onFacialTotalInput.
const postFacialTotalDisplay = computed(() => (postFacialTotal.value === null ? '' : String(postFacialTotal.value)))

// Handles the hand-rolled facial-total input's `input` event (template
// comment above has the "why not v-model on a computed" rationale). Always
// re-derives postFacialTotal from the *sanitized* keystroke and writes that
// sanitization back onto the DOM element itself, so the element can never
// drift from the store.
function onFacialTotalInput(event) {
  const digits = event.target.value.replace(/[^0-9]/g, '')

  // Multi-digit overflow (e.g. "99") clamps to 10 rather than reverting to
  // the last valid value — deterministic, and consistent with the 0-10
  // clamp used everywhere else in this form. Clamp BEFORE writing back to
  // the DOM: once postFacialTotal saturates at 10, assigning 10 again is a
  // reactivity no-op (Object.is guard on the ref), so nothing re-patches
  // the element on its own — the element's value must be a pure function
  // of the clamped result on every keystroke, not the raw digits.
  const clamped = digits === '' ? null : Math.min(10, Math.max(0, Number(digits)))

  postFacialTotal.value = clamped
  event.target.value = clamped === null ? '' : String(clamped)
}

const facialMode = ref('quick') // 'quick' | 'scan'
const rescanResult = ref(null) // { profiles, proposed }
const rescanError = ref(null)

function toggleFacialMode() {
  facialMode.value = facialMode.value === 'quick' ? 'scan' : 'quick'
  rescanResult.value = null
  rescanError.value = null
}

function resetRescan() {
  rescanResult.value = null
}

// R3-T7 (+ review minor 2 fold): the `done` emit also carries a
// baselineSource meta field, deliberately NOT captured here — nothing in
// the rescan flow reads it (completeReassess()/record.reassess only ever
// persisted the aggregate facialTotal, never scores/proposed/
// scoringEngine), and the banked-baseline hint fires once per assessment
// from draft.facial on Step4Result (lead ruling). Capturing it "for
// symmetry" would just be unread state.
function handleRescanDone(profiles) {
  const { scores } = scoreAll(profiles, calibrationStore.thresholds)
  rescanResult.value = { profiles, proposed: scores }
}

function handleRescanError(errorKind) {
  rescanError.value =
    errorKind === 'camera'
      ? 'ไม่สามารถเข้าถึงกล้องได้ — กรุณากรอกตัวเลขแทน'
      : 'ไม่สามารถโหลดโมเดลประมวลผลใบหน้าได้ — กรุณากรอกตัวเลขแทน'
  facialMode.value = 'quick'
  rescanResult.value = null
}

function handleRescanConfirm({ total }) {
  postFacialTotal.value = total
  facialMode.value = 'quick'
  rescanResult.value = null
}

const autoOutcome = computed(() => {
  if (!record.value || postPainScore.value === null) return null
  return computeOutcome(record.value.reported.painScore, postPainScore.value)
})

const outcomeTouched = ref(false)
const outcomeOverride = ref(null)

const selectedOutcome = computed(() => outcomeOverride.value ?? autoOutcome.value)

function selectOutcome(opt) {
  outcomeOverride.value = opt
  outcomeTouched.value = true
}

const overridden = computed(() => outcomeTouched.value && outcomeOverride.value !== autoOutcome.value)

// A different record entered this step (route recordId changed while this
// component instance stayed mounted) — start every ephemeral input fresh
// rather than carrying the previous record's half-filled answers over.
watch(
  () => store.activeRecordId,
  () => {
    reassessTime.value = nowHm()
    postPainScore.value = null
    postFacialTotal.value = null
    facialMode.value = 'quick'
    rescanResult.value = null
    rescanError.value = null
    outcomeOverride.value = null
    outcomeTouched.value = false
  }
)

function onSave() {
  if (postPainScore.value === null || !record.value) return
  const result = store.completeReassess({
    time: reassessTime.value,
    painScore: postPainScore.value,
    facialTotal: postFacialTotal.value,
    outcome: selectedOutcome.value,
    overridden: overridden.value,
  })
  if (!result) {
    toast('ไม่พบข้อมูลเดิมของการประเมิน — บันทึกไม่สำเร็จ', 'error')
    return
  }
  toast('บันทึกแล้ว', 'success')
  router.push(`/records/${result.id}`)
}
</script>
