// Part 2 "ผู้ป่วยรายงานความปวด" — 0-10 pain scale, Pain Smart Wheel style.
// All 11 labels are authoritative, verbatim copy from the Pain Smart Wheel
// infographic (per lead ruling R14) — not self-authored. No Vue/pinia imports.

export const PAIN_SCALE_LABELS = [
  { value: 0, label: 'ไม่ปวด สบายดี ไม่ปวดเลย' },
  { value: 1, label: 'ปวดเล็กน้อย พอทนได้' },
  { value: 2, label: 'เริ่มปวด ยังพอทนได้' },
  { value: 3, label: 'ปวดเพิ่มขึ้น เริ่มรบกวน' },
  { value: 4, label: 'ปวดพอสมควร เริ่มรบกวน' },
  { value: 5, label: 'ปวดค่อนข้างมาก รบกวนการทำกิจกรรม' },
  { value: 6, label: 'ปวดมาก ทำกิจกรรมลำบาก' },
  { value: 7, label: 'ปวดมาก นั่งนิ่งไม่ได้' },
  { value: 8, label: 'ปวดรุนแรงมาก ทรมาน' },
  { value: 9, label: 'ปวดที่สุด แทบทนไม่ไหว' },
  { value: 10, label: 'ปวดมากที่สุด ไม่สามารถทนได้' },
]
