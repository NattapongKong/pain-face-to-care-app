// @vitest-environment jsdom
//
// Fix round 1 MAJOR 2: tapping ออก (via the PatientContextCard now embedded
// in BaselineView) while the camera preview is live must actually release
// the camera. Before this fix, patientStore.linked flipping false only
// swapped this view's OWN v-if/v-else TEMPLATE branch back to the "please
// link" panel — the component itself stays mounted (same route, same
// instance), so onUnmounted()'s stop() never fires on its own, leaving the
// MediaStream tracks live and the rAF detection loop running against a
// now-detached <video>.
//
// useFaceScan.js is mocked wholesale (its own doc comment invites this —
// "Runtime module — not unit-tested; reviewed + live-tested at
// integration") so this test can put `state.phase` into a genuinely live
// phase and assert BaselineView's own new watch(() => patientStore.linked,
// ...) is what tears it down, without fighting jsdom's non-functional
// <video>.play()/getUserMedia.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { reactive } from 'vue'
import BaselineView from '../../src/views/BaselineView.vue'
import { usePatientStore } from '../../src/stores/patientStore.js'
import { useFaceScan } from '../../src/facescan/useFaceScan.js'

vi.mock('../../src/facescan/useFaceScan.js', () => ({
  useFaceScan: vi.fn(),
}))

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/baseline', name: 'baseline', component: BaselineView },
    ],
  })
}

let fakeState
let stopSpy
let toggleFacingSpy

beforeEach(() => {
  setActivePinia(createPinia())
  // start() is fully mocked away (see below), so onMounted's deferred rAF
  // callback is harmless either way — stubbed here only so it never throws
  // if jsdom lacks a native requestAnimationFrame.
  vi.stubGlobal('requestAnimationFrame', (cb) => {
    cb()
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())

  fakeState = reactive({
    phase: 'preview', // camera already live — the scenario this bug lived in
    errorKind: null,
    faceDetected: false,
    live: { brow: 0, eyes: 0, noseCheek: 0, mouth: 0, overall: 0 },
    progress: 0,
    profiles: null,
    modelSource: null,
    scoringEngine: 'model-v1',
    modelCutpoints: null,
    countdownSeconds: 0,
    countdownNext: null,
    baselineResult: null,
    // R4-T5 (new user requirement): front/back camera swap state.
    facing: 'user',
    canSwapCamera: false,
    swapInFlight: false, // R4-T5 fix round 1 minor 5
  })
  stopSpy = vi.fn(() => {
    fakeState.phase = 'idle'
  })
  toggleFacingSpy = vi.fn()
  useFaceScan.mockReturnValue({
    state: fakeState,
    start: vi.fn(),
    beginBaselineCapture: vi.fn(),
    stop: stopSpy,
    toggleFacing: toggleFacingSpy,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function mountBaseline() {
  const router = makeRouter()
  router.push('/baseline')
  await router.isReady()
  return mount(BaselineView, { global: { plugins: [router] }, attachTo: document.body })
}

describe('BaselineView — camera release on mid-preview unlink (fix round 1 MAJOR 2)', () => {
  it('unlinking (patientStore.clear()) while the camera preview is live calls stop() — state.phase becomes idle', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-1', token: 'tok-1' })
    patientStore.applyServerInfo({ displayName: 'สมชาย', bed: '5A', baseline: null })

    const wrapper = await mountBaseline()

    // Sanity: the camera is "live" per the mocked composable before unlink.
    expect(fakeState.phase).toBe('preview')
    expect(stopSpy).not.toHaveBeenCalled()

    patientStore.clear()
    await wrapper.vm.$nextTick()

    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(fakeState.phase).toBe('idle')

    wrapper.unmount()
  })

  it('via the ออก -> ยืนยัน flow on the embedded PatientContextCard, not just a direct store call', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-2', token: 'tok-2' })
    patientStore.applyServerInfo({ displayName: 'วิชัย', bed: '2B', baseline: null })

    const wrapper = await mountBaseline()
    expect(fakeState.phase).toBe('preview')

    const outButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ออก')
    expect(outButton).toBeTruthy()
    await outButton.trigger('click')
    const confirmButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ออกจากผู้ป่วย')
    expect(confirmButton).toBeTruthy()
    await confirmButton.trigger('click')
    await wrapper.vm.$nextTick()

    expect(patientStore.linked).toBe(false)
    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(fakeState.phase).toBe('idle')

    wrapper.unmount()
  })

  it('does not call stop() on mount / while still linked', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-3', token: 'tok-3' })
    patientStore.applyServerInfo({ displayName: 'อารีย์', bed: '1C', baseline: null })

    const wrapper = await mountBaseline()

    expect(stopSpy).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})

// R4-T5 (new user requirement): front/back camera swap icon + conditional
// mirror, exercised here (rather than baselineViewMount.test.js) because
// this file already mocks useFaceScan wholesale — full control over
// state.canSwapCamera/state.facing without needing a real camera.
describe('BaselineView — camera swap button + mirror (R4-T5)', () => {
  function swapButton(wrapper) {
    return wrapper.find('[aria-label="สลับกล้องหน้า/หลัง"]')
  }

  it('is absent while canSwapCamera is false, present once true (still in preview)', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-4', token: 'tok-4' })
    patientStore.applyServerInfo({ displayName: 'มานี', bed: '3D', baseline: null })

    const wrapper = await mountBaseline()
    expect(swapButton(wrapper).exists()).toBe(false)

    fakeState.canSwapCamera = true
    await wrapper.vm.$nextTick()
    expect(swapButton(wrapper).exists()).toBe(true)

    wrapper.unmount()
  })

  it('calls toggleFacing() on click', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-5', token: 'tok-5' })
    patientStore.applyServerInfo({ displayName: 'สมหญิง', bed: '4E', baseline: null })

    const wrapper = await mountBaseline()
    fakeState.canSwapCamera = true
    await wrapper.vm.$nextTick()

    await swapButton(wrapper).trigger('click')

    expect(toggleFacingSpy).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('mirrors the video preview when facing is "user" but not when facing is "environment"', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-6', token: 'tok-6' })
    patientStore.applyServerInfo({ displayName: 'ประไพ', bed: '5F', baseline: null })

    const wrapper = await mountBaseline()
    fakeState.facing = 'user'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('video').classes()).toContain('-scale-x-100')

    fakeState.facing = 'environment'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('video').classes()).not.toContain('-scale-x-100')

    wrapper.unmount()
  })

  // Fix round 1 MAJOR 1: same DOM-order regression as ScanPanel.vue — the
  // button used to sit BEFORE the oval scrim SVG, so the scrim (a later
  // absolute sibling, fill-opacity 0.55) painted OVER it.
  it('places the swap button AFTER the oval scrim SVG in DOM order (fix round 1 MAJOR 1)', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-7', token: 'tok-7' })
    patientStore.applyServerInfo({ displayName: 'บุญมี', bed: '6G', baseline: null })

    const wrapper = await mountBaseline()
    fakeState.canSwapCamera = true
    await wrapper.vm.$nextTick()

    const container = wrapper.find('.bg-primary-900')
    const children = Array.from(container.element.children)
    const scrimIndex = children.findIndex((el) => el.tagName.toLowerCase() === 'svg')
    const buttonIndex = children.findIndex(
      (el) => el.getAttribute('aria-label') === 'สลับกล้องหน้า/หลัง',
    )

    expect(scrimIndex).toBeGreaterThanOrEqual(0)
    expect(buttonIndex).toBeGreaterThan(scrimIndex)

    wrapper.unmount()
  })

  // Fix round 1 minor 5 / round 2 R2: no dead tap while a device's camera
  // handoff is in flight — the swap button disables + spinners, and the
  // "เริ่มถ่ายภาพหน้าปกติ" capture button (which would otherwise start a
  // countdown that beginBaselineCapture() silently refuses mid-swap)
  // disables too, mirroring ScanPanel.vue's own coverage.
  it('disables the swap button + capture button and shows a spinner while state.swapInFlight is true', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-8', token: 'tok-8' })
    patientStore.applyServerInfo({ displayName: 'สมพร', bed: '7H', baseline: null })

    const wrapper = await mountBaseline()
    fakeState.canSwapCamera = true
    fakeState.swapInFlight = true
    await wrapper.vm.$nextTick()

    const button = swapButton(wrapper)
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.loading-spinner').exists()).toBe(true)

    const captureButton = wrapper.findAll('button').find((b) => b.text().trim() === 'เริ่มถ่ายภาพหน้าปกติ')
    expect(captureButton).toBeTruthy()
    expect(captureButton.attributes('disabled')).toBeDefined()

    wrapper.unmount()
  })
})
