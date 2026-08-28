// Pinia sync store: runtime config + offline outbox + pull, wired together
// (spec §6). Every action must be a safe zero-fetch no-op when unconfigured.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSyncStore } from '../../src/stores/syncStore.js'
import * as repository from '../../src/domain/repository.js'
import { enqueue, pending, __resetOutbox } from '../../src/sync/outbox.js'
import { __setRequestTimeoutMs } from '../../src/sync/client.js'

const SYNC_URL = 'https://script.google.com/macros/s/deadbeef/exec'

/**
 * A single fetch stub that answers BOTH the config GET (`fetch(url)`, no
 * init) and the client.js POSTs (`fetch(url, {method, headers, body})`),
 * routed by `body.action`. `submitResult`/`myScoresResult` may be a plain
 * payload object (returned as the JSON body of an ok:true HTTP response)
 * or an Error instance (rejects the fetch call itself, i.e. a network
 * failure).
 */
function stubFetch({ configSyncUrl = SYNC_URL, submitResult, myScoresResult } = {}) {
  const fetchMock = vi.fn((url, init) => {
    if (!init) {
      return Promise.resolve({ ok: true, json: async () => ({ syncUrl: configSyncUrl }) })
    }
    const body = JSON.parse(init.body)
    if (body.action === 'submit') {
      if (submitResult instanceof Error) return Promise.reject(submitResult)
      return Promise.resolve({ ok: true, json: async () => submitResult ?? { ok: true, saved: 'inserted' } })
    }
    if (body.action === 'myScores') {
      if (myScoresResult instanceof Error) return Promise.reject(myScoresResult)
      return Promise.resolve({ ok: true, json: async () => myScoresResult })
    }
    return Promise.reject(new Error(`unexpected fetch action: ${body.action}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// Round 2 minor 6: reset the outbox's module-level state (flush mutex,
// last-write-failed flag, seq counter) before every test — otherwise a
// hung-fetch test earlier in this file could wedge every test after it.
beforeEach(() => {
  setActivePinia(createPinia())
  __resetOutbox()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __setRequestTimeoutMs() // restore the default between tests
})

describe('stores/syncStore — unconfigured (no sync URL)', () => {
  it('init() sets configured:false and every action is a safe no-op (zero further fetches)', async () => {
    const fetchMock = stubFetch({ configSyncUrl: '' })
    const store = useSyncStore()

    await store.init()
    expect(store.configured).toBe(false)
    expect(store.syncUrl).toBe('')

    fetchMock.mockClear()
    await store.enqueueRecord({ patientId: 'P-1', token: 'tok' }, { id: 'r1' })
    await store.flush()
    await store.pull({ patientId: 'P-1', token: 'tok' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.pendingCount).toBe(0)
    expect(pending()).toEqual([])
    expect(store.serverRecords).toEqual([])
    expect(store.authFailed).toBe(false)
  })

  it('init() never throws when window/navigator have no onLine/addEventListener support (non-DOM test env)', async () => {
    stubFetch({ configSyncUrl: '' })
    const store = useSyncStore()
    await store.init()
    expect(store.online).toBe(true)
  })

  // round 3 minor 6: consistent {sent,failed} shape regardless of the
  // unconfigured guard clause — callers never need to special-case undefined.
  it('flush() resolves to {sent:[], failed:[]} even when unconfigured', async () => {
    stubFetch({ configSyncUrl: '' })
    const store = useSyncStore()
    await store.init()

    await expect(store.flush()).resolves.toEqual({ sent: [], failed: [] })
  })
})

describe('stores/syncStore — init()', () => {
  // Round 3 minor 2: init()'s own backlog flush is fire-and-forget too, so
  // pendingCount right after init() resolving reflects the pre-flush
  // outbox length — the sent outcome lands asynchronously.
  it('reports the current outbox length as pendingCount and, once the background flush settles, drains it', async () => {
    enqueue({
      recordId: 'r1',
      patientId: 'P-1',
      token: 'tok',
      record: { id: 'r1' },
      queuedAt: '2026-08-25T09:00:00.000Z',
      attempts: 0,
    })
    stubFetch({ submitResult: { ok: true, saved: 'inserted' } })

    const store = useSyncStore()
    await store.init()

    expect(store.configured).toBe(true)
    expect(store.pendingCount).toBe(1) // init() resolved before its own fire-and-forget flush could have settled

    await vi.waitFor(() => expect(store.pendingCount).toBe(0)) // let the background flush settle
    expect(pending()).toEqual([])
  })

  // minor 6
  it('is idempotent — a second call does not re-run setup or add duplicate listeners', async () => {
    const addEventListener = vi.fn()
    vi.stubGlobal('window', { addEventListener, removeEventListener: () => {} })
    const fetchMock = stubFetch({ configSyncUrl: '' })

    const store = useSyncStore()
    await store.init()
    expect(fetchMock).toHaveBeenCalledTimes(1) // the one config fetch

    await store.init()

    expect(fetchMock).toHaveBeenCalledTimes(1) // NOT called again
    expect(addEventListener).toHaveBeenCalledTimes(2) // online + offline, once each
  })

  // minor 6
  it('skips the initial flush attempt when online is false', async () => {
    enqueue({
      recordId: 'r1',
      patientId: 'P-1',
      token: 'tok',
      record: { id: 'r1' },
      queuedAt: '2026-08-25T09:00:00.000Z',
      attempts: 0,
    })
    const fetchMock = stubFetch({ submitResult: { ok: true, saved: 'inserted' } })
    vi.stubGlobal('navigator', { onLine: false })

    const store = useSyncStore()
    await store.init()

    expect(store.configured).toBe(true)
    expect(store.online).toBe(false)
    expect(store.pendingCount).toBe(1) // untouched -- no flush attempted
    const submitCalls = fetchMock.mock.calls.filter(([, init]) => init && JSON.parse(init.body).action === 'submit')
    expect(submitCalls).toHaveLength(0)
  })
})

describe('stores/syncStore — enqueueRecord', () => {
  // Round 2 MAJOR 1: enqueueRecord no longer awaits its own flush, so
  // `pendingCount` right after the call reflects only the synchronous
  // enqueue — the sent/synced outcome lands asynchronously once the
  // fire-and-forget flush settles.
  it('enqueues immediately (without waiting for the flush) and, once the background flush settles, marks the record synced and decrements pendingCount', async () => {
    stubFetch({ submitResult: { ok: true, saved: 'inserted' } })
    const updateSpy = vi.spyOn(repository, 'updateRecord')

    const store = useSyncStore()
    await store.init()
    expect(store.configured).toBe(true)

    await store.enqueueRecord({ patientId: 'P-1', token: 'tok' }, { id: 'r1' })
    expect(store.pendingCount).toBe(1) // enqueueRecord resolved before the flush could have settled

    await vi.waitFor(() => expect(store.pendingCount).toBe(0)) // let the fire-and-forget flush settle

    expect(updateSpy).toHaveBeenCalledWith('r1', { synced: true })
    expect(pending()).toEqual([])
  })

  it('a failed background flush leaves the item queued, increments attempts, and never marks it synced', async () => {
    stubFetch({ submitResult: new TypeError('offline') })
    const updateSpy = vi.spyOn(repository, 'updateRecord')

    const store = useSyncStore()
    await store.init()

    await store.enqueueRecord({ patientId: 'P-1', token: 'tok' }, { id: 'r1' })
    await vi.waitFor(() => expect(pending()[0]?.attempts).toBe(1)) // let the fire-and-forget flush settle

    expect(updateSpy).not.toHaveBeenCalled()
    expect(store.pendingCount).toBe(1)
    const queue = pending()
    expect(queue).toHaveLength(1)
    expect(queue[0].attempts).toBe(1)
  })

  // App-integration review round 1 MINOR 6: unlike lastSyncAt (success-only),
  // lastFlushAt must be bumped for a FAILED pass too — it exists purely so
  // UI code has a dependency that reliably changes on every flush, even one
  // that doesn't change the outbox's length.
  it('a failed flush still bumps lastFlushAt (review round 1 MINOR 6)', async () => {
    stubFetch({ submitResult: new TypeError('offline') })
    const store = useSyncStore()
    await store.init()
    expect(store.lastFlushAt).toBeNull()

    await store.enqueueRecord({ patientId: 'P-1', token: 'tok' }, { id: 'r1' })
    await vi.waitFor(() => expect(store.lastFlushAt).toEqual(expect.any(String)))
  })

  // minor 5: unlinked records must never enter the outbox (spec §8).
  it('is a safe no-op — before touching the outbox — when ctx is missing patientId/token', async () => {
    const fetchMock = stubFetch({ submitResult: { ok: true, saved: 'inserted' } })
    const store = useSyncStore()
    await store.init()
    fetchMock.mockClear()

    await store.enqueueRecord(null, { id: 'r1' })
    await store.enqueueRecord(undefined, { id: 'r2' })
    await store.enqueueRecord({ patientId: 'P-1' }, { id: 'r3' })
    await store.enqueueRecord({ token: 'tok' }, { id: 'r4' })

    expect(pending()).toEqual([])
    expect(store.pendingCount).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Round 2 MAJOR 1(b): enqueueRecord must resolve promptly even while its
  // own (or an unrelated) flush attempt is wedged on a slow/hung request —
  // callers such as assessmentStore.finalize() must never stall on network
  // reachability.
  it('resolves promptly without waiting for its own flush attempt to settle', async () => {
    __setRequestTimeoutMs(20) // bound the background request so nothing dangles past this test
    const fetchMock = vi.fn((url, init) => {
      if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: SYNC_URL }) })
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const store = useSyncStore()
    await store.init()

    const NOT_YET = Symbol('not-yet-resolved')
    const marker = new Promise((resolve) => setTimeout(() => resolve(NOT_YET), 100))
    const result = await Promise.race([store.enqueueRecord({ patientId: 'P-1', token: 'tok' }, { id: 'r1' }), marker])

    expect(result).not.toBe(NOT_YET) // enqueueRecord itself resolved well before the 100ms marker
    expect(store.pendingCount).toBe(1) // set synchronously inside enqueueRecord, before the fire-and-forget flush

    // Let the background request actually start and abort (~20ms) so
    // nothing dangles past this test, then confirm it really did happen
    // in the background — proving enqueueRecord did not wait for it.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(fetchMock).toHaveBeenCalled()
  })

  // BLOCKER 1b, end-to-end: a stale ack for a since-replaced record must
  // never mark it synced while the server actually holds the stale row —
  // the replacement is delivered (and legitimately marked synced) instead.
  it('a stale ack for a since-replaced record does not falsely mark it synced; the replacement is delivered instead', async () => {
    const submittedPayloads = []
    let resolveOld
    const fetchMock = vi.fn((url, init) => {
      if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: SYNC_URL }) })
      const body = JSON.parse(init.body)
      if (body.action !== 'submit') return Promise.reject(new Error('unexpected action'))
      submittedPayloads.push(body.record)
      if (body.record.painScore === undefined) {
        return new Promise((resolve) => {
          resolveOld = resolve
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, saved: 'inserted' }) })
    })
    vi.stubGlobal('fetch', fetchMock)

    const updateSpy = vi.spyOn(repository, 'updateRecord')
    const store = useSyncStore()
    await store.init()

    // Round 2 MAJOR 1: enqueueRecord no longer awaits its own flush, so p1
    // and p2 both resolve almost immediately regardless of the hung
    // request — the background flushes are awaited separately below via
    // vi.waitFor, not via these promises.
    const p1 = store.enqueueRecord({ patientId: 'P-1', token: 'tok' }, { id: 'r9' })
    await p1
    await new Promise((resolve) => setImmediate(resolve)) // let the background flush reach the hung fetch call
    expect(typeof resolveOld).toBe('function')

    const p2 = store.enqueueRecord({ patientId: 'P-1', token: 'tok' }, { id: 'r9', painScore: 9 })
    await p2

    resolveOld({ ok: true, json: async () => ({ ok: true, saved: 'inserted' }) }) // stale ack for the OLD payload
    await vi.waitFor(() => expect(pending()).toEqual([])) // wait for BOTH background flushes to fully settle

    const r9Calls = updateSpy.mock.calls.filter(([id]) => id === 'r9')
    expect(r9Calls).toEqual([['r9', { synced: true }]]) // exactly once, from the real (updated) ack
    expect(submittedPayloads.some((r) => r.painScore === 9)).toBe(true) // the update really reached the server
  })

  // Round 3 BLOCKER 1: seqCounter used to restart at 0 on every module load
  // while a still-queued PERSISTED item kept its OLD seq from a prior
  // session — a fresh session's first enqueue() collided with it (both
  // seq:1). Reproduced here exactly as probed: a backlog item is seeded
  // DIRECTLY into storage (bypassing enqueue(), simulating a prior page
  // load), __resetOutbox() simulates the fresh session's module reload,
  // then a same-recordId replacement is enqueued mid-flight and a stale
  // ack for the OLD (persisted) payload arrives. The replacement must
  // survive and only the REAL ack (for the replacement) may mark it synced.
  it('a persisted item from a prior "session" and a same-session replacement never collide on identity (cross-session seq restart)', async () => {
    localStorage.setItem(
      'painface.outbox.v1',
      JSON.stringify([
        {
          recordId: 'r9',
          patientId: 'P-1',
          token: 'tok',
          record: { id: 'r9' },
          queuedAt: '2026-08-25T09:00:00.000Z',
          attempts: 0,
          seq: 1,
        },
      ]),
    )
    __resetOutbox() // simulates a fresh page load: reseeds seqCounter from the persisted max (1)

    let resolveOld
    const fetchMock = vi.fn((url, init) => {
      if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: SYNC_URL }) })
      const body = JSON.parse(init.body)
      if (body.action !== 'submit') return Promise.reject(new Error('unexpected action'))
      if (body.record.painScore === undefined) {
        return new Promise((resolve) => {
          resolveOld = resolve
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, saved: 'inserted' }) })
    })
    vi.stubGlobal('fetch', fetchMock)

    const updateSpy = vi.spyOn(repository, 'updateRecord')
    const store = useSyncStore()
    await store.init() // kicks off (fire-and-forget) a flush of the persisted backlog -- hangs on r9's old payload
    await new Promise((resolve) => setImmediate(resolve)) // let that background flush reach the hung fetch call
    expect(typeof resolveOld).toBe('function')

    // A NEW enqueue in THIS session replaces r9 mid-flight.
    await store.enqueueRecord({ patientId: 'P-1', token: 'tok' }, { id: 'r9', painScore: 9 })

    resolveOld({ ok: true, json: async () => ({ ok: true, saved: 'inserted' }) }) // stale ack for the OLD (persisted) payload
    await vi.waitFor(() => expect(pending()).toEqual([]))

    const r9Calls = updateSpy.mock.calls.filter(([id]) => id === 'r9')
    expect(r9Calls).toEqual([['r9', { synced: true }]]) // exactly once, from the real (updated) ack
  })
})

describe('stores/syncStore — storage failure (review round 1, MAJOR 2)', () => {
  it('a storage write failure (e.g. QuotaExceededError) never rejects enqueueRecord and sets storageFailed', async () => {
    stubFetch({ submitResult: { ok: true, saved: 'inserted' } })
    const store = useSyncStore()
    await store.init()
    expect(store.storageFailed).toBe(false)

    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      const err = new Error('quota exceeded')
      err.name = 'QuotaExceededError'
      throw err
    })

    await expect(store.enqueueRecord({ patientId: 'P-1', token: 'tok' }, { id: 'r1' })).resolves.toBeUndefined()

    expect(store.storageFailed).toBe(true)
  })
})

describe('stores/syncStore — pull', () => {
  it('success populates serverRecords/serverDisplayName + lastSyncAt and clears authFailed', async () => {
    stubFetch({ myScoresResult: { ok: true, displayName: 'สมชาย', records: [{ id: 'r1' }] } })
    const store = useSyncStore()
    await store.init()
    store.authFailed = true

    await store.pull({ patientId: 'P-1', token: 'tok' })

    expect(store.serverRecords).toEqual([{ id: 'r1' }])
    expect(store.serverDisplayName).toBe('สมชาย')
    expect(store.lastSyncAt).toEqual(expect.any(String))
    expect(store.authFailed).toBe(false)
  })

  // plan Task 2: bed/baseline round-trip through pull() alongside
  // displayName/records.
  it('success populates serverBed/serverBaseline', async () => {
    stubFetch({
      myScoresResult: {
        ok: true,
        displayName: 'สมชาย',
        bed: '304/2',
        baseline: { browDownLeft: 0.1 },
        records: [],
      },
    })
    const store = useSyncStore()
    await store.init()

    await store.pull({ patientId: 'P-1', token: 'tok' })

    expect(store.serverBed).toBe('304/2')
    expect(store.serverBaseline).toEqual({ browDownLeft: 0.1 })
  })

  it('defends against a non-string bed payload (defaults to \'\')', async () => {
    stubFetch({ myScoresResult: { ok: true, displayName: 'x', bed: 42, baseline: null, records: [] } })
    const store = useSyncStore()
    await store.init()

    await store.pull({ patientId: 'P-1', token: 'tok' })

    expect(store.serverBed).toBe('')
  })

  it('defends against a non-plain-object baseline payload (array or primitive default to null)', async () => {
    const store = useSyncStore()

    stubFetch({ myScoresResult: { ok: true, displayName: 'x', bed: '', baseline: ['not', 'an', 'object'], records: [] } })
    await store.init()
    await store.pull({ patientId: 'P-1', token: 'tok' })
    expect(store.serverBaseline).toBeNull()

    stubFetch({ myScoresResult: { ok: true, displayName: 'x', bed: '', baseline: 'not-an-object', records: [] } })
    await store.pull({ patientId: 'P-2', token: 'tok' })
    expect(store.serverBaseline).toBeNull()
  })

  it('an absent bed/baseline on the payload defaults to \'\'/null (old-GAS tolerance)', async () => {
    stubFetch({ myScoresResult: { ok: true, displayName: 'x', records: [] } })
    const store = useSyncStore()
    await store.init()

    await store.pull({ patientId: 'P-1', token: 'tok' })

    expect(store.serverBed).toBe('')
    expect(store.serverBaseline).toBeNull()
  })

  it('unauthorized sets authFailed:true without throwing', async () => {
    stubFetch({ myScoresResult: { ok: false, error: 'unauthorized' } })
    const store = useSyncStore()
    await store.init()

    await store.pull({ patientId: 'P-1', token: 'bad' })

    expect(store.authFailed).toBe(true)
  })

  // minor 7
  it('defends against a non-array records payload', async () => {
    stubFetch({ myScoresResult: { ok: true, displayName: 'x', records: 'not-an-array' } })
    const store = useSyncStore()
    await store.init()

    await store.pull({ patientId: 'P-1', token: 'tok' })

    expect(store.serverRecords).toEqual([])
  })

  // minor 5: unlinked context must never trigger a network call.
  it('is a safe no-op when ctx is missing patientId/token', async () => {
    const fetchMock = stubFetch({ myScoresResult: { ok: true, displayName: 'x', records: [] } })
    const store = useSyncStore()
    await store.init()
    fetchMock.mockClear()

    await store.pull(null)
    await store.pull({ patientId: 'P-1' })
    await store.pull({ token: 'tok' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.serverRecords).toEqual([])
  })
})

// Fix round (MAJOR): pull() now returns a boolean about RESPONSE OWNERSHIP
// — true only when THIS call's settle actually wrote server* state (not
// superseded, not a failure); false on every guard/superseded/unauthorized/
// catch path. This is a context-agnostic signal (R35 holds — it says
// nothing about which patient), and it is the ONLY thing syncHelpers may
// now gate the applyServerInfo copy on — see tests/stores/syncHelpers.test.js
// for the cross-patient poisoning this closes.
describe('stores/syncStore — pull() return value (fix round: response-ownership boolean)', () => {
  it('resolves true on a successful, non-superseded pull', async () => {
    stubFetch({ myScoresResult: { ok: true, displayName: 'x', bed: '', baseline: null, records: [] } })
    const store = useSyncStore()
    await store.init()

    await expect(store.pull({ patientId: 'P-1', token: 'tok' })).resolves.toBe(true)
  })

  it('resolves false on unauthorized', async () => {
    stubFetch({ myScoresResult: { ok: false, error: 'unauthorized' } })
    const store = useSyncStore()
    await store.init()

    await expect(store.pull({ patientId: 'P-1', token: 'bad' })).resolves.toBe(false)
  })

  it('resolves false on a network failure', async () => {
    stubFetch({ myScoresResult: new TypeError('offline') })
    const store = useSyncStore()
    await store.init()

    await expect(store.pull({ patientId: 'P-1', token: 'tok' })).resolves.toBe(false)
  })

  it('resolves false when unconfigured', async () => {
    stubFetch({ configSyncUrl: '' })
    const store = useSyncStore()
    await store.init()

    await expect(store.pull({ patientId: 'P-1', token: 'tok' })).resolves.toBe(false)
  })

  it('resolves false when ctx is missing patientId/token', async () => {
    stubFetch({ myScoresResult: { ok: true, displayName: 'x', records: [] } })
    const store = useSyncStore()
    await store.init()

    await expect(store.pull(null)).resolves.toBe(false)
    await expect(store.pull({ patientId: 'P-1' })).resolves.toBe(false)
  })

  it('resolves false for a superseded response even though the request itself succeeded', async () => {
    const resolvers = []
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init) => {
        if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: SYNC_URL }) })
        const idx = call++
        return new Promise((resolve, reject) => {
          resolvers[idx] = { resolve, reject }
        })
      }),
    )
    const store = useSyncStore()
    await store.init()

    const older = store.pull({ patientId: 'A', token: 'tok-a' })
    await vi.waitFor(() => expect(resolvers[0]).toBeDefined())
    const newer = store.pull({ patientId: 'B', token: 'tok-b' })
    await vi.waitFor(() => expect(resolvers[1]).toBeDefined())

    resolvers[1].resolve({ ok: true, json: async () => ({ ok: true, displayName: 'B', records: [] }) })
    await expect(newer).resolves.toBe(true)

    resolvers[0].resolve({ ok: true, json: async () => ({ ok: true, displayName: 'A', records: [] }) }) // stale, arrives late
    await expect(older).resolves.toBe(false)
  })

  it('resolves false for a superseded unauthorized response too', async () => {
    const resolvers = []
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init) => {
        if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: SYNC_URL }) })
        const idx = call++
        return new Promise((resolve, reject) => {
          resolvers[idx] = { resolve, reject }
        })
      }),
    )
    const store = useSyncStore()
    await store.init()

    const older = store.pull({ patientId: 'A', token: 'tok-a' })
    await vi.waitFor(() => expect(resolvers[0]).toBeDefined())
    const newer = store.pull({ patientId: 'B', token: 'tok-b' })
    await vi.waitFor(() => expect(resolvers[1]).toBeDefined())

    resolvers[1].resolve({ ok: true, json: async () => ({ ok: true, displayName: 'B', records: [] }) })
    await expect(newer).resolves.toBe(true)

    resolvers[0].resolve({ ok: true, json: async () => ({ ok: false, error: 'unauthorized' }) }) // stale, arrives late
    await expect(older).resolves.toBe(false)
  })
})

// App-integration review round 2 MAJOR N1(a) — probe-proven: an OLDER pull
// (context A) settling AFTER a NEWER one (context B) overwrote
// serverRecords/serverDisplayName/authFailed with A's stale response, a
// real cross-patient leak. `pullSeq` makes pull() latest-request-wins on
// every settle path.
describe('stores/syncStore — pull latest-request-wins (review round 2 MAJOR N1a)', () => {
  // Manual, individually-resolvable fetch stub: the shared `stubFetch`
  // helper above resolves immediately, which can't express "the older of
  // two in-flight requests settles LAST" — the exact ordering this pins.
  function stubOrderedFetch() {
    const resolvers = []
    let call = 0
    const fetchMock = vi.fn((url, init) => {
      if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: SYNC_URL }) })
      const idx = call++
      return new Promise((resolve, reject) => {
        resolvers[idx] = { resolve, reject }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    return resolvers
  }

  it('an older pull response resolving AFTER a newer one is discarded entirely; final state reflects the newer', async () => {
    const resolvers = stubOrderedFetch()
    const store = useSyncStore()
    await store.init()

    const older = store.pull({ patientId: 'A', token: 'tok-a' })
    await vi.waitFor(() => expect(resolvers[0]).toBeDefined())
    const newer = store.pull({ patientId: 'B', token: 'tok-b' })
    await vi.waitFor(() => expect(resolvers[1]).toBeDefined())

    // Newer settles FIRST...
    resolvers[1].resolve({
      ok: true,
      json: async () => ({ ok: true, displayName: 'B-name', bed: '200/1', baseline: { a: 1 }, records: [{ id: 'b1' }] }),
    })
    await newer
    // ...then the OLDER response arrives late.
    resolvers[0].resolve({
      ok: true,
      json: async () => ({ ok: true, displayName: 'A-name', bed: '100/1', baseline: { a: 2 }, records: [{ id: 'a1' }] }),
    })
    await older

    expect(store.serverDisplayName).toBe('B-name')
    expect(store.serverRecords).toEqual([{ id: 'b1' }])
    // plan Task 2: the same discard rule covers serverBed/serverBaseline —
    // the stale (older) response must never touch them either.
    expect(store.serverBed).toBe('200/1')
    expect(store.serverBaseline).toEqual({ a: 1 })
  })

  it('a stale unauthorized response is also discarded (authFailed reflects only the newer, successful settle)', async () => {
    const resolvers = stubOrderedFetch()
    const store = useSyncStore()
    await store.init()

    const older = store.pull({ patientId: 'A', token: 'tok-a' })
    await vi.waitFor(() => expect(resolvers[0]).toBeDefined())
    const newer = store.pull({ patientId: 'B', token: 'tok-b' })
    await vi.waitFor(() => expect(resolvers[1]).toBeDefined())

    resolvers[1].resolve({ ok: true, json: async () => ({ ok: true, displayName: 'B-name', records: [] }) })
    await newer
    resolvers[0].resolve({ ok: true, json: async () => ({ ok: false, error: 'unauthorized' }) }) // stale failure
    await older

    expect(store.authFailed).toBe(false) // stale failure must not clobber the newer success
    expect(store.serverDisplayName).toBe('B-name')
  })
})

describe('stores/syncStore — resetServer', () => {
  it('clears serverRecords, serverDisplayName, serverBed, serverBaseline, and authFailed', async () => {
    stubFetch({
      myScoresResult: { ok: true, displayName: 'สมชาย', bed: '304/2', baseline: { a: 1 }, records: [{ id: 'r1' }] },
    })
    const store = useSyncStore()
    await store.init()
    await store.pull({ patientId: 'P-1', token: 'tok' })
    expect(store.serverRecords).toHaveLength(1)
    expect(store.serverBed).toBe('304/2')
    expect(store.serverBaseline).toEqual({ a: 1 })

    store.resetServer()

    expect(store.serverRecords).toEqual([])
    expect(store.serverDisplayName).toBe('')
    expect(store.serverBed).toBe('')
    expect(store.serverBaseline).toBeNull()
    expect(store.authFailed).toBe(false)
  })

  it('supersedes an in-flight pull: a response landing after resetServer() cannot repopulate the cleared state', async () => {
    // Same manual-ordering stub as the latest-request-wins block: the pull
    // must still be unsettled when resetServer() fires.
    const resolvers = []
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init) => {
        if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: SYNC_URL }) })
        const idx = call++
        return new Promise((resolve, reject) => {
          resolvers[idx] = { resolve, reject }
        })
      }),
    )
    const store = useSyncStore()
    await store.init()

    const inflight = store.pull({ patientId: 'A', token: 'tok-a' })
    await vi.waitFor(() => expect(resolvers[0]).toBeDefined())

    store.resetServer() // unlink while the pull is still in flight

    resolvers[0].resolve({
      ok: true,
      json: async () => ({ ok: true, displayName: 'A-name', bed: '100/1', baseline: { a: 9 }, records: [{ id: 'a1' }] }),
    })
    await inflight

    expect(store.serverRecords).toEqual([])
    expect(store.serverDisplayName).toBe('')
    expect(store.serverBed).toBe('')
    expect(store.serverBaseline).toBeNull()
    expect(store.authFailed).toBe(false)
  })
})

describe('stores/syncStore — online/offline', () => {
  it("an 'online' window event triggers a flush attempt", async () => {
    const listeners = {}
    vi.stubGlobal('window', {
      addEventListener: (type, cb) => {
        listeners[type] = cb
      },
      removeEventListener: () => {},
    })

    let shouldFail = true
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init) => {
        if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: SYNC_URL }) })
        const body = JSON.parse(init.body)
        if (body.action !== 'submit') return Promise.reject(new Error('unexpected action'))
        if (shouldFail) return Promise.reject(new TypeError('offline'))
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, saved: 'inserted' }) })
      }),
    )

    const store = useSyncStore()
    await store.init()
    await store.enqueueRecord({ patientId: 'P-1', token: 'tok' }, { id: 'r1' })
    expect(store.pendingCount).toBe(1)

    shouldFail = false
    store.online = false
    await listeners.online()

    expect(store.online).toBe(true)
    expect(store.pendingCount).toBe(0)
  })

  it("an 'offline' window event sets online:false", async () => {
    const listeners = {}
    vi.stubGlobal('window', {
      addEventListener: (type, cb) => {
        listeners[type] = cb
      },
      removeEventListener: () => {},
    })
    stubFetch({ configSyncUrl: '' })

    const store = useSyncStore()
    await store.init()
    expect(store.online).toBe(true)

    listeners.offline()

    expect(store.online).toBe(false)
  })
})
