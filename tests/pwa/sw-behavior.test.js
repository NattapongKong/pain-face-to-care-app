// Behavioral tests for public/sw.js's fetch handler. Unlike pwa.test.js
// (which only parses/greps the source), these actually EXECUTE the real
// sw.js source — via node:vm, as a classic script, exactly how a browser
// loads it — inside a hand-rolled mock of the Service Worker globals
// (self/caches/fetch). This is the only way to catch bugs in the promise
// wiring itself (e.g. a cold-miss+failure path resolving to undefined, or
// a cache write that isn't tracked by event.waitUntil()).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SW_SOURCE = readFileSync(join(__dirname, '../../public/sw.js'), 'utf-8')
const ORIGIN = 'https://painface.test'

function cacheKey(reqOrUrl) {
  return typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url
}

// Evaluates the real sw.js source as a classic script in a fresh vm
// context standing in for the Service Worker global scope, backed by an
// in-memory Map for every named cache. Returns the handlers it registered
// via self.addEventListener, keyed by event type.
function loadServiceWorker({ fetchImpl }) {
  const stores = new Map() // cacheName -> Map(key -> response)
  const openCache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)
    return {
      match: (req) => Promise.resolve(store.get(cacheKey(req))),
      put: (req, res) => {
        store.set(cacheKey(req), res)
        return Promise.resolve()
      },
    }
  }

  const listeners = {}
  const context = {
    URL,
    fetch: fetchImpl,
    caches: {
      open: (name) => Promise.resolve(openCache(name)),
      match: (req) => {
        for (const store of stores.values()) {
          if (store.has(cacheKey(req))) return Promise.resolve(store.get(cacheKey(req)))
        }
        return Promise.resolve(undefined)
      },
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name) => Promise.resolve(stores.delete(name)),
    },
  }
  context.self = context
  context.self.location = { origin: ORIGIN }
  context.self.addEventListener = (type, handler) => {
    listeners[type] = handler
  }
  context.self.skipWaiting = () => {}
  context.self.clients = { claim: () => {} }

  vm.createContext(context)
  vm.runInContext(SW_SOURCE, context, { filename: 'sw.js' })

  return { listeners, stores }
}

// Drives a 'fetch' event through the loaded handler and captures both what
// it passed to respondWith() and every promise it registered via
// waitUntil() — the two things the Fetch/ServiceWorker contract cares
// about and exactly what BUG 1 / BUG 2 broke.
function dispatchFetch(listeners, request) {
  const waitUntilPromises = []
  let respondWithPromise = null
  const event = {
    request,
    waitUntil: (p) => waitUntilPromises.push(p),
    respondWith: (p) => {
      respondWithPromise = p
    },
  }
  listeners.fetch(event)
  return { respondWithPromise, waitUntilPromises }
}

describe('public/sw.js — fetch handler (real source, executed via vm)', () => {
  it('SWR cold-miss + network failure never resolves respondWith() to undefined', async () => {
    const { listeners } = loadServiceWorker({
      fetchImpl: () => Promise.reject(new Error('network down')),
    })
    const request = {
      method: 'GET',
      mode: 'same-origin',
      url: `${ORIGIN}/models/painface-scoring.v1.json`,
    }

    const { respondWithPromise } = dispatchFetch(listeners, request)
    expect(respondWithPromise).toBeInstanceOf(Promise)

    let rejected = false
    let resolvedValue = 'not-settled'
    try {
      resolvedValue = await respondWithPromise
    } catch {
      rejected = true
    }

    // The old (buggy) `.catch(() => cached)` swallowed the network
    // rejection and resolved to `cached` (undefined on a cold miss) —
    // fulfilling respondWith() with undefined, a Fetch-contract
    // violation. The fixed handler must reject instead.
    expect(rejected).toBe(true)
    expect(resolvedValue).not.toBe(undefined)
  })

  it('SWR serves a cached response immediately even when the background revalidation fails', async () => {
    const cachedResponse = { ok: true, status: 200, type: 'basic', clone: () => cachedResponse, tag: 'cached' }
    const { listeners, stores } = loadServiceWorker({
      fetchImpl: () => Promise.reject(new Error('network down')),
    })
    const url = `${ORIGIN}/models/painface-scoring.v1.json`
    stores.set('painface-v1', new Map([[url, cachedResponse]]))

    const { respondWithPromise, waitUntilPromises } = dispatchFetch(listeners, {
      method: 'GET',
      mode: 'same-origin',
      url,
    })

    await expect(respondWithPromise).resolves.toBe(cachedResponse)
    // The background revalidation attempt must be tracked so the worker
    // isn't killed mid-write, and its failure must not reject anything.
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    await expect(Promise.all(waitUntilPromises)).resolves.toBeDefined()
  })

  it('cacheFirst routes the cache.put() write through event.waitUntil() (not fire-and-forget)', async () => {
    const networkResponse = { ok: true, status: 200, type: 'basic', clone: () => networkResponse, tag: 'network' }
    const { listeners, stores } = loadServiceWorker({
      fetchImpl: () => Promise.resolve(networkResponse),
    })
    const url = `${ORIGIN}/assets/index-abc123.js`

    const { respondWithPromise, waitUntilPromises } = dispatchFetch(listeners, {
      method: 'GET',
      mode: 'same-origin',
      url,
    })

    await expect(respondWithPromise).resolves.toBe(networkResponse)

    // BUG 2: the old code called cache.put() without ever handing the
    // promise to event.waitUntil(), so nothing here would register.
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    await Promise.all(waitUntilPromises)

    expect(stores.get('painface-v1')?.get(url)).toBe(networkResponse)
  })
})
