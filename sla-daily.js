// sla-daily.js — ตัวสร้าง/ประมวลผลข้อมูล SLA "รายวัน" (แกนวันที่ต่อเนื่องข้ามเดือน)
//
// โครงที่ระบบคาดหวังจาก Google Sheet (แท็บ "Daily" — เก็บเป็น "จำนวนงาน"):
//   วันที่ (D/M/YYYY เช่น 26/6/2026 หรือ YYYY-MM-DD) | DC | หมวด(ทั่วไป/Coldchain) | งานทั้งหมด | ตรงเวลา(ทุกสาเหตุ) | ตรงเวลา(ตัดลูกค้า)
//   - SLA% = ตรงเวลา ÷ งานทั้งหมด  · การรวมข้ามวัน/ข้ามช่วง = บวกจำนวนก่อนหารเสมอ (ถ่วงน้ำหนักถูกต้อง)
//
// แกนเวลาเป็น "วันที่จริงต่อเนื่อง" (ไม่ผูกเดือนเดียว) — เติมข้อมูลในชีตแล้วกราฟยืดตามอัตโนมัติ ข้ามเดือนได้
//
// "ช่วงเทียบ" (windows) = ยืดหยุ่นเป็นลิสต์:
//   • ช่วงประวัติเดือน มิ.ย. 2 ช่วง: 1–20 มิ.ย. และ 21–25 มิ.ย.
//   • จาก 26 มิ.ย. 2026 (วันศุกร์) เป็นต้นไป → สร้างช่วงรายสัปดาห์ "ศุกร์–พฤหัส" อัตโนมัติ ตามวันที่ล่าสุดในชีต
//   • หน้าเทียบช่วงจะแสดง "3 ช่วงล่าสุด" เสมอ (rolling) · Δ = ช่วงล่าสุด − ช่วงก่อนหน้า

(function () {
  "use strict";

  var MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  var MONTHS_TH = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

  // ── config ช่วงเทียบ ────────────────────────────────────────────────────
  var LEGACY_WINDOWS = [                 // ช่วงประวัติ (มิ.ย.) — ตายตัว
    { from: "2026-06-01", to: "2026-06-20" },
    { from: "2026-06-21", to: "2026-06-25" },
  ];
  var WEEKLY_ANCHOR = "2026-06-26";      // วันศุกร์แรกของรอบรายสัปดาห์ (ศุกร์–พฤหัส, ยาว 7 วัน)
  var WEEKLY_LEN = 7;
  var RECENT_N = 3;                      // จำนวนช่วงที่โชว์ในหน้าเทียบ

  // ── โหมดตัวอย่าง (fallback เมื่อดึงชีตไม่ได้): ช่วงวันที่ที่จะสังเคราะห์ ──
  var SYNTH_START = "2026-06-01", SYNTH_END = "2026-07-02";

  // ── date helpers (ใช้ ordinal = จำนวนวันนับจาก epoch เพื่อเทียบช่วงข้ามเดือน) ──
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function parseDate(s) {
    s = String(s || "").trim();
    var y, m, d;               // m = 1..12
    if (s.indexOf("-") >= 0) { var a = s.split("-"); y = +a[0]; m = +a[1]; d = +a[2]; }        // YYYY-MM-DD
    else if (s.indexOf("/") >= 0) { var b = s.split("/"); d = +b[0]; m = +b[1]; y = +b[2]; }    // D/M/YYYY
    else return null;
    if (!y || !m || !d) return null;
    return { y: y, m0: m - 1, d: d, ord: Math.floor(Date.UTC(y, m - 1, d) / 86400000) };
  }
  function ordToDate(ord) { var dt = new Date(ord * 86400000); return { y: dt.getUTCFullYear(), m0: dt.getUTCMonth(), d: dt.getUTCDate(), dow: dt.getUTCDay(), ord: ord }; }
  function isoOf(o) { return o.y + "-" + pad2(o.m0 + 1) + "-" + pad2(o.d); }
  function ordOfISO(iso) { var p = parseDate(iso); return p ? p.ord : null; }
  function rangeLabel(fromIso, toIso) {
    var a = parseDate(fromIso), b = parseDate(toIso);
    if (!a || !b) return "";
    if (a.y === b.y && a.m0 === b.m0) return a.d + "–" + b.d + " " + MONTHS_SHORT[b.m0];
    return a.d + " " + MONTHS_SHORT[a.m0] + "–" + b.d + " " + MONTHS_SHORT[b.m0];
  }

  function hashStr(s) { var h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── สร้างแกนวันจาก ord ต่ำสุด→สูงสุด (ต่อเนื่อง ข้ามเดือน) ─────────────────
  function daysBetween(minOrd, maxOrd) {
    var out = [];
    for (var o = minOrd; o <= maxOrd; o++) {
      var dt = ordToDate(o);
      out.push({ ord: o, d: dt.d, m0: dt.m0, y: dt.y, dow: dt.dow, weekend: dt.dow === 0 || dt.dow === 6, monthName: MONTHS_TH[dt.m0], iso: isoOf(dt) });
    }
    return out;
  }

  // ── สร้างลิสต์ "ช่วง" (windows) ที่อยู่ในกรอบข้อมูล + คืน 3 ช่วงล่าสุด ─────
  function buildWindows(minOrd, maxOrd) {
    var raw = [];
    LEGACY_WINDOWS.forEach(function (w) { raw.push({ fromOrd: ordOfISO(w.from), toOrd: ordOfISO(w.to), from: w.from, to: w.to }); });
    var startOrd = ordOfISO(WEEKLY_ANCHOR);
    while (startOrd <= maxOrd) {                      // สร้างช่วงรายสัปดาห์ที่ "เริ่มแล้ว" ตามข้อมูล
      var endOrd = startOrd + WEEKLY_LEN - 1;
      raw.push({ fromOrd: startOrd, toOrd: endOrd, from: isoOf(ordToDate(startOrd)), to: isoOf(ordToDate(endOrd)) });
      startOrd += WEEKLY_LEN;
    }
    var wins = raw
      .filter(function (w) { return w.fromOrd != null && w.fromOrd <= maxOrd && w.toOrd >= minOrd; })
      .sort(function (a, b) { return a.fromOrd - b.fromOrd; })
      .map(function (w) { return { fromOrd: w.fromOrd, toOrd: w.toOrd, from: w.from, to: w.to, label: rangeLabel(w.from, w.to) }; });
    return { all: wins, recent: wins.slice(-RECENT_N) };
  }

  // ── สังเคราะห์จำนวนงานรายวันของ DC หนึ่งตัว (โหมดตัวอย่าง) ─────────────────
  function synthDC(name, baseGen, baseCold, days) {
    var rnd = mulberry32(hashStr(name));
    var h = hashStr(name);
    var dir = (h % 3) - 1;
    var genVol = 180 + (h % 420);
    var coldVol = Math.round(genVol * (0.14 + (h % 22) / 100));
    var gen = { vol: [], otAll: [], otExcl: [] };
    var cold = { vol: [], otAll: [], otExcl: [] };
    for (var i = 0; i < days.length; i++) {
      var wknd = days[i].weekend;
      var trend = dir * 0.5 * Math.max(0, i - 12);
      function sla(base) { var v = base + trend + (rnd() - 0.5) * 8; if (wknd) v -= 2 + rnd() * 4; return clamp(v, 18, 99.3); }
      var gv = Math.max(0, Math.round(genVol * (0.7 + rnd() * 0.5) * (wknd ? 0.45 : 1)));
      var cv = Math.max(0, Math.round(coldVol * (0.6 + rnd() * 0.6) * (wknd ? 0.4 : 1)));
      var gA = sla(baseGen), gE = Math.min(99.8, gA + 0.6 + rnd() * 2.6);
      var cA = sla(baseCold), cE = Math.min(99.9, cA + 0.6 + rnd() * 2.6);
      gen.vol.push(gv); gen.otAll.push(Math.round(gv * gA / 100)); gen.otExcl.push(Math.min(gv, Math.round(gv * gE / 100)));
      cold.vol.push(cv); cold.otAll.push(Math.round(cv * cA / 100)); cold.otExcl.push(Math.min(cv, Math.round(cv * cE / 100)));
    }
    return { name: name, gen: gen, cold: cold };
  }

  // ── helper: จำนวน → % รายวัน + ค่าเฉลี่ยต่อช่วง (บวกจำนวนก่อนหาร) ──────────
  function pct(ot, vol) { return vol > 0 ? (ot / vol * 100) : null; }
  function winAvg(otArr, volArr, win, days) {
    var so = 0, sv = 0;
    for (var i = 0; i < days.length; i++) {
      var o = days[i].ord; if (o < win.fromOrd || o > win.toOrd) continue;
      sv += volArr[i] || 0; so += otArr[i] || 0;
    }
    return sv > 0 ? (so / sv * 100) : null;
  }
  function catSeries(counts, days, windows) {        // counts = {vol,otAll,otExcl}
    var all = [], excl = [], vol = counts.vol;
    for (var i = 0; i < days.length; i++) { all.push(pct(counts.otAll[i], vol[i])); excl.push(pct(counts.otExcl[i], vol[i])); }
    var wins = windows.map(function (w) { return { all: winAvg(counts.otAll, vol, w, days), excl: winAvg(counts.otExcl, vol, w, days) }; });
    return { all: all, excl: excl, vol: vol, wins: wins };
  }
  function sumCounts(list, pick, days) {
    var n = days.length, vol = new Array(n).fill(0), otAll = new Array(n).fill(0), otExcl = new Array(n).fill(0);
    list.forEach(function (c) { var s = pick(c); for (var i = 0; i < n; i++) { vol[i] += s.vol[i] || 0; otAll[i] += s.otAll[i] || 0; otExcl[i] += s.otExcl[i] || 0; } });
    return { vol: vol, otAll: otAll, otExcl: otExcl };
  }

  // ── รายชื่อเดือนที่มีข้อมูล (สำหรับ dropdown เลือกเดือน) ────────────────────
  function monthsPresent(days) {
    var seen = {}, out = [];
    days.forEach(function (dy) { var key = dy.y + "-" + dy.m0; if (!seen[key]) { seen[key] = true; out.push({ y: dy.y, m0: dy.m0, name: MONTHS_TH[dy.m0], short: MONTHS_SHORT[dy.m0] }); } });
    out.sort(function (a, b) { return (a.y - b.y) || (a.m0 - b.m0); });
    return out;
  }

  // ── ประกอบผลลัพธ์เป็นโครงที่ UI ใช้ ───────────────────────────────────────
  function assemble(rawDCs, days) {
    var minOrd = days.length ? days[0].ord : 0, maxOrd = days.length ? days[days.length - 1].ord : 0;
    var W = buildWindows(minOrd, maxOrd);
    var windows = W.recent;                            // 3 ช่วงล่าสุด (ที่ UI เทียบ)

    function build(pickCat) {
      var dcs = rawDCs.map(function (r) {
        var s = catSeries(pickCat(r), days, windows);
        return { name: r.name, all: s.all, excl: s.excl, vol: s.vol, wins: s.wins };
      });
      var g = catSeries(sumCounts(rawDCs, pickCat, days), days, windows);
      return { dcs: dcs, grand: { all: g.all, excl: g.excl, vol: g.vol, wins: g.wins } };
    }
    var general = build(function (r) { return r.gen; });
    var cold = build(function (r) { return r.cold; });
    var total = build(function (r) {
      var n = days.length, vol = [], otAll = [], otExcl = [];
      for (var i = 0; i < n; i++) { vol.push((r.gen.vol[i] || 0) + (r.cold.vol[i] || 0)); otAll.push((r.gen.otAll[i] || 0) + (r.cold.otAll[i] || 0)); otExcl.push((r.gen.otExcl[i] || 0) + (r.cold.otExcl[i] || 0)); }
      return { vol: vol, otAll: otAll, otExcl: otExcl };
    });

    var last = days[days.length - 1] || { d: 0, m0: 5 };
    return {
      sample: true,
      year: last.y || 2026,
      monthName: MONTHS_TH[last.m0],                   // เดือนล่าสุด (ค่า default ของหน้ารายวัน)
      latestDay: last.d,
      days: days.map(function (x) { return { d: x.d, weekend: x.weekend, m0: x.m0, y: x.y, monthName: x.monthName, iso: x.iso, ord: x.ord }; }),
      monthsList: monthsPresent(days),
      windows: windows,                                // recent-N สำหรับหน้าเทียบ
      windowsAll: W.all,
      // เผื่อ fallback เดิม (2 ช่วงล่าสุด)
      windowA: windows[windows.length - 2] || null,
      windowB: windows[windows.length - 1] || null,
      byCat: { total: total, general: general, cold: cold },
    };
  }

  // ── จุดเข้า: สร้างจากข้อมูลเดือนที่โหลดมาแล้ว (โหมดตัวอย่าง) ──────────────────
  function buildDaily(SLA) {
    var minOrd = ordOfISO(SYNTH_START), maxOrd = ordOfISO(SYNTH_END);
    var days = daysBetween(minOrd, maxOrd);
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

  // ── จุดเข้า: สร้างจากแถว CSV จริง (ดึงสดจาก Google Sheet แท็บ Daily) ─────────
  // rows = [{date:'26/6/2026'|'2026-06-26', dc:'DC เชียงใหม่', cat:'ทั่วไป'|'Coldchain', total, otAll, otExcl}, ...]
  function buildFromRows(rows) {
    var ords = [];
    rows.forEach(function (r) { var p = parseDate(r.date); if (p) ords.push(p.ord); });
    if (!ords.length) { var out0 = assemble([], daysBetween(ordOfISO(SYNTH_START), ordOfISO(SYNTH_END))); out0.sample = false; return out0; }
    var minOrd = Math.min.apply(null, ords), maxOrd = Math.max.apply(null, ords);
    var days = daysBetween(minOrd, maxOrd);
    var dayIndex = {}; days.forEach(function (x, i) { dayIndex[x.ord] = i; });
    function blank(n) { return { vol: new Array(n).fill(0), otAll: new Array(n).fill(0), otExcl: new Array(n).fill(0) }; }
    var map = {};
    rows.forEach(function (r) {
      var p = parseDate(r.date); if (!p || !(p.ord in dayIndex)) return;
      var key = r.dc; if (!map[key]) map[key] = { name: r.dc, gen: blank(days.length), cold: blank(days.length) };
      var slot = /cold/i.test(r.cat) || /เย็น/.test(r.cat) ? map[key].cold : map[key].gen;
      var i = dayIndex[p.ord];
      slot.vol[i] = +r.total || 0; slot.otAll[i] = +r.otAll || 0; slot.otExcl[i] = +r.otExcl || 0;
    });
    var out = assemble(Object.keys(map).map(function (k) { return map[k]; }), days);
    out.sample = false;
    return out;
  }

  // ── CSV → rows → buildFromRows ────────────────────────────────────────────
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
      var res = await fetch(url + "&_=" + Date.now(), { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var text = await res.text();
      var rows = parseCSV(text);
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i]; if (!r || r.length < 6) continue;
        var dc = String(r[1] || "").trim();
        var total = parseFloat(r[3]);
        if (!dc || !isFinite(total)) continue;
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
