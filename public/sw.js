// PAIN FACE to Care — service worker (classic script, not a module: Vue's
// build never touches this file, so it is hand-written and hand-versioned).
//
// Bump strategy: bump the numeric suffix on CACHE_NAME (painface-v1 ->
// painface-v2 -> ...) whenever fetch strategy below changes OR whenever a
// precached file's content changes shape in a way old cached bytes would
// break. activate() deletes every "painface-*" cache that isn't the current
// CACHE_NAME, so a version bump is the only thing that ever evicts stale
// entries — without a bump, cache-first assets never expire on their own.
const CACHE_NAME = 'painface-v1'
const PRECACHE_URLS = ['./', './index.html']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('painface-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

function isCacheable(response) {
  // Never cache a failed response, and never cache an opaque one (a
  // no-cors cross-origin response body we can't validate) — an opaque
  // "error" would look identical to an opaque success and get served
  // forever.
  return !!response && response.ok && response.type !== 'opaque'
}

function cacheFirst(request, event) {
  return caches.match(request).then((cached) => {
    if (cached) return cached
    return fetch(request).then((response) => {
      if (isCacheable(response)) {
        const copy = response.clone()
        // Routed through waitUntil() so the browser can't tear this worker
        // down before the write lands — without this the put() is
        // fire-and-forget and cache population becomes probabilistic on
        // exactly the weak devices this is meant to help.
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)))
      }
      return response
    })
  })
}

// Serves the cached copy immediately (if any) while refetching in the
// background to update the cache for next time — used only for
// painface-scoring.v1.json so a retrained model propagates on the visit
// after it changes, without ever blocking the current visit on a network
// round-trip.
function staleWhileRevalidate(request, event) {
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match(request).then((cached) => {
      const revalidate = fetch(request).then((response) => {
        if (isCacheable(response)) {
          event.waitUntil(cache.put(request, response.clone()))
        }
        return response
      })

      if (cached) {
        // Serve the cached copy now; update the cache in the background
        // and never let a background failure surface anywhere — the
        // caller already has `cached`.
        event.waitUntil(revalidate.catch(() => {}))
        return cached
      }

      // Cold miss: there is no cached fallback, so the network response —
      // or its rejection — IS the response. Must never resolve to
      // undefined: respondWith() requires a Response or a rejection, and
      // `cached || network` with `.catch(() => cached)` used to do exactly
      // that when both cached and the network were unavailable.
      return revalidate
    }),
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return // network passthrough

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // network passthrough

  // (a) navigation requests: network-first, falling back to the offline
  // app shell so the SPA still boots with no connectivity.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html')))
    return
  }

  // (b) heavy same-origin build/ML assets: cache-first (or SWR for the
  // scoring model). Everything else (c) falls through to plain network
  // passthrough below.
  if (/\/(assets|wasm|models)\//.test(url.pathname)) {
    if (url.pathname.endsWith('/painface-scoring.v1.json')) {
      event.respondWith(staleWhileRevalidate(request, event))
    } else {
      event.respondWith(cacheFirst(request, event))
    }
  }
})
