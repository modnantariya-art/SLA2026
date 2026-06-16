// sla-loader.js — ดึงข้อมูล SLA สดจาก Google Sheet (Publish to web → CSV)
// แล้ว merge เข้ากับ "ทะเบียน DC → ภาค" ที่อยู่ใน sla-data.js (ส่วนนี้แทบไม่เปลี่ยน)
//
// โครงคอลัมน์ของแต่ละแท็บ (AB / CC / AB+CC) เหมือนกัน:
//   A = ชื่อ DC | B,C = ม.ค.(ทุกสาเหตุ, ตัดลูกค้า) | D,E = ก.พ. | ... สลับไปเรื่อยๆ
//   แถวล่างสุด = Grand Total
//
// วิธีอัปเดตข้อมูล: แก้ตัวเลขใน Google Sheet → หน้าเว็บกดรีเฟรชก็เห็นค่าใหม่

import STATIC from './sla-data.js';

// ── ลิงก์ CSV (Publish to web) ของแต่ละแท็บ ───────────────────────────────
// ⚠️ CC ยังเป็นลิงก์เดียวกับ AB (gid 713489536) — รอลิงก์ที่ถูกต้อง
//    ระหว่างนี้ระบบจะ fallback หมวด Coldchain ไปใช้ข้อมูลในไฟล์ให้อัตโนมัติ
export const CSV_URLS = {
  general: "https://docs.google.com/spreadsheets/d/e/2PACX-1vR7DJfYHleowvSMfrW_J72TWW9SSWTwbQv-wLr4DGUXoL5X9ncJGiTpdQsXPhSHdAUTEmEovL-TdQex/pub?gid=713489536&single=true&output=csv", // AB  = ทั่วไป
  cold:    "https://docs.google.com/spreadsheets/d/e/2PACX-1vR7DJfYHleowvSMfrW_J72TWW9SSWTwbQv-wLr4DGUXoL5X9ncJGiTpdQsXPhSHdAUTEmEovL-TdQex/pub?gid=866530577&single=true&output=csv", // CC  = Coldchain
  total:   "https://docs.google.com/spreadsheets/d/e/2PACX-1vR7DJfYHleowvSMfrW_J72TWW9SSWTwbQv-wLr4DGUXoL5X9ncJGiTpdQsXPhSHdAUTEmEovL-TdQex/pub?gid=563246109&single=true&output=csv", // AB+CC = รวม
};

const MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const MONTHS_FULL  = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

// ── ทะเบียน DC → ภาค (ดึงจาก sla-data.js) ────────────────────────────────
const REGION_BY_NAME = {};
STATIC.dataByCat.general.dcs.forEach((d) => { REGION_BY_NAME[norm(d.name)] = d.region; });

function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

// ── CSV parser (รองรับ quote/คอมมาในเซลล์) ───────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') { q = true; }
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c === "\r") { /* skip */ }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// fetch ที่มี timeout (กันค้างเมื่อเครือข่ายเข้าไม่ถึง)
async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

function pct(v) {
  if (v == null) return null;
  const t = String(v).replace("%", "").replace(/,/g, "").trim();
  if (t === "" || t === "-" || t === "—") return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

// parse 1 แท็บ → { dcs:[{name,region,all,excl}], grand, maxMonth }
function parseCategory(text) {
  const rows = parseCSV(text);
  const dcs = [];
  let grand = null, maxMonth = 0;
  for (const r of rows) {
    const name = norm(r[0]);
    if (!name) continue;
    const isDC = /^C?DC\s/.test(name);
    const isGrand = /grand\s*total/i.test(name);
    if (!isDC && !isGrand) continue;
    const all = [], excl = [];
    for (let m = 0; m < 12; m++) {
      const a = pct(r[1 + m * 2]); // คอลัมน์ B เป็นต้นไป (ข้าม A=ชื่อ DC)
      const e = pct(r[2 + m * 2]);
      all.push(a); excl.push(e);
      if (a != null || e != null) maxMonth = Math.max(maxMonth, m + 1);
    }
    if (isGrand) grand = { all, excl };
    else dcs.push({ name, region: REGION_BY_NAME[name] || null, all, excl });
  }
  return { dcs, grand, maxMonth };
}

// แปลงข้อมูล static (สำรอง) ของหมวดหนึ่งให้ยาวเท่ากับ n เดือน
function staticCat(catId, n) {
  const src = STATIC.dataByCat[catId];
  const pad = (arr) => { const a = (arr || []).slice(0, n); while (a.length < n) a.push(null); return a; };
  return {
    dcs: src.dcs.map((d) => ({ name: d.name, region: d.region, all: pad(d.all), excl: pad(d.excl) })),
    grand: { all: pad(src.grand.all), excl: pad(src.grand.excl) },
  };
}

// ── โหลดข้อมูลสด ─────────────────────────────────────────────────────────
export async function loadLive(urls = CSV_URLS) {
  const cats = ["general", "cold", "total"];
  // หมวดที่ลิงก์ซ้ำกับหมวดก่อนหน้า = ยังไม่ได้ publish แยก → ใช้สำรอง
  const seen = {};
  const dup = {};
  for (const c of cats) {
    const u = urls[c];
    if (seen[u]) dup[c] = true; else seen[u] = c;
  }

  const raw = {};
  let monthCount = 0;
  for (const c of cats) {
    if (dup[c]) { console.warn("[SLA] หมวด " + c + " ลิงก์ซ้ำ — ใช้ข้อมูลสำรองในไฟล์"); continue; }
    const text = await fetchText(urls[c] + "&_=" + Date.now()); // กัน cache + timeout
    raw[c] = parseCategory(text);
    monthCount = Math.max(monthCount, raw[c].maxMonth);
  }
  monthCount = Math.max(1, monthCount);

  const dataByCat = {};
  for (const c of cats) {
    if (dup[c] || !raw[c]) { dataByCat[c] = staticCat(c, monthCount); continue; }
    const p = raw[c];
    dataByCat[c] = {
      dcs: p.dcs.map((d) => ({ name: d.name, region: d.region, all: d.all.slice(0, monthCount), excl: d.excl.slice(0, monthCount) })),
      grand: p.grand
        ? { all: p.grand.all.slice(0, monthCount), excl: p.grand.excl.slice(0, monthCount) }
        : { all: Array(monthCount).fill(null), excl: Array(monthCount).fill(null) },
    };
  }

  return {
    months: MONTHS_SHORT.slice(0, monthCount),
    monthsFull: MONTHS_FULL.slice(0, monthCount),
    regions: STATIC.regions,
    categories: STATIC.categories,
    dataByCat,
    latestMonth: monthCount - 1,
    year: STATIC.year,
    fetchedAt: Date.now(),
    fallbackCats: Object.keys(dup),
  };
}
