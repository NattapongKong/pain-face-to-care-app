<template>
  <span :class="['badge h-auto gap-1.5 whitespace-normal break-words py-1 font-medium border-none', cfg.cls]">
    {{ label || cfg.th }}
  </span>
</template>

<script setup>
import { computed } from 'vue'

// severity → { th: Thai fallback label, cls: DaisyUI badge tone }
const SEVERITY = {
  mild: { th: 'ปวดน้อย', cls: 'badge-success text-white' },
  moderate: { th: 'ปวดปานกลาง', cls: 'badge-warning text-white' },
  severe: { th: 'ปวดมาก', cls: 'badge-error text-white' },
}

const props = defineProps({
  severity: { type: String, default: null },
  label: { type: String, default: '' },
})

const cfg = computed(() => SEVERITY[props.severity] ?? { th: 'ไม่ปวด', cls: 'badge-ghost' })
</script>
