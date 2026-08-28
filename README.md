# PAIN FACE to Care — เทมเพลตสำหรับติดตั้งเอง

แอปประเมินความปวดสำหรับพยาบาล: เปิดแอปที่มือถือ/แท็บเล็ตของหอผู้ป่วย
สแกนใบหน้าผู้ป่วย โมเดล AI ที่ทำงานในเบราว์เซอร์เสนอคะแนนสีหน้า 5 หมวด
พยาบาลยืนยัน/แก้ไข แล้วกรอกแบบประเมินตามแบบฟอร์มทางการที่เหลือ (ข้อมูล
ผู้ป่วย, คะแนนความปวดที่ผู้ป่วยรายงาน, ผลลัพธ์รวม, รายการดูแลตามระดับ
ความปวด, และการประเมินซ้ำหลังให้การดูแล)

**การสแกนใบหน้าและการประมวลผล AI ทำงานทั้งหมดในเบราว์เซอร์ของอุปกรณ์ —
ไม่มีภาพหรือวิดีโอใบหน้าผู้ป่วยถูกส่งออกไปที่ใดเลย ไม่ว่าจะตั้งค่าแบบใด**
ฐานข้อมูลกลาง (Google Sheet ที่คุณเป็นเจ้าของ) เก็บเฉพาะ *คะแนน* การประเมิน
เท่านั้น เป็นฟีเจอร์เสริมที่เปิดใช้งานได้ผ่านคู่มือติดตั้งด้านล่าง

รีโปนี้เป็น **สำเนาเฉพาะส่วนแอป** (mirror) ของโปรเจกต์ต้นฉบับ — ไม่มีสคริปต์
เบื้องหลัง (Apps Script), ไม่มีข้อมูลการฝึกโมเดล, ไม่มี URL หรือรหัสเฉพาะของ
เจ้าของระบบต้นฉบับอยู่ในนี้เลย ปลอดภัยสำหรับให้แต่ละสถานพยาบาล deploy
เป็นแอปของตัวเอง

---

## เริ่มติดตั้ง

**อ่าน [CLIENT-INSTALL.md](./CLIENT-INSTALL.md)** — คู่มือหน้าเดียว 5 ขั้นตอน
ทำสำเนา Sheet เทมเพลต → ติดตั้งผ่านเมนูในชีต → กด Deploy ด้านล่าง → เชื่อม
อุปกรณ์ ใช้เวลา 5–10 นาที ไม่ต้องเห็นโค้ดเลย

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FNattapongKong%2Fpain-face-to-care-app)

กดปุ่มด้านบนเพื่อ deploy แอปนี้เป็นของคุณเองบน Vercel โดยตรง (ไม่ต้อง clone
ด้วยมือ ไม่ต้องรู้จัก Git) — ใช้ร่วมกับขั้นตอนใน CLIENT-INSTALL.md

---

## รันเองเพื่อพัฒนา/ทดสอบ (สำหรับนักพัฒนา)

```bash
npm install
npm run fetch-model   # ดาวน์โหลดโมเดล face_landmarker.task (~3.6MB) + ไฟล์ WASM
npm run dev           # http://localhost:5173
```

Production build:

```bash
npm run build         # ได้ dist/ — เอาไป serve บนโฮสต์ static ใดก็ได้ (HTTPS)
```

รันชุดทดสอบ (รีโปนี้ยกชุดทดสอบของแอปจริงมาด้วย — ไม่ใช่ stub; มีเพียงไฟล์
ทดสอบเดียวที่ไม่ได้ติดมา คือทดสอบสคริปต์เบื้องหลัง Apps Script ที่ต้องใช้
ซอร์สโค้ด `gas/Code.gs` ซึ่งอยู่ในรีโปต้นทาง/รีโปส่วนตัวเท่านั้น):

```bash
npm test
```

ค่าเริ่มต้นของ `public/sync-config.json` คือ `{"syncUrl": ""}` — แอปทำงาน
เป็น local-only เต็มรูปแบบจนกว่าจะทำ CLIENT-INSTALL.md เสร็จ (ค่านี้จะถูก
เปลี่ยนโดย Dialog ติดตั้งในชีตของคุณเอง ไม่ใช่การแก้ไฟล์ด้วยมือ)

---

## English

A nurse-facing pain-assessment PWA. Camera capture and on-device ML
scoring run entirely in the browser — no patient image or video frame is
ever sent anywhere, on any configuration. An optional central database
(a Google Sheet **you** own) syncs assessment *scores* only, never images.

This repository is an **app-only mirror** of the source project — no Apps
Script backend source, no training-pipeline internals, and no owner
identifiers or URLs. It ships with the real app test suite included, not a
trimmed-down demo — the one exception is the Apps Script backend's own
test, which needs the `gas/Code.gs` source and so stays in the source/
private repo; every other test runs here exactly as it does there.

**To install your own copy end to end** (your own Google Sheet + your own
hosted app, no code required), read **[CLIENT-INSTALL.md](./CLIENT-INSTALL.md)**
and click the Deploy with Vercel button above.

**To run locally for development:**

```bash
npm install
npm run fetch-model
npm run dev      # http://localhost:5173
npm run build    # production build -> dist/
npm test         # run the test suite
```

The shipped `public/sync-config.json` (`{"syncUrl": ""}`) keeps the app
fully local-only until you complete the CLIENT-INSTALL.md walkthrough,
which writes the real value for you through the Sheet's install dialog —
you never hand-edit a config file.
