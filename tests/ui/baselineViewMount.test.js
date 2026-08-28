// @vitest-environment jsdom
//
// Regression pin for the production blocker (plan Task 3 / spec §4):
// BaselineView's onMounted() does
//   startHandle = requestAnimationFrame(() => start(videoRef.value))
// one rAF after mount, while phase is still 'idle'. On the OLD template the
// camera container (and its <video ref="videoRef">) only rendered inside the
// v-else camera branch — i.e. NOT during 'idle'/'loading' — so videoRef.value
// was still null when that rAF callback read it, start() received null,
// getUserMedia succeeded (camera light on), and `videoEl.srcObject = stream`
// then threw on null deep in the async path: camera light on, view stuck on
// the spinner forever.
//
// This test never lets the rAF callback run at all (requestAnimationFrame is
// stubbed to a no-op capture) — it only needs to pin the SYNCHRONOUS,
// mount-time DOM shape that start()'s deferred rAF callback would observe a
// frame later. That is exactly the moment the bug lived in: if <video> is
// missing from the DOM right after mount (phase 'idle'), the fix is not
// actually in place, regardless of anything that happens after start() runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import BaselineView from '../../src/views/BaselineView.vue'
import { usePatientStore } from '../../src/stores/patientStore.js'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/baseline', name: 'baseline', component: BaselineView },
    ],
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BaselineView mount — camera-hang regression (production blocker)', () => {
  it('the <video> element exists in the DOM immediately at mount (linked, phase still idle) — before start() ever runs', async () => {
    const rafStub = vi.fn()
    vi.stubGlobal('requestAnimationFrame', rafStub)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-1', token: 'tok-1' })
    patientStore.applyServerInfo({ displayName: 'สมชาย', bed: '5A', baseline: null })

    const router = makeRouter()
    router.push('/baseline')
    await router.isReady()

    const wrapper = mount(BaselineView, {
      global: { plugins: [router] },
      attachTo: document.body,
    })

    // Sanity: the rAF callback that calls start(videoRef.value) was
    // scheduled but never invoked — start() truly never ran, so this is
    // pinning the mount-time DOM shape, not some later post-start() state.
    expect(rafStub).toHaveBeenCalledTimes(1)

    expect(wrapper.find('video').exists()).toBe(true)

    wrapper.unmount()
  })

  // R4-T5 (new user requirement): the mirror-class assertion for the
  // "harness that allows" per this view — this file uses the REAL
  // useFaceScan() composable (never mocked), whose state.facing defaults to
  // 'user' and is not itself under test here, so this only pins the DEFAULT
  // (unswapped) mirrored state; the swapped/environment case is covered in
  // tests/ui/baselineViewUnlink.test.js, which already mocks the composable
  // and can drive state.facing directly.
  it('mirrors the video by default (facing starts as "user")', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn())
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-2', token: 'tok-2' })
    patientStore.applyServerInfo({ displayName: 'สมหญิง', bed: '6B', baseline: null })

    const router = makeRouter()
    router.push('/baseline')
    await router.isReady()

    const wrapper = mount(BaselineView, {
      global: { plugins: [router] },
      attachTo: document.body,
    })

    expect(wrapper.find('video').classes()).toContain('-scale-x-100')

    wrapper.unmount()
  })
})
