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
// unchanged. The percent text itself is untouched — see the countdown/label
// suite above.
describe('ScanPanel — mild-oval face guide + on-guide progress arc (R5-T1 round 3)', () => {
  function guideEllipse(wrapper) {
    return wrapper.find('[data-testid="face-guide"]')
  }
  function progressArc(wrapper) {
    return wrapper.find('[data-testid="face-progress-arc"]')
  }
  function progressArcShadow(wrapper) {
    return wrapper.find('[data-testid="face-progress-arc-shadow"]')
  }

  it('cuts the scrim mask with an <ellipse> (not a <circle>) while active', async () => {
    const wrapper = mountPanel()
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
    const wrapper = mountPanel()
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
    const wrapper = mountPanel()
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
    const wrapper = mountPanel()
    fakeState.phase = 'capturing'
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
    const wrapper = mountPanel()
    fakeState.phase = 'capturing'
    await wrapper.vm.$nextTick()

    expect(progressArc(wrapper).attributes('transform')).toBeUndefined()
    expect(progressArcShadow(wrapper).attributes('transform')).toBeUndefined()

    wrapper.unmount()
  })

  it('the old separate track/arc ring testid ("face-progress-track") no longer exists anywhere', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'capturing'
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
    const wrapper = mountPanel()
    fakeState.phase = 'capturing'

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

  it('also drains during the "baseline" timed phase (phase A, model mode) — same as the FAB ring', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'baseline'
    fakeState.progress = 0.5
    await wrapper.vm.$nextTick()

    expect(progressArc(wrapper).attributes('stroke-dasharray')).toBe('50 50')

    wrapper.unmount()
  })

  it('both arc paths are ABSENT (v-if, not just dash math) during preview, even with a nonzero stale progress value', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'preview'
    fakeState.progress = 0.7 // stale leftover from a prior capture — must not leak into the arc here
    await wrapper.vm.$nextTick()

    expect(progressArc(wrapper).exists()).toBe(false)
    expect(progressArcShadow(wrapper).exists()).toBe(false)

    wrapper.unmount()
  })

  it('both arc paths are ABSENT during countdown too (the numeral is that phase\'s own indicator)', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'countdown'
    fakeState.progress = 0.3
    await wrapper.vm.$nextTick()

    expect(progressArc(wrapper).exists()).toBe(false)
    expect(progressArcShadow(wrapper).exists()).toBe(false)

    wrapper.unmount()
  })

  // Round 2 ruling (unaffected by round 3): no navy/red phase-color split
  // for this arc — plain white with a dark contrast halo underneath,
  // regardless of baseline vs capturing (the FAB ring keeps its own
  // independent navy/red split).
  it('renders white (not phase-colored) with a translucent dark halo underneath, in both timed phases', async () => {
    const wrapper = mountPanel()

    fakeState.phase = 'baseline'
    await wrapper.vm.$nextTick()
    expect(progressArc(wrapper).attributes('stroke')).toBe('#ffffff')
    expect(progressArcShadow(wrapper).attributes('stroke')).toBe('#000000')

    fakeState.phase = 'capturing'
    await wrapper.vm.$nextTick()
    expect(progressArc(wrapper).attributes('stroke')).toBe('#ffffff')
    expect(progressArcShadow(wrapper).attributes('stroke')).toBe('#000000')

    wrapper.unmount()
  })

  it('arc uses pathLength="100" normalization', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'capturing'
    await wrapper.vm.$nextTick()

    const arc = progressArc(wrapper)
    // SVG attribute names are case-sensitive and NOT lowercased by the DOM
    // for non-HTML elements — pathLength must be asserted with this exact
    // case or the lookup silently returns undefined against a passing test.
    expect(arc.attributes('pathLength')).toBe('100')

    wrapper.unmount()
  })

  it('no vector-effect on either dashed arc path (round-1 root-cause guard)', async () => {
    const wrapper = mountPanel()
    fakeState.phase = 'capturing'
    await wrapper.vm.$nextTick()

    expect(progressArc(wrapper).attributes('vector-effect')).toBeUndefined()
    expect(progressArcShadow(wrapper).attributes('vector-effect')).toBeUndefined()

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
