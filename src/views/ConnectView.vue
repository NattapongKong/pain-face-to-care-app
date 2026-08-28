<!--
  Runtime connect flow (spec §2/§3, plan Round 4 Task 1). Reached two ways:

  - `#/connect?u=<encoded execUrl>` — from the GAS install dialog's connect
    link, or a share-QR scanned off another already-connected device. Shows
    a confirm step (host emphasized) before persisting the URL as a
    device-local override via syncStore.applySyncOverride(). A malformed/
    invalid `u` renders an honest error instead of a confirm the store
    would just reject anyway.
  - Bare `#/connect` — the "เชื่อมต่ออุปกรณ์เพิ่ม" entry point from HomeView
    on an already-connected device: shows the current connection (override
    vs ไฟล์ตั้งค่า) plus a share-QR of THIS device's own connect link so the
    next device can scan instead of typing anything, and — only when the
    live source is an override, never the file — an undo affordance
    (clearSyncOverride()). On an unconfigured device it just explains where
    a connect link comes from.

  Follows the same idioms as every other view here: SectionCard/BaseButton/
  Icon from the ui barrel, and the QR modal pattern lifted directly from
  PatientContextCard (open-on-demand canvas render via QRCode.toCanvas,
  text fallback on failure).

  Fix round 1 (Opus review) additions:
  - MAJOR 2 / LEAD RULING R45: both the ?u= confirm step and the ยกเลิก
    (disconnect) action refuse — rendering a "มีข้อมูลค้างส่ง" blocked
    state with a "ลองส่งตอนนี้" retry instead of a confirm/ยกเลิก button —
    whenever taking the action would repoint a non-empty outbox at a
    different backend (syncStore.wouldOrphanPending(), the single source
    of truth the store itself also enforces). A button that would silently
    no-op on click is a dead control, so the blocked state REPLACES the
    normal button rather than merely disabling it.
  - minor 4: the `u` query value is trimmed (whitespace incl. a stray
    trailing %0A from a pasted/scanned link) before any validation.
  - minor 8: a link that already matches this device's live FILE config
    needs no override at all (avoids needlessly pinning the device against
    a future sync-config.json update) — an "already connected" state shows
    instead, without ever calling applySyncOverride(). When configured and
    the link differs, the ordinary confirm step names what it will replace.

  Fix round 2 (Opus review) minors folded in here:
  - retryFlush() now surfaces an honest toast when a pass still leaves the
    outbox non-empty (offline, or the old backend genuinely unreachable) —
    a full drain needs no toast of its own, since the blocked panel
    disappearing (both viewStates react to syncStore.pendingCount) already
    shows success.
  - confirmDisconnect() checks clearSyncOverride()'s now-meaningful return
    (the store itself can refuse under R45, e.g. a race that fills the
    outbox between opening this modal and confirming it) and toasts rather
    than silently no-opping.
-->
<script setup>
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import QRCode from 'qrcode'
import { useSyncStore, isValidSyncUrl } from '../stores/syncStore.js'
import { BaseButton, BaseModal, Icon, SectionCard, useToast } from '../components/ui'

const props = defineProps({
  // route.js passes route.query.u verbatim — undefined when absent, a
  // string when present once, an array when the query key repeats. Every
  // shape funnels through rawU below.
  u: { type: [String, Array], default: '' },
})

const router = useRouter()
const syncStore = useSyncStore()
const { toast } = useToast()

const rawU = computed(() => {
  const value = Array.isArray(props.u) ? props.u[0] : props.u
  return typeof value === 'string' ? value : ''
})
const hasU = computed(() => rawU.value.length > 0)
// Fix round 1 minor 4: whitespace (including a stray trailing %0A from a
// pasted/scanned link) is trimmed HERE, in the view, before any validation
// or comparison — syncStore's own contract (isValidSyncUrl / syncUrl)
// stays untouched; it just never sees untrimmed input from this view.
const decodedU = computed(() => rawU.value.trim())
const urlValid = computed(() => hasU.value && isValidSyncUrl(decodedU.value))

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const urlHost = computed(() => hostOf(decodedU.value))

// Flips true only once applySyncOverride() has actually run and succeeded
// for THIS view instance — url validity alone (urlValid) must not imply
// success, since the confirm step is a deliberate user action.
const confirmed = ref(false)

// Fix round 1 minor 8: this device is ALREADY pointed at exactly this url
// via the ordinary file config — applying an override would be redundant
// and would needlessly pin the device against a future sync-config.json
// update. (A device already on this SAME url via an override falls
// through to the plain confirm step below; re-applying it there is a
// harmless no-op — see applySyncOverride's urlChanged guard.)
const alreadyConnectedToFile = computed(
  () => hasU.value && urlValid.value && decodedU.value === syncStore.syncUrl && syncStore.syncSource === 'file',
)

// Fix round 1 MAJOR 2 / LEAD RULING R45 (binding): mirrors the exact guard
// syncStore.applySyncOverride() itself enforces (single source of truth)
// — read here too so the blocked state renders BEFORE the confirm button
// is ever offered, never as a button that silently no-ops on click.
const pendingBlock = computed(() => syncStore.wouldOrphanPending(decodedU.value))

const viewState = computed(() => {
  if (!hasU.value) return syncStore.configured ? 'configured' : 'unconfigured'
  if (!urlValid.value) return 'invalid'
  if (confirmed.value) return 'success'
  if (alreadyConnectedToFile.value) return 'already-connected'
  if (pendingBlock.value) return 'blocked'
  return 'confirm'
})

// Fix round 1 minor 8 (second half): the plain confirm step (reached only
// once the blocked/already-connected states above don't apply) names what
// it's about to replace, when there is one.
const replacesExisting = computed(() => syncStore.configured && decodedU.value !== syncStore.syncUrl)

const sectionTitle = computed(() => {
  switch (viewState.value) {
    case 'confirm':
      return 'เชื่อมต่อกับฐานข้อมูลกลาง'
    case 'blocked':
      return 'มีข้อมูลค้างส่ง'
    case 'already-connected':
      return 'เชื่อมต่ออยู่แล้ว'
    case 'success':
      return 'เชื่อมต่อสำเร็จ'
    case 'invalid':
      return 'ลิงก์เชื่อมต่อไม่ถูกต้อง'
    case 'configured':
      return 'การเชื่อมต่อฐานข้อมูล'
    default:
      return 'เชื่อมต่อฐานข้อมูล'
  }
})

function confirmConnect() {
  const result = syncStore.applySyncOverride(decodedU.value)
  // pendingBlock above already keeps this button from rendering on a
  // 'pending' refusal — this guard is belt-and-braces only.
  if (!result.ok) return
  confirmed.value = true
  // Fix round 1 minor 3: a device linking a patient's context for the
  // first time via this flow shows their data without waiting for a reload.
  syncStore.flush().catch(() => {})
}

// Fix round 1 MAJOR 2: shared by both the ?u= blocked state and the
// disconnect-blocked panel below — "send the OLD backend's backlog before
// switching/leaving it" is the same action either way. Fix round 2 minor
// 3: honest feedback when a pass still leaves items queued (offline, or
// the old backend genuinely unreachable) — silence there would look like
// the tap did nothing. A pass that fully drains the outbox needs no toast:
// the blocked panel disappearing (pendingBlock/disconnectBlocked both
// react to syncStore.pendingCount) already shows success.
async function retryFlush() {
  await syncStore.flush().catch(() => {})
  if (syncStore.pendingCount > 0) {
    toast('ยังส่งไม่สำเร็จ — ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต', 'error')
  }
}

function cancelConnect() {
  router.push('/')
}

function goHome() {
  router.push('/')
}

// review round 1 BLOCKER 3 (HomeView/PatientContextCard): origin + pathname
// is the actual resolved deployed URL under this app's `base: './'` vite
// config — carried over verbatim here for the share-QR link.
const appBase = `${location.origin}${location.pathname}`
const shareLink = computed(() => `${appBase}#/connect?u=${encodeURIComponent(syncStore.syncUrl)}`)

const qrCanvas = ref(null)
const qrFailed = ref(false)
const showQr = ref(false)

async function openQr() {
  showQr.value = true
  await nextTick()
  try {
    await QRCode.toCanvas(qrCanvas.value, shareLink.value, {
      width: 200,
      margin: 1,
      color: { dark: '#1e3a5f', light: '#ffffff' },
    })
    qrFailed.value = false
  } catch {
    qrFailed.value = true
  }
}

function closeQr() {
  showQr.value = false
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareLink.value)
    toast('คัดลอกลิงก์แล้ว', 'success')
  } catch {
    toast('คัดลอกไม่สำเร็จ กรุณาคัดลอกด้วยตนเอง', 'error')
  }
}

const showUnlinkConfirm = ref(false)

// Fix round 1 MAJOR 2 / R45: the same guard the store itself enforces
// (defense in depth) — computed here so the "ยกเลิก" button is REPLACED by
// the blocked state before the confirm modal is ever offered, rather than
// opening a modal whose confirm click would then silently no-op.
const disconnectBlocked = computed(
  () => syncStore.syncSource === 'override' && syncStore.wouldOrphanPending(syncStore.fileSyncUrl),
)

function requestDisconnect() {
  showUnlinkConfirm.value = true
}

function cancelDisconnect() {
  showUnlinkConfirm.value = false
}

// Fix round 2 minor 2: clearSyncOverride()'s return is now meaningful (R45
// can refuse it) — disconnectBlocked above already keeps this modal from
// opening in the ordinary case, but a race (outbox filled between opening
// the modal and confirming) means the store's OWN refusal is still the
// authority; a silent no-op here would look like a bug, not a decision.
function confirmDisconnect() {
  const result = syncStore.clearSyncOverride()
  if (!result.ok) {
    toast('มีข้อมูลค้างส่ง — ยกเลิกการเชื่อมต่อไม่ได้', 'error')
  }
  showUnlinkConfirm.value = false
}
</script>

<template>
  <div>
    <BaseButton variant="ghost" size="md" class="mb-3" @click="goHome">
      <Icon name="chevron-left" :size="16" /> กลับหน้าหลัก
    </BaseButton>

    <SectionCard :number="1" :title="sectionTitle">
      <!-- ?u= present and valid, not yet confirmed -->
      <div v-if="viewState === 'confirm'" class="flex flex-col gap-4">
        <p class="text-sm text-gray-600">เชื่อมต่อกับฐานข้อมูลกลางนี้หรือไม่?</p>
        <p v-if="replacesExisting" class="text-xs text-warning">
          การเชื่อมต่อนี้จะแทนที่การเชื่อมต่อฐานข้อมูลปัจจุบันของอุปกรณ์นี้
        </p>
        <div class="break-all rounded-lg bg-base-200 p-3">
          <p class="text-sm font-semibold text-primary-700">{{ urlHost }}</p>
          <p class="text-xs text-gray-500">{{ decodedU }}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <BaseButton variant="primary" @click="confirmConnect">เชื่อมต่อ</BaseButton>
          <BaseButton variant="ghost" @click="cancelConnect">ยกเลิก</BaseButton>
        </div>
      </div>

      <!-- ?u= present, valid, DIFFERENT backend, but this device's outbox
           still carries records for the CURRENT one (R45) -->
      <div v-else-if="viewState === 'blocked'" class="flex flex-col gap-4">
        <div class="alert alert-warning text-sm">
          <Icon name="alert-triangle" :size="18" />
          <span>
            มีข้อมูลค้างส่ง {{ syncStore.pendingCount }} รายการ —
            กรุณาส่งข้อมูลไปยังฐานข้อมูลเดิมให้เสร็จก่อนเปลี่ยนฐานข้อมูล
          </span>
        </div>
        <div class="flex flex-wrap gap-2">
          <BaseButton variant="primary" @click="retryFlush">ลองส่งตอนนี้</BaseButton>
          <BaseButton variant="ghost" @click="cancelConnect">ยกเลิก</BaseButton>
        </div>
      </div>

      <!-- ?u= present, valid, and IDENTICAL to the file config already live
           on this device — nothing to do, no override needed -->
      <div v-else-if="viewState === 'already-connected'" class="flex flex-col items-center gap-3 py-4 text-center">
        <Icon name="success" :size="32" class="text-success" />
        <p class="text-sm text-gray-700">อุปกรณ์นี้เชื่อมต่อกับฐานข้อมูลนี้อยู่แล้ว</p>
        <BaseButton variant="primary" @click="goHome">ไปหน้าหลัก</BaseButton>
      </div>

      <!-- confirmed this session -->
      <div v-else-if="viewState === 'success'" class="flex flex-col items-center gap-3 py-4 text-center">
        <Icon name="success" :size="32" class="text-success" />
        <p class="text-sm font-medium text-gray-700">เชื่อมต่อกับฐานข้อมูลกลางสำเร็จ</p>
        <p v-if="syncStore.storageFailed" class="text-xs text-warning">
          ใช้งานได้ในเซสชันนี้ แต่พื้นที่จัดเก็บของอุปกรณ์เต็ม
          การเชื่อมต่ออาจไม่คงอยู่หลังปิดแอปหรือโหลดหน้าใหม่
        </p>
        <BaseButton variant="primary" @click="goHome">ไปหน้าหลัก</BaseButton>
      </div>

      <!-- ?u= present but malformed / not a real exec URL -->
      <div v-else-if="viewState === 'invalid'" class="flex flex-col items-center gap-3 py-4 text-center">
        <Icon name="alert-circle" :size="32" class="text-error" />
        <p class="text-sm text-gray-700">
          ลิงก์เชื่อมต่อนี้ไม่ถูกต้อง กรุณาขอลิงก์ใหม่จากอุปกรณ์ที่เชื่อมต่อแล้ว
          หรือจากเมนู "ติดตั้งระบบ + เชื่อมต่อแอป" ในชีตของโรงพยาบาล
        </p>
        <BaseButton variant="outline" @click="goHome">กลับหน้าหลัก</BaseButton>
      </div>

      <!-- bare #/connect, already configured -->
      <div v-else-if="viewState === 'configured'" class="flex flex-col gap-4">
        <p class="text-sm text-gray-600">
          เชื่อมต่อผ่าน
          <span class="font-semibold text-primary-700">
            {{ syncStore.syncSource === 'override' ? 'การตั้งค่าที่อุปกรณ์นี้' : 'ไฟล์ตั้งค่า' }}
          </span>
        </p>
        <p class="break-all text-xs text-gray-500">{{ syncStore.syncUrl }}</p>

        <p class="text-sm text-gray-600">แสดง QR หรือคัดลอกลิงก์นี้ให้อุปกรณ์ถัดไปสแกน/เปิด เพื่อเชื่อมต่อฐานข้อมูลเดียวกัน</p>
        <div class="flex flex-wrap gap-2">
          <BaseButton variant="outline" @click="openQr">
            <Icon name="qrcode" :size="16" /> แสดง QR
          </BaseButton>
          <BaseButton variant="outline" @click="copyLink">
            <Icon name="copy" :size="16" /> คัดลอกลิงก์
          </BaseButton>
        </div>

        <template v-if="syncStore.syncSource === 'override'">
          <!-- R45: this device's outbox still carries records for the
               OVERRIDE backend — disconnecting (reverting to the file's
               backend) would orphan them, so ยกเลิก is replaced, not just
               disabled. -->
          <div v-if="disconnectBlocked" class="flex flex-col gap-2">
            <div class="alert alert-warning text-sm">
              <Icon name="alert-triangle" :size="18" />
              <span>มีข้อมูลค้างส่ง {{ syncStore.pendingCount }} รายการ — กรุณาส่งข้อมูลให้เสร็จก่อนยกเลิกการเชื่อมต่อ</span>
            </div>
            <BaseButton variant="outline" @click="retryFlush">ลองส่งตอนนี้</BaseButton>
          </div>
          <BaseButton v-else variant="error" @click="requestDisconnect">
            ยกเลิกการเชื่อมต่อฐานข้อมูลนี้
          </BaseButton>
        </template>
      </div>

      <!-- bare #/connect, never configured -->
      <div v-else class="flex flex-col items-center gap-3 py-4 text-center">
        <Icon name="info" :size="28" class="text-primary-700" />
        <p class="text-sm text-gray-600">
          อุปกรณ์นี้ยังไม่ได้เชื่อมต่อกับฐานข้อมูลกลาง ลิงก์เชื่อมต่อจะได้จากเมนู "ติดตั้งระบบ + เชื่อมต่อแอป" ในชีตของโรงพยาบาล
          หรือสแกน QR จากอุปกรณ์ที่เชื่อมต่อแล้ว
        </p>
        <BaseButton variant="outline" @click="goHome">กลับหน้าหลัก</BaseButton>
      </div>
    </SectionCard>

    <BaseModal :open="showQr" title="QR เชื่อมต่ออุปกรณ์" @close="closeQr">
      <div class="flex flex-col items-center gap-3">
        <canvas v-show="!qrFailed" ref="qrCanvas" class="rounded-lg border border-base-300 bg-white p-2"></canvas>
        <!-- Fix round 1 minor 6: shown unconditionally (not only on
             qrFailed) — the "คัดลอกลิงก์นี้" manual-copy affordance this
             text backs must always have something selectable on screen,
             QR render success or not. -->
        <p class="break-all text-center text-sm font-medium text-primary-700">{{ shareLink }}</p>
      </div>
      <template #actions>
        <BaseButton variant="ghost" @click="closeQr">ปิด</BaseButton>
      </template>
    </BaseModal>

    <BaseModal :open="showUnlinkConfirm" title="ยกเลิกการเชื่อมต่อ" @close="cancelDisconnect">
      <p class="text-sm">
        ต้องการยกเลิกการเชื่อมต่อฐานข้อมูลนี้ใช่หรือไม่? อุปกรณ์นี้จะกลับไปใช้ไฟล์ตั้งค่าเดิม
        (หรือโหมดไม่เชื่อมต่อ หากไม่มีไฟล์ตั้งค่า)
      </p>
      <template #actions>
        <BaseButton variant="ghost" @click="cancelDisconnect">ไม่ยกเลิก</BaseButton>
        <BaseButton variant="error" @click="confirmDisconnect">ยืนยันยกเลิกการเชื่อมต่อ</BaseButton>
      </template>
    </BaseModal>
  </div>
</template>
