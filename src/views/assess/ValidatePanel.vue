<!--
  Five-category score editor (spec §5.4 the validation loop). Reused by
  Step3Facial (wizard step 1, form part 3) and Step6Reassess ("สแกนซ้ำ"):

  - Scan-confirm mode (`profiles` set): scores start pre-filled from
    `proposed` (the ML output), each ScoreTileGroup highlights the proposed
    value, and confirming logs a calibration sample (`profiles` are needed
    for that — nothing else uses them).
  - Manual mode (`profiles` null): no highlight, no calibration sample —
    the nurse is entering all five scores from scratch.

  Either way the parent decides what to do with the confirmed {scores,
  total, source, proposed} via the `confirm` event; this component owns
  only the five-tile editor + the calibration side-effect that is common
  to both call sites.
-->
<template>
  <div class="flex flex-col gap-4">
    <ScoreTileGroup
      v-for="cat in FACIAL_CATALOG"
      :key="cat.key"
      :title="cat.title"
      :options="cat.options"
      :model-value="scores[cat.key]"
      :highlight="proposed ? proposed[cat.key] : null"
      @update:model-value="setScore(cat.key, $event)"
    />

    <div class="flex items-center justify-between rounded-xl bg-base-200 px-4 py-3">
      <span class="text-sm font-medium text-primary-700">คะแนนรวม Face Pain Scale</span>
      <span class="text-lg font-semibold text-primary-700">{{ total }}/10</span>
    </div>

    <BaseButton variant="primary" size="lg" block :disabled="!allScored" @click="onConfirm">
      {{ confirmLabel }}
    </BaseButton>
  </div>
</template>

<script setup>
import { computed, reactive, watch } from 'vue'
import { BaseButton, ScoreTileGroup } from '@/components/ui'
import { FACIAL_CATALOG } from '@/domain/facialCatalog.js'
import { useCalibrationStore } from '@/stores/calibrationStore.js'

const props = defineProps({
  // {brow,eyes,noseCheek,mouth,overall}: 0|1|2 — starting scores. In
  // scan-confirm mode this is normally the same as `proposed`.
  initialScores: { type: Object, default: null },
  // {brow,eyes,noseCheek,mouth,overall}: 0|1|2|null — the ML-proposed
  // scores, used for the highlight badge. Null => manual mode.
  proposed: { type: Object, default: null },
  // Per-category {deciles,mean} temporal profiles for this capture. Only
  // present in scan mode; presence is what triggers a calibration sample
  // on confirm (manual mode never has profiles, so never samples).
  profiles: { type: Object, default: null },
  confirmLabel: { type: String, default: 'ยืนยันคะแนน' },
})

const emit = defineEmits(['confirm'])

const calibrationStore = useCalibrationStore()

function freshScores() {
  const base = {}
  for (const cat of FACIAL_CATALOG) {
    base[cat.key] = props.initialScores?.[cat.key] ?? props.proposed?.[cat.key] ?? null
  }
  return base
}

const scores = reactive(freshScores())

// Re-seed whenever this panel is handed a new capture (e.g. "สแกนใหม่").
watch(
  () => [props.initialScores, props.proposed, props.profiles],
  () => Object.assign(scores, freshScores())
)

function setScore(key, value) {
  scores[key] = value
}

const allScored = computed(() => FACIAL_CATALOG.every((cat) => scores[cat.key] !== null))

const total = computed(() =>
  FACIAL_CATALOG.reduce((sum, cat) => sum + (scores[cat.key] ?? 0), 0)
)

function onConfirm() {
  if (!allScored.value) return

  const confirmed = { ...scores }

  // Manual mode has no profiles, so it never contributes a calibration
  // sample (spec: "Manual mode … NO calibration sample").
  if (props.profiles) {
    calibrationStore.addValidation({
      profiles: props.profiles,
      proposed: props.proposed,
      confirmed,
    })
  }

  emit('confirm', {
    scores: confirmed,
    total: total.value,
    source: props.profiles ? 'scan+confirmed' : 'manual',
    proposed: props.proposed ?? null,
  })
}
</script>
