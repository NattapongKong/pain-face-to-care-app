// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PainScalePicker from '../../src/components/ui/PainScalePicker.vue'

// Thai short labels for all 11 tiles (0–10), as the caller is contractually
// required to pass via `labels`.
const labels = Array.from({ length: 11 }, (_, value) => ({ value, label: `ป้าย ${value}` }))

describe('PainScalePicker', () => {
  it('renders 11 tappable tiles', () => {
    const wrapper = mount(PainScalePicker, { props: { modelValue: null, labels } })
    expect(wrapper.findAll('[role="radio"]')).toHaveLength(11)
  })

  it('clicking tile 7 emits update:modelValue with 7', async () => {
    const wrapper = mount(PainScalePicker, { props: { modelValue: null, labels } })
    await wrapper.get('[data-testid="pain-tile-7"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[7]])
  })

  it('applies the error ring class to the selected tile when it is in the severe band (7-10)', () => {
    const wrapper = mount(PainScalePicker, { props: { modelValue: 7, labels } })
    const tile = wrapper.get('[data-testid="pain-tile-7"]')
    expect(tile.classes()).toContain('ring-error')
  })

  it('does not apply the error ring to a non-selected severe-band tile', () => {
    const wrapper = mount(PainScalePicker, { props: { modelValue: 2, labels } })
    const tile = wrapper.get('[data-testid="pain-tile-8"]')
    expect(tile.classes()).not.toContain('ring-error')
  })

  it('applies the success ring to a selected mild-band tile (1-3)', () => {
    const wrapper = mount(PainScalePicker, { props: { modelValue: 2, labels } })
    expect(wrapper.get('[data-testid="pain-tile-2"]').classes()).toContain('ring-success')
  })

  it('applies a neutral ring to a selected tile 0', () => {
    const wrapper = mount(PainScalePicker, { props: { modelValue: 0, labels } })
    const classes = wrapper.get('[data-testid="pain-tile-0"]').classes()
    expect(classes).not.toContain('ring-success')
    expect(classes).not.toContain('ring-warning')
    expect(classes).not.toContain('ring-error')
  })

  it('renders the Thai label passed for each tile', () => {
    const wrapper = mount(PainScalePicker, { props: { modelValue: null, labels } })
    expect(wrapper.get('[data-testid="pain-tile-5"]').text()).toContain('ป้าย 5')
  })
})
