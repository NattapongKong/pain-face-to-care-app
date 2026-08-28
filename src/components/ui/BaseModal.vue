<template>
  <dialog
    ref="dialogRef"
    class="modal modal-bottom sm:modal-middle"
    @close="emit('close')"
    @cancel.prevent="close"
  >
    <div class="modal-box flex flex-col max-h-[85svh] w-[calc(100vw-2rem)] sm:max-w-lg">
      <header class="flex items-center justify-between shrink-0 gap-3 pb-4 border-b border-base-200">
        <h3 class="min-w-0 break-words text-lg font-semibold text-primary">{{ title }}</h3>
        <button
          type="button"
          class="btn btn-ghost btn-square min-h-[44px] min-w-[44px] shrink-0"
          aria-label="ปิด"
          @click="close"
        >
          <Icon name="close" :size="20" />
        </button>
      </header>

      <div class="flex-1 overflow-y-auto py-4">
        <slot />
      </div>

      <footer v-if="$slots.actions" class="shrink-0 pt-4 border-t border-base-200 flex flex-wrap justify-end gap-3">
        <slot name="actions" />
      </footer>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button>ปิด</button>
    </form>
  </dialog>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
})

const emit = defineEmits(['close'])

const dialogRef = ref(null)

function close() {
  emit('close')
}

// Feature-detect showModal/close: supported in every modern browser, but
// absent from jsdom (test environment), so guard rather than assume.
function openDialog() {
  const el = dialogRef.value
  if (el && typeof el.showModal === 'function') el.showModal()
}
function closeDialog() {
  const el = dialogRef.value
  if (el && typeof el.close === 'function') el.close()
}

watch(
  () => props.open,
  (val) => {
    if (val) openDialog()
    else closeDialog()
  }
)

onMounted(() => {
  if (props.open) openDialog()
})
</script>
