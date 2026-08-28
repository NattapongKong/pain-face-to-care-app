// @vitest-environment jsdom
//
// Wave-4 layout audit (docs/superpowers/plans/2026-08-24-layout-audit.md).
// Locks in the narrow-viewport overflow guards added to the ui library so a
// future edit can't silently drop them: flex children paired with a
// shrink-0 sibling (icon, badge, close button) must be able to shrink below
// their content size (min-w-0) and wrap long/unbreakable Thai or numeric
// text (break-words) instead of forcing horizontal overflow.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusBadge from '../../src/components/ui/StatusBadge.vue'
import BaseModal from '../../src/components/ui/BaseModal.vue'
import SectionCard from '../../src/components/ui/SectionCard.vue'
import ScoreTileGroup from '../../src/components/ui/ScoreTileGroup.vue'
import ChecklistGroup from '../../src/components/ui/ChecklistGroup.vue'
import YesNoDetail from '../../src/components/ui/YesNoDetail.vue'
import StepProgress from '../../src/components/ui/StepProgress.vue'

describe('layout overflow guards', () => {
  it('StatusBadge wraps instead of forcing a single unbroken line for a long label', () => {
    const wrapper = mount(StatusBadge, {
      props: { severity: 'severe', label: 'สีหน้า: ปวดมาก (ค่าที่ยาวมากสำหรับทดสอบการตัดบรรทัด)' },
    })
    expect(wrapper.classes()).toContain('whitespace-normal')
    expect(wrapper.classes()).toContain('break-words')
  })

  it('BaseModal footer actions row wraps and the title cannot force horizontal overflow', async () => {
    const wrapper = mount(BaseModal, {
      props: { open: true, title: 'หัวข้อ' },
      slots: { actions: '<button>หนึ่ง</button><button>สอง</button><button>สาม</button>' },
      attachTo: document.body,
    })
    expect(wrapper.find('footer').classes()).toContain('flex-wrap')
    expect(wrapper.find('h3').classes()).toEqual(
      expect.arrayContaining(['min-w-0', 'break-words'])
    )
    wrapper.unmount()
  })

  it('SectionCard title cannot force horizontal overflow next to the numbered circle', () => {
    const wrapper = mount(SectionCard, { props: { number: 1, title: 'หัวข้อ' } })
    expect(wrapper.find('h3').classes()).toEqual(
      expect.arrayContaining(['min-w-0', 'break-words'])
    )
  })

  it('ScoreTileGroup option label wraps instead of overflowing past the "AI เสนอ" badge', () => {
    const wrapper = mount(ScoreTileGroup, {
      props: {
        modelValue: null,
        options: [{ value: 2, label: 'สีหน้าเคร่งเครียด แสดงความเจ็บปวดหรือทุกข์ทรมานชัดเจน/ต่อเนื่อง' }],
        highlight: 2,
      },
    })
    const label = wrapper.get('[data-testid="score-tile-2"] span')
    expect(label.classes()).toEqual(expect.arrayContaining(['min-w-0', 'break-words']))
  })

  it('ChecklistGroup item label wraps instead of overflowing past the checkbox', () => {
    const wrapper = mount(ChecklistGroup, {
      props: {
        modelValue: [],
        items: [{ key: 'a', label: 'รายการที่มีข้อความยาวมากสำหรับทดสอบการตัดบรรทัดในรายการตรวจสอบ', hasDetail: false }],
      },
    })
    expect(wrapper.get('label span').classes()).toEqual(
      expect.arrayContaining(['min-w-0', 'break-words'])
    )
  })

  it('YesNoDetail wraps its yes/no row and both option labels can shrink', () => {
    const wrapper = mount(YesNoDetail, {
      props: { modelValue: { answer: null, detail: '' }, yesLabel: 'ใช่', noLabel: 'ไม่' },
    })
    expect(wrapper.find('div.flex.gap-4').classes()).toContain('flex-wrap')
  })

  it('StepProgress stays inside an overflow-x-auto wrapper for a 6-item header', () => {
    const labels = ['สังเกตสีหน้า', 'ข้อมูลผู้ป่วย', 'ความปวด', 'ผลประเมิน', 'การพยาบาล', 'ประเมินซ้ำ'] // R18 scan-first order
    const wrapper = mount(StepProgress, { props: { current: 3, labels } })
    expect(wrapper.classes()).toContain('overflow-x-auto')
    expect(wrapper.find('ul').classes()).toEqual(expect.arrayContaining(['min-w-max', 'w-full']))
    expect(wrapper.findAll('.step')).toHaveLength(6)
  })
})
