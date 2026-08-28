<!--
  Wizard step 2 "ข้อมูลผู้ป่วย" (form part 1 — spec §2 part 1; ruling R18).
  R41 T5 (spec §6): this step is never rendered at all while
  patientStore.linked — AssessView's step list omits it entirely and
  Step3Facial's goNext() skips straight past it — so `sectionNumber`
  only ever reflects the UNLINKED (today's) numbering here. Kept as a
  prop anyway (default = today's literal '2') for the same reason every
  other step component takes one: AssessView is the single source of
  truth for the contiguous display number, this file just renders it.
-->
<template>
  <SectionCard :number="sectionNumber" title="ข้อมูลผู้ป่วย">
    <div class="flex flex-col gap-4">
      <BaseInput v-model="name" label="ชื่อ-นามสกุลผู้ป่วย" placeholder="ชื่อ-นามสกุล" />
      <BaseInput v-model="bed" label="เตียง" placeholder="เลขเตียง/ห้อง" />
      <BaseInput v-model="datetime" label="วันที่/เวลา" type="datetime-local" />
    </div>
  </SectionCard>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { BaseInput, SectionCard } from '@/components/ui'
import { useAssessmentStore } from '@/stores/assessmentStore.js'

// spec §6: display number bound by AssessView, default is today's literal
// so this step still renders correctly if ever mounted standalone (e.g. a
// future test) without a parent supplying it.
defineProps({
  sectionNumber: { type: [String, Number], default: '2' },
})

const store = useAssessmentStore()

// spec §6: covers a pull that resolves displayName/bed AFTER startNew()
// already ran with an unresolved (empty) patientStore — same fill-if-empty
// rule as startNew()'s own prefill, so an already-typed name/bed is never
// overwritten. AssessView switches steps with v-if (not v-show), so
// stepping away from and back to this step tears down and remounts it,
// firing this onMounted (and therefore fillPatientFromContext()) again each
// time — accepted per spec §6's fill-ONLY-when-empty contract: it is a
// no-op the moment the fields it would touch are no longer empty.
onMounted(() => {
  store.fillPatientFromContext()
})

const name = computed({
  get: () => store.draft.patient.name,
  set: (value) => store.updatePatient({ name: value }),
})

const bed = computed({
  get: () => store.draft.patient.bed,
  set: (value) => store.updatePatient({ bed: value }),
})

const datetime = computed({
  get: () => store.draft.patient.datetime,
  set: (value) => store.updatePatient({ datetime: value }),
})
</script>
