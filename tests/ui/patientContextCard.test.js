// @vitest-environment jsdom
//
// R41 Task T4: PatientContextCard is self-contained (no props, no events) —
// it reads patientStore directly and owns the QR modal + unlink confirm
// flows extracted from HomeView. Pinned here: linked renders name/bed/both
// buttons, patientId fallback, bed line hidden when empty, unlinked renders
// nothing, and ออก asks for confirmation before actually unlinking (same
// confirm semantics HomeView had — clear() + resetServer() only fire after
// the confirm click, never on the first click).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PatientContextCard from '../../src/components/PatientContextCard.vue'
import { usePatientStore } from '../../src/stores/patientStore.js'
import { useSyncStore } from '../../src/stores/syncStore.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('PatientContextCard', () => {
  it('renders nothing when unlinked', () => {
    const wrapper = mount(PatientContextCard)

    expect(wrapper.text()).toBe('')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('linked renders the display name, bed line, and both buttons (แสดง QR above ออก)', () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-1', token: 'tok-1' })
    patientStore.applyServerInfo({ displayName: 'สมชาย ใจดี', bed: '5A', baseline: null })

    const wrapper = mount(PatientContextCard)

    expect(wrapper.text()).toContain('สมชาย ใจดี')
    expect(wrapper.text()).toContain('เตียง 5A')
    expect(wrapper.text()).toContain('แสดง QR')
    expect(wrapper.text()).toContain('ออก')

    const buttons = wrapper.findAll('button')
    expect(buttons.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to patientId when displayName is empty', () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-2', token: 'tok-2' })
    // displayName left '' (setContext default / never resolved yet)

    const wrapper = mount(PatientContextCard)

    expect(wrapper.text()).toContain('P-2')
  })

  it('hides the bed line entirely when bed is empty', () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-3', token: 'tok-3' })
    patientStore.applyServerInfo({ displayName: 'มานี', bed: '', baseline: null })

    const wrapper = mount(PatientContextCard)

    expect(wrapper.text()).not.toContain('เตียง')
  })

  it('ออก asks for confirmation first — clicking it alone does not unlink', async () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-4', token: 'tok-4' })
    patientStore.applyServerInfo({ displayName: 'วิชัย', bed: '2B', baseline: null })
    const syncStore = useSyncStore()
    const resetServerSpy = vi.spyOn(syncStore, 'resetServer').mockImplementation(() => {})

    const wrapper = mount(PatientContextCard, { attachTo: document.body })

    const outButton = wrapper.findAll('button').find((b) => b.text().trim() === 'ออก')
    expect(outButton).toBeTruthy()
    await outButton.trigger('click')

    // Clicking ออก alone must not unlink — patientStore stays linked and
    // resetServer() has not fired yet (jsdom has no HTMLDialogElement
    // showModal(), so BaseModal's visual open/close is a no-op here — the
    // meaningful assertion is that the confirm step's SIDE EFFECTS haven't
    // run, same as recordDetailView.test.js's rescue-button/rescue-confirm
    // pattern).
    expect(patientStore.linked).toBe(true)
    expect(resetServerSpy).not.toHaveBeenCalled()

    // Confirming the modal actually unlinks — clear() + resetServer(), same
    // as HomeView's requestUnlink/confirmUnlink today.
    const confirmButton = wrapper
      .findAll('button')
      .find((b) => b.text().trim() === 'ออกจากผู้ป่วย')
    expect(confirmButton).toBeTruthy()
    await confirmButton.trigger('click')

    expect(patientStore.linked).toBe(false)
    expect(resetServerSpy).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  // Fix round 1 MAJOR 3 / ruling R44: hideUnlink is an optional prop
  // (default false) — every existing call site above is unaffected;
  // AssessView is the one call site that passes it true.
  it('hideUnlink hides the ออก button and the unlink-confirm modal entirely; แสดง QR is unaffected', () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-6', token: 'tok-6' })
    patientStore.applyServerInfo({ displayName: 'บุญมี', bed: '8A', baseline: null })

    const wrapper = mount(PatientContextCard, { props: { hideUnlink: true } })

    expect(wrapper.text()).toContain('แสดง QR')
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ออก')).toBe(false)
    // The confirm modal's own copy must not be in the DOM at all, not just
    // visually hidden — it's guarded with v-if, not v-show.
    expect(wrapper.text()).not.toContain('ออกจากผู้ป่วย')

    wrapper.unmount()
  })

  it('hideUnlink defaults to false — ออก still renders when the prop is omitted', () => {
    const patientStore = usePatientStore()
    patientStore.setContext({ patientId: 'P-7', token: 'tok-7' })
    patientStore.applyServerInfo({ displayName: 'สายชล', bed: '9B', baseline: null })

    const wrapper = mount(PatientContextCard)

    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'ออก')).toBe(true)

    wrapper.unmount()
  })
})
