<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap gap-4">
      <label class="flex items-center gap-2 min-h-[44px] cursor-pointer">
        <input
          type="radio"
          :name="groupName"
          class="radio radio-primary shrink-0"
          :checked="modelValue.answer === true"
          @change="setAnswer(true)"
        />
        <span class="min-w-0 break-words text-sm">{{ yesLabel }}</span>
      </label>
      <label class="flex items-center gap-2 min-h-[44px] cursor-pointer">
        <input
          type="radio"
          :name="groupName"
          class="radio radio-primary shrink-0"
          :checked="modelValue.answer === false"
          @change="setAnswer(false)"
        />
        <span class="min-w-0 break-words text-sm">{{ noLabel }}</span>
      </label>
    </div>
    <BaseInput
      v-if="modelValue.answer === true"
      :model-value="modelValue.detail"
      :placeholder="detailPlaceholder"
      @update:model-value="setDetail"
    />
  </div>
</template>

<script setup>
import { useId } from 'vue'
import BaseInput from './BaseInput.vue'

const props = defineProps({
  modelValue: { type: Object, default: () => ({ answer: null, detail: '' }) },
  yesLabel: { type: String, default: 'ใช่' },
  noLabel: { type: String, default: 'ไม่' },
  detailPlaceholder: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue'])

// Unique per instance so multiple YesNoDetail fields on the same page don't
// natively group each other's radios together.
const groupName = useId()

function setAnswer(answer) {
  emit('update:modelValue', { ...props.modelValue, answer })
}

function setDetail(detail) {
  emit('update:modelValue', { ...props.modelValue, detail })
}
</script>
