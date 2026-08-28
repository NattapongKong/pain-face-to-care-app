<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useRecordsStore } from '../stores/recordsStore.js'
import { usePatientStore } from '../stores/patientStore.js'
import { useSyncStore } from '../stores/syncStore.js'
import * as repository from '../domain/repository.js'
import { severityBand, SEVERITY_META } from '../domain/severity.js'
import { FACIAL_CATALOG } from '../domain/facialCatalog.js'
import { SectionCard, BaseButton, BaseModal, StatusBadge, useToast } from '../components/ui'
import PatientContextCard from '../components/PatientContextCard.vue'

const props = defineProps({
  id: { type: String, required: true },
})

const router = useRouter()
const recordsStore = useRecordsStore()
const patientStore = usePatientStore()
const syncStore = useSyncStore()
const { toast } = useToast()

const showRescueConfirm = ref(false)

onMounted(() => {
  recordsStore.load()
})

// spec §8: resolve from the same scoped/merged list RecordsView shows — a
// serverOnly match (assessed on another device) renders read-only below.
const contextId = computed(() => (patientStore.linked ? patientStore.patientId : null))
const record = computed(() => {
  const scoped = recordsStore.visibleRecords(contextId.value).find((r) => r.id === props.id) ?? null
  if (scoped) return scoped
  // Fix round BLOCKER: visibleRecords(contextId) correctly EXCLUDES a
  // null-attributed local record while linked (contextId is a real patient
  // id, not null) — that's the whole point of the R37b rescue action's
  // existence. But it also meant this view could never even FIND such a
  // record to render its rescue button in the first place ("ไม่พบข้อมูล"
  // instead). Fall back to the raw local record ONLY when it is genuinely
  // unattributed (patientId ?? null === null) — this can never open a path
  // to rendering a DIFFERENT patient's record while linked: a record with a
  // real, non-matching patientId is deliberately left excluded here, same
  // as visibleRecords() already decided. The server-merge path above is
  // completely untouched by this fallback.
  const localRecord = recordsStore.records.find((r) => r.id === props.id) ?? null
  return localRecord && (localRecord.patientId ?? null) === null ? localRecord : null
})

// Ruling R42 (recorded lead ruling, T4 review): a nurse can now unlink
// (ออก, via the PatientContextCard above) WHILE viewing a record for that
// same patient — patientStore.clear() drops contextId back to null,
// visibleRecords(null) no longer includes a patient-scoped record, and
// `record` above resolves to null on the very next computed re-run. That
// transition (was resolved, now isn't — while this view stayed mounted) is
// a live context change, not a bad id, so it gets a silent redirect back to
// the records list instead of flashing "ไม่พบข้อมูล" at the nurse. Guarded
// on the TRANSITION specifically (prev truthy, next falsy) rather than on
// null alone: an initial load with a bad/stale id in the URL must keep
// today's "ไม่พบข้อมูล" behavior unchanged — that case never had a non-null
// `prev` to transition away from, so this watcher never fires for it.
//
// Fix round 1 MINOR 4: also keyed on props.id (prevId === nextId) — this
// view is reused in place across /records/A -> /records/B (vue-router
// keeps the instance for the same route record, only the param changes,
// same reuse RecordsView/AssessView already lean on), so an in-place
// navigation from a resolved record A to a genuinely bad id B is ALSO a
// "was resolved, now isn't" transition on `record` alone — without the id
// check it would be wrongly redirected instead of showing B's own
// "ไม่พบข้อมูล". The id staying THE SAME is what tells a real unlink-style
// loss apart from simply having navigated to a different (bad) record.
watch(
  () => [record.value, props.id],
  ([next, nextId], [prev, prevId]) => {
    if (prev && !next && prevId === nextId) router.replace('/records')
  }
)

// Ruling R37b: a LOCAL (not server-only) record stranded with
// patientId:null while THIS device is now linked can be explicitly
// rescued — attributed to the current patient and synced. Never offered
// for a server-only record (this device never stored it) or one already
// attributed to some patient (rescue is not a re-attribution tool).
const canRescue = computed(
  () => !!record.value && !record.value.serverOnly && (record.value.patientId ?? null) === null && patientStore.linked
)
const contextPatientLabel = computed(() => patientStore.displayName || patientStore.patientId)

function requestRescue() {
  showRescueConfirm.value = true
}

function cancelRescue() {
  showRescueConfirm.value = false
}

function confirmRescue() {
  if (!record.value) return
  const updated = repository.updateRecord(record.value.id, { patientId: patientStore.patientId })
  recordsStore.load()
  showRescueConfirm.value = false
  if (!updated) return
  syncStore.enqueueRecord({ patientId: patientStore.patientId, token: patientStore.token }, updated)
  toast('ผูกกับผู้ป่วยแล้ว', 'success')
}

function severityLabel(band) {
  return SEVERITY_META[band]?.label ?? 'ไม่ปวด'
}

function formatDatetime(value) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
}

function facialOptionLabel(key, value) {
  const category = FACIAL_CATALOG.find((c) => c.key === key)
  return category?.options.find((o) => o.value === value)?.label ?? '-'
}

function checkedNursingItems(nursing) {
  if (!nursing || !Array.isArray(nursing.items)) return []
  return nursing.items.filter((item) => item.checked)
}

function outcomeClass(outcome) {
  if (outcome === 'ลดลง') return 'badge-success text-white'
  if (outcome === 'เพิ่มขึ้น') return 'badge-error text-white'
  return 'badge-ghost'
}

function statusLabel(status) {
  return status === 'complete' ? 'เสร็จสิ้น' : 'รอประเมินซ้ำ'
}

function statusClass(status) {
  return status === 'complete' ? 'badge-success text-white' : 'badge-warning text-white'
}

function startReassess() {
  router.push(`/assess?recordId=${props.id}`)
}
</script>

<template>
  <div>
    <PatientContextCard />
    <router-link to="/records" class="mb-4 inline-block text-sm text-primary-700 hover:underline">
      ← กลับไปยังประวัติการประเมิน
    </router-link>

    <div v-if="!record" class="mt-8 flex flex-col items-center gap-4 text-center">
      <p class="text-base font-medium text-gray-600">ไม่พบข้อมูล</p>
      <router-link to="/records" class="text-sm text-primary-700 hover:underline">
        กลับไปยังประวัติการประเมิน
      </router-link>
    </div>

    <div v-else class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="min-w-0 break-words text-lg font-semibold text-primary-700">{{ record.patient?.name || 'ไม่ระบุชื่อ' }}</h2>
        <div class="flex shrink-0 items-center gap-2">
          <span v-if="record.serverOnly" class="badge badge-ghost">อุปกรณ์อื่น</span>
          <span :class="['badge shrink-0', statusClass(record.status)]">
            {{ statusLabel(record.status) }}
          </span>
        </div>
      </div>

      <div v-if="canRescue" class="flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
        <p class="text-sm text-amber-800">บันทึกนี้ยังไม่ได้ผูกกับผู้ป่วยรายใด เก็บอยู่ในเครื่องนี้เท่านั้น</p>
        <BaseButton variant="outline" size="md" data-testid="rescue-button" @click="requestRescue">
          ผูกกับผู้ป่วย "{{ contextPatientLabel }}" และซิงค์
        </BaseButton>
      </div>

      <SectionCard :number="1" title="ข้อมูลผู้ป่วย">
        <dl class="flex flex-col gap-2 text-sm">
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">ชื่อ-นามสกุลผู้ป่วย</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">{{ record.patient?.name || '-' }}</dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">เตียง</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">{{ record.patient?.bed || '-' }}</dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">วันที่/เวลา</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">{{ formatDatetime(record.patient?.datetime) }}</dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard :number="2" title="ผู้ป่วยรายงานความปวด">
        <dl class="flex flex-col gap-2 text-sm">
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">Pain Score</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">{{ record.reported?.painScore ?? '-' }} / 10</dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">ตำแหน่งที่ปวด</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">{{ record.reported?.location || '-' }}</dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">สัญญาณชีพเปลี่ยนแปลงหรือไม่</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">
              {{ record.reported?.vitalsChanged ? 'ใช่' : 'ไม่' }}
              <span v-if="record.reported?.vitalsChanged && record.reported?.vitalsDetail">
                — {{ record.reported.vitalsDetail }}
              </span>
            </dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard :number="3" title="สังเกตสีหน้า">
        <dl class="flex flex-col gap-2 text-sm">
          <div v-for="category in FACIAL_CATALOG" :key="category.key" class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">{{ category.title }}</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">
              {{ record.facial?.scores?.[category.key] ?? '-' }} —
              {{ facialOptionLabel(category.key, record.facial?.scores?.[category.key]) }}
            </dd>
          </div>
          <div class="mt-1 flex justify-between gap-2 border-t border-base-200 pt-2">
            <dt class="shrink-0 text-gray-500">คะแนนรวม</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-semibold">{{ record.facial?.total ?? '-' }} / 10</dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">ที่มา</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">
              {{ record.facial?.source === 'scan+confirmed' ? 'จากกล้อง (ยืนยันแล้ว)' : 'กรอกด้วยตนเอง' }}
            </dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard :number="4" title="ผลการประเมิน">
        <div class="flex flex-col gap-3 text-sm">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="shrink-0 text-gray-500">Pain Score จากผู้ป่วย</span>
            <div class="flex flex-wrap items-center gap-2">
              <span class="break-words font-semibold">{{ record.reported?.painScore ?? '-' }} / 10</span>
              <StatusBadge :severity="severityBand(record.reported?.painScore)" />
            </div>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="shrink-0 text-gray-500">Face Pain Scale</span>
            <div class="flex flex-wrap items-center gap-2">
              <span class="break-words font-semibold">{{ record.facial?.total ?? '-' }} / 10</span>
              <StatusBadge :severity="severityBand(record.facial?.total)" />
            </div>
          </div>
          <p class="text-xs text-gray-500">
            ข้อมูลสีหน้าเป็นข้อมูลเสริม ไม่ใช้แทนคะแนนที่ผู้ป่วยรายงาน
          </p>
        </div>
      </SectionCard>

      <SectionCard :number="5" title="การพยาบาล">
        <div class="flex flex-col gap-2 text-sm">
          <p class="text-gray-500">
            ระดับ Face Pain Scale: {{ severityLabel(record.nursing?.band) }}
          </p>
          <ul v-if="checkedNursingItems(record.nursing).length" class="flex flex-col gap-2">
            <li
              v-for="item in checkedNursingItems(record.nursing)"
              :key="item.key"
              class="flex flex-col gap-0.5 rounded-lg bg-base-200 p-2"
            >
              <span class="break-words font-medium">{{ item.label }}</span>
              <span v-if="item.detail" class="break-words text-xs text-gray-500">รายละเอียด: {{ item.detail }}</span>
            </li>
          </ul>
          <p v-else class="text-gray-500">ไม่มีรายการที่บันทึก</p>
        </div>
      </SectionCard>

      <SectionCard :number="6" title="ประเมินหลังการพยาบาล">
        <div v-if="record.status === 'awaiting-reassess'" class="flex flex-col gap-3">
          <p class="text-sm text-gray-500">ยังไม่ได้ประเมินซ้ำ</p>
          <BaseButton v-if="!record.serverOnly" variant="primary" size="lg" block @click="startReassess">
            ประเมินซ้ำ
          </BaseButton>
          <p v-else class="text-xs text-gray-500">
            บันทึกจากอุปกรณ์อื่น — ประเมินซ้ำได้จากอุปกรณ์ที่บันทึกไว้เท่านั้น
          </p>
        </div>
        <dl v-else class="flex flex-col gap-2 text-sm">
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">เวลาประเมินซ้ำ</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">{{ formatDatetime(record.reassess?.time) }}</dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">Pain Score หลัง</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">{{ record.reassess?.painScore ?? '-' }} / 10</dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-gray-500">Face Pain Scale หลัง</dt>
            <dd class="min-w-0 flex-1 break-words text-right font-medium">{{ record.reassess?.facialTotal ?? '-' }} / 10</dd>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <dt class="shrink-0 text-gray-500">ผลลัพธ์</dt>
            <dd class="flex min-w-0 flex-wrap items-center justify-end gap-1">
              <span :class="['badge', outcomeClass(record.reassess?.outcome)]">
                {{ record.reassess?.outcome || '-' }}
              </span>
              <span v-if="record.reassess?.overridden" class="text-xs text-gray-500">
                (ปรับโดยพยาบาล)
              </span>
            </dd>
          </div>
        </dl>
      </SectionCard>
    </div>

    <BaseModal :open="showRescueConfirm" title="ยืนยันการผูกกับผู้ป่วย" @close="cancelRescue">
      <p class="text-sm">
        ต้องการผูกบันทึกนี้กับผู้ป่วย "{{ contextPatientLabel }}" ใช่หรือไม่?
      </p>
      <p class="mt-2 text-xs text-gray-500">
        บันทึกจะถูกระบุว่าเป็นของผู้ป่วยรายนี้ในฐานข้อมูลกลางและซิงค์ทันที
      </p>
      <template #actions>
        <BaseButton variant="ghost" data-testid="rescue-cancel-button" @click="cancelRescue">ยกเลิก</BaseButton>
        <BaseButton variant="primary" data-testid="rescue-confirm-button" @click="confirmRescue">ยืนยัน</BaseButton>
      </template>
    </BaseModal>
  </div>
</template>
