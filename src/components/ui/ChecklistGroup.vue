<template>
  <div class="flex flex-col gap-3">
    <div v-for="item in items" :key="item.key" class="flex flex-col gap-2">
      <label class="flex items-center gap-3 min-h-[44px] cursor-pointer">
        <input
          type="checkbox"
          class="checkbox checkbox-primary shrink-0"
          :checked="isChecked(item.key)"
          @change="toggle(item.key, $event.target.checked)"
        />
        <span class="min-w-0 break-words text-sm">{{ item.label }}</span>
      </label>
      <BaseInput
        v-if="item.hasDetail && isChecked(item.key)"
        :model-value="detailFor(item.key)"
        placeholder="ระบุ…"
        class="ml-9 w-[calc(100%-2.25rem)]"
        @update:model-value="setDetail(item.key, $event)"
      />
    </div>
  </div>
</template>

<script setup>
import BaseInput from './BaseInput.vue'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  items: { type: Array, default: () => [] },
})

const emit = defineEmits(['update:modelValue'])

function entryFor(key) {
  return props.modelValue.find((e) => e.key === key)
}

function isChecked(key) {
  return !!entryFor(key)?.checked
}

function detailFor(key) {
  return entryFor(key)?.detail ?? ''
}

function emitNext(key, patch) {
  const exists = props.modelValue.some((e) => e.key === key)
  const next = exists
    ? props.modelValue.map((e) => (e.key === key ? { ...e, ...patch } : e))
    : [...props.modelValue, { key, checked: false, detail: '', ...patch }]
  emit('update:modelValue', next)
}

function toggle(key, checked) {
  emitNext(key, { checked })
}

function setDetail(key, detail) {
  emitNext(key, { detail })
}
</script>
