// @vitest-environment jsdom
//
// R41 Task T5 (spec §6): AssessView omits the ข้อมูลผู้ป่วย step entirely
// while patientStore.linked, renumbers the remaining SectionCards
// contiguously, and refills patient/bed from a LATE-resolving context pull
// (fill-only-when-empty preserved). requestAnimationFrame/cancelAnimationFrame
// are stubbed as no-ops throughout (same pattern as
// tests/ui/baselineViewMount.test.js) so step 1's ScanPanel (always
// mounted first — it is never the omitted step) never actually calls
// getUserMedia: the stub captures useFaceScan's deferred start() callback
// but never invokes it, so the scan stays in phase 'idle' for the whole
// test — no camera/model wiring is exercised or needed here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import AssessView from '../../src/views/assess/AssessView.vue'
import Step3Facial from '../../src/views/assess/Step3Facial.vue'
import Step4Result from '../../src/views/assess/Step4Result.vue'
import { usePatientStore } from '../../src/stores/patientStore.js'
import { useAssessmentStore } from '../../src/stores/assessmentStore.js'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/assess', name: 'assess', component: AssessView }],
  })
}

async function mountAssess() {
  const router = makeRouter()
  router.push('/assess')
  await router.isReady()
  return mount(AssessView, { global: { plugins: [router] }, attachTo: document.body })
}

// SectionCard renders <header><span>{{number}}</span><h3>{{title}}</h3></header>
// — locate the header whose h3 matches `title` exactly and read its number
// badge. BaseModal also renders a <header><h3>...</header> (PatientContextCard's
// QR/unlink modals), but never with a matching title and never with a
// leading <span>, so it can't collide with a step's SectionCard header.
function sectionNumberFor(wrapper, title) {
  const header = wrapper.findAll('header').find((h) => h.find('h3').exists() && h.find('h3').text() === title)
  return header ? header.find('span').text() : undefined
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AssessView — linked step skip + contiguous numbering (spec §6)', () => {
  it('linked: renders no ข้อมูลผู้ป่วย SectionCard anywhere in the wizard, and SectionCard numbers read contiguously 1..5', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-1', token: 'tok-1' })
    patientStore.applyServerInfo({ displayName: 'สมชาย', bed: '5A', baseline: null })

    const wrapper = await mountAssess()
    const store = useAssessmentStore()

    // Step 1 สังเกตสีหน้า — always first, display number 1 either way.
    expect(sectionNumberFor(wrapper, 'สังเกตสีหน้า')).toBe('1')
    expect(wrapper.findAll('h3').some((h) => h.text() === 'ข้อมูลผู้ป่วย')).toBe(false)

    store.setStep(3) // ความปวด — first step after the omitted patient step
    await wrapper.vm.$nextTick()
    expect(sectionNumberFor(wrapper, 'ผู้ป่วยรายงานความปวด')).toBe('2')
    expect(wrapper.findAll('h3').some((h) => h.text() === 'ข้อมูลผู้ป่วย')).toBe(false)

    store.setStep(4) // ผลประเมิน (3 SectionCards, all sharing one number)
    await wrapper.vm.$nextTick()
    expect(sectionNumberFor(wrapper, 'Pain Score จากผู้ป่วย')).toBe('3')
    expect(sectionNumberFor(wrapper, 'Face Pain Scale')).toBe('3')
    expect(sectionNumberFor(wrapper, 'เกณฑ์ระดับความปวด')).toBe('3')

    store.setStep(5) // การพยาบาล
    await wrapper.vm.$nextTick()
    expect(sectionNumberFor(wrapper, 'การพยาบาล')).toBe('4')

    store.setStep(6) // ประเมินหลังการพยาบาล
    await wrapper.vm.$nextTick()
    expect(sectionNumberFor(wrapper, 'ประเมินหลังการพยาบาล')).toBe('5')

    wrapper.unmount()
  })

  it('unlinked: ข้อมูลผู้ป่วย still renders at step 2, and numbering matches today\'s literal 1..6', async () => {
    const wrapper = await mountAssess()
    const store = useAssessmentStore()

    expect(sectionNumberFor(wrapper, 'สังเกตสีหน้า')).toBe('1')

    store.setStep(2)
    await wrapper.vm.$nextTick()
    expect(sectionNumberFor(wrapper, 'ข้อมูลผู้ป่วย')).toBe('2')

    store.setStep(3)
    await wrapper.vm.$nextTick()
    expect(sectionNumberFor(wrapper, 'ผู้ป่วยรายงานความปวด')).toBe('3')

    store.setStep(4)
    await wrapper.vm.$nextTick()
    expect(sectionNumberFor(wrapper, 'Pain Score จากผู้ป่วย')).toBe('4')

    store.setStep(5)
    await wrapper.vm.$nextTick()
    expect(sectionNumberFor(wrapper, 'การพยาบาล')).toBe('5')

    store.setStep(6)
    await wrapper.vm.$nextTick()
    expect(sectionNumberFor(wrapper, 'ประเมินหลังการพยาบาล')).toBe('6')

    wrapper.unmount()
  })

  it('goBack from ความปวด (step 3) while linked skips straight to สังเกตสีหน้า (step 1), never landing on the hidden step 2', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-2', token: 'tok-2' })
    patientStore.applyServerInfo({ displayName: 'วิชัย', bed: '2B', baseline: null })

    const wrapper = await mountAssess()
    const store = useAssessmentStore()
    store.setStep(3)
    await wrapper.vm.$nextTick()

    const backButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ย้อนกลับ')
    expect(backButton).toBeTruthy()
    await backButton.trigger('click')

    expect(store.step).toBe(1)

    wrapper.unmount()
  })

  it('goBack from ความปวด (step 3) while unlinked returns to step 2 ข้อมูลผู้ป่วย — today\'s behavior, unchanged', async () => {
    const wrapper = await mountAssess()
    const store = useAssessmentStore()
    store.setStep(3)
    await wrapper.vm.$nextTick()

    const backButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ย้อนกลับ')
    await backButton.trigger('click')

    expect(store.step).toBe(2)

    wrapper.unmount()
  })

  it('a resumed draft that lands on step 2 while now linked is bounced forward to step 3 (enterFromRoute guard)', async () => {
    // Persist a draft on step 2 (as an unlinked device would), then link
    // BEFORE the wizard is (re-)entered — mirrors a device that started an
    // assessment unlinked, stepped into ข้อมูลผู้ป่วย, then got QR-linked
    // before coming back to /assess. facial.source must already be set:
    // assessmentStore.resume()'s OWN ruling-R22 clamp re-forces step back
    // to 1 whenever a steps-2..5 draft has no confirmed facial score yet
    // (unrelated to linking) — this test seeds a confirmed score so step 2
    // genuinely survives resume() and this view's OWN guard is what's
    // actually being exercised.
    const store = useAssessmentStore()
    store.startNew()
    store.updateFacial({
      scores: { brow: 1, eyes: 1, noseCheek: 1, mouth: 1, overall: 1 },
      total: 5,
      source: 'manual',
      proposed: null,
    })
    store.setStep(2)

    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-3', token: 'tok-3' })
    patientStore.applyServerInfo({ displayName: 'มานี', bed: '3C', baseline: null })

    const wrapper = await mountAssess()

    expect(store.step).toBe(3)
    expect(wrapper.findAll('h3').some((h) => h.text() === 'ข้อมูลผู้ป่วย')).toBe(false)
    // Fix round 1 BLOCKER: the bounce path must ALSO fill the empty
    // name/bed it inherited from before the device linked — resume() never
    // calls fillPatientFromContext() on its own.
    expect(store.draft.patient.name).toBe('มานี')
    expect(store.draft.patient.bed).toBe('3C')

    wrapper.unmount()
  })

  it('fix round 1 BLOCKER: a resumed draft with empty name/bed and an ALREADY-resolved context is filled on entry, not left empty', async () => {
    // Build a persisted draft with empty name/bed while unlinked (so
    // startNew()'s own fillPatientFromContext() is a no-op), survive
    // resume()'s R22 clamp the same way as the bounce test above, then
    // resolve the context BEFORE the wizard is ever (re-)entered — e.g. an
    // app reload on a device that was already linked and already pulled.
    const store = useAssessmentStore()
    store.startNew()
    store.updateFacial({
      scores: { brow: 1, eyes: 1, noseCheek: 1, mouth: 1, overall: 1 },
      total: 5,
      source: 'manual',
      proposed: null,
    })
    store.setStep(3) // any non-hidden step; R22 does not clamp facial-confirmed drafts
    expect(store.draft.patient.name).toBe('')
    expect(store.draft.patient.bed).toBe('')

    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-7', token: 'tok-7' })
    patientStore.applyServerInfo({ displayName: 'ประไพ', bed: '7F', baseline: null })

    const wrapper = await mountAssess() // enters via store.resume(), NOT startNew()

    expect(store.draft.patient.name).toBe('ประไพ')
    expect(store.draft.patient.bed).toBe('7F')

    wrapper.unmount()
  })
})

describe('AssessView — StepProgress breadcrumb (fix round 1 MINOR 5)', () => {
  it('linked: breadcrumb has 5 labels, no ข้อมูลผู้ป่วย', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-8', token: 'tok-8' })
    patientStore.applyServerInfo({ displayName: 'สมพงษ์', bed: '4B', baseline: null })

    const wrapper = await mountAssess()
    const items = wrapper.findAll('ul.steps li')

    expect(items.length).toBe(5)
    expect(items.some((li) => li.text().trim() === 'ข้อมูลผู้ป่วย')).toBe(false)

    wrapper.unmount()
  })

  it('unlinked: breadcrumb still has all 6 labels including ข้อมูลผู้ป่วย — today\'s behavior, unchanged', async () => {
    const wrapper = await mountAssess()
    const items = wrapper.findAll('ul.steps li')

    expect(items.length).toBe(6)
    expect(items.some((li) => li.text().trim() === 'ข้อมูลผู้ป่วย')).toBe(true)

    wrapper.unmount()
  })
})

describe('AssessView — PatientContextCard hides ออก (ruling R44)', () => {
  it('the card rendered inside the wizard has no ออก button', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-9', token: 'tok-9' })
    patientStore.applyServerInfo({ displayName: 'อรุณ', bed: '6C', baseline: null })

    const wrapper = await mountAssess()

    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ออก')).toBe(false)
    // แสดง QR (unaffected by hideUnlink) still renders.
    expect(wrapper.text()).toContain('แสดง QR')

    wrapper.unmount()
  })
})

describe('AssessView — late-context refill (spec §6, fill-only-when-empty)', () => {
  it('a displayName/bed pull that resolves AFTER mount still fills the draft, and a second resolve never overwrites the first', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-4', token: 'tok-4' })
    // displayName/bed still '' at mount time — context not resolved yet.

    const wrapper = await mountAssess()
    const store = useAssessmentStore()
    expect(store.draft.patient.name).toBe('')
    expect(store.draft.patient.bed).toBe('')

    // Late pull resolves.
    patientStore.applyServerInfo({ displayName: 'สมหญิง', bed: '9D', baseline: null })
    await wrapper.vm.$nextTick()

    expect(store.draft.patient.name).toBe('สมหญิง')
    expect(store.draft.patient.bed).toBe('9D')

    // A second resolve (e.g. a later re-pull) must never clobber an
    // already-filled field — same fill-only-when-empty contract as
    // assessmentStore.fillPatientFromContext everywhere else.
    patientStore.applyServerInfo({ displayName: 'คนละคน', bed: '1Z', baseline: null })
    await wrapper.vm.$nextTick()

    expect(store.draft.patient.name).toBe('สมหญิง')
    expect(store.draft.patient.bed).toBe('9D')

    wrapper.unmount()
  })

  it('never fills while unlinked', async () => {
    const wrapper = await mountAssess()
    const store = useAssessmentStore()
    const patientStore = usePatientStore()

    // Not linked — applyServerInfo can still be called (e.g. stale timer
    // from a previous link), but the watch must not act on it unlinked.
    patientStore.displayName = 'ไม่ควรเติม'
    patientStore.bed = '0X'
    await wrapper.vm.$nextTick()

    expect(store.draft.patient.name).toBe('')
    expect(store.draft.patient.bed).toBe('')

    wrapper.unmount()
  })
})

describe('Step3Facial — goNext skip (spec §6)', () => {
  function seedConfirmedDraft(store) {
    store.draft.facial = {
      scores: { brow: 1, eyes: 1, noseCheek: 1, mouth: 1, overall: 1 },
      total: 5,
      source: 'manual',
      proposed: null,
    }
  }

  it('advancing from the already-confirmed summary goes to step 3 (ความปวด) when linked, skipping ข้อมูลผู้ป่วย', async () => {
    const store = useAssessmentStore()
    seedConfirmedDraft(store)
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-5', token: 'tok-5' })

    const wrapper = mount(Step3Facial)
    const nextButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ถัดไป')
    expect(nextButton).toBeTruthy()
    await nextButton.trigger('click')

    expect(store.step).toBe(3)
    wrapper.unmount()
  })

  it('advancing from the already-confirmed summary goes to step 2 (ข้อมูลผู้ป่วย) when unlinked — today\'s behavior, unchanged', async () => {
    const store = useAssessmentStore()
    seedConfirmedDraft(store)

    const wrapper = mount(Step3Facial)
    const nextButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ถัดไป')
    await nextButton.trigger('click')

    expect(store.step).toBe(2)
    wrapper.unmount()
  })
})

// R3-T7 (T2 review follow-up, spec §3): the "บันทึกหน้าปกติ" hint used to
// live in ScanPanel's own (unreachable — spec §3 incident) done-state
// branch; it now lives here, fed by store.draft.facial.baselineSource
// (written by Step3Facial's handleConfirm from ScanPanel's `done` emit).
const HINT_TEXT = 'เพื่อผลที่แม่นยำขึ้น แนะนำให้บันทึกหน้าปกติของผู้ป่วยในช่วงที่ไม่ปวด'

function seedFacial(store, extra) {
  store.draft.facial = {
    scores: { brow: 1, eyes: 1, noseCheek: 1, mouth: 1, overall: 1 },
    total: 5,
    source: 'scan+confirmed',
    proposed: null,
    ...extra,
  }
}

describe('Step4Result — default-baseline hint (R3-T7, relocated from ScanPanel)', () => {
  it('renders the hint when baselineSource is "default" and the patient is linked', () => {
    const store = useAssessmentStore()
    seedFacial(store, { baselineSource: 'default' })
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-10', token: 'tok-10' })
    patientStore.applyServerInfo({ displayName: 'สมศรี', bed: '8A', baseline: null })

    const wrapper = mount(Step4Result)
    expect(wrapper.text()).toContain(HINT_TEXT)
    wrapper.unmount()
  })

  it('does not render the hint when baselineSource is "banked" (even while linked)', () => {
    const store = useAssessmentStore()
    seedFacial(store, { baselineSource: 'banked' })
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-11', token: 'tok-11' })
    patientStore.applyServerInfo({ displayName: 'สมศักดิ์', bed: '8B', baseline: { some: 'vector' } })

    const wrapper = mount(Step4Result)
    expect(wrapper.text()).not.toContain(HINT_TEXT)
    wrapper.unmount()
  })

  it('does not render the hint when baselineSource is "default" but the device is unlinked', () => {
    const store = useAssessmentStore()
    seedFacial(store, { baselineSource: 'default' })
    // patientStore left unlinked — no setContext() call.

    const wrapper = mount(Step4Result)
    expect(wrapper.text()).not.toContain(HINT_TEXT)
    wrapper.unmount()
  })

  it('does not render the hint for a legacy draft with no baselineSource field at all (undefined-safe)', () => {
    const store = useAssessmentStore()
    // No `baselineSource` key at all — simulates a draft persisted before
    // this field existed (resume() copies saved.draft verbatim, so this
    // shape is exactly what a legacy draft looks like after resume()).
    store.draft.facial = {
      scores: { brow: 1, eyes: 1, noseCheek: 1, mouth: 1, overall: 1 },
      total: 5,
      source: 'scan+confirmed',
      proposed: null,
    }
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-12', token: 'tok-12' })
    patientStore.applyServerInfo({ displayName: 'สมบัติ', bed: '8C', baseline: null })

    const wrapper = mount(Step4Result)
    expect(wrapper.text()).not.toContain(HINT_TEXT)
    wrapper.unmount()
  })
})
