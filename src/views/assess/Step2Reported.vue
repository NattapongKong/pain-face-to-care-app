<!-- Wizard step 3 "ผู้ป่วยรายงานความปวด" (form part 2 — spec §2 part 2; ruling R18). -->
<template>
  <SectionCard :number="sectionNumber" title="ผู้ป่วยรายงานความปวด">
    <div class="flex flex-col gap-4">
      <div>
        <h4 class="mb-2 text-sm font-semibold text-primary-700">ระดับความปวด (0–10)</h4>
        <PainScalePicker v-model="painScore" :labels="PAIN_SCALE_LABELS" />
      </div>

      <BaseTextarea v-model="location" label="ตำแหน่งที่ปวด" :rows="2" />

      <div>
        <h4 class="mb-2 text-sm font-semibold text-primary-700">สัญญาณชีพเปลี่ยนแปลงหรือไม่</h4>
        <YesNoDetail
          v-model="vitals"
          yes-label="ใช่"
          no-label="ไม่"
          detail-placeholder="ระบุการเปลี่ยนแปลงของสัญญาณชีพ"
        />
        <p v-if="vitals.answer === true && !vitals.detail.trim()" class="mt-1 text-xs text-error">
          กรุณาระบุรายละเอียดสัญญาณชีพที่เปลี่ยนแปลง
        </p>
      </div>

      <p class="rounded-lg bg-base-200 p-3 text-xs text-slate-600">หมายเหตุ: สัญญาณชีพใช้เป็นข้อมูลประกอบการประเมิน ไม่ควรใช้เพียงอย่างเดียวในการตัดสินระดับความปวด เนื่องจากสัญญาณชีพอาจเปลี่ยนแปลงจากสาเหตุอื่นได้</p>
    </div>
  </SectionCard>
</template>

<script setup>
import { computed } from 'vue'
import { BaseTextarea, PainScalePicker, SectionCard, YesNoDetail } from '@/components/ui'
import { PAIN_SCALE_LABELS } from '@/domain/painScaleLabels.js'
import { useAssessmentStore } from '@/stores/assessmentStore.js'

// spec §6: display number bound by AssessView — 3 unlinked (today's), 2
// when linked (ข้อมูลผู้ป่วย omitted ahead of this step).
defineProps({
  sectionNumber: { type: [String, Number], default: '3' },
})

const store = useAssessmentStore()

const painScore = computed({
  get: () => store.draft.reported.painScore,
  set: (value) => store.updateReported({ painScore: value }),
})

const location = computed({
  get: () => store.draft.reported.location,
  set: (value) => store.updateReported({ location: value }),
})

const vitals = computed({
  get: () => ({
    answer: store.draft.reported.vitalsChanged,
    detail: store.draft.reported.vitalsDetail,
  }),
  set: (value) => store.updateReported({ vitalsChanged: value.answer, vitalsDetail: value.detail }),
})
</script>
