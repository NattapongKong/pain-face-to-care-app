<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import QRCode from 'qrcode'
import { useRecordsStore } from '../stores/recordsStore.js'
import { useCalibrationStore } from '../stores/calibrationStore.js'
import { usePatientStore } from '../stores/patientStore.js'
import { useSyncStore } from '../stores/syncStore.js'
import * as outbox from '../sync/outbox.js'
import { severityBand, SEVERITY_META } from '../domain/severity.js'
import { BaseButton, StatusBadge, Icon } from '../components/ui'
import PatientContextCard from '../components/PatientContextCard.vue'

const router = useRouter()
const recordsStore = useRecordsStore()
const calibrationStore = useCalibrationStore()
const patientStore = usePatientStore()
const syncStore = useSyncStore()

const qrCanvas = ref(null)
const qrFailed = ref(false)
// review round 1 BLOCKER 3: `${location.origin}${import.meta.env.BASE_URL}`
// is broken under this app's `base: './'` vite config — BASE_URL is the
// RELATIVE string './', so concatenating it onto origin produces a literal
// "https://host./" (note the stray dot) in production. origin + pathname is
// the actual resolved deployed URL, correct regardless of how deep the app
// is hosted — and (review round 2 deferred-minor 1) unlike
// `location.href.split('#')[0]`, it also drops any stray query string
// ahead of the hash rather than carrying it into every QR/app link.
const appBase = `${location.origin}${location.pathname}`
const qrUrl = appBase

// spec §8: the same visibility filter every scoped surface uses — linked
// shows only the active patient's records (local ∪ server), unlinked shows
// only local records with no patientId (legacy records included).
const contextId = computed(() => (patientStore.linked ? patientStore.patientId : null))
const visibleRecords = computed(() => recordsStore.visibleRecords(contextId.value))
const recentRecords = computed(() => visibleRecords.value.slice(0, 3))

// review round 1 MINOR 7 (lead ruling R34): pending counts are PATIENT-
// FACING data — B must never see A's queue depth, even as a bare number.
// outbox.pending() is a plain localStorage read, not Vue-reactive on its
// own; pendingCount alone can under-trigger (a flush pass that fails
// without changing the QUEUE LENGTH leaves pendingCount unchanged, and
// same-value writes don't retrigger Vue's reactivity), so lastFlushAt —
// bumped on every flush pass regardless of outcome — is read here too,
// purely to force a fresh re-evaluation.
const scopedPendingCount = computed(() => {
  void syncStore.pendingCount
  void syncStore.lastFlushAt
  return outbox.pending().filter((item) => (item.patientId ?? null) === contextId.value).length
})

function severityLabel(band) {
  return SEVERITY_META[band]?.label ?? 'ไม่ปวด'
}

function formatDatetime(value) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
}

// A revoked/mistyped QR must not brick the app (spec §7) — clearing here
// discards the bad context the same way ออกจากผู้ป่วย does.
function dismissAuthFailed() {
  patientStore.clear()
  syncStore.resetServer()
}

onMounted(async () => {
  // Real store data only — record count + calibration sample count. Never
  // probe/load the ML landmarker model here (3 MB cost, spec R-home).
  recordsStore.load()
  calibrationStore.init()

  try {
    await QRCode.toCanvas(qrCanvas.value, qrUrl, {
      width: 176,
      margin: 1,
      color: { dark: '#1e3a5f', light: '#ffffff' },
    })
    qrFailed.value = false
  } catch {
    qrFailed.value = true
  }
})
</script>

<template>
  <div>
    <div v-if="syncStore.authFailed" class="alert alert-error mb-4 text-sm">
      <Icon name="alert-circle" :size="18" />
      <span class="flex-1">QR ไม่ถูกต้องหรือถูกยกเลิก</span>
      <BaseButton variant="ghost" size="md" @click="dismissAuthFailed">ยกเลิกการเชื่อม</BaseButton>
    </div>

    <div v-if="syncStore.storageFailed" class="alert alert-warning mb-4 text-sm">
      <Icon name="alert-triangle" :size="18" />
      <span>พื้นที่จัดเก็บเต็ม — ข้อมูลอาจไม่ถูกบันทึก/ซิงค์</span>
    </div>

    <PatientContextCard />
    <p v-if="!patientStore.linked" class="mb-4 text-xs text-gray-500">โหมดไม่เชื่อมผู้ป่วย (บันทึกในเครื่องเท่านั้น)</p>

    <!-- spec §7 / plan Task 6: banked-baseline entry point, shown only when
         linked — an unlinked device has no patient record to bank a
         baseline against. -->
    <section v-if="patientStore.linked" class="mb-4 flex flex-col gap-2 rounded-2xl border border-base-200 bg-white p-4 shadow-sm">
      <div class="flex items-center gap-2">
        <Icon name="scan-face" :size="18" class="shrink-0 text-primary-700" />
        <span class="text-sm font-semibold text-primary-700">หน้าปกติของผู้ป่วย</span>
      </div>
      <p class="text-xs text-gray-500">{{ patientStore.baseline ? 'บันทึกแล้ว' : 'ยังไม่ได้บันทึก' }}</p>
      <BaseButton variant="outline" size="md" @click="router.push('/baseline')">
        {{ patientStore.baseline ? 'อัปเดตหน้าปกติ' : 'บันทึกหน้าปกติ' }}
      </BaseButton>
    </section>

    <section class="rounded-2xl bg-white p-4 shadow-md">
      <h3 class="mb-3 text-base font-semibold text-primary-700">PAIN FACE to Care</h3>
      <p class="mb-4 text-sm text-gray-600">สแกน QR Code เพื่อเข้าสู่แบบประเมิน</p>

      <div class="flex flex-col items-center gap-2 py-2">
        <canvas
          v-show="!qrFailed"
          ref="qrCanvas"
          class="rounded-lg border border-base-300 bg-white p-2"
          data-testid="home-qr-canvas"
        ></canvas>
        <p v-if="qrFailed" class="break-all text-center text-sm font-medium text-primary-700">
          {{ qrUrl }}
        </p>
      </div>

      <div class="mt-4 flex flex-col gap-3">
        <BaseButton variant="primary" size="lg" block @click="router.push('/assess')">
          เริ่มประเมิน
        </BaseButton>
        <BaseButton variant="outline" block @click="router.push('/records')">
          ดูประวัติการประเมิน
        </BaseButton>
        <!-- Round 4 Task 1 (spec §2): device-to-device spread entry point —
             only meaningful once THIS device already has a live sync
             connection to share (a share-QR of an unconfigured device's
             connect link would just carry an empty URL). -->
        <BaseButton v-if="syncStore.configured" variant="outline" block @click="router.push('/connect')">
          <Icon name="share" :size="16" /> เชื่อมต่ออุปกรณ์เพิ่ม
        </BaseButton>
      </div>

      <div class="mt-4 flex flex-col gap-2">
        <span class="badge badge-lg badge-ghost h-auto gap-2 whitespace-normal py-2 text-sm font-medium">
          <Icon name="clipboard" :size="16" />
          บันทึกทั้งหมด {{ visibleRecords.length }} รายการ
        </span>
        <span class="badge badge-lg badge-ghost h-auto gap-2 whitespace-normal py-2 text-sm font-medium">
          <Icon name="sparkles" :size="16" />
          ปรับปรุงโมเดลจากการยืนยัน {{ calibrationStore.sampleCount }} ครั้ง
        </span>
        <span
          v-if="syncStore.configured"
          class="badge badge-lg badge-ghost h-auto gap-2 whitespace-normal py-2 text-sm font-medium"
        >
          <Icon name="refresh" :size="16" />
          <template v-if="scopedPendingCount > 0">รอซิงค์ {{ scopedPendingCount }} รายการ</template>
          <template v-else-if="syncStore.lastSyncAt">ซิงค์ล่าสุด {{ formatDatetime(syncStore.lastSyncAt) }}</template>
          <template v-else>ยังไม่มีการซิงค์</template>
        </span>
      </div>
    </section>

    <section class="mt-6 rounded-2xl bg-white p-4 shadow-md">
      <h3 class="mb-3 text-base font-semibold text-primary-700">รายการล่าสุด</h3>

      <ul v-if="recentRecords.length" class="flex flex-col gap-3">
        <li v-for="record in recentRecords" :key="record.id">
          <router-link
            :to="`/records/${record.id}`"
            class="flex min-h-[44px] flex-col gap-2 rounded-xl border border-base-200 p-3 transition-colors hover:bg-base-200"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0 flex-1 truncate font-medium">{{ record.patient?.name || 'ไม่ระบุชื่อ' }}</span>
              <span class="shrink-0 text-xs text-gray-500">{{ formatDatetime(record.patient?.datetime) }}</span>
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
            </div>
          </router-link>
        </li>
      </ul>
      <p v-else class="text-center text-sm text-gray-500">ยังไม่มีประวัติการประเมิน</p>
    </section>
  </div>
</template>
