// Registers public/sw.js — the app-shell + heavy-ML-asset cache — so a
// second visit opens instantly even on bad hospital Wi-Fi.
//
// Gated to production builds only: Vite's dev server serves unbundled,
// per-request modules for HMR, and caching those would both break HMR and
// serve stale dev code, so registration must never run under `npm run dev`.
// A registration failure (unsupported browser, sw.js 404, etc.) is logged
// once and never throws — it must not be able to break app boot.
export function registerPainfacePwa() {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('[pwa] service worker registration failed:', err)
  })
}
