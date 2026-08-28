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

// R5-T1 round 3 (owner: "ring misorientation" — round 2's
// transform="rotate(-90 cx cy)" only relocates the dash start on a CIRCLE;
// on an ELLIPSE it rotates the whole shape and swaps its axes, so the
// arc/halo traced a landscape ellipse over the portrait guide, crossing it
// at four points instead of riding it). Fix: NO transform on either dashed
// path — dash math (a constant stroke-dashoffset="25" + a progress-driven
// two-value stroke-dasharray) relocates the visible-arc start to 12 o'clock
// instead. Derivation independently verified (not just trusted) via true
// elliptical arc-length integration (confirms path position 75 = the exact
// top point for this rx/ry pair) and a dash on/off simulation (confirms the
// visible arc always starts at path position 75 and grows clockwise) — see
// the component's own root-cause comment for the full reasoning. The
// guide's mild-oval shape (ry/rx ~= 1.2), the shared cx/cy/rx/ry geometry,
// and the pathLength="100" normalization from earlier rounds are all
// unchanged (the existing percent text under "โปรดทำใบหน้าปรกติสักครู่" is
// untouched — not asserted again here).
describe('BaselineView — mild-oval face guide + on-guide progress arc (R5-T1 round 3)', () => {
  function guideEllipse(wrapper) {
    return wrapper.find('[data-testid="face-guide"]')
  }
  function progressArc(wrapper) {
    return wrapper.find('[data-testid="face-progress-arc"]')
  }
  function progressArcShadow(wrapper) {
    return wrapper.find('[data-testid="face-progress-arc-shadow"]')
  }

  async function linkedMount() {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-ring', token: 'tok-ring' })
    patientStore.applyServerInfo({ displayName: 'ริง', bed: '9Z', baseline: null })
    return mountBaseline()
  }

  it('cuts the scrim mask with an <ellipse> (not a <circle>) while active', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'preview'
    await wrapper.vm.$nextTick()

    const svg = wrapper.find('.pointer-events-none.absolute.inset-0')
    expect(svg.find('mask ellipse').exists()).toBe(true)
    expect(svg.find('mask circle').exists()).toBe(false)
    expect(guideEllipse(wrapper).exists()).toBe(true)

    wrapper.unmount()
  })

  // Pins the mild-oval target (~1.2x taller than wide) with a tolerance band
  // that explicitly excludes both a regression back to a pure circle (1.0)
  // and a regression back to the old, too-elongated ellipse (~1.69).
  it('guide ellipse renders ~1.2x taller than wide on screen (mild oval, not a circle or the old too-oval shape)', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'preview'
    await wrapper.vm.$nextTick()

    const el = guideEllipse(wrapper)
    const rx = Number(el.attributes('rx'))
    const ry = Number(el.attributes('ry'))
    const ratio = ry / rx

    expect(ratio).toBeGreaterThan(1.1)
    expect(ratio).toBeLessThan(1.3)

    wrapper.unmount()
  })

  it('keeps the green/gray outline color semantics on the guide ellipse', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'preview'
    fakeState.faceDetected = false
    await wrapper.vm.$nextTick()
    expect(guideEllipse(wrapper).attributes('stroke')).toBe('#e2e8f0')

    fakeState.faceDetected = true
    await wrapper.vm.$nextTick()
    expect(guideEllipse(wrapper).attributes('stroke')).toBe('#16a34a')

    wrapper.unmount()
  })

  // The arc is drawn ON the guide's own path, not a separate concentric
  // ring — pin that the arc's geometry attributes are literally identical
  // to the guide's, so a future regression back to a separate ring (a
  // different rx/ry) fails this test.
  it('progress arc shares the SAME cx/cy/rx/ry as the guide ellipse (no separate ring)', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'baseline'
    await wrapper.vm.$nextTick()

    const guide = guideEllipse(wrapper)
    const arc = progressArc(wrapper)
    const shadow = progressArcShadow(wrapper)

    for (const attr of ['cx', 'cy', 'rx', 'ry']) {
      expect(arc.attributes(attr)).toBe(guide.attributes(attr))
      expect(shadow.attributes(attr)).toBe(guide.attributes(attr))
    }

    wrapper.unmount()
  })

  // Round 3's actual fix: pin that NEITHER dashed path carries a transform
  // at all — round 2's bug was specifically transform="rotate(-90 cx cy)"
  // swapping the ellipse's axes, so its outright absence is the regression
  // guard, not any particular transform value.
  it('neither arc path carries a transform attribute (round-2 axis-swap root-cause guard)', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'baseline'
    await wrapper.vm.$nextTick()

    expect(progressArc(wrapper).attributes('transform')).toBeUndefined()
    expect(progressArcShadow(wrapper).attributes('transform')).toBeUndefined()

    wrapper.unmount()
  })

  it('the old separate track/arc ring testid ("face-progress-track") no longer exists anywhere', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'baseline'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="face-progress-track"]').exists()).toBe(false)

    wrapper.unmount()
  })

  // Round 3: stroke-dashoffset is now a plain CONSTANT (25, placing the
  // dash-pattern start exactly at path position 75 = the ellipse's true
  // top point — verified by arc-length integration, see the component's
  // own comment) — it must NOT vary with progress. stroke-dasharray is what
  // animates instead: "{L} {100-L}" where L = progress*100.
  it('dashoffset stays constant at 25 regardless of progress; dasharray "0 100"/"50 50"/"100 0" at p 0/0.5/1', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'baseline'

    fakeState.progress = 0
    await wrapper.vm.$nextTick()
    expect(progressArc(wrapper).attributes('stroke-dashoffset')).toBe('25')
    expect(progressArcShadow(wrapper).attributes('stroke-dashoffset')).toBe('25')
    expect(progressArc(wrapper).attributes('stroke-dasharray')).toBe('0 100')
    expect(progressArcShadow(wrapper).attributes('stroke-dasharray')).toBe('0 100')

    fakeState.progress = 0.5
    await wrapper.vm.$nextTick()
    expect(progressArc(wrapper).attributes('stroke-dashoffset')).toBe('25')
    expect(progressArc(wrapper).attributes('stroke-dasharray')).toBe('50 50')
    expect(progressArcShadow(wrapper).attributes('stroke-dasharray')).toBe('50 50')

    fakeState.progress = 1
    await wrapper.vm.$nextTick()
    expect(progressArc(wrapper).attributes('stroke-dashoffset')).toBe('25')
    expect(progressArc(wrapper).attributes('stroke-dasharray')).toBe('100 0')
    expect(progressArcShadow(wrapper).attributes('stroke-dasharray')).toBe('100 0')

    wrapper.unmount()
  })

  it('both arc paths are ABSENT (v-if, not just dash math) during preview, even with a nonzero stale progress value', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'preview'
    fakeState.progress = 0.7 // stale leftover from a prior capture — must not leak into the arc here
    await wrapper.vm.$nextTick()

    expect(progressArc(wrapper).exists()).toBe(false)
    expect(progressArcShadow(wrapper).exists()).toBe(false)

    wrapper.unmount()
  })

  it('both arc paths are ABSENT during countdown too (the numeral is that phase\'s own indicator)', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'countdown'
    fakeState.progress = 0.3
    await wrapper.vm.$nextTick()

    expect(progressArc(wrapper).exists()).toBe(false)
    expect(progressArcShadow(wrapper).exists()).toBe(false)

    wrapper.unmount()
  })

  // Round 2 ruling (unaffected by round 3): no phase-color split for this
  // arc — plain white with a dark contrast halo underneath (this view only
  // ever has one timed phase, 'baseline', so there was never a real split
  // to lose here anyway).
  it('renders white (not phase-colored) with a translucent dark halo underneath', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'baseline'
    await wrapper.vm.$nextTick()

    expect(progressArc(wrapper).attributes('stroke')).toBe('#ffffff')
    expect(progressArcShadow(wrapper).attributes('stroke')).toBe('#000000')

    wrapper.unmount()
  })

  it('arc uses pathLength="100" normalization', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'baseline'
    await wrapper.vm.$nextTick()

    const arc = progressArc(wrapper)
    // SVG attribute names are case-sensitive and NOT lowercased by the DOM
    // for non-HTML elements — pathLength must be asserted with this exact
    // case or the lookup silently returns undefined against a passing test.
    expect(arc.attributes('pathLength')).toBe('100')

    wrapper.unmount()
  })

  it('no vector-effect on either dashed arc path (round-1 root-cause guard)', async () => {
    const wrapper = await linkedMount()
    fakeState.phase = 'baseline'
    await wrapper.vm.$nextTick()

    expect(progressArc(wrapper).attributes('vector-effect')).toBeUndefined()
    expect(progressArcShadow(wrapper).attributes('vector-effect')).toBeUndefined()

    wrapper.unmount()
  })
})
