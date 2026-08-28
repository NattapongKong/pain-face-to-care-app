// Offline-first outbox: localStorage queue of not-yet-acknowledged
// assessments (spec §6). Data must never be silently dropped on failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enqueue, pending, flush, storageOk, __resetOutbox } from '../../src/sync/outbox.js'
import { __setRequestTimeoutMs } from '../../src/sync/client.js'

const OUTBOX_KEY = 'painface.outbox.v1'
const SYNC_URL = 'https://script.google.com/macros/s/deadbeef/exec'

function item(recordId, overrides = {}) {
  return {
    recordId,
    patientId: 'P-1',
    token: 'tok-1',
    record: { id: recordId },
    queuedAt: '2026-08-25T09:00:00.000Z',
    attempts: 0,
    ...overrides,
  }
}

function jsonResponse(body) {
  return { ok: true, json: async () => body }
}

// Round 2 minor 6: reset the flush mutex, the last-write-failed flag, and
// the seq counter before every test — otherwise a hung-fetch test earlier
// in this file could wedge the mutex (or leave storageOk() false) for
// every test after it, and the seq counter would make `seq` assertions
// depend on execution order.
beforeEach(() => {
  __resetOutbox()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __setRequestTimeoutMs() // restore the default between tests
})

describe('sync/outbox — enqueue / pending', () => {
  it('enqueue persists the item to localStorage (stamped with a monotonic seq) and pending() reflects it', () => {
    enqueue(item('r1'))
    expect(pending()).toEqual([{ ...item('r1'), seq: 1 }])
    expect(JSON.parse(localStorage.getItem(OUTBOX_KEY))).toEqual([{ ...item('r1'), seq: 1 }])
  })

  // round 2 minor 2
  it('enqueue stamps an increasing seq on each call, distinct even across calls in the same millisecond', () => {
    const a = enqueue(item('r1'))
    const b = enqueue(item('r2', { queuedAt: a.queuedAt })) // identical queuedAt on purpose
    expect(b.seq).toBeGreaterThan(a.seq)
  })

  it('enqueueing the same recordId again replaces it (latest wins, queue length unchanged)', () => {
    enqueue(item('r1', { queuedAt: '2026-08-25T09:00:00.000Z' }))
    enqueue(item('r2'))
    enqueue(item('r1', { record: { id: 'r1', painScore: 9 }, queuedAt: '2026-08-25T09:05:00.000Z' }))

    const queue = pending()
    expect(queue).toHaveLength(2)
    const r1 = queue.find((i) => i.recordId === 'r1')
    expect(r1.record).toEqual({ id: 'r1', painScore: 9 })
    expect(r1.queuedAt).toBe('2026-08-25T09:05:00.000Z')
  })

  it('a corrupted stored queue is treated as empty and never throws', () => {
    localStorage.setItem(OUTBOX_KEY, '{not json')
    expect(() => pending()).not.toThrow()
    expect(pending()).toEqual([])
  })

  // minor 8 + round 3 minor 6 (isQueueItem now also validates
  // patientId/token/record, not just recordId)
  it('pending() filters out any entries from a parseable-but-garbage array (non-objects, or missing/invalid fields)', () => {
    localStorage.setItem(
      OUTBOX_KEY,
      JSON.stringify([
        item('r1'), // the only fully-valid entry
        { recordId: 'r2' }, // missing patientId/token/record entirely
        { recordId: 'r3', patientId: 'P-1', token: '', record: {} }, // empty token
        { recordId: 'r4', patientId: '', token: 't', record: {} }, // empty patientId
        { recordId: 'r5', patientId: 'P-1', token: 't', record: 'not-an-object' }, // record not an object
        { recordId: 'r6', patientId: 'P-1', token: 't', record: ['not', 'plain'] }, // record is an array
        { foo: 'bar' },
        null,
        'garbage',
        42,
        { recordId: '' },
      ]),
    )
    expect(pending()).toEqual([item('r1')])
  })

  // minor 8
  it('enqueue rejects (safe no-op) an item without a non-empty string recordId', () => {
    expect(enqueue({ patientId: 'P-1', token: 't', record: {} })).toBeNull()
    expect(enqueue({ recordId: '', patientId: 'P-1', token: 't', record: {} })).toBeNull()
    expect(enqueue(null)).toBeNull()
    expect(pending()).toEqual([])
  })

  // round 3 minor 6: enqueue() is just as strict as readQueue()'s filter —
  // a malformed item is rejected up front rather than persisted and then
  // POSTed forever with garbage credentials/payload.
  it('enqueue rejects (safe no-op) an item with a missing/invalid patientId, token, or a non-object record', () => {
    expect(enqueue({ recordId: 'r1', patientId: '', token: 't', record: {} })).toBeNull()
    expect(enqueue({ recordId: 'r1', patientId: 'P-1', token: '', record: {} })).toBeNull()
    expect(enqueue({ recordId: 'r1', patientId: 'P-1', token: 't', record: 'nope' })).toBeNull()
    expect(enqueue({ recordId: 'r1', patientId: 'P-1', token: 't' })).toBeNull() // record missing entirely
    expect(pending()).toEqual([])
  })

  // MAJOR 2 + round 2 minor 3: the return value must not claim success it
  // didn't achieve — enqueue() returns null (not the item) when the write
  // failed to persist.
  it('enqueue never throws even if localStorage.setItem throws; returns null (not the item) and storageOk() reflects the failure', () => {
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      const err = new Error('quota exceeded')
      err.name = 'QuotaExceededError'
      throw err
    })

    let returned
    expect(() => {
      returned = enqueue(item('r1'))
    }).not.toThrow()
    expect(returned).toBeNull()
    expect(storageOk()).toBe(false)
  })
})

describe('sync/outbox — flush', () => {
  it('is a no-op with zero fetches when the queue is empty', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await flush(SYNC_URL)

    expect(result).toEqual({ sent: [], failed: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends oldest-first and removes acked items', async () => {
    enqueue(item('r1', { queuedAt: '2026-08-25T09:00:00.000Z' }))
    enqueue(item('r2', { queuedAt: '2026-08-25T08:00:00.000Z' }))

    const seenOrder = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init) => {
        const body = JSON.parse(init.body)
        seenOrder.push(body.record.id)
        return Promise.resolve(jsonResponse({ ok: true, saved: 'inserted' }))
      }),
    )

    const result = await flush(SYNC_URL)

    expect(seenOrder).toEqual(['r2', 'r1']) // r2 queued earlier -> sent first
    expect(result.sent.sort()).toEqual(['r1', 'r2'])
    expect(result.failed).toEqual([])
    expect(pending()).toEqual([])
  })

  it('keeps failed items and increments attempts, never dropping data', async () => {
    enqueue(item('r1', { attempts: 0 }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))

    const result = await flush(SYNC_URL)

    expect(result.sent).toEqual([])
    expect(result.failed).toEqual(['r1'])
    const queue = pending()
    expect(queue).toHaveLength(1)
    expect(queue[0].attempts).toBe(1)
    expect(queue[0].record).toEqual({ id: 'r1' })
  })

  it('retries a previously-failed item and increments attempts again on a second failure', async () => {
    enqueue(item('r1', { attempts: 1 }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('still offline')))

    await flush(SYNC_URL)

    expect(pending()[0].attempts).toBe(2)
  })

  it('handles a mixed batch: acked items removed, failed items kept', async () => {
    enqueue(item('r1'))
    enqueue(item('r2'))

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init) => {
        const body = JSON.parse(init.body)
        if (body.record.id === 'r1') return Promise.resolve(jsonResponse({ ok: true, saved: 'inserted' }))
        return Promise.reject(new TypeError('offline'))
      }),
    )

    const result = await flush(SYNC_URL)

    expect(result.sent).toEqual(['r1'])
    expect(result.failed).toEqual(['r2'])
    const queue = pending()
    expect(queue.map((i) => i.recordId)).toEqual(['r2'])
    expect(queue[0].attempts).toBe(1)
  })

  it('also treats a server error response (ok:false) as a failure, keeping the item', async () => {
    enqueue(item('r1'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'server-error' })))

    const result = await flush(SYNC_URL)

    expect(result.sent).toEqual([])
    expect(result.failed).toEqual(['r1'])
    expect(pending()).toHaveLength(1)
  })

  // minor 9
  it('a send failure persists lastError (the SyncError code) on the item; a later success clears it by removing the item', async () => {
    enqueue(item('r1'))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))

    await flush(SYNC_URL)
    expect(pending()[0].lastError).toBe('network')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true, saved: 'inserted' })))
    const result = await flush(SYNC_URL)

    expect(result.sent).toEqual(['r1'])
    expect(pending()).toEqual([])
  })

  // MAJOR 2
  it('never throws even if the final write-back fails, and storageOk() reflects the failure', async () => {
    enqueue(item('r1'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true, saved: 'inserted' })))
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      const err = new Error('quota exceeded')
      err.name = 'QuotaExceededError'
      throw err
    })

    await expect(flush(SYNC_URL)).resolves.toEqual({ sent: ['r1'], failed: [] })
    expect(storageOk()).toBe(false)
  })

  // round 2 minor 7: the "never rejects" contract must be literally true,
  // not just documented — a broken localStorage.getItem (not just setItem)
  // must not turn flush() into a rejecting promise.
  it('never throws even if reading the queue throws (e.g. a broken localStorage.getItem)', async () => {
    enqueue(item('r1'))
    vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('boom')
    })

    await expect(flush(SYNC_URL)).resolves.toEqual({ sent: [], failed: [] })
  })

  // round 2 MAJOR 1
  it('a timed-out request does not wedge the flush mutex — the next flush runs and sends normally', async () => {
    __setRequestTimeoutMs(15)
    enqueue(item('r1'))

    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        const body = JSON.parse(init.body)
        if (body.record.id !== 'r1') return Promise.resolve(jsonResponse({ ok: true, saved: 'inserted' }))
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      }),
    )

    const resultA = await flush(SYNC_URL) // times out (~15ms) -> r1 fails, stays queued
    expect(resultA.failed).toEqual(['r1'])
    expect(pending()).toHaveLength(1)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true, saved: 'inserted' })))
    const resultB = await flush(SYNC_URL) // mutex was released -> runs immediately, not after another 15s

    expect(resultB.sent).toEqual(['r1'])
    expect(pending()).toEqual([])
  })

  // round 3 minor 4
  it('stops the pass after the first "network" failure — remaining items are left completely untouched', async () => {
    __setRequestTimeoutMs(15)
    enqueue(item('r1', { queuedAt: '2026-08-25T09:00:00.000Z' }))
    enqueue(item('r2', { queuedAt: '2026-08-25T09:01:00.000Z', attempts: 3 }))

    const fetchMock = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await flush(SYNC_URL)

    expect(fetchMock).toHaveBeenCalledTimes(1) // only r1 (oldest) attempted this pass
    expect(result.sent).toEqual([])
    expect(result.failed).toEqual(['r1'])
    const queue = pending()
    expect(queue.find((i) => i.recordId === 'r1').attempts).toBe(1)
    expect(queue.find((i) => i.recordId === 'r2').attempts).toBe(3) // untouched -- the pass stopped before reaching it
  })

  // round 3 minor 4: a non-network (per-item server verdict) failure does
  // NOT stop the pass — only a dead-server 'network' failure does.
  it('does NOT stop the pass on a non-network (server verdict) failure', async () => {
    enqueue(item('r1', { queuedAt: '2026-08-25T09:00:00.000Z' }))
    enqueue(item('r2', { queuedAt: '2026-08-25T09:01:00.000Z' }))

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'server-error' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await flush(SYNC_URL)

    expect(fetchMock).toHaveBeenCalledTimes(2) // both attempted
    expect(result.failed.sort()).toEqual(['r1', 'r2'])
  })
})

// BLOCKER 1: flush() used to read the queue once, then blindly overwrite
// storage with that stale snapshot at the end — silently dropping anything
// enqueued (or replaced-by-recordId) while the network round-trips were in
// flight. Both interleavings below use a controllable (manually-resolved)
// fetch so the exact race is deterministic rather than timing-dependent.
describe('sync/outbox — flush concurrency (review round 1, BLOCKER 1)', () => {
  it('(a) an item enqueued while a flush is in-flight survives that flush\'s write-back', async () => {
    enqueue(item('r1'))
    let resolveR1
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        const body = JSON.parse(init.body)
        if (body.record.id === 'r1') {
          return new Promise((resolve) => {
            resolveR1 = resolve
          })
        }
        return Promise.resolve(jsonResponse({ ok: true, saved: 'inserted' }))
      }),
    )

    const flushA = flush(SYNC_URL) // reads [r1], POST for r1 hangs
    await new Promise((resolve) => setImmediate(resolve)) // let flushA reach the hung fetch call
    expect(typeof resolveR1).toBe('function')

    enqueue(item('r2')) // enqueued mid-flight, while flushA has not written anything back yet
    const flushB = flush(SYNC_URL) // chains behind flushA (module-level guard) instead of racing

    resolveR1(jsonResponse({ ok: true, saved: 'inserted' })) // let flushA's r1 finally ack

    const [resultA, resultB] = await Promise.all([flushA, flushB])

    expect(resultA.sent).toEqual(['r1'])
    expect([...resultA.sent, ...resultB.sent].sort()).toEqual(['r1', 'r2']) // r2 was never lost
    expect(pending()).toEqual([])
  })

  it('(b) a stale ack for a since-replaced item never deletes the replacement or reports it sent', async () => {
    enqueue(item('r9', { queuedAt: '2026-08-25T10:00:00.000Z' }))
    let resolveOld
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        const body = JSON.parse(init.body)
        if (body.record.painScore === undefined) {
          return new Promise((resolve) => {
            resolveOld = resolve
          })
        }
        return Promise.resolve(jsonResponse({ ok: true, saved: 'inserted' }))
      }),
    )

    const flushA = flush(SYNC_URL) // sends the OLD r9 payload, hangs
    await new Promise((resolve) => setImmediate(resolve))
    expect(typeof resolveOld).toBe('function')

    // A reassessment update replaces r9 with new content + a fresh queuedAt
    // WHILE the old payload's POST is still in flight.
    enqueue(item('r9', { queuedAt: '2026-08-25T10:05:00.000Z', record: { id: 'r9', painScore: 9 } }))

    resolveOld(jsonResponse({ ok: true, saved: 'inserted' })) // stale ack for the OLD payload arrives

    const resultA = await flushA

    expect(resultA.sent).not.toContain('r9')
    expect(resultA.failed).not.toContain('r9')
    const queue = pending()
    expect(queue).toHaveLength(1)
    expect(queue[0].record).toEqual({ id: 'r9', painScore: 9 })
    expect(queue[0].queuedAt).toBe('2026-08-25T10:05:00.000Z')
  })

  // round 2 minor 2: (b) above used a different queuedAt for the
  // replacement to prove the mechanism; this pins the REAL hole a
  // queuedAt-only identity check leaves open — two enqueue() calls landing
  // in the exact same millisecond share a queuedAt, so only the
  // module-monotonic `seq` (never caller-supplied) can tell them apart.
  it('(b2) a same-millisecond replacement (identical queuedAt) is still correctly detected via seq, not queuedAt', async () => {
    const SAME_TS = '2026-08-25T10:00:00.000Z'
    enqueue(item('r9', { queuedAt: SAME_TS }))
    let resolveOld
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        const body = JSON.parse(init.body)
        if (body.record.painScore === undefined) {
          return new Promise((resolve) => {
            resolveOld = resolve
          })
        }
        return Promise.resolve(jsonResponse({ ok: true, saved: 'inserted' }))
      }),
    )

    const flushA = flush(SYNC_URL)
    await new Promise((resolve) => setImmediate(resolve))
    expect(typeof resolveOld).toBe('function')

    // Same queuedAt as the original -- only `seq` distinguishes this from
    // the version already in flight.
    enqueue(item('r9', { queuedAt: SAME_TS, record: { id: 'r9', painScore: 9 } }))

    resolveOld(jsonResponse({ ok: true, saved: 'inserted' }))
    const resultA = await flushA

    expect(resultA.sent).not.toContain('r9')
    const queue = pending()
    expect(queue).toHaveLength(1)
    expect(queue[0].record).toEqual({ id: 'r9', painScore: 9 })
    expect(queue[0].queuedAt).toBe(SAME_TS)
  })
})
