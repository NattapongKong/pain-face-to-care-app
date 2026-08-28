// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScoreTileGroup from '../../src/components/ui/ScoreTileGroup.vue'

const options = [
  { value: 0, label: 'ไม่มีอาการ' },
  { value: 1, label: 'มีอาการเล็กน้อย' },
  { value: 2, label: 'มีอาการชัดเจน' },
]

describe('ScoreTileGroup', () => {
  it('renders 3 options', () => {
    const wrapper = mount(ScoreTileGroup, {
      props: { modelValue: null, options, title: 'คิ้ว' },
    })
    expect(wrapper.findAll('[role="radio"]')).toHaveLength(3)
  })

  it('shows the "AI เสนอ" badge only on the option matching highlight=2', () => {
    const wrapper = mount(ScoreTileGroup, {
      props: { modelValue: null, options, title: 'คิ้ว', highlight: 2 },
    })
    expect(wrapper.get('[data-testid="score-tile-2"]').text()).toContain('AI เสนอ')
    expect(wrapper.get('[data-testid="score-tile-0"]').text()).not.toContain('AI เสนอ')
    expect(wrapper.get('[data-testid="score-tile-1"]').text()).not.toContain('AI เสนอ')
  })

  it('shows no "AI เสนอ" badge when highlight is null', () => {
    const wrapper = mount(ScoreTileGroup, {
      props: { modelValue: null, options, title: 'คิ้ว', highlight: null },
    })
    expect(wrapper.text()).not.toContain('AI เสนอ')
  })

  it('clicking an option emits update:modelValue with its value', async () => {
    const wrapper = mount(ScoreTileGroup, {
      props: { modelValue: null, options, title: 'คิ้ว' },
    })
    await wrapper.get('[data-testid="score-tile-1"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[1]])
  })

  it('renders the Thai descriptor labels and the title', () => {
    const wrapper = mount(ScoreTileGroup, {
      props: { modelValue: null, options, title: 'คิ้ว' },
    })
    expect(wrapper.text()).toContain('คิ้ว')
    expect(wrapper.text()).toContain('ไม่มีอาการ')
    expect(wrapper.text()).toContain('มีอาการเล็กน้อย')
    expect(wrapper.text()).toContain('มีอาการชัดเจน')
  })
})
