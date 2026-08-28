// Runtime sync config: a static JSON file next to the deployed app so the
// GAS endpoint can be changed without a rebuild (spec §6, §12). Covers the
// full fallback chain: fetch -> localStorage cache -> local-only default.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadSyncConfig } from '../../src/sync/config.js'

const CACHE_KEY = 'painface.syncconfig.v1'

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('sync/config — loadSyncConfig', () => {
  it('uses a valid fetched config and caches it to localStorage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ syncUrl: 'https://script.google.com/macros/s/abc/exec' }))
    vi.stubGlobal('fetch', fetchMock)

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: 'https://script.google.com/macros/s/abc/exec' })
    expect(JSON.parse(localStorage.getItem(CACHE_KEY))).toEqual({ syncUrl: 'https://script.google.com/macros/s/abc/exec' })
  })

  it('fetches exactly BASE_URL + sync-config.json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ syncUrl: '' }))
    vi.stubGlobal('fetch', fetchMock)

    await loadSyncConfig()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}sync-config.json`)
  })

  it('falls back to the cached copy when the fetch rejects (offline boot)', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ syncUrl: 'https://cached.example/exec' }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')))

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: 'https://cached.example/exec' })
  })

  it('falls back to local-only ({syncUrl:""}) when the fetch rejects and nothing is cached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')))

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: '' })
  })

  it('falls back to the cached copy when the response is a non-404 non-ok status (e.g. a transient 500)', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ syncUrl: 'https://cached.example/exec' }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false)))

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: 'https://cached.example/exec' })
  })

  // Lead ruling R31: a 404 is an intentional statement ("no config file
  // deployed here") rather than a transient failure, so it must NOT
  // resurrect a stale cached syncUrl the owner may have deliberately
  // removed by deleting/renaming the file.
  it('returns {syncUrl:""} on HTTP 404 WITHOUT falling back to any cached copy', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ syncUrl: 'https://cached.example/exec' }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }))

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: '' })
  })

  it('a cache-write failure (e.g. QuotaExceededError) never throws and still returns the freshly fetched config', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ syncUrl: 'https://fresh.example/exec' })))
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      const err = new Error('quota exceeded')
      err.name = 'QuotaExceededError'
      throw err
    })

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: 'https://fresh.example/exec' })
  })

  it('returns {syncUrl:""} on invalid JSON body WITHOUT poisoning an existing cache', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ syncUrl: 'https://cached.example/exec' }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      }),
    )

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: '' })
    expect(JSON.parse(localStorage.getItem(CACHE_KEY))).toEqual({ syncUrl: 'https://cached.example/exec' })
  })

  it('returns {syncUrl:""} on a non-object payload WITHOUT poisoning an existing cache', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ syncUrl: 'https://cached.example/exec' }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('not-an-object')))

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: '' })
    expect(JSON.parse(localStorage.getItem(CACHE_KEY))).toEqual({ syncUrl: 'https://cached.example/exec' })
  })

  it('returns {syncUrl:""} when syncUrl is not a string, without poisoning the cache', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ syncUrl: 'https://cached.example/exec' }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ syncUrl: 12345 })))

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: '' })
    expect(JSON.parse(localStorage.getItem(CACHE_KEY))).toEqual({ syncUrl: 'https://cached.example/exec' })
  })

  it('an empty syncUrl from a valid fetch is used as-is (local-only mode) and cached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ syncUrl: '' })))

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: '' })
    expect(JSON.parse(localStorage.getItem(CACHE_KEY))).toEqual({ syncUrl: '' })
  })

  it('a corrupted cache is treated as no cache (falls to local-only) on fetch failure', async () => {
    localStorage.setItem(CACHE_KEY, '{not json')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')))

    const config = await loadSyncConfig()

    expect(config).toEqual({ syncUrl: '' })
  })
})
