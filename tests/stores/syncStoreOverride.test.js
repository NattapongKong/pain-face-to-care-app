// R4 Task 1 (client self-install, spec §2/§3, plan T1): syncStore's
// device-local override — a localStorage-backed connect URL that outranks
// sync-config.json. Companion to tests/sync/syncStore.test.js (the
// pre-existing config/outbox/pull suite, untouched by this task) — kept in
// its own file per the plan's file-ownership split (`tests/stores/
// syncStore*.test.js additions`).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSyncStore, isValidSyncUrl } from '../../src/stores/syncStore.js'
import { enqueue, __resetOutbox } from '../../src/sync/outbox.js'

const FILE_URL = 'https://script.google.com/macros/s/file-deploy-id/exec'
const OVERRIDE_URL = 'https://script.google.com/macros/s/override-deploy-id/exec'
const OVERRIDE_KEY = 'painface.syncUrl.override.v1'

/** Config fetch only — no outbox/pull traffic exercised by any test here. */
function stubConfigFetch(configSyncUrl = FILE_URL) {
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ syncUrl: configSyncUrl }) }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetOutbox()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks() // undoes the localStorage.setItem spy from the storage-failure test below
  __resetOutbox()
})

describe('syncStore — isValidSyncUrl', () => {
  it('accepts a real Apps Script web-app exec URL', () => {
    expect(isValidSyncUrl(OVERRIDE_URL)).toBe(true)
  })

  it('rejects http (not https)', () => {
    expect(isValidSyncUrl('http://script.google.com/macros/s/x/exec')).toBe(false)
  })

  it('rejects a non-google host', () => {
    expect(isValidSyncUrl('https://evil.example.com/macros/s/x/exec')).toBe(false)
  })

  it('rejects a URL missing the /exec suffix (e.g. a /dev deployment)', () => {
    expect(isValidSyncUrl('https://script.google.com/macros/s/x/dev')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidSyncUrl('')).toBe(false)
  })

  it('rejects non-string values without throwing', () => {
    expect(isValidSyncUrl(null)).toBe(false)
    expect(isValidSyncUrl(undefined)).toBe(false)
    expect(isValidSyncUrl(42)).toBe(false)
  })
})

describe('syncStore — applySyncOverride', () => {
  it('a valid URL is accepted, applied immediately, and persisted to localStorage', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()

    const result = store.applySyncOverride(OVERRIDE_URL)

    expect(result).toEqual({ ok: true })
    expect(store.syncUrl).toBe(OVERRIDE_URL)
    expect(store.configured).toBe(true)
    expect(store.syncSource).toBe('override')
    expect(globalThis.localStorage.getItem(OVERRIDE_KEY)).toBe(OVERRIDE_URL)
  })

  it.each([
    ['http (not https)', 'http://script.google.com/macros/s/x/exec'],
    ['non-google host', 'https://evil.example.com/macros/s/x/exec'],
    ['missing /exec', 'https://script.google.com/macros/s/x/dev'],
    ['empty string', ''],
  ])('rejects an invalid URL (%s) — {ok:false, reason:"invalid-url"}, no state change, nothing persisted', async (_label, badUrl) => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    const urlBefore = store.syncUrl
    const sourceBefore = store.syncSource

    const result = store.applySyncOverride(badUrl)

    expect(result).toEqual({ ok: false, reason: 'invalid-url' })
    expect(store.syncUrl).toBe(urlBefore)
    expect(store.syncSource).toBe(sourceBefore)
    expect(globalThis.localStorage.getItem(OVERRIDE_KEY)).toBeNull()
  })

  // MAJOR 2 stance (module doc): storage-write failures never throw/reject
  // out of an action — they surface via the existing sticky storageFailed
  // flag, and the in-memory override still applies for this session.
  it('a localStorage write failure still applies the override in memory and sets storageFailed, without throwing', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    expect(store.storageFailed).toBe(false)

    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      const err = new Error('quota exceeded')
      err.name = 'QuotaExceededError'
      throw err
    })

    expect(() => store.applySyncOverride(OVERRIDE_URL)).not.toThrow()
    expect(store.syncUrl).toBe(OVERRIDE_URL)
    expect(store.configured).toBe(true)
    expect(store.syncSource).toBe('override')
    expect(store.storageFailed).toBe(true)
  })
})

describe('syncStore — override precedence over sync-config.json (spec §2)', () => {
  it('init() picks a pre-existing valid override over the file value', async () => {
    globalThis.localStorage.setItem(OVERRIDE_KEY, OVERRIDE_URL)
    stubConfigFetch(FILE_URL)

    const store = useSyncStore()
    await store.init()

    expect(store.syncUrl).toBe(OVERRIDE_URL)
    expect(store.configured).toBe(true)
    expect(store.syncSource).toBe('override')
  })

  it('an invalid/malformed override sitting in localStorage is ignored — init() falls through to the file value', async () => {
    globalThis.localStorage.setItem(OVERRIDE_KEY, 'not-a-real-url')
    stubConfigFetch(FILE_URL)

    const store = useSyncStore()
    await store.init()

    expect(store.syncUrl).toBe(FILE_URL)
    expect(store.configured).toBe(true)
    expect(store.syncSource).toBe('file')
  })

  it('persists across a fresh store re-init (simulated reload): a second store instance in a new pinia picks up the override from localStorage', async () => {
    stubConfigFetch(FILE_URL)
    const first = useSyncStore()
    await first.init()
    first.applySyncOverride(OVERRIDE_URL)
    expect(first.syncUrl).toBe(OVERRIDE_URL)

    // Simulate a fresh page load: new pinia, new store instance, but the
    // SAME localStorage (nothing about applySyncOverride is in-memory-only).
    setActivePinia(createPinia())
    stubConfigFetch(FILE_URL)
    const second = useSyncStore()
    await second.init()

    expect(second.syncUrl).toBe(OVERRIDE_URL)
    expect(second.configured).toBe(true)
    expect(second.syncSource).toBe('override')
  })
})

describe('syncStore — clearSyncOverride', () => {
  it('reverts to the sync-config.json value loaded at init(), synchronously, and removes the localStorage key', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    store.applySyncOverride(OVERRIDE_URL)
    expect(store.syncUrl).toBe(OVERRIDE_URL)

    store.clearSyncOverride()

    expect(store.syncUrl).toBe(FILE_URL)
    expect(store.configured).toBe(true)
    expect(store.syncSource).toBe('file')
    expect(globalThis.localStorage.getItem(OVERRIDE_KEY)).toBeNull()
  })

  it('reverts to unconfigured when there was never a file config either', async () => {
    stubConfigFetch('')
    const store = useSyncStore()
    await store.init()
    store.applySyncOverride(OVERRIDE_URL)
    expect(store.configured).toBe(true)

    store.clearSyncOverride()

    expect(store.syncUrl).toBe('')
    expect(store.configured).toBe(false)
    expect(store.syncSource).toBeNull()
  })

  it('is a safe no-op when there was never an override applied', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()

    expect(() => store.clearSyncOverride()).not.toThrow()
    expect(store.syncUrl).toBe(FILE_URL)
    expect(store.syncSource).toBe('file')
  })
})

// Regression pin (plan T1 / global constraint): a device with NO override in
// localStorage must behave byte-identically to today — configured/syncUrl
// driven purely by sync-config.json, exactly as tests/sync/syncStore.test.js
// already pins for the pre-Round-4 store.
describe('syncStore — no-override regression pin', () => {
  it('configured device (file syncUrl present): syncUrl/configured/syncSource come from the file alone', async () => {
    expect(globalThis.localStorage.getItem(OVERRIDE_KEY)).toBeNull() // sanity: setup.js clears storage per test
    stubConfigFetch(FILE_URL)

    const store = useSyncStore()
    await store.init()

    expect(store.syncUrl).toBe(FILE_URL)
    expect(store.configured).toBe(true)
    expect(store.syncSource).toBe('file')
  })

  it('unconfigured device (no file syncUrl either): local-only, exactly as before this task', async () => {
    stubConfigFetch('')

    const store = useSyncStore()
    await store.init()

    expect(store.syncUrl).toBe('')
    expect(store.configured).toBe(false)
    expect(store.syncSource).toBeNull()
  })
})

// Fix round 1 MAJOR 1 (Opus review): applySyncOverride/clearSyncOverride
// must clear server-derived state whenever the EFFECTIVE syncUrl actually
// changes — otherwise database-A's rows keep rendering after repointing at
// database B. No reset when the url is unchanged (nothing to discard).
describe('syncStore — resetServer on backend switch (fix round 1 MAJOR 1)', () => {
  function seedServerState(store) {
    store.serverRecords = [{ id: 'r1' }]
    store.serverDisplayName = 'สมชาย'
    store.serverBed = '5A'
    store.serverBaseline = { browDownLeft: 0.2 }
    store.authFailed = true
  }

  it('applySyncOverride to a DIFFERENT url clears server-derived state', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    seedServerState(store)

    store.applySyncOverride(OVERRIDE_URL)

    expect(store.serverRecords).toEqual([])
    expect(store.serverDisplayName).toBe('')
    expect(store.serverBed).toBe('')
    expect(store.serverBaseline).toBeNull()
    expect(store.authFailed).toBe(false)
  })

  it('applySyncOverride to the SAME url does not call resetServer — server state is left untouched', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    store.applySyncOverride(OVERRIDE_URL) // first switch: url actually changes, resets (irrelevant to this pin)
    seedServerState(store)
    const resetSpy = vi.spyOn(store, 'resetServer')

    store.applySyncOverride(OVERRIDE_URL) // re-apply the SAME url

    expect(resetSpy).not.toHaveBeenCalled()
    expect(store.serverRecords).toEqual([{ id: 'r1' }])
    expect(store.authFailed).toBe(true)
  })

  it('clearSyncOverride to a DIFFERENT file url clears server-derived state', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    store.applySyncOverride(OVERRIDE_URL)
    seedServerState(store)

    store.clearSyncOverride()

    expect(store.serverRecords).toEqual([])
    expect(store.serverDisplayName).toBe('')
    expect(store.serverBed).toBe('')
    expect(store.serverBaseline).toBeNull()
    expect(store.authFailed).toBe(false)
  })

  it('clearSyncOverride when there was never an override (fileSyncUrl already == syncUrl) does not call resetServer', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    seedServerState(store)
    const resetSpy = vi.spyOn(store, 'resetServer')

    store.clearSyncOverride()

    expect(resetSpy).not.toHaveBeenCalled()
    expect(store.serverRecords).toEqual([{ id: 'r1' }])
    expect(store.authFailed).toBe(true)
  })
})

// Fix round 1 MAJOR 2 / LEAD RULING R45 (binding, Opus review): a non-empty
// outbox must never be re-targeted at a different backend. Both actions
// refuse outright — mutating NOTHING, not even storageFailed — via the
// shared wouldOrphanPending() getter.
describe('syncStore — R45: refuse re-targeting a non-empty outbox at a different backend (fix round 1 MAJOR 2)', () => {
  // Fix round 2 minor 1: pendingCount is re-mirrored from the outbox's own
  // live length as the FIRST line of both actions now — seeded here via
  // the real enqueue() (not a hand-set store.pendingCount) so this pin
  // covers that live re-mirror too, not just the guard's comparison logic.
  it('applySyncOverride refuses when pendingCount > 0 and the url differs from the current syncUrl', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    enqueue({ recordId: 'r1', patientId: 'P-1', token: 'tok', record: { id: 'r1' }, queuedAt: '2026-08-25T09:00:00.000Z', attempts: 0 })
    enqueue({ recordId: 'r2', patientId: 'P-1', token: 'tok', record: { id: 'r2' }, queuedAt: '2026-08-25T09:00:00.000Z', attempts: 0 })
    enqueue({ recordId: 'r3', patientId: 'P-1', token: 'tok', record: { id: 'r3' }, queuedAt: '2026-08-25T09:00:00.000Z', attempts: 0 })

    const result = store.applySyncOverride(OVERRIDE_URL)

    expect(result).toEqual({ ok: false, reason: 'pending', count: 3 })
    expect(store.syncUrl).toBe(FILE_URL) // untouched
    expect(store.syncSource).toBe('file')
    expect(globalThis.localStorage.getItem(OVERRIDE_KEY)).toBeNull() // never persisted
  })

  it('applySyncOverride still succeeds when pendingCount > 0 but the url is UNCHANGED (same backend, nothing orphaned)', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    store.applySyncOverride(OVERRIDE_URL)
    enqueue({ recordId: 'r1', patientId: 'P-1', token: 'tok', record: { id: 'r1' }, queuedAt: '2026-08-25T09:00:00.000Z', attempts: 0 })

    const result = store.applySyncOverride(OVERRIDE_URL) // same url again

    expect(result).toEqual({ ok: true })
  })

  it('applySyncOverride still succeeds when the outbox is empty even though the url differs', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    expect(store.pendingCount).toBe(0)

    expect(store.applySyncOverride(OVERRIDE_URL)).toEqual({ ok: true })
  })

  it('clearSyncOverride refuses when pendingCount > 0 and the file url differs from the current override', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    store.applySyncOverride(OVERRIDE_URL)
    enqueue({ recordId: 'r1', patientId: 'P-1', token: 'tok', record: { id: 'r1' }, queuedAt: '2026-08-25T09:00:00.000Z', attempts: 0 })
    enqueue({ recordId: 'r2', patientId: 'P-1', token: 'tok', record: { id: 'r2' }, queuedAt: '2026-08-25T09:00:00.000Z', attempts: 0 })

    const result = store.clearSyncOverride()

    expect(result).toEqual({ ok: false, reason: 'pending', count: 2 })
    expect(store.syncUrl).toBe(OVERRIDE_URL) // untouched
    expect(store.syncSource).toBe('override')
    expect(globalThis.localStorage.getItem(OVERRIDE_KEY)).toBe(OVERRIDE_URL) // never removed
  })

  it('clearSyncOverride still succeeds when the outbox is empty', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    store.applySyncOverride(OVERRIDE_URL)

    expect(store.clearSyncOverride()).toEqual({ ok: true })
    expect(store.syncUrl).toBe(FILE_URL)
  })

  // Fix round 2 minor 1 (Opus review): pendingCount is only a MIRROR,
  // updated by THIS store instance's own actions (enqueueRecord/flush/
  // init) — a second tab/PWA window sharing the same outbox storage can
  // enqueue directly without ever touching that mirror, leaving it stale
  // (here: stale at 0) while the real outbox is non-empty. Fixed in the
  // actions themselves (not the getter): re-reading the outbox's live
  // length is the FIRST thing both applySyncOverride/clearSyncOverride do.
  it('the R45 guard re-reads the LIVE outbox length rather than trusting a stale in-memory pendingCount mirror', async () => {
    stubConfigFetch(FILE_URL)
    const store = useSyncStore()
    await store.init()
    expect(store.pendingCount).toBe(0)

    // Simulates a second tab/window enqueueing into the SAME shared outbox
    // storage directly (bypassing syncStore.enqueueRecord() entirely) —
    // this store instance's pendingCount mirror is never told about it.
    enqueue({
      recordId: 'r1',
      patientId: 'P-1',
      token: 'tok',
      record: { id: 'r1' },
      queuedAt: '2026-08-25T09:00:00.000Z',
      attempts: 0,
    })
    expect(store.pendingCount).toBe(0) // sanity: still stale, exactly as a naive comparison would silently trust

    const result = store.applySyncOverride(OVERRIDE_URL)

    expect(result).toEqual({ ok: false, reason: 'pending', count: 1 }) // the TRUE live count, not the stale mirror
    expect(store.pendingCount).toBe(1) // re-mirrored as a side effect of the guard itself
    expect(store.syncUrl).toBe(FILE_URL) // untouched — refused
  })

  describe('wouldOrphanPending getter', () => {
    it('true only when configured AND the url differs AND pendingCount > 0', async () => {
      stubConfigFetch(FILE_URL)
      const store = useSyncStore()
      await store.init()

      expect(store.wouldOrphanPending(OVERRIDE_URL)).toBe(false) // pendingCount still 0
      store.pendingCount = 1
      expect(store.wouldOrphanPending(OVERRIDE_URL)).toBe(true)
      expect(store.wouldOrphanPending(FILE_URL)).toBe(false) // same url -- nothing would change
    })

    it('false when unconfigured, regardless of pendingCount', async () => {
      stubConfigFetch('')
      const store = useSyncStore()
      await store.init()
      store.pendingCount = 5

      expect(store.wouldOrphanPending(OVERRIDE_URL)).toBe(false)
    })
  })
})

// Fix round 1 minor 9(c): readSyncOverride() (module-private) guards a
// throwing localStorage.getItem — pinned via init(), its only caller.
describe('syncStore — readSyncOverride throwing-getItem guard (fix round 1 minor 9c)', () => {
  it('init() never throws when localStorage.getItem throws, and falls back to the file value', async () => {
    stubConfigFetch(FILE_URL)
    vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled')
    })

    const store = useSyncStore()
    await expect(store.init()).resolves.toBeUndefined()

    expect(store.syncUrl).toBe(FILE_URL)
    expect(store.configured).toBe(true)
    expect(store.syncSource).toBe('file')
  })
})
