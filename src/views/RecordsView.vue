<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useRecordsStore } from '../stores/recordsStore.js'
import { useCalibrationStore } from '../stores/calibrationStore.js'
import { usePatientStore } from '../stores/patientStore.js'
import { useSyncStore } from '../stores/syncStore.js'
import * as outbox from '../sync/outbox.js'
import { severityBand, SEVERITY_META } from '../domain/severity.js'
import { downloadFile } from '../domain/csv.js'
import { BaseButton, BaseModal, StatusBadge, Icon, useToast } from '../components/ui'
import PatientContextCard from '../components/PatientContextCard.vue'

const router = useRouter()
const recordsStore = useRecordsStore()
const calibrationStore = useCalibrationStore()
const patientStore = usePatientStore()
const syncStore = useSyncStore()
const { toast } = useToast()

const fileInput = ref(null)
const pendingDeleteId = ref(null)

// spec §8: the same scoped/merged list every visible surface uses.
const contextId = computed(() => (patientStore.linked ? patientStore.patientId : null))
const records = computed(() => recordsStore.visibleRecords(contextId.value))

// outbox.pending() is a plain localStorage read, not Vue-reactive on its
// own. pendingCount alone under-triggers (review round 1 MINOR 6): a flush
// pass that fails without changing the QUEUE LENGTH — e.g. an item's
// attempts/lastError updates in place — leaves pendingCount unchanged, and
// Vue never retriggers dependents on a same-value write, so the chip would
// silently miss a new "ซิงค์ไม่สำเร็จ" state. lastFlushAt is bumped on
// EVERY flush pass regardless of outcome, so reading it here always forces
// a fresh re-evaluation.
const outboxItems = computed(() => {
  void syncStore.pendingCount
  void syncStore.lastFlushAt
  return outbox.pending()
})

// spec §8/briefing E: ซิงค์แล้ว (acked) / รอซิงค์ (queued) / ซิงค์ไม่สำเร็จ
// (queued with a lastError from a failed attempt) / อุปกรณ์อื่น (server-only,
// never queued on THIS device). No chip at all when none of these apply —
// e.g. sync isn't configured, or the record is an unlinked/local-only one.
const recordChips = computed(() => {
  const chips = new Map()
  for (const record of records.value) {
    if (record.serverOnly) {
      chips.set(record.id, { label: 'อุปกรณ์อื่น', cls: 'badge-ghost' })
      continue
    }
    if (record.synced) {
      chips.set(record.id, { label: 'ซิงค์แล้ว', cls: 'badge-success text-white' })
      continue
    }
    const queued = outboxItems.value.find((item) => item.recordId === record.id)
    if (queued?.lastError) {
      chips.set(record.id, { label: 'ซิงค์ไม่สำเร็จ', cls: 'badge-error text-white' })
    } else if (queued) {
      chips.set(record.id, { label: 'รอซิงค์', cls: 'badge-warning text-white' })
    }
  }
  return chips
})

const pendingDeleteRecord = computed(() =>
  pendingDeleteId.value ? (records.value.find((r) => r.id === pendingDeleteId.value) ?? null) : null,
)

// Fix round MAJOR 2 (ruling R37b follow-up): visibleRecords(contextId)
// deliberately EXCLUDES a stranded (patientId:null) local record while
// linked (contextId is a real patient id, not null) — correct for the main
// list, but it also meant such a record was reachable ONLY by knowing its
// exact /records/:id URL, so even the RecordDetailView rescue fix stayed
// unreachable the moment a nurse navigated back to /records. This is a
// NAVIGATION-ONLY affordance: exportCsv/exportJson below are UNCHANGED —
// both still call visibleRecords(contextId) exclusively, so a linked export
// never includes a record surfaced only in this group (pinned in
// scoping.test.js). Never populated while unlinked: an unlinked context
// already shows every patientId:null record in the normal list above.
const strandedRecords = computed(() => {
  if (!patientStore.linked) return []
  return recordsStore.records
    .filter((r) => (r.patientId ?? null) === null)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
})

onMounted(() => {
  recordsStore.load()
  calibrationStore.init()
})

function severityLabel(band) {
  return SEVERITY_META[band]?.label ?? 'ไม่ปวด'
}

function formatDatetime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
}

function statusLabel(status) {
  return status === 'complete' ? 'เสร็จสิ้น' : 'รอประเมินซ้ำ'
}

function statusClass(status) {
  return status === 'complete' ? 'badge-success text-white' : 'badge-warning text-white'
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

// Every export handler always leaves the user with visible feedback — a
// success toast on the happy path, an error toast if the (synchronous)
// download trigger throws — so nothing fails silently. Download mechanism
// itself (recordsStore/calibrationStore/domain/csv.js) is untouched.
function exportCsv() {
  try {
    recordsStore.exportCsv(contextId.value)
    toast('ส่งออก CSV แล้ว', 'success')
  } catch {
    toast('ส่งออก CSV ไม่สำเร็จ', 'error')
  }
}

function exportJson() {
  try {
    recordsStore.exportJson(contextId.value)
    toast('ส่งออก JSON แล้ว', 'success')
  } catch {
    toast('ส่งออก JSON ไม่สำเร็จ', 'error')
  }
}

function exportDataset() {
  try {
    const json = calibrationStore.exportDataset()
    downloadFile(`painface-dataset-${todayStamp()}.json`, json, 'application/json')
    toast('ส่งออกชุดข้อมูลโมเดลแล้ว', 'success')
  } catch {
    toast('ส่งออกชุดข้อมูลโมเดลไม่สำเร็จ', 'error')
  }
}

function triggerImport() {
  fileInput.value?.click()
}

async function onImportFile(event) {
  const file = event.target.files?.[0]
  if (!file) {
    event.target.value = ''
    return
  }

  try {
    const text = await file.text()
    const { added, rejected } = calibrationStore.importDataset(text)
    toast(`นำเข้าชุดข้อมูล: เพิ่ม ${added} รายการ, ปฏิเสธ ${rejected} รายการ`, added > 0 ? 'success' : 'warning')
  } catch {
    // calibrationStore.importDataset re-throws when recalibrate()/_persist()
    // fails (e.g. localStorage quota exceeded on a large dataset) — surface
    // that instead of leaving an unhandled rejection with no user feedback.
    toast('นำเข้าไม่สำเร็จ: ข้อมูลไม่ถูกต้องหรือพื้นที่จัดเก็บเต็ม', 'error')
  } finally {
    event.target.value = ''
  }
}

function requestDelete(id) {
  pendingDeleteId.value = id
}

function cancelDelete() {
  pendingDeleteId.value = null
}

function confirmDelete() {
  if (!pendingDeleteId.value) return
  recordsStore.remove(pendingDeleteId.value)
  pendingDeleteId.value = null
  toast('ลบบันทึกแล้ว', 'success')
}
</script>

<template>
  <div>
    <PatientContextCard />
    <h2 class="mb-4 text-lg font-semibold text-primary-700">ประวัติการประเมิน</h2>

    <div class="mb-4 flex flex-wrap gap-2">
      <BaseButton variant="outline" size="md" @click="exportCsv">
        <Icon name="download" :size="16" /> ส่งออก CSV
      </BaseButton>
      <BaseButton variant="outline" size="md" @click="exportJson">
        <Icon name="download" :size="16" /> ส่งออก JSON
      </BaseButton>
      <BaseButton variant="outline" size="md" @click="exportDataset">
        <Icon name="download" :size="16" /> ส่งออกชุดข้อมูลโมเดล
      </BaseButton>
      <BaseButton variant="outline" size="md" @click="triggerImport">
        <Icon name="upload" :size="16" /> นำเข้าชุดข้อมูล
      </BaseButton>
      <input
        ref="fileInput"
        type="file"
        accept="application/json"
        class="hidden"
        data-testid="import-dataset-input"
        @change="onImportFile"
      />
    </div>

    <div v-if="!records.length" class="mt-8 flex flex-col items-center gap-4 text-center">
      <p class="text-sm text-gray-500">ยังไม่มีประวัติการประเมิน</p>
      <BaseButton variant="primary" @click="router.push('/assess')">เริ่มประเมิน</BaseButton>
    </div>

    <ul v-else class="flex flex-col gap-3">
      <li v-for="record in records" :key="record.id" class="flex items-stretch gap-2">
        <router-link
          :to="`/records/${record.id}`"
          class="flex min-h-[44px] flex-1 flex-col gap-2 rounded-xl border border-base-200 bg-white p-3 shadow-sm transition-colors hover:bg-base-200"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="min-w-0 flex-1 truncate font-medium">{{ record.patient?.name || 'ไม่ระบุชื่อ' }}</span>
            <span :class="['badge shrink-0', statusClass(record.status)]">
              {{ statusLabel(record.status) }}
            </span>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span>เตียง {{ record.patient?.bed || '-' }}</span>
            <span>{{ formatDatetime(record.patient?.datetime) }}</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <StatusBadge
              :severity="severityBand(record.reported?.painScore)"
              :label="`ผู้ป่วย: ${severityLabel(severityBand(record.reported?.painScore))}`"
            />
            <StatusBadge
              :severity="severityBand(record.facial?.total)"
              :label="`สีหน้า: ${severityLabel(severityBand(record.facial?.total))}`"
            />
            <span
              v-if="recordChips.get(record.id)"
              :class="[
                'badge h-auto gap-1.5 whitespace-normal border-none py-1 text-xs font-medium',
                recordChips.get(record.id).cls,
              ]"
            >
              {{ recordChips.get(record.id).label }}
            </span>
          </div>
        </router-link>
        <button
          v-if="!record.serverOnly"
          type="button"
          class="btn btn-ghost btn-square min-h-[44px] min-w-[44px] shrink-0 text-error"
          aria-label="ลบบันทึก"
          @click="requestDelete(record.id)"
        >
          <Icon name="trash" :size="18" />
        </button>
      </li>
    </ul>

    <!--
      Fix round MAJOR 2: a navigation-only group for stranded local records
      (patientId:null) while linked — see strandedRecords' comment. Reuses
      the same amber accent as AssessView's "ยังไม่ได้เชื่อมผู้ป่วย" warning
      chip so the two surfaces read as the same concept.
    -->
    <template v-if="strandedRecords.length">
      <h3 class="mb-2 mt-6 text-sm font-semibold text-amber-800">ไม่ได้ผูกกับผู้ป่วยรายใด</h3>
      <ul class="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-2">
        <li v-for="record in strandedRecords" :key="record.id">
          <router-link
            :to="`/records/${record.id}`"
            class="flex min-h-[44px] flex-col gap-2 rounded-xl border border-amber-300 bg-white p-3 shadow-sm transition-colors hover:bg-amber-100"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0 flex-1 truncate font-medium">{{ record.patient?.name || 'ไม่ระบุชื่อ' }}</span>
              <span :class="['badge shrink-0', statusClass(record.status)]">
                {{ statusLabel(record.status) }}
              </span>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span>เตียง {{ record.patient?.bed || '-' }}</span>
              <span>{{ formatDatetime(record.patient?.datetime) }}</span>
            </div>
          </router-link>
        </li>
      </ul>
    </template>

    <BaseModal :open="!!pendingDeleteId" title="ยืนยันการลบ" @close="cancelDelete">
      <p class="text-sm">
        ต้องการลบบันทึกของ "{{ pendingDeleteRecord?.patient?.name || 'ไม่ระบุชื่อ' }}" ใช่หรือไม่?
        การลบไม่สามารถย้อนกลับได้
      </p>
      <p v-if="pendingDeleteRecord?.synced" class="mt-2 text-xs text-gray-500">
        การลบที่นี่ลบเฉพาะข้อมูลในเครื่อง ข้อมูลที่ซิงค์แล้วยังอยู่ในระบบของผู้ดูแล
      </p>
      <template #actions>
        <BaseButton variant="ghost" @click="cancelDelete">ยกเลิก</BaseButton>
        <BaseButton variant="error" @click="confirmDelete">ลบ</BaseButton>
      </template>
    </BaseModal>
  </div>
</template>
