<template>
  <section class="bg-white rounded-2xl shadow-md p-4">
    <header class="flex items-center gap-3 mb-3">
      <span
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-700 text-sm font-semibold text-white"
      >
        {{ number }}
      </span>
      <h3 class="min-w-0 break-words text-base font-semibold text-primary-700">{{ title }}</h3>
    </header>
    <div>
      <slot />
    </div>
  </section>
</template>

<script setup>
defineProps({
  number: { type: [Number, String], default: '' },
  title: { type: String, default: '' },
})
</script>
