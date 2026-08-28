import { describe, it, expect } from 'vitest'

describe('localStorage shim (tests/setup.js)', () => {
  it('installs a localStorage object on globalThis', () => {
    expect(globalThis.localStorage).toBeDefined()
    expect(typeof globalThis.localStorage.getItem).toBe('function')
    expect(typeof globalThis.localStorage.setItem).toBe('function')
    expect(typeof globalThis.localStorage.removeItem).toBe('function')
    expect(typeof globalThis.localStorage.clear).toBe('function')
    expect(typeof globalThis.localStorage.key).toBe('function')
  })

  it('starts empty at the beginning of every test (reset via beforeEach)', () => {
    expect(globalThis.localStorage.length).toBe(0)
    expect(globalThis.localStorage.getItem('anything')).toBeNull()
  })

  it('round-trips string values via setItem/getItem', () => {
    globalThis.localStorage.setItem('foo', 'bar')
    expect(globalThis.localStorage.getItem('foo')).toBe('bar')
    expect(globalThis.localStorage.length).toBe(1)
  })

  it('coerces non-string values to strings like the real Web Storage API', () => {
    globalThis.localStorage.setItem('num', 42)
    expect(globalThis.localStorage.getItem('num')).toBe('42')
  })

  it('removeItem deletes a single key', () => {
    globalThis.localStorage.setItem('a', '1')
    globalThis.localStorage.setItem('b', '2')
    globalThis.localStorage.removeItem('a')
    expect(globalThis.localStorage.getItem('a')).toBeNull()
    expect(globalThis.localStorage.getItem('b')).toBe('2')
  })

  it('clear empties all keys', () => {
    globalThis.localStorage.setItem('a', '1')
    globalThis.localStorage.setItem('b', '2')
    globalThis.localStorage.clear()
    expect(globalThis.localStorage.length).toBe(0)
  })

  it('key(index) returns the nth key, or null out of range', () => {
    globalThis.localStorage.setItem('a', '1')
    expect(globalThis.localStorage.key(0)).toBe('a')
    expect(globalThis.localStorage.key(5)).toBeNull()
  })

  it('does not leak state from a previous test (proves beforeEach reset works)', () => {
    // If the previous test's 'a'/'b' keys leaked, length would be > 0.
    expect(globalThis.localStorage.length).toBe(0)
  })
})
