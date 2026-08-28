// Part 3 "สังเกตสีหน้า" — five facial categories, each scored 0/1/2. Thai
// titles + descriptors verbatim from the source form (แบบร่าง.pdf, spec §2
// part 3). No Vue/pinia imports.

export const FACIAL_CATALOG = [
  {
    key: 'brow',
    title: 'คิ้วและหน้าผาก',
    options: [
      { value: 0, label: 'สีหน้าปกติ คิ้วผ่อนคลาย' },
      { value: 1, label: 'ขมวดคิ้วเป็นบางครั้ง' },
      { value: 2, label: 'หน้านิ่ว คิ้วขมวดชัดเจน/ต่อเนื่อง' },
    ],
  },
  {
    key: 'eyes',
    title: 'ดวงตา',
    options: [
      { value: 0, label: 'ลืมตาปกติ สีหน้าผ่อนคลาย' },
      { value: 1, label: 'หรี่ตาหรือหลับตาเป็นบางครั้ง' },
      { value: 2, label: 'หรี่ตาหรือหลับตาแน่น แสดงความทุกข์ทรมาน' },
    ],
  },
  {
    key: 'noseCheek',
    title: 'จมูกและแก้ม',
    options: [
      { value: 0, label: 'ใบหน้าผ่อนคลาย' },
      { value: 1, label: 'มีการเกร็งหรือย่นเล็กน้อย' },
      { value: 2, label: 'เกร็งหรือย่นชัดเจน' },
    ],
  },
  {
    key: 'mouth',
    title: 'ริมฝีปากและปาก',
    options: [
      { value: 0, label: 'ปากผ่อนคลาย' },
      { value: 1, label: 'เม้มปากเป็นบางครั้ง' },
      { value: 2, label: 'เม้มปากแน่น บิดเบี้ยว หรือแสดงความเจ็บปวดชัดเจน' },
    ],
  },
  {
    key: 'overall',
    title: 'สีหน้าโดยรวม',
    options: [
      { value: 0, label: 'สีหน้าปกติและผ่อนคลาย' },
      { value: 1, label: 'สีหน้าเคร่งเครียดหรือไม่สุขสบายเป็นบางครั้ง' },
      { value: 2, label: 'สีหน้าเคร่งเครียด แสดงความเจ็บปวดหรือทุกข์ทรมานชัดเจน/ต่อเนื่อง' },
    ],
  },
]
