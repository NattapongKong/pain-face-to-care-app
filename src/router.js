import { createRouter, createWebHashHistory } from 'vue-router'
import { usePatientStore } from './stores/patientStore.js'
import { useSyncStore } from './stores/syncStore.js'
import { pullForPatient } from './stores/syncHelpers.js'

const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('./views/HomeView.vue'),
  },
  {
    path: '/assess',
    name: 'assess',
    component: () => import('./views/assess/AssessView.vue'),
  },
  {
    path: '/records',
    name: 'records',
    component: () => import('./views/RecordsView.vue'),
  },
  {
    path: '/records/:id',
    name: 'record-detail',
    component: () => import('./views/RecordDetailView.vue'),
    props: true,
  },
  {
    // Banked neutral-face baseline (spec §7, plan Task 6): a plain route,
    // no params — BaselineView reads the active patient straight from
    // patientStore/syncStore itself, same as every other view here.
    path: '/baseline',
    name: 'baseline',
    component: () => import('./views/BaselineView.vue'),
  },
  {
    // Runtime connect link (spec §2/§3, plan Task 1). Bare `#/connect`
    // shows the current connection (or an unconfigured explanation) plus a
    // share-QR to spread it to the next device; `#/connect?u=<encoded
    // execUrl>` (from the GAS install dialog, OR a share-QR scanned from
    // another device) shows a confirm step that persists the URL as a
    // device-local override via syncStore.applySyncOverride(). Query props
    // (not route params) because the payload is a URL, not a path segment.
    path: '/connect',
    name: 'connect',
    component: () => import('./views/ConnectView.vue'),
    props: (route) => ({ u: route.query.u }),
  },
  {
    // Patient QR link (spec §7): scanning /p/:pid/:token sets the device's
    // patient context, then redirects home. No component of its own — the
    // context switch is a pure side effect, never a page the user sees.
    path: '/p/:pid/:token',
    name: 'patient-link',
    redirect: (to) => {
      const patientStore = usePatientStore()
      patientStore.setContext({ patientId: to.params.pid, token: to.params.token })

      // review round 1 BLOCKER 1(a): a stale PRIOR patient's serverRecords
      // must never survive into the new context, not even for the brief
      // window before the fresh pull below resolves — resetServer() clears
      // them synchronously, immediately. pullForPatient() (review round 2
      // MAJOR N2, src/stores/syncHelpers.js) is the SAME helper main.js's
      // boot chain calls — a hand-duplicated copy here is exactly how the
      // two drifted apart in round 1 (a scanned patient's display name
      // never landing). It awaits init() (idempotent — cheap here whether
      // or not main.js's own boot call already ran it) before pulling, and
      // its pull() carries its own latest-request-wins guard (round 2
      // MAJOR N1) against a stale cross-context write. This is what
      // actually fixes round 1's MAJOR 5 mid-session case too: banner name
      // + server history now load on scan, not just on the next reload.
      const syncStore = useSyncStore()
      syncStore.resetServer()
      pullForPatient(syncStore, patientStore).catch(() => {})

      return { path: '/' }
    },
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
