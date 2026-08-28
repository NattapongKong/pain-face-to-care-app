<template>
  <div class="w-full overflow-x-auto">
    <ul class="steps steps-horizontal min-w-max w-full">
      <li
        v-for="(label, i) in labels"
        :key="i"
        :class="['step', { 'step-primary': i + 1 <= current }]"
        :data-content="i + 1 < current ? '✓' : String(i + 1)"
      >
        <span class="text-xs whitespace-nowrap px-1">{{ label }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup>
defineProps({
  current: { type: Number, required: true },
  labels: { type: Array, default: () => [] },
})
</script>
