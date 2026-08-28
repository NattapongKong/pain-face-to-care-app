// Runtime sync configuration (spec §6, §12). The GAS endpoint is shipped as
// a plain static JSON file next to the deployed app
// (`public/sync-config.json`), NOT baked into the build, so the owner can
// point the app at a deployed Apps Script web app (or roll it back to
// local-only) by editing one file — no rebuild required.
//
// Fallback chain, in order:
//   1. fetch succeeds with a valid payload -> use it, cache it.
//   2. HTTP 404 (Lead ruling R31): the file was deliberately not deployed,
//      which IS a valid, intentional statement of "local-only" — return
//      {syncUrl:''} directly, do NOT fall back to a stale cache (that would
//      resurrect a config the owner just removed).
//   3. fetch fails otherwise (rejects, or any other non-ok HTTP status —
//      a transient 5xx, for instance) -> fall back to the last cached
//      copy, if any.
//   4. fetch succeeds but the body is malformed (bad JSON / not an object /
//      syncUrl not a string) -> local-only ({syncUrl:''}) WITHOUT touching
//      the cache — a corrupt deploy must not evict a previously-good config.
//   5. nothing usable anywhere -> {syncUrl:''} = today's exact local-only
//      behavior (spec §1, §12).
//
// Review round 1 (MAJOR 2): the cache write is best-effort — a full/quota-
// exceeded localStorage must never throw out of loadSyncConfig(); the
// freshly-fetched config is still returned even if caching it fails.

const CACHE_KEY = 'painface.syncconfig.v1'

function readCache() {
  const raw = globalThis.localStorage.getItem(CACHE_KEY)
  if (raw === null || raw === undefined) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeCache(config) {
  try {
    globalThis.localStorage.setItem(CACHE_KEY, JSON.stringify(config))
  } catch {
    // Best-effort cache only — a full/quota-exceeded localStorage must
    // never break the (already-successful) config load itself.
  }
}

function isValidConfig(payload) {
  return !!payload && typeof payload === 'object' && typeof payload.syncUrl === 'string'
}

function fallbackToCache() {
  const cached = readCache()
  return isValidConfig(cached) ? { syncUrl: cached.syncUrl } : { syncUrl: '' }
}

/** @returns {Promise<{syncUrl: string}>} */
export async function loadSyncConfig() {
  let response
  try {
    response = await fetch(`${import.meta.env.BASE_URL}sync-config.json`)
  } catch {
    return fallbackToCache()
  }

  if (response.status === 404) return { syncUrl: '' }
  if (!response.ok) return fallbackToCache()

  let payload
  try {
    payload = await response.json()
  } catch {
    return { syncUrl: '' }
  }

  if (!isValidConfig(payload)) return { syncUrl: '' }

  const config = { syncUrl: payload.syncUrl }
  writeCache(config)
  return config
}
