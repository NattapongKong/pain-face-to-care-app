<script setup>
// R41 Task T4 (spec §5, owner sketch): self-contained patient context card —
// no events. Renders nothing when unlinked; reads patientStore directly.
// Owns the QR modal + unlink confirm flows extracted VERBATIM from HomeView
// (same copy, same store/sync calls on unlink) so every surface that
// renders this card (HomeView, RecordsView, RecordDetailView, and — wave 2
// — AssessView/BaselineView) gets identical behavior for free.
//
// Fix round 1 (ruling R44): one optional prop, `hideUnlink`, added for
// AssessView's call site — see AssessView.vue's own comment for the full
// rationale (an ออก mid-wizard would freeze a record's attribution,
// R36/R37, into a state that's both unsynced and invisible in every list).
// Every other call site keeps the default (false) and is unaffected.
import { ref, computed, nextTick } from 'vue'
import QRCode from 'qrcode'
import { usePatientStore } from '../stores/patientStore.js'
import { useSyncStore } from '../stores/syncStore.js'
import { BaseButton, BaseModal, Icon } from './ui'

defineProps({
  hideUnlink: { type: Boolean, default: false },
})

const patientStore = usePatientStore()
const syncStore = useSyncStore()

// review round 1 BLOCKER 3 (see HomeView): origin + pathname is the actual
// resolved deployed URL under this app's `base: './'` vite config — carried
// over verbatim for the patient QR link.
const appBase = `${location.origin}${location.pathname}`
const patientLinkUrl = computed(() => `${appBase}#/p/${patientStore.patientId}/${patientStore.token}`)

const patientQrCanvas = ref(null)
const patientQrFailed = ref(false)
const showPatientQr = ref(false)
const showUnlinkConfirm = ref(false)

async function openPatientQr() {
  showPatientQr.value = true
  await nextTick()
  try {
    await QRCode.toCanvas(patientQrCanvas.value, patientLinkUrl.value, {
      width: 200,
      margin: 1,
      color: { dark: '#1e3a5f', light: '#ffffff' },
    })
    patientQrFailed.value = false
  } catch {
    patientQrFailed.value = true
  }
}

function closePatientQr() {
  showPatientQr.value = false
}

function requestUnlink() {
  showUnlinkConfirm.value = true
}

function cancelUnlink() {
  showUnlinkConfirm.value = false
}

function confirmUnlink() {
  patientStore.clear()
  syncStore.resetServer()
  showUnlinkConfirm.value = false
}
</script>

<template>
  <div v-if="patientStore.linked">
    <!-- owner sketch (spec §5):
         [displayName (title)]        [แสดง QR]
         [เตียง <bed> (secondary)]     [ออก]
    -->
    <section class="mb-4 flex items-start justify-between gap-3 rounded-2xl border border-base-200 bg-white p-4 shadow-sm">
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold text-primary-700">
          {{ patientStore.displayName || patientStore.patientId }}
        </p>
        <p v-if="patientStore.bed" class="truncate text-xs text-gray-500">เตียง {{ patientStore.bed }}</p>
      </div>
      <div class="flex shrink-0 flex-col gap-2">
        <BaseButton variant="outline" size="md" @click="openPatientQr">
          <Icon name="qrcode" :size="16" /> แสดง QR
        </BaseButton>
        <BaseButton v-if="!hideUnlink" variant="ghost" size="md" @click="requestUnlink">ออก</BaseButton>
      </div>
    </section>

    <BaseModal :open="showPatientQr" title="QR ผู้ป่วย" @close="closePatientQr">
      <div class="flex flex-col items-center gap-3">
        <canvas
          v-show="!patientQrFailed"
          ref="patientQrCanvas"
          class="rounded-lg border border-base-300 bg-white p-2"
        ></canvas>
        <p v-if="patientQrFailed" class="break-all text-center text-sm font-medium text-primary-700">
          {{ patientLinkUrl }}
        </p>
        <p class="text-center text-sm text-gray-600">{{ patientStore.displayName || patientStore.patientId }}</p>
      </div>
      <template #actions>
        <BaseButton variant="ghost" @click="closePatientQr">ปิด</BaseButton>
      </template>
    </BaseModal>

    <!-- R44: not rendered at all (not merely hidden) while hideUnlink — the
         button that would open this modal doesn't exist either, but this
         guard is belt-and-braces against anything else ever flipping
         showUnlinkConfirm. -->
    <BaseModal v-if="!hideUnlink" :open="showUnlinkConfirm" title="ออกจากผู้ป่วย" @close="cancelUnlink">
      <p class="text-sm">
        ต้องการออกจากผู้ป่วย "{{ patientStore.displayName || patientStore.patientId }}" ใช่หรือไม่?
        อุปกรณ์นี้จะกลับไปบันทึกในเครื่องเท่านั้นจนกว่าจะสแกน QR ใหม่
      </p>
      <template #actions>
        <BaseButton variant="ghost" @click="cancelUnlink">ยกเลิก</BaseButton>
        <BaseButton variant="error" @click="confirmUnlink"> ออกจากผู้ป่วย </BaseButton>
      </template>
    </BaseModal>
  </div>
</template>
