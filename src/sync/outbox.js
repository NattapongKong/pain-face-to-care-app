// Offline-first outbox (spec §6): a localStorage queue of assessments not
// yet acknowledged by the sync server. Data must never be silently
// dropped — a failed submission stays queued (with `attempts` incremented)
// for the next flush; there is no cap and no timer, only event-driven
// retries (online event, next enqueue, app boot).
//
// Review round 1 (BLOCKER 1): flush() used to read the queue ONCE at the
// start and write that same stale snapshot back at the end — anything
// enqueued (or replaced-by-recordId) while the network round-trips were in
// flight got silently wiped out by that final write. Fixed by (i) a
// module-level in-flight guard so overlapping flush() calls never run their
// read-modify-write cycles concurrently — a call made while one is already
// running chains behind it and does its own FRESH pass once that one
// finishes; (ii) the write-back always re-reads the queue at commit time
// and merges outcomes onto whatever is actually there, rather than
// replacing wholesale; (iii) an outcome (sent or failed) is only applied to
// the currently-stored entry if it is the EXACT one that was sent.
//
// Review round 2: (iii) above compared identity by (recordId, queuedAt),
// which is blind to a same-millisecond replacement (two enqueue() calls in
// the same JS tick share a queuedAt down to millisecond resolution).
// Identity is now a module-monotonic `seq`, stamped by enqueue() itself
// (never caller-supplied) — queuedAt remains for ordering only. Also:
// enqueue()'s return value now honestly reflects whether the write
// persisted (null on failure, minor 3); readQueue()/flushOnce() are fully
// non-throwing so the "flush() never rejects" contract is actually true,
// not just documented (minor 7); and a test-only __resetOutbox() clears
// all module-level state so one file's hung-fetch test can't wedge every
// test after it (minor 6).
//
// Review round 3 (BLOCKER 1): `seqCounter` restarted at 0 on every module
// load (page load) while items already PERSISTED from a prior session kept
// their old seq — a fresh session's first enqueue() got seq:1 again,
// colliding with a still-queued persisted item that was ALSO seq:1. Fixed
// belt-and-braces: (i) the counter is seeded from the persisted max at
// module load AND inside __resetOutbox(), so a fresh session never reuses
// an already-persisted seq; (ii) the ack-identity check additionally
// requires `queuedAt` to match `seq` — a cross-session collision (should
// the reseed ever be wrong) differs in queuedAt even if seq coincides, and
// a same-tick replace (round 2's hole) differs in seq even when queuedAt
// coincides, so either divergence alone is caught. Also: flushOnce stops a
// pass after the FIRST 'network' failure (minor 4) — a dead server
// shouldn't cost 25s-timeout x N-queued-items and inflate every other
// item's attempts counter in the same pass; and isQueueItem now validates
// patientId/token/record too, not just recordId (minor 6) — a malformed
// entry is dropped at read time instead of being retried forever.

import { submitAssessment, SyncError } from './client.js'

const OUTBOX_KEY = 'painface.outbox.v1'

function isQueueItem(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.recordId === 'string' &&
    value.recordId.length > 0 &&
    typeof value.patientId === 'string' &&
    value.patientId.length > 0 &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    !!value.record &&
    typeof value.record === 'object' &&
    !Array.isArray(value.record)
  )
}

function readQueue() {
  let raw
  try {
    raw = globalThis.localStorage.getItem(OUTBOX_KEY)
  } catch {
    return []
  }
  if (raw === null || raw === undefined) return []
  try {
    const parsed = JSON.parse(raw)
    // Corrupted storage is treated as an empty queue (never throws); a
    // parseable array with garbage entries mixed in keeps only the items
    // shaped like real queue entries (minor 8).
    return Array.isArray(parsed) ? parsed.filter(isQueueItem) : []
  } catch {
    return []
  }
}

// Storage writes must never throw out of the sync layer (round 1 MAJOR 2) —
// the sync engine is additive and must never break local-only
// finalize/save. `storageOk()` exposes whether the LAST write attempt
// succeeded so a caller (syncStore) can surface a real, observable failure
// state instead of silently losing data.
let lastWriteFailed = false

function writeQueue(queue) {
  try {
    globalThis.localStorage.setItem(OUTBOX_KEY, JSON.stringify(queue))
    lastWriteFailed = false
    return true
  } catch {
    lastWriteFailed = true
    return false
  }
}

/** @returns {boolean} whether the most recent storage write succeeded. */
export function storageOk() {
  return !lastWriteFailed
}

// Module-monotonic identity (round 2 minor 2): queuedAt alone collides for
// two enqueue() calls landing in the same millisecond (a real, probed
// scenario — same-tick reassessment replace). `seq` is stamped here, never
// accepted from the caller, so it can never collide within a session.
//
// Round 3 BLOCKER 1: a NEW session (module load / page refresh) must not
// restart the counter at 0 while a still-queued PERSISTED item already
// carries a seq from the prior session — seeding from the persisted max
// closes that cross-session collision.
function seedSeqCounter() {
  return Math.max(0, ...readQueue().map((i) => Number(i.seq) || 0))
}

let seqCounter = seedSeqCounter()

/**
 * Queue (or replace) one assessment for sync. An item already queued under
 * the same `recordId` is replaced outright — the latest record state wins,
 * queue length unchanged — so a reassessment update supersedes the
 * not-yet-sent original rather than piling up a stale duplicate. Rejects
 * (safe no-op, returns null) anything without a non-empty string
 * `recordId` — malformed input must never reach storage. Also returns null
 * (round 2 minor 3) if the write itself failed to persist — the return
 * value must never claim success it didn't achieve.
 * @param {{recordId:string, patientId:string, token:string, record:object, queuedAt:string, attempts:number}} item
 * @returns {object|null} the stored item (including its stamped `seq`), or null
 */
export function enqueue(item) {
  if (!isQueueItem(item)) return null
  const queue = readQueue().filter((existing) => existing.recordId !== item.recordId)
  const stamped = { ...item, seq: ++seqCounter }
  queue.push(stamped)
  return writeQueue(queue) ? stamped : null
}

/** @returns {object[]} every item currently queued. */
export function pending() {
  return readQueue()
}

/** Module-level in-flight guard (round 1 BLOCKER 1i): serializes flush()
 * cycles so two overlapping callers never race their read-modify-write
 * against each other. A call made while one is already running is chained
 * to start its own fresh pass only once the current one has fully settled. */
let mutex = Promise.resolve()

async function flushOnce(syncUrl) {
  const snapshot = readQueue()
  if (snapshot.length === 0) return { sent: [], failed: [] }

  const ordered = [...snapshot].sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0))

  // Attempt every item first, recording each OUTCOME against the identity
  // (`seq` + `queuedAt`) of the item as it was when we sent it — the
  // write-back below decides, per currently-stored item, whether that
  // outcome still applies.
  const outcomes = []
  for (const item of ordered) {
    try {
      await submitAssessment(syncUrl, { patientId: item.patientId, token: item.token, record: item.record })
      outcomes.push({ recordId: item.recordId, seq: item.seq, queuedAt: item.queuedAt, status: 'sent' })
    } catch (err) {
      const code = err instanceof SyncError ? err.code : 'network'
      outcomes.push({ recordId: item.recordId, seq: item.seq, queuedAt: item.queuedAt, status: 'failed', errorCode: code })
      // Round 3 minor 4: a 'network' failure (including the 25s request
      // timeout) means the server is unreachable for THIS pass — trying
      // every other queued item too would cost up to 25s x N and inflate
      // every one of their attempts counters for no informational gain.
      // Non-network failures (unauthorized/bad-request/server-error) are
      // per-item verdicts from a server that IS responding, so the pass
      // continues for those.
      if (code === 'network') break
    }
  }

  // BLOCKER 1ii: fresh read at commit time — anything enqueued or replaced
  // while the network round-trips above were in flight is picked up here,
  // never clobbered by a stale snapshot.
  const live = readQueue()
  const sent = []
  const failed = []
  const merged = []

  for (const current of live) {
    const outcome = outcomes.find((o) => o.recordId === current.recordId)
    // No outcome this round (enqueued mid-flight, or simply a different
    // item) -> leave it exactly as-is.
    if (!outcome) {
      merged.push(current)
      continue
    }
    // BLOCKER 1iii (round 3: identity via BOTH `seq` AND `queuedAt`): the
    // outcome only applies if the stored entry is the EXACT one we sent. A
    // recordId match with a different seq OR a different queuedAt means it
    // was replaced-by-recordId mid-flight — either a same-tick reassessment
    // update (same queuedAt, different seq — round 2's hole) or a
    // cross-session collision (same seq, different queuedAt — round 3's
    // hole, closed belt-and-braces alongside the seq-counter reseed above).
    // That stale outcome must not delete the replacement or mark it
    // synced/failed; the replacement stays queued untouched for the next
    // pass.
    if (current.seq !== outcome.seq || current.queuedAt !== outcome.queuedAt) {
      merged.push(current)
      continue
    }
    if (outcome.status === 'sent') {
      sent.push(current.recordId)
      continue // acked -> drop from the queue
    }
    failed.push(current.recordId)
    merged.push({ ...current, attempts: (current.attempts ?? 0) + 1, lastError: outcome.errorCode })
  }

  writeQueue(merged)
  return { sent, failed }
}

/**
 * Attempt to submit queued items, oldest (`queuedAt`) first, STOPPING the
 * pass after the first 'network' failure (round 3 minor 4) — a dead server
 * would otherwise cost up to the 25s request timeout for every remaining
 * item and inflate every one of their attempts counters for no
 * informational gain; a per-item server verdict (unauthorized/bad-request/
 * server-error) does not stop the pass. Acked items are removed; failed
 * items are kept with `attempts` incremented and `lastError` set to the
 * failure's SyncError code (cleared implicitly on a later success, since
 * the item is then removed) — never dropped. Items never attempted this
 * pass (because it stopped early, or because they were enqueued mid-flight)
 * are left completely untouched. Never rejects: a storage read/write
 * failure, or any other unexpected internal error, is swallowed and
 * resolves to an empty outcome; storage failures are additionally
 * observable via `storageOk()`.
 * @returns {Promise<{sent: string[], failed: string[]}>}
 */
export function flush(syncUrl) {
  const run = mutex.then(
    () => flushOnce(syncUrl).catch(() => ({ sent: [], failed: [] })), // round 2 minor 7: make "never rejects" literally true
    () => flushOnce(syncUrl).catch(() => ({ sent: [], failed: [] })),
  )
  // Keep the chain alive for the NEXT caller regardless of outcome, so one
  // flush's rejection (should that ever happen) can't wedge every flush()
  // call after it.
  mutex = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Test-only: resets all module-level state (the flush mutex, the
 * last-write-failed flag, and the seq counter) so one test's hung fetch or
 * simulated storage failure can never bleed into — and wedge — the next
 * test in the same file.
 */
export function __resetOutbox() {
  mutex = Promise.resolve()
  lastWriteFailed = false
  seqCounter = seedSeqCounter()
}
