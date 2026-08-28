// @vitest-environment jsdom
//
// Fix-round MAJOR 3(b): a real end-to-end pin for the R37b rescue action —
// mounts RecordDetailView itself (not a hand-rolled mock of syncStore) so a
// regression in the button-visible / confirm-click / repository-write /
// enqueue-with-the-UPDATED-record wiring fails here, not just in a store
// test that could tautologically mirror whatever the production code does.
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import RecordDetailView from '../../src/views/RecordDetailView.vue'
import { usePatientStore } from '../../src/stores/patientStore.js'
import { useSyncStore } from '../../src/stores/syncStore.js'
import { saveRecord, loadRecords } from '../../src/domain/repository.js'
import { vi } from 'vitest'

function fakeRecord(id, patientId) {
  return {
    id,
    createdAt: '2026-08-25T10:00:00.000Z',
    patientId: patientId ?? null,
    synced: false,
    patient: { name: `ผู้ป่วย ${id}`, bed: '1A', datetime: '2026-08-25T10:00' },
    reported: { painScore: 5, location: '', vitalsChanged: false, vitalsDetail: '' },
    facial: {
      scores: { brow: 1, eyes: 1, noseCheek: 1, mouth: 1, overall: 1 },
      total: 5,
      source: 'manual',
      proposed: null,
    },
    result: { reportedSeverity: 'moderate', faceSeverity: 'moderate' },
    nursing: { band: 'moderate', items: [] },
    reassess: null,
    status: 'awaiting-reassess',
  }
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/records', name: 'records', component: { template: '<div />' } },
      { path: '/records/:id', name: 'record-detail', component: RecordDetailView, props: true },
      { path: '/assess', name: 'assess', component: { template: '<div />' } },
    ],
  })
}

async function mountDetail(id) {
  const router = makeRouter()
  router.push(`/records/${id}`)
  await router.isReady()
  return mount(RecordDetailView, {
    props: { id },
    global: { plugins: [router] },
    attachTo: document.body,
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('RecordDetailView — rescue action (ruling R37b)', () => {
  it('a stranded (patientId:null) LOCAL record is found and its rescue button renders while linked (blocker: record must resolve at all)', async () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    usePatientStore().applyServerInfo({ displayName: 'สมชาย', bed: '5A', baseline: null })
    saveRecord(fakeRecord('r1', null))

    const wrapper = await mountDetail('r1')

    expect(wrapper.text()).not.toContain('ไม่พบข้อมูล')
    expect(wrapper.text()).toContain('ผูกกับผู้ป่วย "สมชาย" และซิงค์')

    wrapper.unmount()
  })

  it('clicking the rescue button then confirming attributes the record, enqueues the UPDATED record (not a stale patientId:null copy), and the record enters the patient\'s visible view', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })
    patientStore.applyServerInfo({ displayName: 'สมชาย', bed: '5A', baseline: null })
    saveRecord(fakeRecord('r1', null))

    const syncStore = useSyncStore()
    const enqueueSpy = vi.spyOn(syncStore, 'enqueueRecord').mockResolvedValue(undefined)

    const wrapper = await mountDetail('r1')

    await wrapper.find('[data-testid="rescue-button"]').trigger('click')
    await wrapper.find('[data-testid="rescue-confirm-button"]').trigger('click')

    // Repository row is actually attributed.
    const stored = loadRecords().find((r) => r.id === 'r1')
    expect(stored.patientId).toBe('A')

    // syncStore received the UPDATED record object -- patientId must already
    // read 'A' on the object handed to enqueueRecord, not the stale null one
    // captured before repository.updateRecord ran.
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    const [ctxArg, recordArg] = enqueueSpy.mock.calls[0]
    expect(ctxArg).toEqual({ patientId: 'A', token: 'tok-a' })
    expect(recordArg.id).toBe('r1')
    expect(recordArg.patientId).toBe('A')

    // The record store's own visibility filter now shows it under 'A'.
    const { useRecordsStore } = await import('../../src/stores/recordsStore.js')
    const recordsStore = useRecordsStore()
    expect(recordsStore.visibleRecords('A').map((r) => r.id)).toContain('r1')

    wrapper.unmount()
  })

  it('never offers rescue for an already-attributed record, even while linked to a DIFFERENT patient', async () => {
    usePatientStore().setContext({ patientId: 'B', token: 'tok-b' })
    saveRecord(fakeRecord('r2', 'A')) // belongs to A, device now linked to B

    const wrapper = await mountDetail('r2')

    // Foreign-patient record: correctly excluded from B's view entirely
    // (unrelated to rescue) -- "ไม่พบข้อมูล", and definitely no rescue button.
    expect(wrapper.text()).toContain('ไม่พบข้อมูล')
    expect(wrapper.find('[data-testid="rescue-button"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('never offers rescue while unlinked', async () => {
    saveRecord(fakeRecord('r3', null))

    const wrapper = await mountDetail('r3')

    expect(wrapper.text()).not.toContain('ไม่พบข้อมูล')
    expect(wrapper.find('[data-testid="rescue-button"]').exists()).toBe(false)

    wrapper.unmount()
  })
})

// Ruling R42 (recorded lead ruling, T4 review): a resolved record that goes
// missing WHILE this view stays mounted (the nurse taps ออก on the new
// PatientContextCard while viewing that patient's own record — the record
// leaves visibleRecords() the instant patientStore clears) must silently
// bounce to /records, never show "ไม่พบข้อมูล". A record that was never
// resolvable in the first place (bad/stale id straight from the URL) keeps
// today's "ไม่พบข้อมูล" behavior — the transition guard (prev truthy, next
// falsy) is what tells the two cases apart.
describe('RecordDetailView — redirect on resolved-record loss (ruling R42)', () => {
  it('unlinking (ออก) while viewing a linked patient\'s own record redirects to /records instead of showing "ไม่พบข้อมูล"', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })
    patientStore.applyServerInfo({ displayName: 'สมชาย', bed: '5A', baseline: null })
    saveRecord(fakeRecord('r10', 'A'))

    // mountDetail() (defined above) creates its own router and awaits it,
    // giving Vue's scheduler a microtask tick to flush the onMounted()
    // recordsStore.load() reactivity update before the first assertion —
    // same helper the R37b rescue tests above already rely on for this.
    const router = makeRouter()
    router.push('/records/r10')
    await router.isReady()
    const wrapper = mount(RecordDetailView, {
      props: { id: 'r10' },
      global: { plugins: [router] },
      attachTo: document.body,
    })
    await wrapper.vm.$nextTick()

    // Sanity: the record is showing before the unlink.
    expect(wrapper.text()).not.toContain('ไม่พบข้อมูล')

    // Same ออก -> ยืนยัน flow PatientContextCard exposes everywhere else.
    const outButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ออก')
    expect(outButton).toBeTruthy()
    await outButton.trigger('click')
    const confirmButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ออกจากผู้ป่วย')
    expect(confirmButton).toBeTruthy()
    await confirmButton.trigger('click')
    // router.replace() resolves through vue-router's own async navigation
    // pipeline, not just a Vue reactivity tick — flushPromises() drains
    // that too.
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/records')

    wrapper.unmount()
  })

  it('a bad/stale id in the URL on initial load still shows "ไม่พบข้อมูล" (no transition, no redirect)', async () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })

    const router = makeRouter()
    router.push('/records/does-not-exist')
    await router.isReady()
    const wrapper = mount(RecordDetailView, {
      props: { id: 'does-not-exist' },
      global: { plugins: [router] },
      attachTo: document.body,
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('ไม่พบข้อมูล')
    expect(router.currentRoute.value.path).toBe('/records/does-not-exist')

    wrapper.unmount()
  })

  it('fix round 1 MINOR 4: an in-place id change (resolved A -> bad B) shows B\'s own "ไม่พบข้อมูล" instead of redirecting', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'A', token: 'tok-a' })
    saveRecord(fakeRecord('r11', 'A'))

    const router = makeRouter()
    router.push('/records/r11')
    await router.isReady()
    const wrapper = mount(RecordDetailView, {
      props: { id: 'r11' },
      global: { plugins: [router] },
      attachTo: document.body,
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('ไม่พบข้อมูล')

    const replaceSpy = vi.spyOn(router, 'replace')

    // Simulates vue-router reusing this SAME instance for /records/r11 ->
    // /records/bad-id (same matched route, only the param differs) —
    // props.id genuinely changing is exactly what must NOT be mistaken for
    // the R42 unlink-style transition.
    await wrapper.setProps({ id: 'bad-id' })
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('ไม่พบข้อมูล')
    expect(replaceSpy).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})
