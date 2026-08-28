// @vitest-environment jsdom
//
// R4 Task 1 (client self-install, spec §2/§3, plan T1): ConnectView's
// states — confirm (?u= valid, unconfirmed), success (confirmed this
// session), invalid (?u= malformed), blocked (R45 outbox guard),
// already-connected (same url as the live file config), and bare
// (configured/unconfigured) — plus the share-QR + copy-link +
// override-only ยกเลิก gating on the bare-configured state. syncStore
// state is set directly (no init()/fetch involved) so each test starts
// from a known, explicit source — same convention as
// tests/ui/patientContextCard.test.js and tests/stores/patientStore.test.js.
//
// Fix round 1 (Opus review) additions live in their own describe blocks
// below, each labeled with the finding it pins.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import ConnectView from '../../src/views/ConnectView.vue'
import HomeView from '../../src/views/HomeView.vue'
import { useSyncStore } from '../../src/stores/syncStore.js'
import { useToast } from '../../src/components/ui'
import { enqueue, pending, __resetOutbox } from '../../src/sync/outbox.js'

const VALID_URL = 'https://script.google.com/macros/s/deadbeef/exec'
const OTHER_URL = 'https://script.google.com/macros/s/other-deploy-id/exec'
const OVERRIDE_KEY = 'painface.syncUrl.override.v1'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/connect', name: 'connect', component: ConnectView, props: (route) => ({ u: route.query.u }) },
    ],
  })
}

async function mountConnect(u) {
  const router = makeRouter()
  router.push('/connect')
  await router.isReady()
  const wrapper = mount(ConnectView, {
    props: { u },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  return { wrapper, router }
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetOutbox()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __resetOutbox()
})

describe('ConnectView — ?u= confirm flow', () => {
  it('a valid u shows the confirm state with the host emphasized', async () => {
    const { wrapper } = await mountConnect(VALID_URL)

    expect(wrapper.text()).toContain('เชื่อมต่อกับฐานข้อมูลกลางนี้หรือไม่?')
    expect(wrapper.text()).toContain('script.google.com')
    expect(wrapper.text()).toContain(VALID_URL)
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'เชื่อมต่อ')).toBe(true)
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ยกเลิก')).toBe(true)

    wrapper.unmount()
  })

  it('confirming calls applySyncOverride and moves to the success state', async () => {
    const { wrapper } = await mountConnect(VALID_URL)
    const syncStore = useSyncStore()
    expect(syncStore.configured).toBe(false)

    const confirmButton = wrapper.findAll('button').find((b) => b.text().trim() === 'เชื่อมต่อ')
    await confirmButton.trigger('click')

    expect(syncStore.configured).toBe(true)
    expect(syncStore.syncUrl).toBe(VALID_URL)
    expect(syncStore.syncSource).toBe('override')
    expect(wrapper.text()).toContain('เชื่อมต่อกับฐานข้อมูลกลางสำเร็จ')
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ไปหน้าหลัก')).toBe(true)

    wrapper.unmount()
  })

  it('cancelling navigates home without touching syncStore', async () => {
    const { wrapper, router } = await mountConnect(VALID_URL)
    const syncStore = useSyncStore()

    const cancelButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ยกเลิก')
    await cancelButton.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/')
    expect(syncStore.configured).toBe(false)

    wrapper.unmount()
  })

  it.each([
    ['http (not https)', 'http://script.google.com/macros/s/x/exec'],
    ['non-google host', 'https://evil.example.com/macros/s/x/exec'],
    ['missing /exec', 'https://script.google.com/macros/s/x/dev'],
  ])('a malformed u (%s) renders the invalid state, not a confirm — no crash, no state change', async (_label, badUrl) => {
    const { wrapper } = await mountConnect(badUrl)
    const syncStore = useSyncStore()

    expect(wrapper.text()).toContain('ลิงก์เชื่อมต่อไม่ถูกต้อง')
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'เชื่อมต่อ')).toBe(false)
    expect(syncStore.configured).toBe(false)

    wrapper.unmount()
  })

  it('an empty u (bare route) does not render the invalid state', async () => {
    const { wrapper } = await mountConnect('')

    expect(wrapper.text()).not.toContain('ลิงก์เชื่อมต่อไม่ถูกต้อง')

    wrapper.unmount()
  })

  it('a repeated query key (u as an array) reads the first value', async () => {
    const { wrapper } = await mountConnect([VALID_URL, 'https://script.google.com/macros/s/second/exec'])

    expect(wrapper.text()).toContain(VALID_URL)
    expect(wrapper.text()).not.toContain('second/exec')

    wrapper.unmount()
  })

  // Fix round 1 minor 5: a shape check (isValidSyncUrl) can only prove a
  // link is malformed, never that it USED to be valid and has since
  // expired — the old copy claimed both.
  it('minor 5: the invalid-link copy does not claim expiry, only invalidity', async () => {
    const { wrapper } = await mountConnect('http://script.google.com/macros/s/x/exec')

    expect(wrapper.text()).not.toContain('หมดอายุ')

    wrapper.unmount()
  })

  // Fix round 1 minor 4: a pasted/scanned link can pick up stray
  // whitespace (e.g. a trailing %0A) — trimmed in the view before any
  // validation/comparison, and the TRIMMED value is what actually gets
  // persisted on confirm.
  it('minor 4: trims whitespace (incl. a stray trailing newline) from u before validating', async () => {
    const { wrapper } = await mountConnect(`  ${VALID_URL}\n`)
    const syncStore = useSyncStore()

    expect(wrapper.text()).toContain('เชื่อมต่อกับฐานข้อมูลกลางนี้หรือไม่?')
    expect(wrapper.text()).toContain(VALID_URL)

    const confirmButton = wrapper.findAll('button').find((b) => b.text().trim() === 'เชื่อมต่อ')
    await confirmButton.trigger('click')

    expect(syncStore.syncUrl).toBe(VALID_URL) // the TRIMMED value, not the padded raw one

    wrapper.unmount()
  })

  // Fix round 1 minor 3: a device linking a patient's context for the
  // first time via this flow must show their data without a reload.
  it('minor 3: a successful confirm kicks a flush attempt', async () => {
    const { wrapper } = await mountConnect(VALID_URL)
    const syncStore = useSyncStore()
    const flushSpy = vi.spyOn(syncStore, 'flush')

    const confirmButton = wrapper.findAll('button').find((b) => b.text().trim() === 'เชื่อมต่อ')
    await confirmButton.trigger('click')

    expect(flushSpy).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  // Fix round 1 minor 7: an override that only half-persisted (in-memory
  // yes, localStorage no) is still LIVE for this session — the success
  // copy must say so, not claim an unqualified success.
  it('minor 7: the success copy is qualified when storageFailed is set after a successful apply', async () => {
    const { wrapper } = await mountConnect(VALID_URL)
    const syncStore = useSyncStore()
    // jsdom's real Storage implementation ignores vi.spyOn() on its
    // built-in methods (getItem/setItem are IDL-defined interface members,
    // not overridable via the named-property mechanism a plain spy relies
    // on) — a full replacement via vi.stubGlobal is what actually takes
    // effect here, unlike the node-environment MemoryStorage shim
    // tests/stores/syncStoreOverride.test.js spies on directly.
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
      removeItem: () => {},
      clear: () => {},
    })

    const confirmButton = wrapper.findAll('button').find((b) => b.text().trim() === 'เชื่อมต่อ')
    await confirmButton.trigger('click')

    expect(syncStore.storageFailed).toBe(true)
    expect(wrapper.text()).toContain('เชื่อมต่อกับฐานข้อมูลกลางสำเร็จ')
    expect(wrapper.text()).toContain('อาจไม่คงอยู่หลังปิดแอปหรือโหลดหน้าใหม่')

    wrapper.unmount()
  })

  it('the success copy is NOT qualified when storageFailed is false', async () => {
    const { wrapper } = await mountConnect(VALID_URL)

    const confirmButton = wrapper.findAll('button').find((b) => b.text().trim() === 'เชื่อมต่อ')
    await confirmButton.trigger('click')

    expect(wrapper.text()).not.toContain('อาจไม่คงอยู่หลังปิดแอปหรือโหลดหน้าใหม่')

    wrapper.unmount()
  })
})

// Fix round 1 MAJOR 2 / LEAD RULING R45 (binding): a non-empty outbox must
// never be re-targeted at a different backend.
describe('ConnectView — R45 outbox guard (fix round 1 MAJOR 2)', () => {
  it('a DIFFERENT backend link while the outbox is non-empty shows the blocked state, not a confirm button', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'file'
    syncStore.pendingCount = 4

    const { wrapper } = await mountConnect(OTHER_URL)

    expect(wrapper.text()).toContain('มีข้อมูลค้างส่ง 4 รายการ')
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'เชื่อมต่อ')).toBe(false)
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ลองส่งตอนนี้')).toBe(true)
    expect(syncStore.syncUrl).toBe(VALID_URL) // untouched

    wrapper.unmount()
  })

  it('the SAME backend link is never blocked even with a non-empty outbox — nothing would be orphaned', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'override'
    syncStore.pendingCount = 4

    const { wrapper } = await mountConnect(VALID_URL)

    expect(wrapper.text()).not.toContain('มีข้อมูลค้างส่ง')
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'เชื่อมต่อ')).toBe(true)

    wrapper.unmount()
  })

  it('ลองส่งตอนนี้ retries the flush and, once the outbox drains, unlocks the ordinary confirm state', async () => {
    enqueue({
      recordId: 'r1',
      patientId: 'P-1',
      token: 'tok',
      record: { id: 'r1' },
      queuedAt: '2026-08-25T09:00:00.000Z',
      attempts: 0,
    })
    const fetchMock = vi.fn((url, init) => {
      if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: VALID_URL }) })
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, saved: 'inserted' }) })
    })
    vi.stubGlobal('fetch', fetchMock)

    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'file'
    syncStore.pendingCount = pending().length // reflects the real outbox seeded above
    expect(syncStore.pendingCount).toBe(1)

    const { wrapper } = await mountConnect(OTHER_URL)
    expect(wrapper.text()).toContain('มีข้อมูลค้างส่ง 1 รายการ')

    const retryButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ลองส่งตอนนี้')
    await retryButton.trigger('click')
    await flushPromises()
    await wrapper.vm.$nextTick()

    expect(syncStore.pendingCount).toBe(0)
    expect(pending()).toEqual([])
    expect(wrapper.text()).toContain('เชื่อมต่อกับฐานข้อมูลกลางนี้หรือไม่?') // unlocked into the ordinary confirm state
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'เชื่อมต่อ')).toBe(true)

    wrapper.unmount()
  })

  it('disconnect (ยกเลิก) is blocked and shows the retry affordance when reverting would switch backends with a non-empty outbox', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'override'
    syncStore.fileSyncUrl = OTHER_URL // reverting would land on a DIFFERENT backend
    syncStore.pendingCount = 2

    const { wrapper } = await mountConnect('')

    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ยกเลิกการเชื่อมต่อฐานข้อมูลนี้')).toBe(false)
    expect(wrapper.text()).toContain('มีข้อมูลค้างส่ง 2 รายการ')
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ลองส่งตอนนี้')).toBe(true)

    wrapper.unmount()
  })

  it('disconnect is NOT blocked when reverting stays on the SAME backend, even with a non-empty outbox', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'override'
    syncStore.fileSyncUrl = VALID_URL // same backend either way
    syncStore.pendingCount = 2

    const { wrapper } = await mountConnect('')

    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ยกเลิกการเชื่อมต่อฐานข้อมูลนี้')).toBe(true)
    expect(wrapper.text()).not.toContain('มีข้อมูลค้างส่ง')

    wrapper.unmount()
  })

  it('disconnect is NOT blocked when the outbox is empty, even though reverting switches backends', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'override'
    syncStore.fileSyncUrl = OTHER_URL
    expect(syncStore.pendingCount).toBe(0)

    const { wrapper } = await mountConnect('')

    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ยกเลิกการเชื่อมต่อฐานข้อมูลนี้')).toBe(true)

    wrapper.unmount()
  })

  // Fix round 2 minor 2: confirmDisconnect() now checks clearSyncOverride()'s
  // return — a race (the outbox fills AFTER the modal opens, before it's
  // confirmed) means disconnectBlocked's mount-time check alone isn't
  // enough; the store's OWN refusal must still surface, not silently no-op.
  it('minor 2: confirmDisconnect toasts when clearSyncOverride refuses (race: outbox fills after the modal opens)', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'override'
    syncStore.fileSyncUrl = OTHER_URL // reverting would switch backends
    // pendingCount starts at 0 -- disconnectBlocked is false, so the entry
    // button renders and the modal opens normally.

    const { wrapper } = await mountConnect('')
    const disconnectButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ยกเลิกการเชื่อมต่อฐานข้อมูลนี้')
    expect(disconnectButton).toBeTruthy()
    await disconnectButton.trigger('click')

    // The race: another tab (or this one) enqueues AFTER the modal opened.
    enqueue({
      recordId: 'r1',
      patientId: 'P-1',
      token: 'tok',
      record: { id: 'r1' },
      queuedAt: '2026-08-25T09:00:00.000Z',
      attempts: 0,
    })

    const { toasts } = useToast()
    const before = toasts.value.length
    const confirmButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ยืนยันยกเลิกการเชื่อมต่อ')
    await confirmButton.trigger('click')

    expect(syncStore.syncSource).toBe('override') // refused -- unchanged
    expect(toasts.value.length).toBe(before + 1)
    expect(toasts.value.at(-1).message).toContain('มีข้อมูลค้างส่ง')

    wrapper.unmount()
  })

  // Fix round 2 minor 3: retryFlush() must say so, honestly, when a pass
  // still leaves the outbox non-empty (offline, or the old backend
  // genuinely unreachable) -- silence there would look like the tap did
  // nothing.
  it('minor 3: retryFlush toasts an honest failure line when a pass still leaves the outbox non-empty', async () => {
    enqueue({
      recordId: 'r1',
      patientId: 'P-1',
      token: 'tok',
      record: { id: 'r1' },
      queuedAt: '2026-08-25T09:00:00.000Z',
      attempts: 0,
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))

    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'file'
    syncStore.pendingCount = pending().length
    expect(syncStore.pendingCount).toBe(1)

    const { wrapper } = await mountConnect(OTHER_URL)
    const { toasts } = useToast()
    const before = toasts.value.length

    const retryButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ลองส่งตอนนี้')
    await retryButton.trigger('click')
    await flushPromises()

    expect(syncStore.pendingCount).toBe(1) // still stuck -- genuinely unreachable
    expect(toasts.value.length).toBe(before + 1)
    expect(toasts.value.at(-1).message).toContain('ยังส่งไม่สำเร็จ')

    wrapper.unmount()
  })

  it('retryFlush does NOT toast when the pass fully drains the outbox', async () => {
    enqueue({
      recordId: 'r1',
      patientId: 'P-1',
      token: 'tok',
      record: { id: 'r1' },
      queuedAt: '2026-08-25T09:00:00.000Z',
      attempts: 0,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((url, init) => {
        if (!init) return Promise.resolve({ ok: true, json: async () => ({ syncUrl: VALID_URL }) })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, saved: 'inserted' }) })
      }),
    )

    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'file'
    syncStore.pendingCount = pending().length

    const { wrapper } = await mountConnect(OTHER_URL)
    const { toasts } = useToast()
    const before = toasts.value.length

    const retryButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ลองส่งตอนนี้')
    await retryButton.trigger('click')
    await flushPromises()

    expect(syncStore.pendingCount).toBe(0)
    expect(toasts.value.length).toBe(before) // no failure toast -- the blocked panel disappearing IS the feedback

    wrapper.unmount()
  })
})

// Fix round 1 minor 8: a link that already matches the live FILE config
// needs no override; a device already configured with a DIFFERENT backend
// is told the confirm step will replace it.
describe('ConnectView — same-URL rescan / replaces-existing copy (fix round 1 minor 8)', () => {
  it('a link matching the live FILE config shows "already connected" WITHOUT writing an override', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'file'
    const applySpy = vi.spyOn(syncStore, 'applySyncOverride')

    const { wrapper } = await mountConnect(VALID_URL)

    expect(wrapper.text()).toContain('เชื่อมต่อกับฐานข้อมูลนี้อยู่แล้ว')
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'เชื่อมต่อ')).toBe(false)
    expect(applySpy).not.toHaveBeenCalled()
    expect(syncStore.syncSource).toBe('file') // unchanged -- no override written
    expect(globalThis.localStorage.getItem(OVERRIDE_KEY)).toBeNull()

    wrapper.unmount()
  })

  it('a link matching the live OVERRIDE (not file) falls through to the ordinary confirm step', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'override'

    const { wrapper } = await mountConnect(VALID_URL)

    expect(wrapper.text()).not.toContain('เชื่อมต่อกับฐานข้อมูลนี้อยู่แล้ว')
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'เชื่อมต่อ')).toBe(true)

    wrapper.unmount()
  })

  it('the confirm step names what it will replace when already configured with a DIFFERENT backend', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'file'

    const { wrapper } = await mountConnect(OTHER_URL)

    expect(wrapper.text()).toContain('แทนที่การเชื่อมต่อฐานข้อมูลปัจจุบัน')

    wrapper.unmount()
  })

  it('the confirm step does NOT show the replace line for a first-ever connect (not configured yet)', async () => {
    const { wrapper } = await mountConnect(VALID_URL)

    expect(wrapper.text()).not.toContain('แทนที่การเชื่อมต่อฐานข้อมูลปัจจุบัน')

    wrapper.unmount()
  })
})

describe('ConnectView — bare #/connect, unconfigured device', () => {
  it('explains where a connect link comes from, no crash', async () => {
    const { wrapper } = await mountConnect('')
    const syncStore = useSyncStore()
    expect(syncStore.configured).toBe(false)

    expect(wrapper.text()).toContain('ยังไม่ได้เชื่อมต่อกับฐานข้อมูลกลาง')
    expect(wrapper.text()).toContain('ติดตั้งระบบ + เชื่อมต่อแอป')
    // No share-QR / copy / "ยกเลิกการเชื่อมต่อฐานข้อมูลนี้" ENTRY button —
    // nothing to share/undo yet. The exact string (not a loose substring)
    // is required here: the confirm modal's own "ยืนยันยกเลิกการเชื่อมต่อ"
    // button is always present in the DOM (BaseModal renders unconditionally,
    // gated only by the jsdom-inert <dialog> open/close — see
    // patientContextCard.test.js) and would false-positive on a shorter match.
    expect(wrapper.findAll('button').some((b) => b.text().trim().includes('แสดง QR'))).toBe(false)
    expect(wrapper.findAll('button').some((b) => b.text().trim().includes('คัดลอกลิงก์'))).toBe(false)
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ยกเลิกการเชื่อมต่อฐานข้อมูลนี้')).toBe(false)

    wrapper.unmount()
  })
})

describe('ConnectView — bare #/connect, configured device (share-QR + clear gating)', () => {
  it('source "file": shows ไฟล์ตั้งค่า, share-QR + copy buttons, but NO ยกเลิก affordance', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'file'

    const { wrapper } = await mountConnect('')

    expect(wrapper.text()).toContain('ไฟล์ตั้งค่า')
    expect(wrapper.text()).toContain(VALID_URL)
    expect(wrapper.findAll('button').some((b) => b.text().trim().includes('แสดง QR'))).toBe(true)
    expect(wrapper.findAll('button').some((b) => b.text().trim().includes('คัดลอกลิงก์'))).toBe(true)
    expect(wrapper.findAll('button').some((b) => b.text().trim().includes('ยกเลิกการเชื่อมต่อฐานข้อมูลนี้'))).toBe(false)

    wrapper.unmount()
  })

  it('source "override": shows การตั้งค่าที่อุปกรณ์นี้ AND the ยกเลิก affordance', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'override'

    const { wrapper } = await mountConnect('')

    expect(wrapper.text()).toContain('การตั้งค่าที่อุปกรณ์นี้')
    expect(wrapper.findAll('button').some((b) => b.text().trim().includes('ยกเลิกการเชื่อมต่อฐานข้อมูลนี้'))).toBe(true)

    wrapper.unmount()
  })

  it('ยกเลิก asks for confirmation first — the click alone does not clear the override', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'override'
    const clearSpy = vi.spyOn(syncStore, 'clearSyncOverride')

    const { wrapper } = await mountConnect('')

    const disconnectButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ยกเลิกการเชื่อมต่อฐานข้อมูลนี้')
    await disconnectButton.trigger('click')

    expect(clearSpy).not.toHaveBeenCalled()
    expect(syncStore.syncSource).toBe('override') // unchanged — confirm not yet clicked

    const confirmButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ยืนยันยกเลิกการเชื่อมต่อ')
    expect(confirmButton).toBeTruthy()
    await confirmButton.trigger('click')

    expect(clearSpy).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('copying the link calls navigator.clipboard.writeText with the ?u= connect link (no token, only the exec URL)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'file'

    const { wrapper } = await mountConnect('')
    const copyButton = wrapper.findAll('button').find((b) => b.text().trim().includes('คัดลอกลิงก์'))
    await copyButton.trigger('click')
    await Promise.resolve() // let the async clipboard write settle

    expect(writeText).toHaveBeenCalledTimes(1)
    const [linkArg] = writeText.mock.calls[0]
    expect(linkArg).toContain('#/connect?u=')
    expect(linkArg).toContain(encodeURIComponent(VALID_URL))

    wrapper.unmount()
  })

  // Fix round 1 minor 6: the QR modal's "คัดลอกลิงก์นี้"/manual-copy
  // fallback used to point at text that only appeared when the QR canvas
  // render FAILED — leaving nothing selectable to copy the rest of the time.
  it('minor 6: the share modal always renders shareLink as selectable text, QR render success or not', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'file'

    const { wrapper } = await mountConnect('')
    const qrButton = wrapper.findAll('button').find((b) => b.text().trim().includes('แสดง QR'))
    await qrButton.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain(`#/connect?u=${encodeURIComponent(VALID_URL)}`)

    wrapper.unmount()
  })
})

// Fix round 1 minor 9(a): the router's actual `props: (route) =>
// ({u: route.query.u})` wiring, exercised via a REAL navigation (not props
// handed directly to mount(), as every test above does) — including a
// double-encoded link, which must be rejected as invalid rather than
// silently mis-decoded (the view must never call decodeURIComponent()
// itself; it relies solely on vue-router's own single decode).
describe('ConnectView — router query wiring via a real navigation (fix round 1 minor 9a)', () => {
  function mountApp(router) {
    return mount({ template: '<router-view />' }, { global: { plugins: [router] }, attachTo: document.body })
  }

  it('a real navigation to #/connect?u=<single-encoded> resolves via route.query.u to the confirm state', async () => {
    const router = makeRouter()
    router.push('/connect?u=' + encodeURIComponent(VALID_URL))
    await router.isReady()
    const wrapper = mountApp(router)
    await flushPromises()

    expect(wrapper.text()).toContain('เชื่อมต่อกับฐานข้อมูลกลางนี้หรือไม่?')
    expect(wrapper.text()).toContain(VALID_URL)

    wrapper.unmount()
  })

  it('a double-encoded u is rejected as invalid, not silently mis-decoded into something else', async () => {
    const router = makeRouter()
    router.push('/connect?u=' + encodeURIComponent(encodeURIComponent(VALID_URL)))
    await router.isReady()
    const wrapper = mountApp(router)
    await flushPromises()

    expect(wrapper.text()).toContain('ลิงก์เชื่อมต่อไม่ถูกต้อง')
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'เชื่อมต่อ')).toBe(false)

    wrapper.unmount()
  })
})

// Fix round 1 minor 9(b): HomeView's "เชื่อมต่ออุปกรณ์เพิ่ม" entry point,
// gated on syncStore.configured — placed here (not a new file) per the
// fix-round file-ownership constraint (only these two test files).
describe('HomeView — เชื่อมต่ออุปกรณ์เพิ่ม button gating on syncStore.configured (fix round 1 minor 9b)', () => {
  function makeHomeRouter() {
    return createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: HomeView },
        { path: '/connect', name: 'connect', component: { template: '<div />' } },
      ],
    })
  }

  async function mountHome() {
    const router = makeHomeRouter()
    router.push('/')
    await router.isReady()
    const wrapper = mount(HomeView, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    return { wrapper, router }
  }

  it('the button is absent when unconfigured', async () => {
    const { wrapper } = await mountHome()

    expect(wrapper.findAll('button').some((b) => b.text().includes('เชื่อมต่ออุปกรณ์เพิ่ม'))).toBe(false)

    wrapper.unmount()
  })

  it('the button renders and navigates to /connect when configured', async () => {
    const syncStore = useSyncStore()
    syncStore.syncUrl = VALID_URL
    syncStore.configured = true
    syncStore.syncSource = 'file'

    const { wrapper, router } = await mountHome()
    const button = wrapper.findAll('button').find((b) => b.text().includes('เชื่อมต่ออุปกรณ์เพิ่ม'))
    expect(button).toBeTruthy()

    await button.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/connect')

    wrapper.unmount()
  })
})
