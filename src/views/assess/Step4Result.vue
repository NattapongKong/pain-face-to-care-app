<!-- Part 4 "ผลการประเมิน" — spec §2 part 4, ruling R7. -->
<template>
  <div class="flex flex-col gap-4">
    <SectionCard :number="sectionNumber" title="Pain Score จากผู้ป่วย">
      <div class="flex items-center justify-between">
        <span class="text-2xl font-semibold text-primary-700">{{ painScore ?? '—' }}/10</span>
        <StatusBadge :severity="reportedSeverity" />
      </div>
    </SectionCard>

    <SectionCard :number="sectionNumber" title="Face Pain Scale">
      <div class="flex items-center justify-between">
        <span class="text-2xl font-semibold text-primary-700">{{ facialTotal }}/10</span>
        <StatusBadge :severity="faceSeverity" />
      </div>
      <!-- R3-T7 (spec §3, relocated from ScanPanel's unreachable done-state
           branch — T2 review follow-up): this capture was scored against
           the model's population-neutral default rather than the
           patient's own banked baseline, and the patient is actually
           linked (so บันทึกหน้าปกติ is an actionable next step, not a
           no-op). Undefined-safe: a legacy draft persisted before
           baselineSource existed reads undefined here and renders
           nothing. -->
      <p v-if="showDefaultBaselineHint" class="mt-2 text-center text-xs text-gray-500">
        เพื่อผลที่แม่นยำขึ้น แนะนำให้บันทึกหน้าปกติของผู้ป่วยในช่วงที่ไม่ปวด
      </p>
    </SectionCard>

    <SectionCard :number="sectionNumber" title="เกณฑ์ระดับความปวด">
      <div class="flex flex-col gap-2">
        <div v-for="band in bands" :key="band.key" class="flex items-center justify-between text-sm">
          <span class="text-slate-600">{{ band.range }}</span>
          <StatusBadge :severity="band.key" :label="band.label" />
        </div>
      </div>
    </SectionCard>

    <p class="rounded-lg bg-base-200 p-3 text-xs text-slate-600">หมายเหตุ: คะแนนจากการสังเกตสีหน้าเป็นข้อมูลประกอบ ไม่ใช้แทนคะแนนความปวดที่ผู้ป่วยรายงาน</p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { SectionCard, StatusBadge } from '@/components/ui'
import { severityBand, SEVERITY_META } from '@/domain/severity.js'
import { useAssessmentStore } from '@/stores/assessmentStore.js'
import { usePatientStore } from '@/stores/patientStore.js'

// spec §6: all three SectionCards on this step share ONE display number
// (today's literal '4' unlinked) — same as before this change, just no
// longer hardcoded three times over.
defineProps({
  sectionNumber: { type: [String, Number], default: '4' },
})

const store = useAssessmentStore()
const patientStore = usePatientStore()

const painScore = computed(() => store.draft.reported.painScore)
const facialTotal = computed(() => store.draft.facial.total)
const reportedSeverity = computed(() => severityBand(painScore.value))
const faceSeverity = computed(() => severityBand(facialTotal.value))

// R3-T7: baselineSource is undefined on any draft persisted before this
// field existed — the `=== 'default'` check is naturally false (not a
// throw) for undefined, so a legacy draft renders no hint with no extra
// guarding needed.
const showDefaultBaselineHint = computed(
  () => store.draft.facial.baselineSource === 'default' && patientStore.linked
)

const bands = computed(() =>
  Object.entries(SEVERITY_META).map(([key, meta]) => ({
    key,
    range: `${meta.range} ${meta.label}`,
    label: meta.label,
  }))
)
</script>
