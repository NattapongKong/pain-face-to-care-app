// @vitest-environment jsdom
//
// R3-T7 (T2 review minor 3): first component test file for ScanPanel.vue.
// useFaceScan.js is a runtime module wrapping getUserMedia/the WASM face
// landmarker (its own doc comment invites mocking it wholesale — "not
// unit-tested; reviewed + live-tested at integration", the same stance
// tests/ui/baselineViewUnlink.test.js already takes for BaselineView's use
// of the same composable). Mounting ScanPanel with the REAL composable
// would mean driving getUserMedia/MediaPipe through jsdom, which is
// impractical — this file mounts ScanPanel for real (not a shallow stub)
// but drives it entirely through a mocked useFaceScan() return value,
// pushing `state.phase`/`state.baselineSource`/etc. through a reactive
// object exactly like the composable would, and asserting on the rendered
// template + emitted events. That is "whatever seam the harness allows"
// per the task brief, honestly narrower than mounting against a real
// camera would be.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import ScanPanel from '../../src/views/assess/ScanPanel.vue'
import { useFaceScan } from '../../src/facescan/useFaceScan.js'
import { usePatientStore } from '../../src/stores/patientStore.js'

vi.mock('../../src/facescan/useFaceScan.js', () => ({
  useFaceScan: vi.fn(),
}))

function zeroLive() {
  return { brow: 0, eyes: 0, noseCheek: 0, mouth: 0, overall: 0 }
}

function freshState() {
  return reactive({
    phase: 'preview',
    errorKind: null,
    faceDetected: false,
    live: zeroLive(),
    progress: 0,
    profiles: null,
    modelSource: null,
    scoringEngine: null,
    modelCutpoints: null,
    countdownSeconds: 0,
    countdownNext: null,
    baselineResult: null,
    baselineSource: null,
    // R4-T5 (new user requirement): front/back camera swap state.
    facing: 'user',
    canSwapCamera: false,
    swapInFlight: false, // R4-T5 fix round 1 minor 5
  })
}

let fakeState
let startSpy
let beginCaptureSpy
let stopSpy
let toggleFacingSpy

beforeEach(() => {
  setActivePinia(createPinia())
  // Same stance as tests/ui/assessViewSteps.test.js / baselineViewUnlink.test.js:
  // rAF is stubbed as a no-op that never invokes its callback, so
  // ScanPanel's deferred start(videoRef.value) call is captured but never
  // fires — no getUserMedia call is ever actually attempted (useFaceScan
  // is mocked anyway, but this keeps the mount side-effect-free either way).
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  vi.stubGlobal('cancelAnimationFrame', vi.fn())

  fakeState = freshState()
  startSpy = vi.fn()
  beginCaptureSpy = vi.fn()
  stopSpy = vi.fn()
  toggleFacingSpy = vi.fn()
  useFaceScan.mockReturnValue({
    state: fakeState,
    start: startSpy,
    beginCapture: beginCaptureSpy,
    stop: stopSpy,
    toggleFacing: toggleFacingSpy,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mountPanel() {
  return mount(ScanPanel, { attachTo: document.body })
}

describe('ScanPanel — baseline-source chip (spec §3/R41)', () => {
  it('renders no chip while baselineSource is null (threshold mode / legacy session capture)', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'capturing'
    fakeState.baselineSource = null
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('ใช้หน้าปกติที่บันทึกไว้')
    expect(wrapper.text()).not.toContain('ใช้หน้าอ้างอิงมาตรฐาน')

    wrapper.unmount()
  })

  it('shows "ใช้หน้าปกติที่บันทึกไว้" for a banked baseline', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'capturing'
    fakeState.baselineSource = 'banked'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('ใช้หน้าปกติที่บันทึกไว้')
    expect(wrapper.text()).not.toContain('ใช้หน้าอ้างอิงมาตรฐาน')

    wrapper.unmount()
  })

  it('shows "ใช้หน้าอ้างอิงมาตรฐาน" for the population-neutral default baseline', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'capturing'
    fakeState.baselineSource = 'default'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('ใช้หน้าอ้างอิงมาตรฐาน')
    expect(wrapper.text()).not.toContain('ใช้หน้าปกติที่บันทึกไว้')

    wrapper.unmount()
  })

  it('never shows a chip during the plain preview phase, even if baselineSource is already set', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'preview'
    fakeState.baselineSource = 'default'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('ใช้หน้าอ้างอิงมาตรฐาน')

    wrapper.unmount()
  })
})

describe('ScanPanel — countdown label (spec §3)', () => {
  it('shows "เตรียมพร้อม" during countdown when countdownNext is capturing (the normal single-phase wizard scan)', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'countdown'
    fakeState.countdownNext = 'capturing'
    fakeState.countdownSeconds = 3
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('เตรียมพร้อม')

    wrapper.unmount()
  })

  it('keeps the legacy "เตรียมทำใบหน้าปรกติ" copy when countdownNext is baseline (legacy two-phase path, grandfathered)', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'countdown'
    fakeState.countdownNext = 'baseline'
    fakeState.countdownSeconds = 3
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('เตรียมทำใบหน้าปรกติ')
    expect(wrapper.text()).not.toContain('เตรียมพร้อม')

    wrapper.unmount()
  })
})

describe('ScanPanel — done emit carries baselineSource (R3-T7)', () => {
  it('emits done with (profiles, { scoringEngine, baselineSource }) when phase transitions to done', async () => {
    const wrapper = mountPanel()
    fakeState.profiles = { brow: { deciles: [], mean: 0 } }
    fakeState.scoringEngine = 'model-v1'
    fakeState.baselineSource = 'default'
    fakeState.phase = 'done'
    await wrapper.vm.$nextTick()

    const doneEvents = wrapper.emitted('done')
    expect(doneEvents).toBeTruthy()
    expect(doneEvents[0][0]).toBe(fakeState.profiles)
    expect(doneEvents[0][1]).toEqual({ scoringEngine: 'model-v1', baselineSource: 'default' })

    wrapper.unmount()
  })

  it('carries baselineSource "banked" through the same emit shape', async () => {
    const wrapper = mountPanel()
    fakeState.profiles = { brow: { deciles: [], mean: 0 } }
    fakeState.scoringEngine = 'model-v1'
    fakeState.baselineSource = 'banked'
    fakeState.phase = 'done'
    await wrapper.vm.$nextTick()

    const doneEvents = wrapper.emitted('done')
    expect(doneEvents[0][1]).toEqual({ scoringEngine: 'model-v1', baselineSource: 'banked' })

    wrapper.unmount()
  })

  it('carries a null baselineSource through unchanged (threshold mode)', async () => {
    const wrapper = mountPanel()
    fakeState.profiles = { brow: { deciles: [], mean: 0 } }
    fakeState.scoringEngine = 'threshold'
    fakeState.baselineSource = null
    fakeState.phase = 'done'
    await wrapper.vm.$nextTick()

    const doneEvents = wrapper.emitted('done')
    expect(doneEvents[0][1]).toEqual({ scoringEngine: 'threshold', baselineSource: null })

    wrapper.unmount()
  })

  // R3-T7: the done-state hint that used to live in ScanPanel's own
  // 'done' branch was removed as unreachable dead UI (both parents swap
  // this panel out for ValidatePanel synchronously on this same emit) —
  // pin that it is gone for good, not just moved silently in a way this
  // suite wouldn't catch a regression of.
  it('no longer renders any done-state hint text itself (relocated to Step4Result)', async () => {
    // T7 review minor 1: the REMOVED hint was additionally gated on
    // patientStore.linked — an unlinked mount would pass this assertion
    // even against the pre-removal component (tautology). Link a patient
    // so the assertion genuinely depends on the hint block being gone.
    usePatientStore().setContext({ patientId: 'P-scanpanel', token: 'tok-scanpanel' })
    const wrapper = mountPanel()
    fakeState.profiles = { brow: { deciles: [], mean: 0 } }
    fakeState.baselineSource = 'default'
    fakeState.phase = 'done'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('แนะนำให้บันทึกหน้าปกติของผู้ป่วยในช่วงที่ไม่ปวด')

    wrapper.unmount()
  })
})

// R4-T5 (new user requirement): front/back camera swap icon.
describe('ScanPanel — camera swap button (R4-T5)', () => {
  function swapButton(wrapper) {
    return wrapper.find('[aria-label="สลับกล้องหน้า/หลัง"]')
  }

  it('is absent during preview when canSwapCamera is false (single-camera device)', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'preview'
    fakeState.canSwapCamera = false
    await wrapper.vm.$nextTick()

    expect(swapButton(wrapper).exists()).toBe(false)

    wrapper.unmount()
  })

  it('is present during preview when canSwapCamera is true', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'preview'
    fakeState.canSwapCamera = true
    await wrapper.vm.$nextTick()

    expect(swapButton(wrapper).exists()).toBe(true)

    wrapper.unmount()
  })

  it('is absent during countdown even when canSwapCamera is true (mid-capture restart would corrupt frames)', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'countdown'
    fakeState.canSwapCamera = true
    await wrapper.vm.$nextTick()

    expect(swapButton(wrapper).exists()).toBe(false)

    wrapper.unmount()
  })

  it('is absent during capturing even when canSwapCamera is true', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'capturing'
    fakeState.canSwapCamera = true
    await wrapper.vm.$nextTick()

    expect(swapButton(wrapper).exists()).toBe(false)

    wrapper.unmount()
  })

  it('calls toggleFacing() on click', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'preview'
    fakeState.canSwapCamera = true
    await wrapper.vm.$nextTick()

    await swapButton(wrapper).trigger('click')

    expect(toggleFacingSpy).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('mirrors the video preview when facing is "user" but not when facing is "environment"', async () => {
    const wrapper = mountPanel()
    fakeState.facing = 'user'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('video').classes()).toContain('-scale-x-100')

    fakeState.facing = 'environment'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('video').classes()).not.toContain('-scale-x-100')

    wrapper.unmount()
  })

  // Fix round 1 MAJOR 1: the button used to sit BEFORE the oval scrim SVG
  // in the template, so the scrim (a later absolute sibling, fill-opacity
  // 0.55) painted OVER it — verified here by actual DOM order, not by
  // reading back computed z-index/opacity (which jsdom doesn't compute
  // from CSS anyway).
  it('places the swap button AFTER the oval scrim SVG in DOM order (fix round 1 MAJOR 1)', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'preview'
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
  // handoff is in flight (can take seconds) — the swap button disables and
  // swaps its icon for a spinner, and the FAB (which would otherwise start
  // a countdown that beginCapture() silently refuses mid-swap) disables too.
  it('disables the swap button + FAB and shows a spinner while state.swapInFlight is true', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'preview'
    fakeState.canSwapCamera = true
    fakeState.swapInFlight = true
    await wrapper.vm.$nextTick()

    const button = swapButton(wrapper)
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.loading-spinner').exists()).toBe(true)

    const fab = wrapper.find('button.bottom-3.right-3')
    expect(fab.exists()).toBe(true)
    expect(fab.attributes('disabled')).toBeDefined()

    wrapper.unmount()
  })
})
