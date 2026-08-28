<template>
  <label class="form-control w-full">
    <span v-if="label" class="label pb-1 pt-0">
      <span class="label-text text-sm font-medium text-primary-700">{{ label }}</span>
    </span>
    <textarea
      :value="modelValue"
      :rows="rows"
      class="textarea textarea-bordered w-full min-h-[44px]"
      @input="emit('update:modelValue', $event.target.value)"
    />
  </label>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: String, default: '' },
  label: { type: String, default: '' },
  rows: { type: [Number, String], default: 3 },
})

const emit = defineEmits(['update:modelValue'])
</script>
