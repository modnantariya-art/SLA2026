// sla-daily.js — ตัวสร้าง/ประมวลผลข้อมูล SLA "รายวัน" ของเดือนมิถุนายน
//
// โครงที่ระบบคาดหวังจาก Google Sheet (แท็บใหม่ "Daily" — เก็บเป็น "จำนวนงาน"):
//   วันที่ (YYYY-MM-DD) | DC | หมวด(ทั่วไป/Coldchain) | งานทั้งหมด | ตรงเวลา(ทุกสาเหตุ) | ตรงเวลา(ตัดลูกค้า)
//   - ไม่ต้องมีคอลัมน์ "ภาค"  · ไม่ต้องกรอกหมวด "รวม" (ระบบบวก ทั่วไป+Coldchain ให้เอง)
//   - SLA% = ตรงเวลา ÷ งานทั้งหมด  · การรวมข้ามวัน/ข้ามช่วง = บวกจำนวนก่อนหารเสมอ (ถ่วงน้ำหนักถูกต้อง)
//
// ระหว่างที่ Sheet ยังไม่มีข้อมูลรายวัน ไฟล์นี้จะ "สังเคราะห์" จำนวนงานรายวันแบบ seeded
// โดยอิงระดับ SLA เดือน มิ.ย. ของแต่ละ DC จากข้อมูลที่โหลดมาแล้ว เพื่อให้หน้าตาสมจริง
// เมื่อมีลิงก์ CSV รายวันจริง ให้เปลี่ยนมา parse แล้วคืนค่าโครงเดียวกัน (ดู buildFromRows ด้านล่าง)

(function () {
  "use strict";

  var YEAR = 2026, MONTH_IDX = 5, MONTH_NAME = "มิถุนายน", DAYS = 25;
  var WIN_A = { from: 1, to: 20, label: "1–20 มิ.ย." };
  var WIN_B = { from: 21, to: 25, label: "21–25 มิ.ย." };

  function hashStr(s) { var h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function dayMeta() {
    var out = [];
    for (var d = 1; d <= DAYS; d++) {
      var dow = new Date(YEAR, MONTH_IDX, d).getDay();
      out.push({ d: d, dow: dow, weekend: dow === 0 || dow === 6 });
    }
    return out;
  }

  // ── สังเคราะห์จำนวนงานรายวันของ DC หนึ่งตัว ───────────────────────────
  function synthDC(name, baseGen, baseCold, days) {
    var rnd = mulberry32(hashStr(name));
    var h = hashStr(name);
    var dir = (h % 3) - 1;                         // -1 ทรุด, 0 ทรง, 1 ฟื้น ในช่วงปลายเดือน
    var genVol = 180 + (h % 420);
    var coldVol = Math.round(genVol * (0.14 + (h % 22) / 100));
    var gen = { vol: [], otAll: [], otExcl: [] };
    var cold = { vol: [], otAll: [], otExcl: [] };

    for (var i = 0; i < days.length; i++) {
      var wknd = days[i].weekend, d = days[i].d;
      var trend = dir * 0.55 * Math.max(0, d - 15);  // แนวโน้มเริ่มชัดหลังวันที่ 15
      function sla(base) {
        var v = base + trend + (rnd() - 0.5) * 8;
        if (wknd) v -= 2 + rnd() * 4;
        return clamp(v, 18, 99.3);
      }
      var gv = Math.max(0, Math.round(genVol * (0.7 + rnd() * 0.5) * (wknd ? 0.45 : 1)));
      var cv = Math.max(0, Math.round(coldVol * (0.6 + rnd() * 0.6) * (wknd ? 0.4 : 1)));
      var gA = sla(baseGen), gE = Math.min(99.8, gA + 0.6 + rnd() * 2.6);
      var cA = sla(baseCold), cE = Math.min(99.9, cA + 0.6 + rnd() * 2.6);
      gen.vol.push(gv); gen.otAll.push(Math.round(gv * gA / 100)); gen.otExcl.push(Math.min(gv, Math.round(gv * gE / 100)));
      cold.vol.push(cv); cold.otAll.push(Math.round(cv * cA / 100)); cold.otExcl.push(Math.min(cv, Math.round(cv * cE / 100)));
    }
    return { name: name, gen: gen, cold: cold };
  }

  // ── helper: จำนวน → % รายวัน + สรุปช่วง (บวกจำนวนก่อนหาร) ────────────────
  function pct(ot, vol) { return vol > 0 ? (ot / vol * 100) : null; }
  function winAvg(otArr, volArr, win, days) {
    var so = 0, sv = 0;
    for (var i = 0; i < days.length; i++) {
      var d = days[i].d; if (d < win.from || d > win.to) continue;
      sv += volArr[i] || 0; so += otArr[i] || 0;
    }
    return sv > 0 ? (so / sv * 100) : null;
  }
  function catSeries(counts, days) {                 // counts = {vol,otAll,otExcl}
    var all = [], excl = [], vol = counts.vol;
    for (var i = 0; i < days.length; i++) { all.push(pct(counts.otAll[i], vol[i])); excl.push(pct(counts.otExcl[i], vol[i])); }
    return {
      all: all, excl: excl, vol: vol,
      aAll: winAvg(counts.otAll, vol, WIN_A, days), aExcl: winAvg(counts.otExcl, vol, WIN_A, days),
      bAll: winAvg(counts.otAll, vol, WIN_B, days), bExcl: winAvg(counts.otExcl, vol, WIN_B, days),
      _otAll: counts.otAll, _otExcl: counts.otExcl,
    };
  }
  function sumCounts(list, pick, days) {             // รวมข้าม DC → grand
    var n = days.length, vol = new Array(n).fill(0), otAll = new Array(n).fill(0), otExcl = new Array(n).fill(0);
    list.forEach(function (c) { var s = pick(c); for (var i = 0; i < n; i++) { vol[i] += s.vol[i] || 0; otAll[i] += s.otAll[i] || 0; otExcl[i] += s.otExcl[i] || 0; } });
    return { vol: vol, otAll: otAll, otExcl: otExcl };
  }

  // ── ประกอบผลลัพธ์เป็นโครงที่ UI ใช้ ───────────────────────────────────
  function assemble(rawDCs, days) {
    function build(pickCat) {
      var dcs = rawDCs.map(function (r) {
        var c = pickCat(r);
        var s = catSeries(c, days);
        return { name: r.name, all: s.all, excl: s.excl, vol: s.vol, aAll: s.aAll, aExcl: s.aExcl, bAll: s.bAll, bExcl: s.bExcl };
      });
      var gc = sumCounts(rawDCs, pickCat, days);
      var g = catSeries(gc, days);
      return { dcs: dcs, grand: { all: g.all, excl: g.excl, vol: g.vol, aAll: g.aAll, aExcl: g.aExcl, bAll: g.bAll, bExcl: g.bExcl } };
    }
    var general = build(function (r) { return r.gen; });
    var cold = build(function (r) { return r.cold; });
    // total = ทั่วไป + Coldchain (บวกจำนวน)
    var total = build(function (r) {
      var n = days.length, vol = [], otAll = [], otExcl = [];
      for (var i = 0; i < n; i++) { vol.push((r.gen.vol[i] || 0) + (r.cold.vol[i] || 0)); otAll.push((r.gen.otAll[i] || 0) + (r.cold.otAll[i] || 0)); otExcl.push((r.gen.otExcl[i] || 0) + (r.cold.otExcl[i] || 0)); }
      return { vol: vol, otAll: otAll, otExcl: otExcl };
    });
    return {
      sample: true, year: YEAR, monthName: MONTH_NAME, latestDay: DAYS,
      days: days.map(function (x) { return { d: x.d, weekend: x.weekend }; }),
      windowA: WIN_A, windowB: WIN_B,
      byCat: { total: total, general: general, cold: cold },
    };
  }

  // ── จุดเข้า: สร้างจากข้อมูลเดือนที่โหลดมาแล้ว (โหมดตัวอย่าง) ─────────────
  function buildDaily(SLA) {
    var days = dayMeta();
    var genDcs = (SLA && SLA.dataByCat && SLA.dataByCat.general && SLA.dataByCat.general.dcs) || [];
    var coldDcs = (SLA && SLA.dataByCat && SLA.dataByCat.cold && SLA.dataByCat.cold.dcs) || [];
    var idx = (SLA && SLA.latestMonth != null) ? SLA.latestMonth : (genDcs[0] ? genDcs[0].all.length - 1 : 5);
    var coldByName = {}; coldDcs.forEach(function (d) { coldByName[d.name] = d; });
    var raw = genDcs.map(function (d) {
      var bg = (d.all[idx] != null ? d.all[idx] : 78);
      var cd = coldByName[d.name];
      var bc = (cd && cd.all[idx] != null) ? cd.all[idx] : clamp(bg + 6, 30, 97);
      return synthDC(d.name, bg, bc, days);
    });
    return assemble(raw, days);
  }

  // ── จุดเข้า (อนาคต): สร้างจากแถว CSV จริง ───────────────────────────────
  // rows = [{date:'1/6/2026'|'2026-06-01', dc:'DC เชียงใหม่', cat:'ทั่วไป'|'Coldchain', total, otAll, otExcl}, ...]
  function parseDay(s) {
    s = String(s || "").trim();
    if (s.indexOf("-") >= 0) { var p = s.split("-"); return parseInt(p[p.length - 1], 10); } // YYYY-MM-DD
    if (s.indexOf("/") >= 0) { return parseInt(s.split("/")[0], 10); }                       // D/M/YYYY
    return parseInt(s.slice(-2), 10);
  }
  function buildFromRows(rows) {
    var fullDays = dayMeta();
    var present = {};
    rows.forEach(function (r) { var d = parseDay(r.date); if (d >= 1 && d <= fullDays.length) present[d] = true; });
    var maxDay = 0; for (var k in present) { if (+k > maxDay) maxDay = +k; }
    if (!maxDay) maxDay = fullDays.length;
    var days = fullDays.slice(0, maxDay);             // ตัดกราฟแค่วันที่มีข้อมูลจริง
    var dayIndex = {}; days.forEach(function (x, i) { dayIndex[x.d] = i; });
    function blank(n) { return { vol: new Array(n).fill(0), otAll: new Array(n).fill(0), otExcl: new Array(n).fill(0) }; }
    var map = {};
    rows.forEach(function (r) {
      var d = parseDay(r.date);
      if (!(d in dayIndex)) return;
      var key = r.dc; if (!map[key]) map[key] = { name: r.dc, gen: blank(days.length), cold: blank(days.length) };
      var slot = /cold/i.test(r.cat) || /เย็น/.test(r.cat) ? map[key].cold : map[key].gen;
      var i = dayIndex[d];
      slot.vol[i] = +r.total || 0; slot.otAll[i] = +r.otAll || 0; slot.otExcl[i] = +r.otExcl || 0;
    });
    var out = assemble(Object.keys(map).map(function (k) { return map[k]; }), days);
    out.sample = false;
    return out;
  }

  // ── CSV → rows → buildFromRows (ดึงสดจาก Google Sheet แท็บ Daily) ────────
  function parseCSV(t) {
    t = String(t).replace(/^\uFEFF/, "");
    var rows = [], f = "", row = [], q = false;
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else { if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; } else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c === "\r") { } else f += c; }
    }
    if (f.length || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  var DAILY_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vR7DJfYHleowvSMfrW_J72TWW9SSWTwbQv-wLr4DGUXoL5X9ncJGiTpdQsXPhSHdAUTEmEovL-TdQex/pub?gid=979420112&single=true&output=csv";
  async function loadDailyLive(url) {
    url = url || DAILY_CSV_URL;
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 12000);
    try {
      var res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var text = await res.text();
      var rows = parseCSV(text);
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i]; if (!r || r.length < 6) continue;
        var dc = String(r[1] || "").trim();
        var total = parseFloat(r[3]);
        if (!dc || !isFinite(total)) continue;               // ข้ามหัวตาราง/แถวว่าง
        out.push({ date: String(r[0] || "").trim(), dc: dc, cat: String(r[2] || "").trim(), total: +r[3] || 0, otAll: +r[4] || 0, otExcl: +r[5] || 0 });
      }
      if (!out.length) return null;
      return buildFromRows(out);
    } catch (e) {
      console.warn("[SLA] ดึงข้อมูลรายวันสดไม่สำเร็จ:", e && e.message);
      return null;
    } finally { clearTimeout(to); }
  }

  window.SLA_buildDaily = buildDaily;
  window.SLA_buildDailyFromRows = buildFromRows;
  window.SLA_loadDailyLive = loadDailyLive;
  window.SLA_DAILY_CSV_URL = DAILY_CSV_URL;
})();
