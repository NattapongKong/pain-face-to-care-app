// Part 5 "การพยาบาล" — intervention checklists keyed to the Face Pain Scale
// severity band (ruling R7). Thai labels verbatim from the source form
// (แบบร่าง.pdf, spec §2 part 5). Keys are stable ascii slugs shared across
// bands where the same intervention recurs. No Vue/pinia imports.

export const NURSING_CATALOG = {
  mild: [
    { key: 'position', label: 'จัดท่าให้สุขสบาย' },
    { key: 'rest', label: 'ส่งเสริมการพักผ่อน' },
    { key: 'distract', label: 'เบี่ยงเบนความสนใจ' },
    { key: 'relax', label: 'สอนการผ่อนคลาย/การหายใจ' },
    { key: 'medicate', label: 'ให้ยาตามแผนการรักษา', hasDetail: true },
    { key: 'reassess', label: 'ประเมินซ้ำ' },
  ],
  moderate: [
    { key: 'assess-loc', label: 'ประเมินตำแหน่ง/ลักษณะความปวดเพิ่มเติม' },
    { key: 'position', label: 'จัดท่าให้สุขสบาย' },
    { key: 'distract', label: 'เบี่ยงเบนความสนใจ' },
    { key: 'relax', label: 'สอนการผ่อนคลาย/การหายใจ' },
    { key: 'wound', label: 'ประเมินแผล/บริเวณที่ปวด' },
    { key: 'medicate', label: 'ให้ยาตามแผนการรักษา', hasDetail: true },
    { key: 'followup', label: 'ติดตามผลหลังได้รับยา' },
    { key: 'reassess', label: 'ประเมินซ้ำ' },
  ],
  severe: [
    { key: 'detail-pain', label: 'ประเมินความปวดโดยละเอียด' },
    { key: 'vitals', label: 'ประเมิน Vital signs' },
    { key: 'complications', label: 'ประเมินแผล/ภาวะแทรกซ้อน' },
    { key: 'position', label: 'จัดท่าให้สุขสบาย' },
    { key: 'medicate', label: 'ให้ยาตามแผนการรักษา', hasDetail: true },
    { key: 'side-effects', label: 'เฝ้าระวังผลข้างเคียงจากยา' },
    { key: 'notify-md', label: 'รายงานแพทย์เมื่อมีข้อบ่งชี้' },
    { key: 'reassess', label: 'ประเมินซ้ำ' },
  ],
}
