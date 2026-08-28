// Pins review round 2 MAJOR N2 (one shared boot/re-scan helper, replacing
// two hand-written copies that drifted apart) and MAJOR N1(b) (the
// caller-side bail: a resolved serverDisplayName must never be persisted
// onto patientStore for a patient the device has since moved on from).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSyncStore } from '../../src/stores/syncStore.js'
import { usePatientStore } from '../../src/stores/patientStore.js'
import { pullForPatient } from '../../src/stores/syncHelpers.js'
import { __setRequestTimeoutMs } from '../../src/sync/client.js'

const SYNC_URL = 'https://script.google.com/macros/s/deadbeef/exec'

/** Config fetch resolves immediately; each myScores POST is individually,
 * manually resolvable via the returned `resolvers` array (in call order). */
function stubControllableFetch() {
  const resolvers = []
  let call = 0
  const fetchMock = vi.fn((url, init) => {
    if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: SYNC_URL }) })
    const idx = call++
    return new Promise((resolve, reject) => {
      resolvers[idx] = { resolve, reject }
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, resolvers }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  __setRequestTimeoutMs()
})

describe('syncHelpers.pullForPatient', () => {
  it('always initializes syncStore, even when unlinked (no pull attempted)', async () => {
    const { fetchMock } = stubControllableFetch()
    const syncStore = useSyncStore()
    const patientStore = usePatientStore()

    await pullForPatient(syncStore, patientStore)

    expect(syncStore.initialized).toBe(true)
    expect(syncStore.configured).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the config fetch
  })

  it('pulls and persists the resolved display name/bed/baseline when linked', async () => {
    const { resolvers } = stubControllableFetch()
    const syncStore = useSyncStore()
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })

    const p = pullForPatient(syncStore, patientStore)
    await vi.waitFor(() => expect(resolvers[0]).toBeDefined())
    resolvers[0].resolve({
      ok: true,
      json: async () => ({ ok: true, displayName: 'สมชาย', bed: '304/2', baseline: { browDownLeft: 0.1 }, records: [] }),
    })
    await p

    expect(patientStore.displayName).toBe('สมชาย')
    expect(patientStore.bed).toBe('304/2')
    expect(patientStore.baseline).toEqual({ browDownLeft: 0.1 })
  })

  // Fix round (minor 2): the round-1 version of this test pinned the WRONG
  // property — an empty displayName (e.g. a hand-edited Sheet row) is still
  // a SUCCESSFUL pull and must still copy bed/baseline. Gating must key off
  // pull()'s response-ownership return value, never off displayName content.
  it('a successful pull with an empty displayName still copies bed/baseline', async () => {
    const { resolvers } = stubControllableFetch()
    const syncStore = useSyncStore()
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })

    const p = pullForPatient(syncStore, patientStore)
    await vi.waitFor(() => expect(resolvers[0]).toBeDefined())
    resolvers[0].resolve({ ok: true, json: async () => ({ ok: true, displayName: '', bed: '304/2', baseline: { a: 1 }, records: [] }) })
    await p

    expect(patientStore.displayName).toBe('')
    expect(patientStore.bed).toBe('304/2')
    expect(patientStore.baseline).toEqual({ a: 1 })
  })

  // plan Task 2: "no copy on auth failure" — a revoked/typo QR must never
  // write anything (stale or otherwise) into patientStore.
  it('does not call applyServerInfo when the pull is unauthorized', async () => {
    const { resolvers } = stubControllableFetch()
    const syncStore = useSyncStore()
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })
    const applyServerInfoSpy = vi.spyOn(patientStore, 'applyServerInfo')

    const p = pullForPatient(syncStore, patientStore)
    await vi.waitFor(() => expect(resolvers[0]).toBeDefined())
    resolvers[0].resolve({ ok: true, json: async () => ({ ok: false, error: 'unauthorized' }) })
    await p

    expect(applyServerInfoSpy).not.toHaveBeenCalled()
    expect(syncStore.authFailed).toBe(true)
  })

  // MAJOR N1(b): the caller-side bail. Isolated from syncStore.pull()'s own
  // pullSeq guard (N1a) by construction — only ONE pull() call happens in
  // this test, so pullSeq never invalidates it; the context change alone
  // must be enough to stop pullForPatient from persisting the stale name.
  it('never persists a resolved display name once the context has moved on to a different patient mid-flight', async () => {
    const { resolvers } = stubControllableFetch()
    const syncStore = useSyncStore()
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })

    const p = pullForPatient(syncStore, patientStore)
    await vi.waitFor(() => expect(resolvers[0]).toBeDefined())

    patientStore.setContext({ patientId: 'B', token: 'tok-b' }) // rescanned mid-flight

    resolvers[0].resolve({
      ok: true,
      json: async () => ({ ok: true, displayName: 'A-name', bed: 'A-bed', baseline: { a: 1 }, records: [] }),
    })
    await p

    // setContext('B') itself resets displayName/bed/baseline to defaults —
    // the bail's job is simply to never overwrite those with A's stale
    // values afterwards.
    expect(patientStore.displayName).toBe('')
    expect(patientStore.bed).toBe('')
    expect(patientStore.baseline).toBeNull()
  })

  // Fix round MAJOR — reviewer probe: syncStore.pull() leaves server*
  // UNTOUCHED on unauthorized/network failure. Gating the copy on
  // `serverDisplayName` truthiness (round 1) only "worked" because
  // something ELSE (router.js's resetServer() call, owned by a different
  // task/wave) happened to clear that stale state first. Without a
  // resetServer() call in between — e.g. two sequential re-links in the
  // same tick before that other wiring lands — patient B's FAILED pull must
  // never let patient A's stale server* survive into B's patientStore.
  it('never copies stale server* state into a new context when that context\'s own pull fails (no resetServer call in between)', async () => {
    const { resolvers } = stubControllableFetch()
    const syncStore = useSyncStore()
    const patientStore = usePatientStore()

    // Patient A: a genuinely successful pull seeds syncStore.server*.
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })
    const pA = pullForPatient(syncStore, patientStore)
    await vi.waitFor(() => expect(resolvers[0]).toBeDefined())
    resolvers[0].resolve({
      ok: true,
      json: async () => ({ ok: true, displayName: 'A-name', bed: 'A-bed', baseline: { a: 1 }, records: [] }),
    })
    await pA
    expect(patientStore.bed).toBe('A-bed') // sanity: A's pull really did land

    // Device re-scans a DIFFERENT patient, B — deliberately with NO
    // resetServer() call in between (that's a different task's wiring;
    // this test proves pullForPatient must not depend on it).
    patientStore.setContext({ patientId: 'B', token: 'tok-b' })
    const applyServerInfoSpy = vi.spyOn(patientStore, 'applyServerInfo')

    const pB = pullForPatient(syncStore, patientStore)
    await vi.waitFor(() => expect(resolvers[1]).toBeDefined())
    resolvers[1].resolve({ ok: true, json: async () => ({ ok: false, error: 'unauthorized' }) }) // B's OWN pull fails
    await pB

    expect(applyServerInfoSpy).not.toHaveBeenCalled()
    // setContext('B') reset these; A's stale bed/baseline (still sitting in
    // syncStore.serverBed/serverBaseline, untouched by B's failed pull)
    // must never have been re-copied on top.
    expect(patientStore.bed).toBe('')
    expect(patientStore.baseline).toBeNull()
  })
})
