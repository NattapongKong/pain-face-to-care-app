import './style.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router.js'
import { registerPainfacePwa } from './pwa.js'
import { usePatientStore } from './stores/patientStore.js'
import { useSyncStore } from './stores/syncStore.js'
import { pullForPatient } from './stores/syncHelpers.js'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')
registerPainfacePwa()

// Boot sync (spec §6, §7). pullForPatient() (src/stores/syncHelpers.js) is
// the SAME helper router.js's /p/:pid/:token handler calls after a fresh
// scan — a hand-duplicated copy of this chain here is exactly how the two
// drifted apart in review round 1 (a scanned patient's display name never
// landing). It always awaits syncStore.init() first (idempotent, so this is
// cheap even when the /p route handler already ran it), which initializes
// sync regardless of link state, then pulls + persists the display name
// only if this device is currently linked. Fire-and-forget: a boot-time
// sync hiccup (offline, revoked QR, wedged deployment) must never block or
// break the app shell mounted above.
const patientStore = usePatientStore()
const syncStore = useSyncStore()

pullForPatient(syncStore, patientStore).catch(() => {})

// review round 1 MAJOR 5b (lead ruling): syncStore itself stays patient-
// context-agnostic (it has no idea what a "patient" is), so a boot pull
// that fails/skips because the device came up offline had nothing to
// retry it later — this device-level listener is the retry, via the same
// shared helper. Guarded for non-DOM environments (tests, SSR) the same
// way syncStore's own online/offline listeners are.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => {
    pullForPatient(syncStore, patientStore).catch(() => {})
  })
}
