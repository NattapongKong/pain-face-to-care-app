<!--
  Part 5 "การพยาบาล" — spec §2 part 5, ruling R7: keyed to the Face Pain
  Scale band, not the patient-reported score. Score 0 => no checklist, just
  a note + reassess guidance (never a dead/empty screen).
-->
<template>
  <SectionCard :number="sectionNumber" title="การพยาบาล">
    <div class="flex flex-col gap-4">
      <template v-if="band === null">
        <p class="rounded-lg bg-base-200 p-3 text-sm text-slate-600">ไม่พบอาการปวดจากสีหน้า</p>
        <p class="text-sm text-slate-600">
          ยังไม่มีข้อบ่งชี้ให้เริ่มการพยาบาลตามระดับความปวดจากสีหน้าในขณะนี้
          บันทึกการประเมินนี้ไว้แล้วนัดประเมินซ้ำเพื่อติดตามอาการต่อเนื่อง
        </p>
      </template>

      <template v-else>
        <ChecklistGroup v-model="items" :items="catalogItems" />
      </template>

      <BaseButton variant="primary" size="lg" block @click="onSave">บันทึกการประเมิน</BaseButton>
    </div>

    <!--
      spec §6 / ruling R37: a draft begun while UNLINKED that is now linked
      (draftPatientId still null) gets an explicit, one-time attribution
      choice BEFORE finalize() — never a silent stamp either way.
    -->
    <BaseModal :open="showAdoptModal" title="ยืนยันผู้ป่วย" @close="cancelAdopt">
      <p class="text-sm">บันทึกนี้เป็นของ "{{ contextPatientLabel }}" ใช่หรือไม่?</p>
      <template #actions>
        <BaseButton variant="ghost" @click="declineAdopt">ไม่ใช่ — เก็บในเครื่องเท่านั้น</BaseButton>
        <BaseButton variant="primary" @click="confirmAdopt">ใช่ — บันทึกเป็นของผู้ป่วยนี้</BaseButton>
      </template>
    </BaseModal>
  </SectionCard>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { BaseButton, BaseModal, ChecklistGroup, SectionCard, useToast } from '@/components/ui'
import { severityBand } from '@/domain/severity.js'
import { NURSING_CATALOG } from '@/domain/nursingCatalog.js'
import { useAssessmentStore } from '@/stores/assessmentStore.js'
import { usePatientStore } from '@/stores/patientStore.js'

// spec §6: display number bound by AssessView, default is today's literal.
defineProps({
  sectionNumber: { type: [String, Number], default: '5' },
})

const store = useAssessmentStore()
const patientStore = usePatientStore()
const router = useRouter()
const { toast } = useToast()

const showAdoptModal = ref(false)
const contextPatientLabel = computed(() => patientStore.displayName || patientStore.patientId)

const band = computed(() => severityBand(store.draft.facial.total))
const catalogItems = computed(() => (band.value ? NURSING_CATALOG[band.value] : []))

const items = computed({
  get: () => store.draft.nursing.items,
  // ChecklistGroup only emits {key, checked, detail} — the record shape
  // (spec §6) and csv.js's exporter also need each entry's `label`, so it's
  // stamped on here from the catalog before it ever reaches the store.
  set: (value) =>
    store.updateNursing({
      items: value.map((e) => ({
        ...e,
        label: catalogItems.value.find((c) => c.key === e.key)?.label ?? e.label ?? e.key,
      })),
    }),
})

function finishSave(options) {
  const record = store.finalize(options)
  toast('บันทึกแล้ว', 'success')
  router.push(`/records/${record.id}`)
}

// spec §6 / ruling R37: only ask when there's actually an ambiguous
// attribution to resolve — linked AND this draft began unlinked
// (draftPatientId still null). Every other case saves exactly as today.
function onSave() {
  if (patientStore.linked && store.draftPatientId === null) {
    showAdoptModal.value = true
    return
  }
  finishSave()
}

function cancelAdopt() {
  showAdoptModal.value = false
}

function confirmAdopt() {
  showAdoptModal.value = false
  finishSave({ adoptCurrentPatient: true })
}

function declineAdopt() {
  showAdoptModal.value = false
  finishSave()
}
</script>
