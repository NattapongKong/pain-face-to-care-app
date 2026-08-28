// Thin fetch wrapper around the Apps Script gatekeeper's HTTP contract
// (spec §5). A single POST to the configured syncUrl, `text/plain`
// content-type (avoids the CORS preflight GAS cannot answer), the token
// carried in the JSON body only — NEVER in the URL.

export class SyncError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.name = 'SyncError'
    this.code = code
  }
}

// The four-value contract (spec §5 + plan Task 2): 'network' is reserved for
// client-side failures (fetch rejection / non-JSON body) below and is never
// produced from a server payload. Any server `error` string outside the
// three it's allowed to send is coerced to 'server-error' — `.code` must
// never leak an arbitrary/unrecognized value to callers that switch on it.
const KNOWN_SERVER_CODES = new Set(['unauthorized', 'bad-request', 'server-error'])

// Review round 2 (MAJOR 1): outbox.flush() holds a module-level mutex for
// the whole duration of a submit/myScores call — a request that never
// settles (captive portal, a wedged /exec deployment) would otherwise stall
// every later flush, and every later enqueueRecord (which triggers a
// flush), for the rest of the page's lifetime. Bounded via AbortController;
// the abort surfaces through the ordinary fetch-rejection catch below and
// maps to the SAME SyncError('network') as any other network failure — the
// wire format is unchanged, only a client-side deadline is added.
const DEFAULT_REQUEST_TIMEOUT_MS = 25000
let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS

/**
 * Test-only hook: override the request timeout (ms). Call with no
 * arguments to restore the default.
 */
export function __setRequestTimeoutMs(ms = DEFAULT_REQUEST_TIMEOUT_MS) {
  requestTimeoutMs = ms
}

async function post(syncUrl, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs)

  try {
    let response
    try {
      response = await fetch(syncUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch {
      // Covers both an ordinary network failure AND an abort triggered by
      // the timeout above — both are equally "couldn't reach the server".
      throw new SyncError('network', 'failed to reach the sync server')
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      throw new SyncError('network', 'sync server returned a non-JSON response')
    }

    if (!payload || payload.ok !== true) {
      const rawCode = payload && typeof payload.error === 'string' ? payload.error : null
      const code = rawCode && KNOWN_SERVER_CODES.has(rawCode) ? rawCode : 'server-error'
      throw new SyncError(code, `sync server rejected the request (${code})`)
    }

    return payload
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @returns {Promise<{ok:true, saved:'inserted'|'updated'}>}
 */
export function submitAssessment(syncUrl, { patientId, token, record }) {
  return post(syncUrl, { action: 'submit', patientId, token, record })
}

/**
 * Thin passthrough (spec §5/§9): `bed` (string, '' when unset) and
 * `baseline` (object|null) ride through in the resolved payload exactly as
 * the server sent them, same as displayName/records — this layer does no
 * shaping of its own. Malformed-payload defenses (non-string bed, non-plain
 * -object baseline) live one layer up, in syncStore.pull().
 * @returns {Promise<{ok:true, displayName:string, bed:string, baseline:object|null, records:object[]}>}
 */
export function fetchMyScores(syncUrl, { patientId, token }) {
  return post(syncUrl, { action: 'myScores', patientId, token })
}

/**
 * Banks (or updates) the patient's neutral-face baseline vector on the
 * server (spec §4/§5, ruling R38). Same text/plain POST + SyncError mapping
 * as submit/fetchMyScores (shared `post()` helper) — 'bad-request' covers
 * every validation failure the server can report (shape, key/value types,
 * entry count, JSON size).
 * @returns {Promise<{ok:true}>}
 */
export function saveBaselineRemote(syncUrl, { patientId, token, baseline }) {
  return post(syncUrl, { action: 'saveBaseline', patientId, token, baseline })
}
