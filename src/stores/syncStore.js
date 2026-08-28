// Pinia store wiring the runtime sync config, the offline outbox, and the
// GAS client together (spec §6). When no sync URL is configured, every
// action is a safe zero-fetch no-op — the app behaves exactly as it does
// today (spec §1, §12) with nothing dead half-wired in.
//
// Review round 1 rulings folded in here:
// - MAJOR 2: no sync action may ever reject/throw out to a caller (the
//   sync layer is additive and must never break local-only finalize/save).
//   Storage-write failures surface as the observable `storageFailed` flag
//   instead (sticky for the store's lifetime — a real failure must not be
//   silently forgotten by a later unrelated success).
// - minor 5: enqueueRecord/pull guard an invalid context (missing
//   patientId/token) BEFORE anything else — an unlinked record must never
//   reach the outbox (spec §8).
// - minor 6: init() is idempotent (an `initialized` guard) so listeners are
//   never attached twice, and skips the boot-time flush attempt while
//   offline.
// - minor 7: pull() defends against a malformed (non-array) records
//   payload / non-string displayName.
//
// Review round 2 rulings folded in here:
// - MAJOR 1: enqueueRecord no longer awaits its own flush attempt — a
//   wedged/slow request must not stall the promise the caller (e.g.
//   assessmentStore.finalize()) is awaiting. The flush is fired and
//   forgotten (its own internal try/catch plus outbox.flush()'s
//   never-rejects contract make the trailing .catch() a pure belt-and-
//   braces); the eventual sent/failed outcome still reaches state via
//   pendingCount/synced, just asynchronously.
//
// Review round 3 rulings folded in here:
// - minor 2: init()'s own backlog flush is ALSO fire-and-forget now — the
//   last caller-visible network wait in this store is gone; init() resolves
//   as soon as config + listener setup is done, never waiting on a request.
// - minor 6: flush() returns {sent:[], failed:[]} even when unconfigured,
//   so its return shape is consistent regardless of the guard clause.
//
// App-integration review round 1 ruling folded in here:
// - MINOR 6: `lastFlushAt` is bumped at the end of every ATTEMPTED flush
//   pass, success OR failure — unlike `lastSyncAt` (only bumped when
//   something was actually sent), this exists purely so UI code (e.g.
//   RecordsView's per-record sync chips) has a dependency that reliably
//   changes on every pass, even one that fails without changing the
//   OUTBOX'S LENGTH (e.g. an item's attempts/lastError updates in place) —
//   `pendingCount` alone would under-trigger there, since Vue's reactivity
//   never retriggers dependents on a same-value write.
//
// App-integration review round 2 ruling folded in here:
// - MAJOR N1(a): `pullSeq` makes pull() latest-request-wins — a probe
//   proved that an OLDER pull (context A) settling AFTER a NEWER one
//   (context B) could overwrite serverRecords/serverDisplayName/authFailed
//   with A's stale response, a real cross-patient leak (A's name rendered
//   AND persisted under B). Bumped before the request goes out; whichever
//   call's await settles checks it still owns the CURRENT seq before
//   touching any state, on every settle path (success, unauthorized, any
//   other error) — a superseded response is discarded outright, not merged.
//
// Plan Task 2 / spec §5 ruling folded in here:
// - `serverBed`/`serverBaseline` join `serverDisplayName` as server-derived
//   state: same malformed-payload defenses (minor 7's stance extended —
//   non-string bed / non-plain-object baseline default rather than throw),
//   same pullSeq latest-request-wins discard rules (N1a), and the same
//   resetServer() clearing.
//
// Round 4 Task 1 (client self-install, spec §2/§3) ruling folded in here:
// - A device-local override (localStorage key `painface.syncUrl.override.v1`,
//   set via the #/connect flow) now sits ABOVE sync-config.json in the
//   precedence order: `init()` checks it FIRST and, only when it is absent
//   or fails validation, falls back to the file value — the exact same
//   `configured`/`syncUrl` computation as before this task, so a device
//   with NO override present is byte-identical to today (the regression
//   pin). `fileSyncUrl` remembers the file's own value (as loaded at
//   init()) purely so `clearSyncOverride()` can revert to it synchronously,
//   in the same session, without an async reload/refetch of
//   sync-config.json. `syncSource` ('override'|'file'|null) tells a
//   consumer (ConnectView) WHICH one is currently live, since `syncUrl`/
//   `configured` alone can't distinguish them.
// - `applySyncOverride`/`clearSyncOverride` never throw, matching every
//   other action in this store — a full/quota-exceeded localStorage write
//   sets the sticky `storageFailed` flag (MAJOR 2's stance) rather than
//   rejecting, and THIS call's own in-memory syncUrl/configured/syncSource
//   update synchronously regardless of whether the write landed. Fix round
//   1 minor 10 (comment accuracy — this used to over-promise): that
//   guarantee is scoped to THIS call. If `init()` is still in flight when
//   the write fails (its own `readSyncOverride()` read happens only after
//   awaiting `loadSyncConfig()`), init()'s later completion can still
//   overwrite this call's in-memory result with whatever was last durably
//   persisted. In practice unreachable: #/connect (the only caller of
//   these two actions) is only reachable once the app's boot-time init()
//   call has already resolved.
//
// Fix round 1 rulings folded in here (R4-T1 Opus review):
// - MAJOR 1: `applySyncOverride`/`clearSyncOverride` now call
//   `resetServer()` whenever the EFFECTIVE syncUrl actually changes —
//   without this, database-A's serverRecords/serverDisplayName/serverBed/
//   serverBaseline/authFailed kept rendering after repointing the device
//   at database B (same rationale resetServer()'s own doc already states:
//   "a stale context's rows never survive"). Re-applying the SAME url is a
//   deliberate no-op here (urlChanged guards it) — nothing to discard.
// - MAJOR 2 / LEAD RULING R45 (binding): a non-empty outbox must never be
//   re-targeted at a different backend — queued items carry
//   patientId+token+record PHI, and the new backend answers `unauthorized`
//   for them (a terminal, non-network verdict), so they would retry
//   forever without ever landing. `wouldOrphanPending` (getter, below) is
//   the single source of truth for the guard; both actions refuse outright
//   (mutating nothing — not even storageFailed) when it holds. Accepted
//   limitation (ledgered by the lead): abandoning a permanently
//   unreachable OLD backend requires the pending records to be
//   cleared/synced first — there is no other escape hatch.

import { defineStore } from 'pinia'
import * as repository from '../domain/repository.js'
import * as outbox from '../sync/outbox.js'
import { loadSyncConfig } from '../sync/config.js'
import { fetchMyScores, SyncError } from '../sync/client.js'

const SYNC_OVERRIDE_KEY = 'painface.syncUrl.override.v1'

function hasContext(ctx) {
  return !(!ctx || !ctx.patientId || !ctx.token)
}

/** A plain, non-array object — the shape a banked baseline vector must have. */
function isPlainBaseline(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The only shape a real Apps Script web-app deployment exec URL ever takes
 * (spec §2/§3, plan Task 1). Exported alongside the store so ConnectView can
 * pre-flight a `?u=` link (honest "malformed" copy) without duplicating this
 * rule, and so the check is defined exactly once.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidSyncUrl(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('https://script.google.com/macros/') &&
    value.endsWith('/exec')
  )
}

function readSyncOverride() {
  try {
    return globalThis.localStorage.getItem(SYNC_OVERRIDE_KEY)
  } catch {
    return null
  }
}

export const useSyncStore = defineStore('sync', {
  state: () => ({
    syncUrl: '',
    configured: false,
    // Round 4 Task 1: which source `syncUrl`/`configured` currently reflect
    // — 'override' (localStorage, set via #/connect), 'file'
    // (sync-config.json), or null (unconfigured, neither present).
    syncSource: null,
    // The raw sync-config.json value as loaded at init() — kept so
    // clearSyncOverride() can revert to it synchronously, without an async
    // refetch. Fix round 1 MAJOR 2 (R45): ConnectView also reads this
    // directly to compute whether "ยกเลิกการเชื่อมต่อ" would repoint a
    // non-empty outbox at the file's backend (wouldOrphanPending(fileSyncUrl))
    // — it IS part of the read surface now, not purely internal bookkeeping.
    fileSyncUrl: '',
    online: true,
    pendingCount: 0,
    lastSyncAt: null,
    lastFlushAt: null,
    serverRecords: [],
    serverDisplayName: '',
    serverBed: '',
    serverBaseline: null,
    authFailed: false,
    storageFailed: false,
    initialized: false,
    pullSeq: 0,
  }),

  getters: {
    /**
     * LEAD RULING R45 (binding, fix round 1 MAJOR 2): true when switching
     * the EFFECTIVE syncUrl to `newUrl` would repoint a non-empty outbox
     * at a different backend. `applySyncOverride`/`clearSyncOverride` are
     * the actual enforcement (they refuse outright — mutating nothing —
     * when this holds); ConnectView also calls this directly so it can
     * render the blocked state BEFORE ever offering a confirm/ยกเลิก
     * button that would otherwise silently no-op on click (no-dead-
     * features stance).
     * @returns {(newUrl:string) => boolean}
     */
    wouldOrphanPending: (state) => (newUrl) => state.configured && newUrl !== state.syncUrl && state.pendingCount > 0,
  },

  actions: {
    /**
     * Loads the runtime config, seeds pendingCount from the outbox, wires
     * up online/offline listeners ONCE (guarded for non-DOM test/SSR
     * environments), and attempts one flush if configured AND online.
     * Safe to call more than once — every call after the first is a no-op.
     *
     * Round 4 Task 1 precedence: a VALID localStorage override
     * (`painface.syncUrl.override.v1`, set via #/connect) wins over
     * sync-config.json; an absent or invalid-shaped override falls through
     * to the file value exactly as before this task — the regression pin
     * (no override present -> byte-identical to today).
     */
    async init() {
      if (this.initialized) return
      this.initialized = true

      let config
      try {
        config = await loadSyncConfig()
      } catch {
        config = { syncUrl: '' }
      }
      this.fileSyncUrl = config.syncUrl

      const override = readSyncOverride()
      if (isValidSyncUrl(override)) {
        this.syncUrl = override
        this.configured = true
        this.syncSource = 'override'
      } else {
        this.syncUrl = config.syncUrl
        this.configured = !!config.syncUrl
        this.syncSource = this.configured ? 'file' : null
      }
      this.pendingCount = outbox.pending().length

      if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
        this.online = navigator.onLine
      }

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('online', () => {
          this.online = true
          // Returning the promise lets a caller await it (useful in
          // tests); the .catch keeps it from ever surfacing as an
          // unhandled rejection when nobody does.
          return this.flush().catch(() => {})
        })
        window.addEventListener('offline', () => {
          this.online = false
        })
      }

      if (this.configured && this.online) {
        // Round 3 minor 2: fire-and-forget, same rationale as
        // enqueueRecord (round 2 MAJOR 1) — init() must resolve as soon as
        // config + listeners are set up, never waiting on a network round
        // trip. The backlog's sent/failed outcome still reaches state via
        // pendingCount/synced, just asynchronously.
        this.flush().catch(() => {})
      }
    },

    /**
     * Validates and applies a new sync URL (spec §2/§3, plan Task 1 — the
     * #/connect confirm action). Takes effect immediately, THIS session, no
     * reload needed, and persists to localStorage so it survives future
     * `init()` calls. Never throws: an unwritable localStorage (full/quota-
     * exceeded) still applies the override in memory for this session and
     * surfaces via the existing sticky `storageFailed` flag, same stance as
     * every other storage write in this store. Fix round 1 MAJOR 2 (R45):
     * refuses outright — mutating nothing — when `wouldOrphanPending(url)`
     * holds. Fix round 1 MAJOR 1: when the effective syncUrl actually
     * changes, clears server-derived state via `resetServer()` so a stale
     * backend's rows never survive the switch; re-applying the SAME url is
     * a deliberate no-op (nothing to discard). Fix round 2 minor 1: the
     * FIRST thing this does is re-mirror `pendingCount` from the outbox's
     * own live length — another tab/PWA window can enqueue into the SAME
     * shared outbox storage without this store instance's in-memory
     * mirror ever seeing it, which would otherwise let the R45 guard below
     * check a stale (too-low, possibly zero) count and silently pass.
     * @param {string} url
     * @returns {{ok:true}|{ok:false, reason:'invalid-url'}|{ok:false, reason:'pending', count:number}}
     */
    applySyncOverride(url) {
      this.pendingCount = outbox.pending().length
      if (!isValidSyncUrl(url)) return { ok: false, reason: 'invalid-url' }
      if (this.wouldOrphanPending(url)) return { ok: false, reason: 'pending', count: this.pendingCount }

      const urlChanged = url !== this.syncUrl

      try {
        globalThis.localStorage.setItem(SYNC_OVERRIDE_KEY, url)
      } catch {
        this.storageFailed = true
      }

      this.syncUrl = url
      this.configured = true
      this.syncSource = 'override'
      if (urlChanged) this.resetServer()
      return { ok: true }
    },

    /**
     * Clears a device-local override and reverts to the sync-config.json
     * value loaded at `init()` (spec §2, plan Task 1) — synchronously, in
     * the same session, no reload. Safe to call even when there was never
     * an override applied (a no-op revert to the current file value — the
     * effective syncUrl doesn't change, so the R45/resetServer machinery
     * below never fires). Fix round 1 MAJOR 2 (R45): refuses outright —
     * mutating nothing — when `wouldOrphanPending(fileSyncUrl)` holds (the
     * revert would repoint a non-empty outbox at the file's backend). Fix
     * round 1 MAJOR 1: when the effective syncUrl actually changes, clears
     * server-derived state via `resetServer()`. Fix round 2 minor 1: same
     * live re-mirror of `pendingCount` as applySyncOverride, first thing —
     * see that action's doc for why (a second tab/window can leave the
     * in-memory mirror stale).
     * @returns {{ok:true}|{ok:false, reason:'pending', count:number}}
     */
    clearSyncOverride() {
      this.pendingCount = outbox.pending().length
      if (this.wouldOrphanPending(this.fileSyncUrl)) return { ok: false, reason: 'pending', count: this.pendingCount }

      const urlChanged = this.fileSyncUrl !== this.syncUrl

      try {
        globalThis.localStorage.removeItem(SYNC_OVERRIDE_KEY)
      } catch {
        this.storageFailed = true
      }

      this.syncUrl = this.fileSyncUrl
      this.configured = !!this.fileSyncUrl
      this.syncSource = this.configured ? 'file' : null
      if (urlChanged) this.resetServer()
      return { ok: true }
    },

    /**
     * Queues one assessment (replacing any not-yet-sent copy of the same
     * record — latest state wins) and kicks a flush attempt WITHOUT
     * waiting for it to settle (round 2 MAJOR 1) — a wedged/slow request
     * must not stall the caller. On ack the local record is stamped
     * `synced: true`; on failure the item stays queued for the next flush
     * trigger; either way that outcome reaches state (pendingCount/synced)
     * asynchronously, after this call has already resolved. A safe no-op
     * — the outbox is never touched — when unconfigured OR when `ctx`
     * doesn't carry a real patientId/token (spec §8: unlinked records
     * never sync).
     * @param {{patientId:string, token:string}} ctx
     * @param {object} record
     */
    async enqueueRecord(ctx, record) {
      if (!hasContext(ctx)) return
      if (!this.configured) return

      outbox.enqueue({
        recordId: record.id,
        patientId: ctx.patientId,
        token: ctx.token,
        record,
        queuedAt: new Date().toISOString(),
        attempts: 0,
      })
      this.storageFailed = this.storageFailed || !outbox.storageOk()
      this.pendingCount = outbox.pending().length
      // Fire-and-forget: outbox.flush() (and this.flush() around it) is
      // designed to never reject, so the .catch() here is a pure
      // last-resort guard, not the primary safety net.
      this.flush().catch(() => {})
    },

    /**
     * Attempts to send every queued item. Acked records are stamped
     * `synced: true` in the local repository; failures stay queued. Never
     * rejects, and always resolves to the same {sent, failed} shape
     * (round 3 minor 6) — including the unconfigured no-op case, so
     * callers never need to special-case an `undefined` return. Every
     * ATTEMPTED pass (this early unconfigured no-op excluded) bumps
     * `lastFlushAt` regardless of outcome (app-integration review round 1
     * MINOR 6).
     * @returns {Promise<{sent:string[], failed:string[]}>}
     */
    async flush() {
      if (!this.configured) return { sent: [], failed: [] }

      let result
      try {
        result = await outbox.flush(this.syncUrl)
      } catch {
        // outbox.flush() is designed to never reject; this is a
        // last-resort guard so the sync layer can never break the
        // caller's flow.
        result = { sent: [], failed: [] }
      }

      for (const recordId of result.sent) {
        try {
          repository.updateRecord(recordId, { synced: true })
        } catch {
          this.storageFailed = true
        }
      }

      this.storageFailed = this.storageFailed || !outbox.storageOk()
      this.pendingCount = outbox.pending().length
      // MINOR 6: bumped for every attempted pass, sent or failed — see the
      // module-level comment. lastSyncAt (below) stays success-only.
      this.lastFlushAt = new Date().toISOString()
      if (result.sent.length > 0) {
        this.lastSyncAt = new Date().toISOString()
      }
      return result
    },

    /**
     * Pulls the authenticated patient's server-side records (plus bed/
     * baseline, plan Task 2). A revoked or mistyped QR (unauthorized) sets
     * `authFailed` rather than throwing — a junk QR must not brick the app.
     * A safe no-op when unconfigured OR when `ctx` doesn't carry a real
     * patientId/token. Latest-request-wins (review round 2 MAJOR N1a): a
     * response that settles after a NEWER `pull()` call has already started
     * is discarded entirely, on every settle path — it never touches
     * serverRecords/serverDisplayName/serverBed/serverBaseline/authFailed.
     *
     * Fix round (MAJOR): returns a boolean about RESPONSE OWNERSHIP — true
     * ONLY when THIS call's settle actually wrote server* state (i.e. it
     * was not superseded AND the request succeeded); false on every guard/
     * superseded/unauthorized/network-failure path. This says nothing about
     * WHICH patient (context-agnostic, R35 holds) — it is the caller's job
     * (syncHelpers) to also confirm the context hasn't moved on. Callers
     * must use this, not `serverDisplayName` truthiness, to decide whether
     * server* actually reflects a fresh success — stale server* values from
     * an earlier successful pull are never cleared by a later FAILED pull,
     * so truthiness of old data would otherwise look like a live success.
     * @param {{patientId:string, token:string}} ctx
     * @returns {Promise<boolean>}
     */
    async pull(ctx) {
      if (!hasContext(ctx)) return false
      if (!this.configured) return false

      const seq = ++this.pullSeq

      try {
        const res = await fetchMyScores(this.syncUrl, { patientId: ctx.patientId, token: ctx.token })
        if (seq !== this.pullSeq) return false // superseded by a newer pull -- discard entirely
        this.serverRecords = Array.isArray(res.records) ? res.records : []
        this.serverDisplayName = String(res.displayName ?? '')
        this.serverBed = typeof res.bed === 'string' ? res.bed : ''
        this.serverBaseline = isPlainBaseline(res.baseline) ? res.baseline : null
        this.lastSyncAt = new Date().toISOString()
        this.authFailed = false
        return true
      } catch (err) {
        if (seq !== this.pullSeq) return false // superseded -- discard entirely, including authFailed
        if (err instanceof SyncError && err.code === 'unauthorized') {
          this.authFailed = true
        }
        return false
      }
    },

    /** Clears server-derived state — called on context switch/unlink so a stale context's rows never survive. */
    resetServer() {
      // Supersede any pull still in flight: without this, a response landing
      // after the unlink would repopulate the cleared fields (and could raise
      // a stale authFailed alert) for a context that no longer exists.
      this.pullSeq += 1
      this.serverRecords = []
      this.serverDisplayName = ''
      this.serverBed = ''
      this.serverBaseline = null
      this.authFailed = false
    },
  },
})
