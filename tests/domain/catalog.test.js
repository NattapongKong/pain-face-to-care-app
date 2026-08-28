import { describe, it, expect } from 'vitest'
import { NURSING_CATALOG } from '../../src/domain/nursingCatalog.js'
import { FACIAL_CATALOG } from '../../src/domain/facialCatalog.js'
import { PAIN_SCALE_LABELS } from '../../src/domain/painScaleLabels.js'

describe('domain/nursingCatalog', () => {
  it('has mild (6), moderate (8), severe (8) items', () => {
    expect(NURSING_CATALOG.mild).toHaveLength(6)
    expect(NURSING_CATALOG.moderate).toHaveLength(8)
    expect(NURSING_CATALOG.severe).toHaveLength(8)
  })

  it('every item has a stable ascii key and Thai label', () => {
    for (const band of ['mild', 'moderate', 'severe']) {
      for (const item of NURSING_CATALOG[band]) {
        expect(item.key).toMatch(/^[a-z-]+$/)
        expect(typeof item.label).toBe('string')
        expect(item.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('the medication item is flagged hasDetail in every band', () => {
    for (const band of ['mild', 'moderate', 'severe']) {
      const med = NURSING_CATALOG[band].find((i) => i.label === 'ให้ยาตามแผนการรักษา')
      expect(med).toBeDefined()
      expect(med.hasDetail).toBe(true)
    }
  })

  it('mild items match the form verbatim', () => {
    expect(NURSING_CATALOG.mild.map((i) => i.label)).toEqual([
      'จัดท่าให้สุขสบาย',
      'ส่งเสริมการพักผ่อน',
      'เบี่ยงเบนความสนใจ',
      'สอนการผ่อนคลาย/การหายใจ',
      'ให้ยาตามแผนการรักษา',
      'ประเมินซ้ำ',
    ])
  })

  it('moderate items match the form verbatim', () => {
    expect(NURSING_CATALOG.moderate.map((i) => i.label)).toEqual([
      'ประเมินตำแหน่ง/ลักษณะความปวดเพิ่มเติม',
      'จัดท่าให้สุขสบาย',
      'เบี่ยงเบนความสนใจ',
      'สอนการผ่อนคลาย/การหายใจ',
      'ประเมินแผล/บริเวณที่ปวด',
      'ให้ยาตามแผนการรักษา',
      'ติดตามผลหลังได้รับยา',
      'ประเมินซ้ำ',
    ])
  })

  it('severe items match the form verbatim', () => {
    expect(NURSING_CATALOG.severe.map((i) => i.label)).toEqual([
      'ประเมินความปวดโดยละเอียด',
      'ประเมิน Vital signs',
      'ประเมินแผล/ภาวะแทรกซ้อน',
      'จัดท่าให้สุขสบาย',
      'ให้ยาตามแผนการรักษา',
      'เฝ้าระวังผลข้างเคียงจากยา',
      'รายงานแพทย์เมื่อมีข้อบ่งชี้',
      'ประเมินซ้ำ',
    ])
  })
})

describe('domain/facialCatalog', () => {
  it('has 5 categories in order brow, eyes, noseCheek, mouth, overall', () => {
    expect(FACIAL_CATALOG.map((c) => c.key)).toEqual(['brow', 'eyes', 'noseCheek', 'mouth', 'overall'])
  })

  it('each category has 3 options (0,1,2) with Thai labels', () => {
    for (const cat of FACIAL_CATALOG) {
      expect(cat.options).toHaveLength(3)
      expect(cat.options.map((o) => o.value)).toEqual([0, 1, 2])
      for (const opt of cat.options) {
        expect(typeof opt.label).toBe('string')
        expect(opt.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('brow descriptors match the form verbatim', () => {
    const brow = FACIAL_CATALOG.find((c) => c.key === 'brow')
    expect(brow.title).toBe('คิ้วและหน้าผาก')
    expect(brow.options.map((o) => o.label)).toEqual([
      'สีหน้าปกติ คิ้วผ่อนคลาย',
      'ขมวดคิ้วเป็นบางครั้ง',
      'หน้านิ่ว คิ้วขมวดชัดเจน/ต่อเนื่อง',
    ])
  })

  it('eyes descriptors match the form verbatim', () => {
    const eyes = FACIAL_CATALOG.find((c) => c.key === 'eyes')
    expect(eyes.title).toBe('ดวงตา')
    expect(eyes.options.map((o) => o.label)).toEqual([
      'ลืมตาปกติ สีหน้าผ่อนคลาย',
      'หรี่ตาหรือหลับตาเป็นบางครั้ง',
      'หรี่ตาหรือหลับตาแน่น แสดงความทุกข์ทรมาน',
    ])
  })

  it('noseCheek descriptors match the form verbatim', () => {
    const noseCheek = FACIAL_CATALOG.find((c) => c.key === 'noseCheek')
    expect(noseCheek.title).toBe('จมูกและแก้ม')
    expect(noseCheek.options.map((o) => o.label)).toEqual([
      'ใบหน้าผ่อนคลาย',
      'มีการเกร็งหรือย่นเล็กน้อย',
      'เกร็งหรือย่นชัดเจน',
    ])
  })

  it('mouth descriptors match the form verbatim', () => {
    const mouth = FACIAL_CATALOG.find((c) => c.key === 'mouth')
    expect(mouth.title).toBe('ริมฝีปากและปาก')
    expect(mouth.options.map((o) => o.label)).toEqual([
      'ปากผ่อนคลาย',
      'เม้มปากเป็นบางครั้ง',
      'เม้มปากแน่น บิดเบี้ยว หรือแสดงความเจ็บปวดชัดเจน',
    ])
  })

  it('overall descriptors match the form verbatim', () => {
    const overall = FACIAL_CATALOG.find((c) => c.key === 'overall')
    expect(overall.title).toBe('สีหน้าโดยรวม')
    expect(overall.options.map((o) => o.label)).toEqual([
      'สีหน้าปกติและผ่อนคลาย',
      'สีหน้าเคร่งเครียดหรือไม่สุขสบายเป็นบางครั้ง',
      'สีหน้าเคร่งเครียด แสดงความเจ็บปวดหรือทุกข์ทรมานชัดเจน/ต่อเนื่อง',
    ])
  })
})

describe('domain/painScaleLabels', () => {
  it('has 11 entries for values 0..10', () => {
    expect(PAIN_SCALE_LABELS).toHaveLength(11)
    expect(PAIN_SCALE_LABELS.map((l) => l.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('labels match the Pain Smart Wheel verbatim (ruling R14)', () => {
    expect(PAIN_SCALE_LABELS.map((l) => l.label)).toEqual([
      'ไม่ปวด สบายดี ไม่ปวดเลย',
      'ปวดเล็กน้อย พอทนได้',
      'เริ่มปวด ยังพอทนได้',
      'ปวดเพิ่มขึ้น เริ่มรบกวน',
      'ปวดพอสมควร เริ่มรบกวน',
      'ปวดค่อนข้างมาก รบกวนการทำกิจกรรม',
      'ปวดมาก ทำกิจกรรมลำบาก',
      'ปวดมาก นั่งนิ่งไม่ได้',
      'ปวดรุนแรงมาก ทรมาน',
      'ปวดที่สุด แทบทนไม่ไหว',
      'ปวดมากที่สุด ไม่สามารถทนได้',
    ])
  })

  it('every label is a non-empty Thai string', () => {
    for (const entry of PAIN_SCALE_LABELS) {
      expect(typeof entry.label).toBe('string')
      expect(entry.label.length).toBeGreaterThan(0)
    }
  })
})
