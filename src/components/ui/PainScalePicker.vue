<template>
  <div class="grid grid-cols-4 sm:grid-cols-6 gap-2" role="radiogroup" aria-label="ระดับความปวด 0 ถึง 10">
    <button
      v-for="tile in tiles"
      :key="tile.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === tile.value"
      :data-testid="`pain-tile-${tile.value}`"
      :class="tileClasses(tile.value)"
      @click="select(tile.value)"
    >
      <span class="text-2xl leading-none" aria-hidden="true">{{ FACES[tile.value] }}</span>
      <span class="text-sm font-semibold">{{ tile.value }}</span>
      <span v-if="tile.label" class="text-[10px] leading-tight text-center">{{ tile.label }}</span>
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const FACES = ['😊', '🙂', '😐', '😕', '😟', '☹️', '😣', '😖', '😫', '😭', '😱']

const props = defineProps({
  modelValue: { type: Number, default: null },
  labels: { type: Array, default: () => [] },
})

const emit = defineEmits(['update:modelValue'])

const tiles = computed(() =>
  Array.from({ length: 11 }, (_, value) => ({
    value,
    label: props.labels.find((l) => l.value === value)?.label ?? '',
  }))
)

// Band follows the same 0/null|1-3|4-6|7-10 split as domain severityBand,
// just labelled "neutral" for 0 since 0 means "no pain", not "unscored".
function bandRing(value) {
  if (value === 0) return 'ring-base-300'
  if (value <= 3) return 'ring-success'
  if (value <= 6) return 'ring-warning'
  return 'ring-error'
}

function tileClasses(value) {
  const selected = props.modelValue === value
  return [
    'flex flex-col items-center justify-center gap-0.5 rounded-xl border border-base-300 bg-base-100 p-1.5',
    'min-h-[44px] min-w-[44px] transition-colors',
    selected ? ['ring-2 ring-offset-2', bandRing(value)] : 'hover:bg-base-200',
  ]
}

function select(value) {
  emit('update:modelValue', value)
}
</script>
