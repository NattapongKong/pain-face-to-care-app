<script setup>
import AppLayout from './layouts/AppLayout.vue'
import ToastContainer from './components/ui/ToastContainer.vue'
import { useCalibrationStore } from './stores/calibrationStore.js'

// Restore persisted calibration before any route renders — a /assess deep link
// must score with the calibrated thresholds, not the defaults (spec §5.4).
useCalibrationStore().init()
</script>

<template>
  <AppLayout>
    <router-view />
  </AppLayout>
  <ToastContainer />
</template>
