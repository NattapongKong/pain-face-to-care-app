<template>
  <label class="form-control w-full">
    <span v-if="label" class="label pb-1 pt-0">
      <span class="label-text text-sm font-medium text-primary-700">{{ label }}</span>
    </span>
    <input
      :value="modelValue"
      :type="type"
      :placeholder="placeholder"
      class="input input-bordered w-full min-h-[44px]"
      @input="emit('update:modelValue', $event.target.value)"
    />
  </label>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  label: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  type: { type: String, default: 'text' },
})

const emit = defineEmits(['update:modelValue'])
</script>
