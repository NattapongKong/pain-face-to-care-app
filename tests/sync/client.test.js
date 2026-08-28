// Thin fetch wrapper around the Apps Script gatekeeper HTTP contract
// (spec §5). No network is ever hit in tests — fetch is fully stubbed.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SyncError,
  submitAssessment,
  fetchMyScores,
  saveBaselineRemote,
  __setRequestTimeoutMs,
} from '../../src/sync/client.js'

const SYNC_URL = 'https://script.google.com/macros/s/deadbeef/exec'

function jsonResponse(body) {
  return { ok: true, json: async () => body }
}

/** A fetch mock that hangs until its AbortSignal fires, then rejects like a real aborted fetch(). */
function hangingUntilAbort() {
  return vi.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  __setRequestTimeoutMs() // restore the default between tests
})

describe('sync/client — submitAssessment', () => {
  it('POSTs to exactly syncUrl with text/plain content-type and the action body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, saved: 'inserted' }))
    vi.stubGlobal('fetch', fetchMock)

    const record = { id: 'r1', patient: { name: 'สมชาย' } }
    const result = await submitAssessment(SYNC_URL, { patientId: 'P-1', token: 'tok-1', record })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(SYNC_URL)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('text/plain;charset=utf-8')
    expect(JSON.parse(init.body)).toEqual({ action: 'submit', patientId: 'P-1', token: 'tok-1', record })
    expect(result).toEqual({ ok: true, saved: 'inserted' })
  })

  it('never places the token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, saved: 'updated' }))
    vi.stubGlobal('fetch', fetchMock)

    await submitAssessment(SYNC_URL, { patientId: 'P-1', token: 'super-secret-token', record: { id: 'r1' } })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(SYNC_URL)
    expect(url).not.toContain('super-secret-token')
  })

  it('throws SyncError with the server error code on {ok:false}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'unauthorized' })))

    await expect(submitAssessment(SYNC_URL, { patientId: 'P-1', token: 'bad', record: { id: 'r1' } })).rejects.toMatchObject({
      name: 'SyncError',
      code: 'unauthorized',
    })
  })

  it('throws SyncError("bad-request") when the server reports bad-request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'bad-request' })))

    await expect(submitAssessment(SYNC_URL, { patientId: 'P-1', token: 't', record: {} })).rejects.toMatchObject({
      code: 'bad-request',
    })
  })

  it('throws SyncError("server-error") when the server reports server-error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'server-error' })))

    await expect(submitAssessment(SYNC_URL, { patientId: 'P-1', token: 't', record: { id: 'r1' } })).rejects.toMatchObject({
      code: 'server-error',
    })
  })

  it('throws SyncError("network") when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))

    await expect(submitAssessment(SYNC_URL, { patientId: 'P-1', token: 't', record: { id: 'r1' } })).rejects.toMatchObject({
      name: 'SyncError',
      code: 'network',
    })
  })

  it('maps an unrecognized server error string to SyncError("server-error") — .code never escapes the four-value contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'totally-unexpected-code' })))

    await expect(submitAssessment(SYNC_URL, { patientId: 'P-1', token: 't', record: { id: 'r1' } })).rejects.toMatchObject({
      code: 'server-error',
    })
  })

  it('throws SyncError("network") on a non-JSON response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('not json')
        },
      }),
    )

    await expect(submitAssessment(SYNC_URL, { patientId: 'P-1', token: 't', record: { id: 'r1' } })).rejects.toMatchObject({
      code: 'network',
    })
  })
})

describe('sync/client — fetchMyScores', () => {
  it('POSTs {action:"myScores", patientId, token} and resolves with the payload', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, displayName: 'สมชาย', records: [{ id: 'r1' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchMyScores(SYNC_URL, { patientId: 'P-1', token: 'tok-1' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(SYNC_URL)
    expect(init.headers['Content-Type']).toBe('text/plain;charset=utf-8')
    expect(JSON.parse(init.body)).toEqual({ action: 'myScores', patientId: 'P-1', token: 'tok-1' })
    expect(result).toEqual({ ok: true, displayName: 'สมชาย', records: [{ id: 'r1' }] })
  })

  it('throws SyncError("unauthorized") on a revoked/typo token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'unauthorized' })))

    await expect(fetchMyScores(SYNC_URL, { patientId: 'P-1', token: 'wrong' })).rejects.toMatchObject({
      name: 'SyncError',
      code: 'unauthorized',
    })
  })

  // plan Task 2 / spec §5: bed (string) and baseline (object|null) ride
  // through fetchMyScores untouched — it is a thin passthrough, the same as
  // displayName/records; syncStore is where malformed-payload defenses live.
  it('passes bed and baseline through untouched, alongside displayName/records', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          displayName: 'สมชาย',
          bed: '304/2',
          baseline: { browDownLeft: 0.1 },
          records: [{ id: 'r1' }],
        }),
      ),
    )

    const result = await fetchMyScores(SYNC_URL, { patientId: 'P-1', token: 'tok-1' })

    expect(result).toEqual({
      ok: true,
      displayName: 'สมชาย',
      bed: '304/2',
      baseline: { browDownLeft: 0.1 },
      records: [{ id: 'r1' }],
    })
  })

  it('passes an unset bed/baseline (\'\'/null) through untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ ok: true, displayName: 'สมชาย', bed: '', baseline: null, records: [] })),
    )

    const result = await fetchMyScores(SYNC_URL, { patientId: 'P-1', token: 'tok-1' })

    expect(result.bed).toBe('')
    expect(result.baseline).toBeNull()
  })
})

describe('sync/client — saveBaselineRemote', () => {
  it('POSTs {action:"saveBaseline", patientId, token, baseline} and resolves with the ack', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const baseline = { browDownLeft: 0.12, jawOpen: 0.03 }
    const result = await saveBaselineRemote(SYNC_URL, { patientId: 'P-1', token: 'tok-1', baseline })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(SYNC_URL)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('text/plain;charset=utf-8')
    expect(JSON.parse(init.body)).toEqual({ action: 'saveBaseline', patientId: 'P-1', token: 'tok-1', baseline })
    expect(result).toEqual({ ok: true })
  })

  it('never places the token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await saveBaselineRemote(SYNC_URL, { patientId: 'P-1', token: 'super-secret-token', baseline: { a: 1 } })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(SYNC_URL)
    expect(url).not.toContain('super-secret-token')
  })

  // Same shared post() helper as submit/myScores — this table pins that
  // saveBaselineRemote inherits the identical four-value error mapping
  // rather than growing its own bespoke handling.
  it('throws SyncError("unauthorized") when the server rejects the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'unauthorized' })))

    await expect(
      saveBaselineRemote(SYNC_URL, { patientId: 'P-1', token: 'bad', baseline: { a: 1 } }),
    ).rejects.toMatchObject({ name: 'SyncError', code: 'unauthorized' })
  })

  it('throws SyncError("bad-request") when the server rejects the baseline shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'bad-request' })))

    await expect(
      saveBaselineRemote(SYNC_URL, { patientId: 'P-1', token: 't', baseline: {} }),
    ).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('throws SyncError("network") when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))

    await expect(
      saveBaselineRemote(SYNC_URL, { patientId: 'P-1', token: 't', baseline: { a: 1 } }),
    ).rejects.toMatchObject({ name: 'SyncError', code: 'network' })
  })
})

describe('sync/client — SyncError', () => {
  it('is a real Error subclass carrying a .code', () => {
    const err = new SyncError('unauthorized')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SyncError')
    expect(err.code).toBe('unauthorized')
  })
})

// Review round 2, MAJOR 1: a request that never settles (captive portal,
// wedged /exec) must not hang forever — it needs a bounded client-side
// deadline. The timeout is overridden to a small value here so the test
// runs fast and deterministically (real timers, no vi.useFakeTimers
// interaction with the fetch mock's own promise machinery).
describe('sync/client — request timeout (review round 2, MAJOR 1)', () => {
  it('aborts a hung request after the configured timeout and surfaces SyncError("network")', async () => {
    __setRequestTimeoutMs(15)
    vi.stubGlobal('fetch', hangingUntilAbort())

    await expect(
      submitAssessment(SYNC_URL, { patientId: 'P-1', token: 't', record: { id: 'r1' } }),
    ).rejects.toMatchObject({ name: 'SyncError', code: 'network' })
  })

  it('clears the timer on an ordinary fast response — no dangling abort fires later', async () => {
    __setRequestTimeoutMs(15)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true, saved: 'inserted' })))

    await expect(
      submitAssessment(SYNC_URL, { patientId: 'P-1', token: 't', record: { id: 'r1' } }),
    ).resolves.toEqual({ ok: true, saved: 'inserted' })

    // If the timer had NOT been cleared, waiting past it would still be
    // harmless (the request already settled) — this just documents intent.
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
})
