<template>
  <div
    class="fixed top-4 inset-x-4 z-[9999] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4"
    aria-live="polite"
  >
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        :class="['alert shadow-lg text-sm font-medium max-w-md w-full sm:max-w-sm', colorClass(t.type)]"
        role="status"
      >
        <span class="flex-1 whitespace-pre-line">{{ t.message }}</span>
        <button
          class="min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
          aria-label="ปิด"
          @click="dismiss(t.id)"
        >
          <Icon name="close" :size="16" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import Icon from './Icon.vue'
import { useToast } from './useToast.js'

const { toasts, dismiss } = useToast()

function colorClass(type) {
  return (
    {
      success: 'alert-success',
      error: 'alert-error',
      warning: 'alert-warning',
      info: 'alert-info',
    }[type] ?? 'alert-info'
  )
}
</script>

<style scoped>
.toast-enter-active {
  transition: all 0.25s ease-out;
}
.toast-leave-active {
  transition: all 0.2s ease-in;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
}
</style>
