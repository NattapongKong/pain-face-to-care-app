import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePatientStore } from '../../src/stores/patientStore.js'

const STORAGE_KEY = 'painface.patient.v1'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('stores/patientStore — initial state', () => {
  it('linked is false and fields are empty when nothing is persisted', () => {
    const store = usePatientStore()
    expect(store.linked).toBe(false)
    expect(store.patientId).toBeNull()
    expect(store.token).toBeNull()
    expect(store.displayName).toBe('')
    expect(store.bed).toBe('')
    expect(store.baseline).toBeNull()
  })

  it('restores a previously persisted context on a fresh store instance', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        patientId: 'P-abc123',
        token: 'tok-1',
        displayName: 'สมชาย',
        bed: '304/2',
        baseline: { browDownLeft: 0.1 },
      }),
    )
    const store = usePatientStore()
    expect(store.linked).toBe(true)
    expect(store.patientId).toBe('P-abc123')
    expect(store.token).toBe('tok-1')
    expect(store.displayName).toBe('สมชาย')
    expect(store.bed).toBe('304/2')
    expect(store.baseline).toEqual({ browDownLeft: 0.1 })
  })

  // spec §5: absent keys on an old (pre-round-2) persisted blob must hydrate
  // to defaults rather than crash or leave the fields `undefined`.
  it('hydrates bed/baseline to defaults from an old blob that predates those keys', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ patientId: 'P-abc123', token: 'tok-1', displayName: 'สมชาย' }),
    )
    const store = usePatientStore()
    expect(store.linked).toBe(true)
    expect(store.bed).toBe('')
    expect(store.baseline).toBeNull()
  })

  // Fix round (deferred minor): a tampered/hand-edited blob must not hand
  // a garbage-shaped bed/baseline downstream (a number "bed" or an array
  // "baseline" would become a garbage subtraction vector in the scan
  // layer) — same defenses syncStore.pull() already applies to the wire
  // payload, applied here to the LOCAL hydration path too.
  it('sanitizes a tampered (non-string) bed to \'\' on hydration', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ patientId: 'P-abc123', token: 'tok-1', displayName: 'x', bed: 42, baseline: null }),
    )
    const store = usePatientStore()
    expect(store.linked).toBe(true)
    expect(store.bed).toBe('')
  })

  it('sanitizes a tampered (array) baseline to null on hydration', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ patientId: 'P-abc123', token: 'tok-1', displayName: 'x', bed: '', baseline: [1, 2, 3] }),
    )
    const store = usePatientStore()
    expect(store.linked).toBe(true)
    expect(store.baseline).toBeNull()
  })

  it('sanitizes a tampered (primitive) baseline to null on hydration', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ patientId: 'P-abc123', token: 'tok-1', displayName: 'x', bed: '', baseline: 'not-an-object' }),
    )
    const store = usePatientStore()
    expect(store.baseline).toBeNull()
  })

  it('ignores corrupted persisted JSON and starts unlinked', () => {
    localStorage.setItem(STORAGE_KEY, '{not-json')
    const store = usePatientStore()
    expect(store.linked).toBe(false)
  })

  it('ignores a persisted context missing patientId or token', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ patientId: 'P-abc123' }))
    const store = usePatientStore()
    expect(store.linked).toBe(false)

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'tok-1' }))
    const store2 = usePatientStore()
    expect(store2.linked).toBe(false)
  })
})

describe('stores/patientStore — setContext', () => {
  it('sets patientId/token, resets displayName/bed/baseline, marks linked, and persists', () => {
    const store = usePatientStore()
    store.setContext({ patientId: 'P-abc123', token: 'tok-1' })

    expect(store.linked).toBe(true)
    expect(store.patientId).toBe('P-abc123')
    expect(store.token).toBe('tok-1')
    expect(store.displayName).toBe('')
    expect(store.bed).toBe('')
    expect(store.baseline).toBeNull()

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toEqual({
      patientId: 'P-abc123',
      token: 'tok-1',
      displayName: '',
      bed: '',
      baseline: null,
    })
  })

  it('a later setContext discards the previous displayName/bed/baseline — even for the same id', () => {
    const store = usePatientStore()
    store.setContext({ patientId: 'P-aaa', token: 'tok-a' })
    store.applyServerInfo({ displayName: 'สมชาย', bed: '304/2', baseline: { browDownLeft: 0.1 } })
    expect(store.displayName).toBe('สมชาย')

    store.setContext({ patientId: 'P-aaa', token: 'tok-a' })
    expect(store.displayName).toBe('')
    expect(store.bed).toBe('')
    expect(store.baseline).toBeNull()
  })

  it('persists across a fresh store instance — the device stays linked after one scan', () => {
    const store1 = usePatientStore()
    store1.setContext({ patientId: 'P-abc123', token: 'tok-1' })

    setActivePinia(createPinia())
    const store2 = usePatientStore()
    expect(store2.linked).toBe(true)
    expect(store2.patientId).toBe('P-abc123')
    expect(store2.token).toBe('tok-1')
  })
})

describe('stores/patientStore — applyServerInfo', () => {
  it('updates displayName/bed/baseline and persists alongside the existing context', () => {
    const store = usePatientStore()
    store.setContext({ patientId: 'P-abc123', token: 'tok-1' })
    store.applyServerInfo({ displayName: 'สมชาย', bed: '304/2', baseline: { browDownLeft: 0.1 } })

    expect(store.displayName).toBe('สมชาย')
    expect(store.bed).toBe('304/2')
    expect(store.baseline).toEqual({ browDownLeft: 0.1 })
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY))
    expect(persisted.displayName).toBe('สมชาย')
    expect(persisted.bed).toBe('304/2')
    expect(persisted.baseline).toEqual({ browDownLeft: 0.1 })
  })

  it('still updates in-memory state, but persists nothing, when unlinked', () => {
    const store = usePatientStore()
    store.applyServerInfo({ displayName: 'สมชาย', bed: '304/2', baseline: { browDownLeft: 0.1 } })

    expect(store.displayName).toBe('สมชาย')
    expect(store.bed).toBe('304/2')
    expect(store.baseline).toEqual({ browDownLeft: 0.1 })
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  // Fix round (deferred minor): reviewer probed that store.baseline ended
  // up the SAME object reference as the caller's (syncStore.serverBaseline,
  // in practice) — mutating one mutated the other. A shallow copy stops the
  // banked vector handed to the scan layer from ever aliasing syncStore
  // state.
  it('stores a copy of the baseline object, never the same reference as the caller\'s', () => {
    const store = usePatientStore()
    store.setContext({ patientId: 'P-abc123', token: 'tok-1' })
    const source = { browDownLeft: 0.1 }

    store.applyServerInfo({ displayName: 'สมชาย', bed: '304/2', baseline: source })

    expect(store.baseline).not.toBe(source)
    source.browDownLeft = 0.99 // mutate the ORIGINAL object afterwards
    expect(store.baseline).toEqual({ browDownLeft: 0.1 }) // unaffected
  })

  it('leaves a null baseline as null (no copy attempted)', () => {
    const store = usePatientStore()
    store.setContext({ patientId: 'P-abc123', token: 'tok-1' })

    store.applyServerInfo({ displayName: 'สมชาย', bed: '304/2', baseline: null })

    expect(store.baseline).toBeNull()
  })
})

describe('stores/patientStore — setBaseline', () => {
  it('updates baseline only and persists alongside the existing context', () => {
    const store = usePatientStore()
    store.setContext({ patientId: 'P-abc123', token: 'tok-1' })
    store.applyServerInfo({ displayName: 'สมชาย', bed: '304/2', baseline: null })

    store.setBaseline({ browDownLeft: 0.2, jawOpen: 0.05 })

    expect(store.baseline).toEqual({ browDownLeft: 0.2, jawOpen: 0.05 })
    expect(store.displayName).toBe('สมชาย') // untouched
    expect(store.bed).toBe('304/2') // untouched
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY))
    expect(persisted.baseline).toEqual({ browDownLeft: 0.2, jawOpen: 0.05 })
  })

  it('still updates in-memory state, but persists nothing, when unlinked', () => {
    const store = usePatientStore()
    store.setBaseline({ browDownLeft: 0.2 })

    expect(store.baseline).toEqual({ browDownLeft: 0.2 })
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})

describe('stores/patientStore — clear', () => {
  it('wipes state and storage — ออกจากผู้ป่วย returns the device to unlinked, local-only behavior', () => {
    const store = usePatientStore()
    store.setContext({ patientId: 'P-abc123', token: 'tok-1' })
    store.applyServerInfo({ displayName: 'สมชาย', bed: '304/2', baseline: { browDownLeft: 0.1 } })

    store.clear()

    expect(store.linked).toBe(false)
    expect(store.patientId).toBeNull()
    expect(store.token).toBeNull()
    expect(store.displayName).toBe('')
    expect(store.bed).toBe('')
    expect(store.baseline).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('a fresh store instance after clear() stays unlinked (the wipe actually persisted)', () => {
    const store1 = usePatientStore()
    store1.setContext({ patientId: 'P-abc123', token: 'tok-1' })
    store1.clear()

    setActivePinia(createPinia())
    const store2 = usePatientStore()
    expect(store2.linked).toBe(false)
    expect(store2.patientId).toBeNull()
  })
})
