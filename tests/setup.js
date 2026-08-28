// In-memory localStorage shim installed on globalThis for the 'node' vitest
// environment (no jsdom / real Storage available). Map-backed, implements
// the subset of the Web Storage API this app relies on: getItem, setItem,
// removeItem, clear, key, length. Reset between tests via beforeEach so no
// state leaks across test files.

class MemoryStorage {
  #map = new Map()

  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null
  }

  setItem(key, value) {
    this.#map.set(key, String(value))
  }

  removeItem(key) {
    this.#map.delete(key)
  }

  clear() {
    this.#map.clear()
  }

  key(index) {
    const keys = Array.from(this.#map.keys())
    return index >= 0 && index < keys.length ? keys[index] : null
  }

  get length() {
    return this.#map.size
  }
}

if (!globalThis.localStorage || typeof globalThis.localStorage.clear !== 'function') {
  globalThis.localStorage = new MemoryStorage()
}

beforeEach(() => {
  globalThis.localStorage.clear()
})
