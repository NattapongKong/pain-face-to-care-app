<template>
  <div class="flex flex-col gap-2">
    <h4 v-if="title" class="text-sm font-semibold text-primary-700">{{ title }}</h4>
    <div class="flex flex-col gap-2" role="radiogroup" :aria-label="title">
      <button
        v-for="opt in options"
        :key="opt.value"
        type="button"
        role="radio"
        :aria-checked="modelValue === opt.value"
        :data-testid="`score-tile-${opt.value}`"
        :class="tileClasses(opt.value)"
        @click="select(opt.value)"
      >
        <span class="min-w-0 flex-1 break-words text-left text-sm">{{ opt.label }}</span>
        <span
          v-if="highlight === opt.value"
          class="badge badge-info badge-sm text-white shrink-0 whitespace-nowrap"
        >
          AI เสนอ
        </span>
      </button>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: Number, default: null },
  options: { type: Array, default: () => [] },
  title: { type: String, default: '' },
  highlight: { type: Number, default: null },
})

const emit = defineEmits(['update:modelValue'])

function tileClasses(value) {
  const selected = props.modelValue === value
  return [
    'flex items-center gap-2 rounded-xl border p-3 min-h-[44px] text-left transition-colors',
    selected
      ? 'border-primary bg-primary/10 ring-1 ring-primary'
      : 'border-base-300 bg-base-100 hover:bg-base-200',
  ]
}

function select(value) {
  emit('update:modelValue', value)
}
</script>
