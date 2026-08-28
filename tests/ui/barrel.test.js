// @vitest-environment jsdom
//
// Whole-library smoke test. `SKIP_MODEL_FETCH=1 npm run build` alone would NOT
// catch a syntax/reference error in these components yet — nothing in the
// scaffold imports src/components/ui/** until Wave 3 wires up the views, so
// Vite's module graph never reaches them. This test forces every barrel
// export to be transformed and mounted at least once.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import * as ui from '../../src/components/ui/index.js'

describe('ui barrel', () => {
  it('exports every component named in the Task 2 contract', () => {
    const names = [
      'BaseButton',
      'BaseInput',
      'BaseTextarea',
      'BaseModal',
      'StatusBadge',
      'Icon',
      'StepProgress',
      'PainScalePicker',
      'ScoreTileGroup',
      'ChecklistGroup',
      'YesNoDetail',
      'SectionCard',
      'ToastContainer',
      'useToast',
    ]
    for (const name of names) {
      expect(ui[name], `missing export: ${name}`).toBeTruthy()
    }
  })

  it('BaseButton mounts, shows its slot, and emits click', async () => {
    const wrapper = mount(ui.BaseButton, { slots: { default: 'บันทึก' } })
    expect(wrapper.text()).toContain('บันทึก')
    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toBeTruthy()
  })

  it('BaseButton disables and shows a spinner while loading', () => {
    const wrapper = mount(ui.BaseButton, { props: { loading: true } })
    expect(wrapper.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.loading-spinner').exists()).toBe(true)
  })

  it('BaseInput mounts with a label and emits update:modelValue on input', async () => {
    const wrapper = mount(ui.BaseInput, { props: { modelValue: '', label: 'ชื่อผู้ป่วย' } })
    expect(wrapper.text()).toContain('ชื่อผู้ป่วย')
    await wrapper.find('input').setValue('สมชาย')
    expect(wrapper.emitted('update:modelValue')[0]).toEqual(['สมชาย'])
  })

  it('BaseTextarea mounts and emits update:modelValue on input', async () => {
    const wrapper = mount(ui.BaseTextarea, { props: { modelValue: '', rows: 5 } })
    expect(wrapper.find('textarea').attributes('rows')).toBe('5')
    await wrapper.find('textarea').setValue('รายละเอียด')
    expect(wrapper.emitted('update:modelValue')[0]).toEqual(['รายละเอียด'])
  })

  it('BaseModal renders its title and default slot, and emits close', async () => {
    const wrapper = mount(ui.BaseModal, {
      props: { open: true, title: 'ยืนยัน' },
      slots: { default: '<p>เนื้อหา</p>' },
      attachTo: document.body,
    })
    expect(wrapper.text()).toContain('ยืนยัน')
    expect(wrapper.html()).toContain('เนื้อหา')
    await wrapper.find('[aria-label="ปิด"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })

  it('StatusBadge shows severity label, and "ไม่ปวด" ghost badge when severity is null', () => {
    const mild = mount(ui.StatusBadge, { props: { severity: 'mild' } })
    expect(mild.text()).toContain('ปวดน้อย')
    const none = mount(ui.StatusBadge, { props: { severity: null } })
    expect(none.text()).toContain('ไม่ปวด')
    expect(none.classes()).toContain('badge-ghost')
  })

  it('Icon renders a known glyph without warning and falls back for unknown names', () => {
    const known = mount(ui.Icon, { props: { name: 'close', size: 24 } })
    expect(known.find('svg').exists()).toBe(true)
    const unknown = mount(ui.Icon, { props: { name: 'not-a-real-icon' } })
    expect(unknown.find('svg').exists()).toBe(true)
  })

  it('StepProgress renders one step per label and marks steps up to current active', () => {
    const wrapper = mount(ui.StepProgress, {
      props: { current: 3, labels: ['หนึ่ง', 'สอง', 'สาม', 'สี่'] },
    })
    const steps = wrapper.findAll('.step')
    expect(steps).toHaveLength(4)
    expect(steps[2].classes()).toContain('step-primary')
    expect(steps[3].classes()).not.toContain('step-primary')
  })

  it('ChecklistGroup toggles a checkbox and reveals a detail input only for hasDetail items', async () => {
    const items = [
      { key: 'a', label: 'ข้อ ก', hasDetail: false },
      { key: 'b', label: 'ข้อ ข', hasDetail: true },
    ]
    const wrapper = mount(ui.ChecklistGroup, { props: { modelValue: [], items } })
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    await checkboxes[0].setValue(true)
    expect(wrapper.emitted('update:modelValue')[0][0]).toEqual([{ key: 'a', checked: true, detail: '' }])

    const wrapper2 = mount(ui.ChecklistGroup, {
      props: { modelValue: [{ key: 'b', checked: true, detail: '' }], items },
    })
    expect(wrapper2.findComponent(ui.BaseInput).exists()).toBe(true)
  })

  it('YesNoDetail shows the detail input only when answer is true, and emits patches', async () => {
    const wrapper = mount(ui.YesNoDetail, {
      props: { modelValue: { answer: null, detail: '' }, detailPlaceholder: 'ระบุ' },
    })
    expect(wrapper.findComponent(ui.BaseInput).exists()).toBe(false)
    const radios = wrapper.findAll('input[type="radio"]')
    await radios[0].setValue(true)
    expect(wrapper.emitted('update:modelValue')[0]).toEqual([{ answer: true, detail: '' }])
  })

  it('SectionCard renders the numbered circle, title, and slot body', () => {
    const wrapper = mount(ui.SectionCard, {
      props: { number: 3, title: 'สังเกตสีหน้า' },
      slots: { default: '<p>เนื้อหา</p>' },
    })
    expect(wrapper.text()).toContain('3')
    expect(wrapper.text()).toContain('สังเกตสีหน้า')
    expect(wrapper.html()).toContain('เนื้อหา')
  })

  it('useToast + ToastContainer share state: toast() pushes a rendered alert', async () => {
    const { toast } = ui.useToast()
    const wrapper = mount(ui.ToastContainer)
    toast('บันทึกแล้ว', 'success')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('บันทึกแล้ว')
    expect(wrapper.find('.alert-success').exists()).toBe(true)
  })
})
