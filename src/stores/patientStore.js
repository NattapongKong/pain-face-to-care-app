// Pinia store holding the QR-delivered per-patient device context (spec
// §7). A device "links" to one patient by scanning `/p/:pid/:token`
// (router.js sets the context here, then redirects home); the link
// persists across reloads — PWA phones scan once — until ออกจากผู้ป่วย
// calls clear(), which returns the device to unlinked, local-only
// behavior. No domain/repository.js dependency: this store owns its own
// localStorage key directly, the same self-contained idiom src/sync/
// config.js and outbox.js already use for their own storage keys.

import { defineStore } from 'pinia'

const STORAGE_KEY = 'painface.patient.v1'

function isValidContext(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.patientId === 'string' &&
    value.patientId.length > 0 &&
    typeof value.token === 'string' &&
    value.token.length > 0
  )
}

// Fix round (deferred minor): a tampered/hand-edited localStorage blob must
// not hand a garbage-shaped bed/baseline downstream — a non-string bed or
// an array/primitive "baseline" would become a garbage subtraction vector
// in the scan layer. Same defenses syncStore.pull() already applies to the
// wire payload, applied here to the local hydration path too.
function sanitizeBed(value) {
  return typeof value === 'string' ? value : ''
}

function sanitizeBaseline(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function readContext() {
  let raw
  try {
    raw = globalThis.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null || raw === undefined) return null
  try {
    const parsed = JSON.parse(raw)
    return isValidContext(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeContext(context) {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(context))
  } catch {
    // Best-effort persistence only (matches sync/outbox.js's stance): a
    // full/quota-exceeded localStorage must not throw out of the store —
    // in-memory state for the rest of this session is still correct even
    // if it fails to survive a reload.
  }
}

function clearContext() {
  try {
    globalThis.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // best-effort, see writeContext above
  }
}

export const usePatientStore = defineStore('patient', {
  state: () => {
    const saved = readContext()
    return {
      patientId: saved?.patientId ?? null,
      token: saved?.token ?? null,
      displayName: saved?.displayName ?? '',
      // Round-2 additions (spec §5): a pre-round-2 persisted blob simply
      // lacks these keys, so `saved?.bed`/`saved?.baseline` read `undefined`
      // and fall through to the same defaults a brand-new context gets.
      // sanitizeBed/sanitizeBaseline additionally cover a TAMPERED blob
      // (wrong-shaped value present, not merely absent).
      bed: sanitizeBed(saved?.bed),
      baseline: sanitizeBaseline(saved?.baseline),
    }
  },

  getters: {
    linked: (state) => !!(state.patientId && state.token),
  },

  actions: {
    /**
     * Sets the active patient context from a scanned `/p/:pid/:token` link.
     * Always resets `displayName`/`bed`/`baseline` — even when re-linking to
     * the SAME id — because none of the three is trustworthy until the next
     * `pull()` for THIS context resolves; carrying old values forward across
     * a setContext() call risks showing stale (or, after a device is handed
     * to a different patient, WRONG) data for the brief window before that.
     * @param {{patientId:string, token:string}} ctx
     */
    setContext({ patientId, token }) {
      this.patientId = patientId
      this.token = token
      this.displayName = ''
      this.bed = ''
      this.baseline = null
      writeContext({ patientId, token, displayName: '', bed: '', baseline: null })
    },

    /**
     * Persists displayName/bed/baseline resolved from the server (spec
     * §5/§7). This is the ONE place server-derived patient context lands in
     * this store — syncHelpers.pullForPatient is the ONE call site (R35).
     * The baseline is stored as a SHALLOW COPY (fix round, deferred minor):
     * the caller passes syncStore.serverBaseline directly, and without a
     * copy this store's `baseline` would be the exact same object
     * reference — mutating one would silently mutate the other. The banked
     * vector handed to the scan layer must never alias syncStore state.
     * @param {{displayName:string, bed:string, baseline:object|null}} info
     */
    applyServerInfo({ displayName, bed, baseline }) {
      const safeBaseline = baseline ? { ...baseline } : baseline
      this.displayName = displayName
      this.bed = bed
      this.baseline = safeBaseline
      if (!this.linked) return
      writeContext({ patientId: this.patientId, token: this.token, displayName, bed, baseline: safeBaseline })
    },

    /**
     * Local write-through after a successful `saveBaselineRemote` (spec
     * §7). Leaves displayName/bed untouched — this only ever changes the
     * banked baseline vector.
     * @param {object} vector
     */
    setBaseline(vector) {
      this.baseline = vector
      if (!this.linked) return
      writeContext({
        patientId: this.patientId,
        token: this.token,
        displayName: this.displayName,
        bed: this.bed,
        baseline: vector,
      })
    },

    /** ออกจากผู้ป่วย — returns the device to unlinked, local-only behavior. */
    clear() {
      this.patientId = null
      this.token = null
      this.displayName = ''
      this.bed = ''
      this.baseline = null
      clearContext()
    },
  },
})
