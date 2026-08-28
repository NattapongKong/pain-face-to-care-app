<template>
  <button
    :class="classes"
    :disabled="disabled || loading"
    @click="emit('click', $event)"
  >
    <span v-if="loading" class="loading loading-spinner loading-sm" aria-hidden="true"></span>
    <slot />
  </button>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  variant: {
    type: String,
    default: 'primary',
    validator: (v) => ['primary', 'ghost', 'outline', 'error', 'success'].includes(v),
  },
  size: {
    type: String,
    default: 'md',
    validator: (v) => ['md', 'lg'].includes(v),
  },
  block: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
})

const emit = defineEmits(['click'])

// Root font-size is 14px app-wide (src/style.css), so rem-based DaisyUI/Tailwind
// height utilities (e.g. min-h-11 = 2.75rem = 38.5px) undershoot the 44px touch
// floor. Use px-literal arbitrary values for the floor instead — see BaseModal
// idiom this library is ported from.
const VARIANTS = {
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  outline: 'btn-outline btn-primary',
  error: 'btn-error',
  success: 'btn-success',
}

const SIZES = {
  md: 'btn-md min-h-[44px]',
  lg: 'btn-lg min-h-[52px] text-base',
}

const classes = computed(() => [
  'btn gap-2 font-medium min-w-[44px]',
  VARIANTS[props.variant],
  SIZES[props.size],
  props.block ? 'btn-block' : '',
])
</script>
