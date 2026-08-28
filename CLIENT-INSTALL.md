# ติดตั้ง PAIN FACE to Care (สำหรับสถานพยาบาลของคุณ)

คู่มือหน้าเดียวนี้พาไปติดตั้งระบบทั้งชุด — ฐานข้อมูล (Google Sheet ของคุณเอง)
และแอปสำหรับพยาบาล (แอปของคุณเอง บนโฮสต์ของคุณเอง) — โดยไม่ต้องเห็นโค้ดสักบรรทัด
และไม่ต้องแก้ไฟล์ config ใด ๆ ด้วยมือ ใช้เวลาประมาณ 5–10 นาที ทำครั้งเดียว

> ทุกอย่างที่ติดตั้งด้วยคู่มือนี้เป็นของคุณเอง 100% — Sheet อยู่ในบัญชี
> Google ของคุณ แอปรันบนบัญชี Vercel ของคุณ ไม่มีอะไรส่งกลับไปหาผู้พัฒนา
> และรูปภาพ/วิดีโอใบหน้าผู้ป่วยไม่เคยถูกส่งออกจากเบราว์เซอร์เลย ไม่ว่ากรณีใด

---

## ขั้นตอน

### 1) ทำสำเนา Google Sheet เทมเพลต (ฐานข้อมูลติดมาด้วย)

เปิดลิงก์เทมเพลตด้านล่าง แล้วกดปุ่ม **ทำสำเนา (Make a copy)** — คุณจะได้
สเปรดชีตของตัวเอง พร้อมสคริปต์เบื้องหลัง (Apps Script) ติดมาด้วยในตัว ไม่ต้อง
คัดลอกโค้ดเอง:

**ลิงก์เทมเพลต:**
<https://docs.google.com/spreadsheets/d/1PZNREEDZqh5z3xui8OJ_55XH3WdI9rX6dJdwVEpwfhA/copy>

### 2) เปิดเมนู PAIN FACE → ติดตั้งระบบ + เชื่อมต่อแอป

ในสเปรดชีตของคุณเอง (สำเนาจากขั้นตอนที่ 1) จะมีเมนูใหม่ชื่อ **PAIN FACE** ที่
แถบเมนูด้านบน คลิกเมนูนี้ → **ติดตั้งระบบ + เชื่อมต่อแอป** ครั้งแรกที่รัน
Google จะขอสิทธิ์เข้าถึงสเปรดชีตนี้ — กด **อนุญาต (Allow)** (ทำครั้งเดียว
เป็นเรื่องปกติสำหรับสคริปต์ที่ผูกกับสเปรดชีตของคุณเอง)

### 3) ทำตาม Dialog แนะนำ (Deploy เว็บแอปของสคริปต์ — ครั้งเดียว)

Dialog จะแนะนำทีละขั้น: **Deploy → New deployment → Web app**
(**Execute as: Me**, **Who has access: Anyone**) — ทำครั้งเดียวตอนติดตั้ง
Dialog จะตรวจจับ URL ที่ได้ให้อัตโนมัติ ถ้าตรวจจับไม่ได้จะมีช่องให้วาง URL
กลับเข้ามาเอง

### 4) กดปุ่ม Deploy to Vercel (ได้แอปของคุณเอง)

กดปุ่มด้านล่างเพื่อสร้างแอปพยาบาลของคุณเองบน Vercel (ฟรี ไม่ต้องมีบัตรเครดิต
สำหรับ tier ฟรี) — Vercel จะ clone โค้ดแอปนี้เข้าบัญชีของคุณและ build ให้เอง:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FNattapongKong%2Fpain-face-to-care-app)

เมื่อ deploy เสร็จ Vercel จะให้ URL ของแอป (เช่น `https://your-app.vercel.app`)
— คัดลอก URL นี้ แล้ววางกลับในช่องของ Dialog ที่ขั้นตอนที่ 3 (ช่อง "ช่อง URL
แอป") จากนั้นกด **สร้างลิงก์เชื่อมต่อ**

### 5) เชื่อมต่ออุปกรณ์แรก แล้วสแกน QR สำหรับเครื่องถัดไป

Dialog จะแสดง **ลิงก์เชื่อมต่อ** พร้อมปุ่ม **คัดลอก** — เปิดลิงก์นี้บน
อุปกรณ์เครื่องแรก (มือถือ/แท็บเล็ตของหอผู้ป่วย) แล้วกดยืนยัน อุปกรณ์นั้นจะ
เชื่อมต่อกับฐานข้อมูลของคุณทันที

สำหรับอุปกรณ์เครื่องถัดไป **ไม่ต้องพิมพ์ลิงก์ซ้ำ** — เปิดแอปบนอุปกรณ์ที่
เชื่อมต่อแล้ว แตะปุ่ม **"เชื่อมต่ออุปกรณ์เพิ่ม"** บนหน้าหลัก แล้วให้เครื่อง
ถัดไปสแกน QR ที่ขึ้นมา

---

## หมายเหตุที่ควรรู้ (ตรงไปตรงมา)

- **สำเนาชีตของคุณไม่อัปเดตอัตโนมัติ** เมื่อผู้พัฒนาปรับปรุงสคริปต์เบื้องหลัง
  (`gas/Code.gs`) ในเทมเพลตต้นฉบับ สำเนาที่คุณทำไปแล้วจะไม่ได้รับการอัปเดตนั้น
  โดยอัตโนมัติ (เป็นข้อจำกัดของโมเดล "ทำสำเนา" ของ Google Sheets เอง) —
  ถ้าต้องการเวอร์ชันใหม่ ติดต่อผู้ดูแลระบบสำหรับขั้นตอนอัปเดต
- **แอปของคุณอัปเดตได้สองทาง:** (ก) กดปุ่ม Deploy to Vercel ซ้ำเพื่อ clone
  โค้ดเวอร์ชันล่าสุดเป็นโปรเจกต์ใหม่ หรือ (ข) ตั้งค่า Vercel git integration
  ให้ดึงจาก repo ต้นฉบับเอง (สำหรับผู้ที่คุ้นเคยกับ Git/GitHub) — ทั้งสองทาง
  ไม่กระทบข้อมูลใน Google Sheet ของคุณเลย เพราะข้อมูลอยู่คนละที่กับตัวแอป
- **ไม่มีข้อมูลรูปภาพ/วิดีโอใบหน้าส่งออกจากเบราว์เซอร์** ไม่ว่ากรณีใด — สิ่ง
  ที่ซิงค์ขึ้น Google Sheet มีแค่คะแนนการประเมิน ไม่ใช่ภาพ
- ปัญหาที่พบบ่อยระหว่างติดตั้ง ดูได้จากตาราง "แก้ปัญหา" ใน README.md ของแอป

---

## English summary

1. Open the template Sheet link above and click **Make a copy** — you get
   your own spreadsheet with the backend script already attached.
2. In your copy, use the new **PAIN FACE** menu → **ติดตั้งระบบ +
   เชื่อมต่อแอป** ("Install system + connect app") — approve the Google
   permission prompt once.
3. Follow the dialog's one-time **Deploy → New deployment → Web app**
   steps (Execute as: Me, Who has access: Anyone); the URL is
   auto-detected or pasted back manually.
4. Click **Deploy with Vercel** above to get your own hosted copy of the
   app, then paste that URL into the dialog and click "สร้างลิงก์เชื่อมต่อ"
   (create connect link).
5. Open the resulting connect link on your first device to link it to
   your database; every additional device scans the QR shown behind the
   "เชื่อมต่ออุปกรณ์เพิ่ม" (connect another device) button on that device's
   home screen — no retyping or re-scanning the Sheet link needed.

**Honest notes:** your Sheet copy will not auto-update when the original
template's backend script changes — ask your administrator for an update
walkthrough if you need a newer version. Your app copy updates either by
re-clicking the Deploy button (creates a fresh deployment from the latest
code) or by wiring Vercel's git integration to the source repo yourself;
neither path touches the data already in your Google Sheet, since the app
and the database are two separate pieces you each own.
