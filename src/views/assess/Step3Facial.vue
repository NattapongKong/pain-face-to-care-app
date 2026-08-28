<!--
  Wizard step 1 "สังเกตสีหน้า" (form part 3 — spec §2 part 3, §5.4/§5.5;
  ruling R18 moved it first in the wizard). Scan mode is the default;
  camera/model failure or the "กรอกเอง" toggle falls back to fully manual
  entry (ruling R9) without ever showing a dead/disabled screen.
-->
<template>
  <SectionCard :number="sectionNumber" title="สังเกตสีหน้า">
    <div class="flex flex-col gap-4">
      <!-- Already confirmed (e.g. navigated back from step 2): show a
           read-only summary with the option to re-open the editor. -->
      <template v-if="!editing">
        <div class="flex flex-col gap-1.5">
          <div v-for="cat in FACIAL_CATALOG" :key="cat.key" class="flex items-center justify-between text-sm">
            <span class="text-slate-600">{{ cat.title }}</span>
            <span class="font-medium text-primary-700">{{ store.draft.facial.scores[cat.key] }}</span>
          </div>
        </div>
        <div class="flex items-center justify-between rounded-xl bg-base-200 px-4 py-3">
          <span class="text-sm font-medium text-primary-700">คะแนนรวม Face Pain Scale</span>
          <span class="text-lg font-semibold text-primary-700">{{ store.draft.facial.total }}/10</span>
        </div>
        <p class="text-xs text-slate-500">
          ที่มาของคะแนน: {{ store.draft.facial.source === 'manual' ? 'กรอกด้วยตนเอง' : 'สแกน + ยืนยันโดยพยาบาล' }}
        </p>
        <!-- flex-1 min-w-0 wrappers: see AssessView.vue's footer-nav comment
             (R21 audit) — two block (width:100%) buttons as bare flex
             siblings each try to fill the row and overflow uncontained. -->
        <div class="flex gap-3">
          <div class="min-w-0 flex-1">
            <BaseButton variant="outline" block @click="startEditing">แก้ไขคะแนน</BaseButton>
          </div>
          <div class="min-w-0 flex-1">
            <BaseButton variant="primary" block @click="goNext">ถัดไป</BaseButton>
          </div>
        </div>
      </template>

      <template v-else>
        <p v-if="errorNotice" class="rounded-lg bg-warning/10 p-3 text-sm text-warning-800">
          {{ errorNotice }}
        </p>

        <div class="flex justify-end">
          <button
            v-if="mode === 'scan' && !scanResult"
            type="button"
            class="text-xs font-medium text-primary underline"
            @click="switchToManual"
          >
            กรอกเอง
          </button>
          <button
            v-if="mode === 'manual'"
            type="button"
            class="text-xs font-medium text-primary underline"
            @click="switchToScan"
          >
            ลองสแกนใหม่
          </button>
        </div>

        <template v-if="mode === 'scan'">
          <ScanPanel v-if="!scanResult" @done="handleScanDone" @error="handleScanError" />
          <template v-else>
            <ValidatePanel
              :initial-scores="scanResult.proposed"
              :proposed="scanResult.proposed"
              :profiles="scanResult.profiles"
              @confirm="handleConfirm"
            />
            <BaseButton variant="ghost" size="md" block @click="resetScan">สแกนใหม่</BaseButton>
          </template>
        </template>

        <template v-else>
          <ValidatePanel
            :initial-scores="store.draft.facial.source ? store.draft.facial.scores : null"
            :proposed="null"
            :profiles="null"
            @confirm="handleConfirm"
          />
        </template>
      </template>
    </div>
  </SectionCard>
</template>

<script setup>
import { ref } from 'vue'
import { BaseButton, SectionCard } from '@/components/ui'
import { FACIAL_CATALOG } from '@/domain/facialCatalog.js'
import { scoreAll } from '@/facescan/index.js'
import { useAssessmentStore } from '@/stores/assessmentStore.js'
import { useCalibrationStore } from '@/stores/calibrationStore.js'
import { usePatientStore } from '@/stores/patientStore.js'
import ScanPanel from './ScanPanel.vue'
import ValidatePanel from './ValidatePanel.vue'

// spec §6: display number bound by AssessView (always '1' either way —
// this step is always first — but still a prop, not a literal, per T5's
// uniform contract across every step component).
defineProps({
  sectionNumber: { type: [String, Number], default: '1' },
})

const store = useAssessmentStore()
const calibrationStore = useCalibrationStore()
const patientStore = usePatientStore()

// Skip straight to the editor the first time this step is opened; once a
// score has been confirmed, re-entering the step (e.g. via "ย้อนกลับ" from
// step 2) shows the read-only summary instead of forcing a re-scan.
const editing = ref(!store.draft.facial.source)
const mode = ref('scan') // 'scan' | 'manual'
const errorNotice = ref(null)
const scanResult = ref(null) // { profiles, proposed } once a scan completes

const ERROR_NOTICES = {
  camera: 'ไม่สามารถเข้าถึงกล้องได้ (อาจไม่ได้รับอนุญาต หรือไม่มีกล้อง) — กรุณากรอกคะแนนด้วยตนเอง',
  model: 'ไม่สามารถโหลดโมเดลประมวลผลใบหน้าได้ — กรุณากรอกคะแนนด้วยตนเอง',
}

function startEditing() {
  editing.value = true
  // Seed from the record's own source rather than always defaulting back to
  // 'scan' — a camera-denied/manual record shouldn't re-trigger a
  // getUserMedia prompt every time the nurse reopens this step to edit.
  mode.value = store.draft.facial.source === 'manual' ? 'manual' : 'scan'
  scanResult.value = null
  errorNotice.value = null
}

function switchToManual() {
  mode.value = 'manual'
  scanResult.value = null
  errorNotice.value = null
}

function switchToScan() {
  mode.value = 'scan'
  scanResult.value = null
  errorNotice.value = null
}

function resetScan() {
  scanResult.value = null
}

// R3-T7: ScanPanel's `done` emit's second argument now carries
// baselineSource alongside scoringEngine (spec §3/R41 relocation — the
// done-state hint moved from ScanPanel to Step4Result). Captured here
// alongside profiles/proposed so handleConfirm below can forward it into
// the draft; `meta` is optional-chained since manual mode never produces
// one.
function handleScanDone(profiles, meta) {
  const { scores } = scoreAll(profiles, calibrationStore.thresholds)
  scanResult.value = { profiles, proposed: scores, baselineSource: meta?.baselineSource ?? null }
}

function handleScanError(errorKind) {
  errorNotice.value = ERROR_NOTICES[errorKind] ?? ERROR_NOTICES.model
  mode.value = 'manual'
  scanResult.value = null
}

function handleConfirm({ scores, total, source, proposed }) {
  // draft.facial is a plain spread-merged object (assessmentStore's
  // updateFacial does `{ ...this.draft.facial, ...partial }`, no
  // whitelist) — baselineSource rides along without any store-schema
  // change. Manual entry (scanResult null) writes baselineSource: null,
  // same as a fresh draft's default shape.
  store.updateFacial({ scores, total, source, proposed, baselineSource: scanResult.value?.baselineSource ?? null })
  editing.value = false
  goNext()
}

// R41 T5 (spec §6): a linked device never sees the ข้อมูลผู้ป่วย step — its
// name/bed prefill instead comes from patient context (startNew()'s
// fillPatientFromContext + AssessView's late-refill watch) — so advancing
// out of the scan step skips straight to ความปวด (step 3) while linked,
// same as AssessView's own goBack() skips the same step in reverse.
function goNext() {
  store.setStep(patientStore.linked ? 3 : 2)
}
</script>
