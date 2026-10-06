// v122: list hover and dot hover share one tooltip + highlight; dot click scrolls the list, list click jumps the chart(s).
// v115: Pending/Refresh 3s after news time; All Day news on chart at 00:00 UTC; same-time news = one dot.
// v114: news between candles always sits on the EARLIER candle (no mid-gap placement).
// v113: default filters USD + High/Medium and saved to disk; 9 currency chips (no "All"); news between two candles sit on the earlier candle's line.
// v112: list hover rings the dot + shows its title on the chart; news run to the end (Saturday) of the live week.
// =============================================================================
// news.js — v111: economic news on the chart + the News tab of the Trade panel.
//  * Chart: one solid vertical line per news time (color = highest Impact at
//    that time) with highlighted dots on the top edge; hover a dot = details.
//    Painted by drawing-engine.js (App.News.paint) per surface, so Multi-Chart
//    gets it on all 3 charts. Only the VISIBLE range is read from ff_news.db
//    (small padded window per surface, replaced when the view leaves it).
//  * News tab: Impact / Currency filters (shared with the chart), lazy day-by-day
//    list (a few days in the DOM at a time), date jump + calendar, Today,
//    Pending state + Refresh (re-reads one week).
// =============================================================================
(function () {
  "use strict";
  var App = window.App;
  var $ = function (id) { return document.getElementById(id); };
  function api() { return window.pywebview && window.pywebview.api; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  var IKEY = { 4: "high", 3: "medium", 2: "low", 1: "none" };
  var ILABEL = { 4: "High", 3: "Medium", 2: "Low", 1: "Non-economic" };
  var ISHORT = { 4: "High", 3: "Med", 2: "Low", 1: "None" };
  var MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  var MONL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DAY = 86400;
  var PEND_DELAY = 3;            // v115: seconds after the news time until Actual counts as Pending
  var PEND_WINDOW = 36 * 3600;   // an Actual still missing after this long is "no value", not "pending"

  // ---------------------------------------------------------------- time helpers
  // ts_utc (Forex Factory, UTC) -> chart time (broker) -> display time (system clock).
  // v116: shifts are DST-aware and taken at the event's own UTC time (u; "now" when omitted).
  function nowU(u) { return u == null ? Date.now() / 1000 : u; }
  function brokerUtc(u) { return App.Tz && App.Tz.brokerOffsetAtUtc ? App.Tz.brokerOffsetAtUtc(nowU(u)) : 0; }
  function dispShift(u) {
    if (!App.Tz || !App.Tz.sysOffsetAtUtc) return 0;
    u = nowU(u);
    return App.Tz.isEnabled() ? App.Tz.sysOffsetAtUtc(u) : App.Tz.brokerOffsetAtUtc(u);
  }
  function shAtDisp(t) { var s0 = dispShift(); return dispShift(t - s0); }   // shift for a display-clock time
  function isoOf(sec) { var d = new Date(sec * 1000); return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()); }
  function dayTs(iso) { var p = iso.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 1000; }
  function addDays(iso, n) { return isoOf(dayTs(iso) + n * DAY); }
  function fmtDay(iso) { var p = iso.split("-"); return MON[+p[1] - 1] + " " + (+p[2]) + ", " + p[0]; }
  function validDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return false;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]), x = new Date(t);
    return x.getUTCFullYear() === +m[1] && x.getUTCMonth() === +m[2] - 1 && x.getUTCDate() === +m[3];
  }
  function hhmm(sec) { var d = new Date(sec * 1000); return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()); }

  // row = [id, ts, imp, cur, title, actual, forecast, previous, time_txt, date]
  // v119: in Replay, an Actual after the replay playhead stays hidden until price reaches it.
  var rpDirty = false, rpNow = null, rpNext = Infinity, rpOffT = -1e12, rpOff = 0;
  function relTs(r) { return r[1] != null && !r[10] ? r[1] : (r[9] ? dayTs(r[9]) + DAY : null); }
  function hidA(r) { var t; return rpNow !== null && r[5] !== "" && (t = relTs(r)) !== null && t > rpNow; }
  function aOf(r) { return hidA(r) ? "" : r[5]; }
  function isPending(r, now) {
    if (rpNow !== null) return false;
    return r[1] != null && !r[10] && now - r[1] >= PEND_DELAY && r[5] === "" && (r[6] !== "" || r[7] !== "") && now - r[1] <= PEND_WINDOW;
  }

  // ---------------------------------------------------------------- filters (chart + list)
  var FKEY = "mtte.news.filters.v113";
  var imp = { 4: 1, 3: 1, 2: 0, 1: 0 };      // v113: default High + Medium
  var curOn = { USD: 1 };                    // v113: default USD only (whitelist)
  var curList = [];
  var saveTimer = 0;
  function applySaved(d) {
    if (!d || typeof d !== "object") return;
    if (d.imp) imp = { 4: d.imp[4] ? 1 : 0, 3: d.imp[3] ? 1 : 0, 2: d.imp[2] ? 1 : 0, 1: d.imp[1] ? 1 : 0 };
    if (d.curOn) curOn = d.curOn;
  }
  try { applySaved(JSON.parse(localStorage.getItem(FKEY) || "null")); } catch (e) { /* defaults */ }
  function saveFilters() {
    var d = { imp: imp, curOn: curOn };
    try { localStorage.setItem(FKEY, JSON.stringify(d)); } catch (e) {}
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { var a = api(); if (a && a.save_news_filters) a.save_news_filters(d).catch(function () {}); }, 300);
  }
  function loadSavedFilters() {               // from disk (survives restarts); resolves true when something was applied
    var a = api();
    if (!a || !a.get_news_filters) return Promise.resolve(false);
    return a.get_news_filters().then(function (d) { if (!d) return false; applySaved(d); return true; }).catch(function () { return false; });
  }
  function setCurList(list) {                // no "All" chip; USD, EUR first, the rest A-Z
    var out = (list || []).filter(function (c) { return String(c).toLowerCase() !== "all"; });
    var first = ["USD", "EUR"];
    out.sort(function (a, b) { var x = first.indexOf(a), y = first.indexOf(b); if (x < 0) x = 9; if (y < 0) y = 9; return x - y || (a < b ? -1 : a > b ? 1 : 0); });
    curList = out;
  }
  function passes(r) { return imp[r[2]] && curOn[r[3]]; }
  function impSel() { return [4, 3, 2, 1].filter(function (k) { return imp[k]; }); }
  function impArr() { var a = impSel(); return a.length === 4 ? null : a; }               // null = no filter
  function curOnKeys() { return Object.keys(curOn).filter(function (k) { return curOn[k]; }); }
  function curArr() { return curOnKeys(); }
  function filterEmpty() { return !impSel().length || !curOnKeys().length; }
  function filterSig() { return impSel().join("") + "|" + curOnKeys().sort().join(","); }

  function redraw() { if (App.DrawingEngine && App.DrawingEngine.requestRender) App.DrawingEngine.requestRender(); }

  // ================================================================ chart part
  var colors = null, colorsAt = 0, colorsCls = "";
  function readColors(surface) {
    var now = Date.now(), cls = document.body.className;
    if (colors && cls === colorsCls && now - colorsAt < 1000) return colors;
    var cs = getComputedStyle(document.body), c = { 4: "", 3: "", 2: "", 1: "", bg: "" };
    c[4] = cs.getPropertyValue("--imp-high").trim() || "#e5484d";
    c[3] = cs.getPropertyValue("--imp-medium").trim() || "#f0993a";
    c[2] = cs.getPropertyValue("--imp-low").trim() || "#e3c53a";
    c[1] = cs.getPropertyValue("--imp-none").trim() || "#7d8797";
    try {
      var bgo = surface.chart.options().layout.background;
      c.bg = (bgo && bgo.color) || "";
    } catch (e) { /* fall through */ }
    if (!c.bg) c.bg = cs.getPropertyValue("--bg").trim() || "#0a0e17";
    c.panel = cs.getPropertyValue("--panel").trim() || "#11161f";
    c.text = cs.getPropertyValue("--text").trim() || "#e6e9ef";
    c.border = cs.getPropertyValue("--border").trim() || "#1e2531";
    colors = c; colorsAt = now; colorsCls = cls;
    return c;
  }

  // Per-surface window cache of timed events (UTC seconds), refilled when the view leaves it.
  function cacheOf(surface) {
    return surface._news || (surface._news = { lo: 0, hi: -1, rows: [], busy: false, want: null, timer: 0, failAt: 0 });
  }
  function want(surface, u0, u1) {
    var st = cacheOf(surface);
    st.want = [u0, u1];
    if (st.timer || st.busy || Date.now() - st.failAt < 3000) return;
    st.timer = setTimeout(function () { st.timer = 0; fetchWindow(surface); }, 90);
  }
  function fetchWindow(surface) {
    var st = cacheOf(surface), w = st.want, a = api();
    if (!w) return;
    st.want = null;
    if (!a || !a.get_news_chart) { st.failAt = Date.now(); return; }
    var span = Math.max(w[1] - w[0], 3600);
    var lo = Math.floor(w[0] - span * 0.5), hi = Math.ceil(w[1] + span * 0.5);
    st.busy = true;
    a.get_news_chart(lo, hi).then(function (res) {
      st.busy = false;
      if (res && res.ok) { st.lo = lo; st.hi = hi; st.rows = res.rows || []; st.ver = (st.ver || 0) + 1; } else { st.failAt = Date.now(); }
      redraw();
    }).catch(function () { st.busy = false; st.failAt = Date.now(); });
  }
  function dropCaches() {
    var ss = App.DrawingEngine && App.DrawingEngine.getSurfaces ? App.DrawingEngine.getSurfaces() : [];
    ss.forEach(function (s) { if (s._news) { s._news.hi = -1; s._news.rows = []; s._news.ver = (s._news.ver || 0) + 1; } });
    redraw();
  }

  function lowerBound(rows, ts) {
    var a = 0, b = rows.length;
    while (a < b) { var m = (a + b) >> 1; if (rows[m][1] < ts) a = m + 1; else b = m; }
    return a;
  }

  var MAXDOTS = 5, DOT_R = 4.5, DOT_STEP = 14, DOT_TOP = 12;
  var extHover = null;       // v112: id (string) of the event hovered in the News tab list
  var tipExt = false;        // v122: the shared tooltip is currently shown for a list hover
  function setExtHover(id) {
    id = id == null ? null : String(id); if (id === extHover) return; extHover = id;
    if (id === null && tipExt) { tipExt = false; if (tip) tip.style.display = "none"; }
    redraw();
  }
  var hlEls = [];            // v122: list boxes dimmed because their dot is hovered on the chart
  function listHl(evs) {
    for (var i = 0; i < hlEls.length; i++) hlEls[i].classList.remove("hl");
    hlEls.length = 0;
    if (!evs || !tabActive || !list) return;
    for (var j = 0; j < evs.length; j++) {
      var el = list.querySelector('.nw-item[data-id="' + String(evs[j][0]).replace(/["\\]/g, "\\$&") + '"]');
      if (el) { el.classList.add("hl"); hlEls.push(el); }
    }
  }
  function ringDot(ctx, d, col) {                                 // v122: one hover ring for dot hover and list hover
    ctx.lineWidth = 1.5; ctx.strokeStyle = col[d.evs[0][2]]; ctx.beginPath();
    if (d.pill) { var rr = d.r + 2; if (ctx.roundRect) ctx.roundRect(d.x - rr, d.y - 9, rr * 2, 18, 9); else ctx.rect(d.x - rr, d.y - 9, rr * 2, 18); }
    else ctx.arc(d.x, d.y, DOT_R + 3.5, 0, 6.2832);
    ctx.stroke();
  }

  var MAX_LINES = 1200;     // visible-line budget: when zoomed far out, least important news drop out first
  function buildGroups(surface, rows, u0, u1, bu, w, arr, n, tf, C) {
    var i0 = lowerBound(rows, u0), cnt = { 1: 0, 2: 0, 3: 0, 4: 0 }, i;
    for (i = i0; i < rows.length && rows[i][1] <= u1; i++) if (passes(rows[i])) cnt[rows[i][2]]++;
    var floor = 1, total = cnt[1] + cnt[2] + cnt[3] + cnt[4];
    while (floor < 4 && total > MAX_LINES) { total -= cnt[floor]; floor++; }
    var gapMax = Math.max(tf * 2, 3600), groups = [], byKey = {};
    var ld = Math.floor(arr[n - 1].time / DAY), weekEnd = (ld + (6 - (ld + 4) % 7) + 1) * DAY;   // v112: end of Saturday
    for (i = i0; i < rows.length; i++) {
      var r = rows[i];
      if (r[1] > u1) break;
      if (r[2] < floor || !passes(r)) continue;
      var rb = r[1] + brokerUtc(r[1]);                           // v116: broker-clock time of this event
      var l = C.timeToLogical(rb);
      if (l === null) continue;
      if (l < -0.5 || (l > n - 0.5 && rb >= weekEnd)) continue;   // before the data / after Saturday
      if (l >= 0) l = Math.floor(l);                             // v114: always the earlier candle (round down), gaps included
      var x = C.logicalToX(l);
      if (x === null || x < -4 || x > w + 4) continue;
      var key = Math.floor(x / 3);                               // lines <3px apart merge into one
      var g = byKey[key];
      if (!g) { g = byKey[key] = { x: x, top: 0, evs: [] }; groups.push(g); }
      g.evs.push(r);
      if (r[2] > g.top) g.top = r[2];
    }
    for (var gi = 0; gi < groups.length; gi++) {
      var g2 = groups[gi], cm = {}, cl = [];
      g2.evs.sort(function (a, b) { return b[2] - a[2] || a[1] - b[1]; });
      for (var ci = 0; ci < g2.evs.length; ci++) {               // v115: same exact time -> one dot (top = highest impact)
        var e0 = g2.evs[ci], c0 = cm[e0[1]];
        if (!c0) { c0 = cm[e0[1]] = { evs: [], top: e0[2] }; cl.push(c0); }
        c0.evs.push(e0);
      }
      g2.cls = cl;
    }
    return groups;
  }

  function paint(surface, ctx, w, h) {
    if (!surface.getCandles || App.jumpRenderSuppressed) return;
    hook(surface);
    surface._newsDots = null;
    if (filterEmpty()) return;
    var arr = surface.getCandles();
    if (!arr || !arr.length) return;
    var range = null;
    try { range = surface.chart.timeScale().getVisibleLogicalRange(); } catch (e) {}
    if (!range) return;
    var C = surface.C, n = arr.length, tf = surface.getTf ? surface.getTf() : 0;
    var tMin = C.logicalToTime(range.from - 1), tMax = C.logicalToTime(range.to + 1);
    if (tMin === null || tMax === null) return;
    if (App.Tz && App.Tz.hasRule && !App.Tz.hasRule()) return;   // v117: UTC -> broker time is unknown until the broker clock is detected/set
    var bLo = brokerUtc(tMin), bHi = brokerUtc(tMax), bu = bLo + "/" + bHi;   // v116: per-event offsets inside buildGroups
    var u0 = tMin - Math.max(bLo, bHi) - 7200, u1 = tMax - Math.min(bLo, bHi) + 7200;
    var st = cacheOf(surface);
    if (u0 < st.lo || u1 > st.hi) want(surface, u0, u1);
    if (st.hi < st.lo || !st.rows.length) return;

    var key0 = range.from + "," + range.to + "|" + n + "|" + tf + "|" + arr[0].time + "|" + arr[n - 1].time + "|" + Math.round(w) + "|" + filterSig() + "|" + bu + "|" + (st.ver || 0);
    var memo = surface._newsMemo, groups;
    if (memo && memo.key === key0) groups = memo.groups;          // only the price axis moved: reuse
    else {
      groups = buildGroups(surface, st.rows, u0, u1, bu, w, arr, n, tf, C);
      surface._newsMemo = { key: key0, groups: groups };
    }
    if (!groups.length) return;

    var col = readColors(surface);
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    for (var imp4 = 1; imp4 <= 4; imp4++) {                       // one path per color; High drawn last (on top)
      ctx.beginPath();
      var any = false;
      for (var k = 0; k < groups.length; k++) {
        if (groups[k].top !== imp4) continue;
        var px = Math.round(groups[k].x) + 0.5;
        ctx.moveTo(px, 0); ctx.lineTo(px, h);
        any = true;
      }
      if (any) { ctx.strokeStyle = col[imp4]; ctx.globalAlpha = 0.85; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;

    var maxDots = Math.max(1, Math.min(MAXDOTS, Math.floor((h * 0.5 - DOT_TOP) / DOT_STEP) + 1));
    var dots = [], hov = surface._newsHover;
    ctx.font = "10px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (var gi = 0; gi < groups.length; gi++) {
      var gr = groups[gi];
      var cls = gr.cls, cnt = cls.length, shown = cnt > maxDots ? maxDots - 1 : cnt;   // v115: one dot per distinct time
      var gx = Math.round(gr.x) + 0.5;
      for (var di = 0; di < shown; di++) {
        var dy = DOT_TOP + di * DOT_STEP, cl1 = cls[di];
        ctx.beginPath(); ctx.arc(gx, dy, DOT_R, 0, 6.2832);
        ctx.fillStyle = col[cl1.top]; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = col.bg; ctx.stroke();
        dots.push({ x: gx, y: dy, r: DOT_R + 4, evs: cl1.evs });
      }
      if (cnt > shown) {                                         // "+N" pill for the rest of a crowded line
        var py = DOT_TOP + shown * DOT_STEP, rest = [];
        for (var ri = shown; ri < cnt; ri++) rest = rest.concat(cls[ri].evs);
        var lab = "+" + rest.length, pw = ctx.measureText(lab).width + 8;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(gx - pw / 2, py - 7, pw, 14, 7); else ctx.rect(gx - pw / 2, py - 7, pw, 14);
        ctx.fillStyle = col[cls[shown].top]; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = col.bg; ctx.stroke();
        ctx.fillStyle = col.bg; ctx.fillText(lab, gx, py + 0.5);
        dots.push({ x: gx, y: py, r: Math.max(pw / 2, 9), evs: rest, pill: true });
      }
    }
    var extFound = null;
    if (hov) {                                                    // highlight ring of the hovered dot
      for (var hi2 = 0; hi2 < dots.length; hi2++) {
        var d = dots[hi2];
        if (d.evs[0][0] === hov.id && Math.abs(d.x - hov.x) < 2 && Math.abs(d.y - hov.y) < 2) { ringDot(ctx, d, col); break; }
      }
    }
    if (extHover !== null) {                                      // v122: list hover = same ring as a dot hover (tooltip below)
      for (var ei = 0; ei < dots.length && !extFound; ei++) {
        var ed = dots[ei];
        for (var ej = 0; ej < ed.evs.length; ej++) if (String(ed.evs[ej][0]) === extHover) { extFound = ed; break; }
      }
      if (extFound) ringDot(ctx, extFound, col);
    }
    ctx.restore();
    surface._newsDots = dots;
    if (extFound && !tipExt) { tipExt = true; showTip(surface, extFound); }   // v122: same tooltip as hovering the dot
  }

  // ---- tooltip + hover (one DOM tooltip, listeners hooked once per surface)
  var tip = null;
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "nw-tip";
    document.body.appendChild(tip);
    return tip;
  }
  function valHtml(r, now) {
    if (aOf(r) !== "") return esc(r[5]);
    return isPending(r, now) ? '<span style="font-style:italic;color:var(--muted)">pending</span>' : "-";
  }
  function showTip(surface, dot) {
    var t = ensureTip(), now = Date.now() / 1000, sh = dispShift(), evs = dot.evs, ev = evs[0];
    var day = ev[1] != null && !ev[10] ? fmtDay(isoOf(ev[1] + dispShift(ev[1]))) + " \u00b7 " + hhmm(ev[1] + dispShift(ev[1])) : fmtDay(ev[9]) + " \u00b7 " + esc(ev[8] || "All Day");   // v115
    function afp(e) { return '<div class="r3"><span><i>A</i>' + valHtml(e, now) + "</span><span><i>F</i>" + (esc(e[6]) || "-") + "</span><span><i>P</i>" + (esc(e[7]) || "-") + "</span></div>"; }
    function head(e) { return '<div class="r1"><span class="nw-sq" style="--c:var(--imp-' + IKEY[e[2]] + ')"></span>' + esc(e[3]) + " \u00b7 " + esc(e[4]) + "</div>"; }
    var html;
    if (dot.pill) {                                               // "+N" pill: list the rest compactly
      html = "";
      evs.slice(0, 8).forEach(function (e) {
        html += '<div class="r1" style="margin-bottom:2px"><span class="nw-sq" style="--c:var(--imp-' + IKEY[e[2]] + ')"></span>' + esc(e[3]) + " \u00b7 " + esc(e[4]) +
          '<span style="margin-left:auto;color:var(--muted);font-weight:400">' + (e[1] != null && !e[10] ? hhmm(e[1] + dispShift(e[1])) : esc(e[8] || "All Day")) + "</span></div>";
      });
      if (evs.length > 8) html += '<div class="r4">+' + (evs.length - 8) + " more</div>";
    } else if (evs.length > 1) {                                  // v115: same-time news stacked in one tooltip
      html = '<div class="r2">' + day + "</div>";
      evs.slice(0, 6).forEach(function (e, i) { html += '<div' + (i ? ' style="margin-top:6px"' : "") + ">" + head(e) + afp(e) + "</div>"; });
      if (evs.length > 6) html += '<div class="r4">+' + (evs.length - 6) + " more</div>";
    } else {
      html = '<div class="r2">' + day + "</div>" + head(ev) + afp(ev);   // v115: single news = same layout as grouped (date first)
    }
    t.innerHTML = html;
    t.style.display = "block";
    var rc = surface.canvas.getBoundingClientRect();
    var l = rc.left + dot.x + 12, top = Math.max(4, rc.top + dot.y - 12);
    if (l + t.offsetWidth > window.innerWidth - 4) l = rc.left + dot.x - 12 - t.offsetWidth;
    if (top + t.offsetHeight > window.innerHeight - 4) top = window.innerHeight - 4 - t.offsetHeight;
    t.style.left = Math.max(4, l) + "px"; t.style.top = top + "px";
  }
  function hideTip(surface) {
    if (tip && !tipExt) tip.style.display = "none";
    if (surface._newsHover) { surface._newsHover = null; listHl(null); redraw(); }
  }
  function hook(surface) {
    if (surface._newsHooked || !surface.container) return;
    surface._newsHooked = true;
    var pend = null, raf = 0;
    function hit(e) {                                           // v122: dot under the cursor (shared by hover and click)
      var dots = surface._newsDots;
      if (!dots || !dots.length) return null;
      var rc = surface.canvas.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top, best = null, bd = 1e9;
      if (y > DOT_TOP + MAXDOTS * DOT_STEP + 8) return null;
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i], dd = (d.x - x) * (d.x - x) + (d.y - y) * (d.y - y);
        if (dd <= d.r * d.r && dd < bd) { bd = dd; best = d; }
      }
      return best;
    }
    function run() {
      raf = 0;
      var e = pend; pend = null;
      var best = e ? hit(e) : null;
      if (!best) { if (surface._newsHover) hideTip(surface); return; }
      var hv = surface._newsHover;
      if (!hv || hv.id !== best.evs[0][0] || hv.x !== best.x || hv.y !== best.y) {
        if (tipExt) { tipExt = false; extHover = null; }          // v122: chart hover takes over from a list hover
        surface._newsHover = { id: best.evs[0][0], x: best.x, y: best.y };
        showTip(surface, best);
        listHl(best.evs);                                         // v122: dim the same box(es) in the News list
        redraw();
      }
    }
    surface.container.addEventListener("mousemove", function (e) {
      if (!surface._newsDots || !surface._newsDots.length) return;
      pend = e;
      if (!raf) raf = requestAnimationFrame(run);
    }, { passive: true });
    surface.container.addEventListener("mouseleave", function () { pend = null; hideTip(surface); });
    var dn = null;                                                // v122: click (not drag) on a dot -> scroll the News list to it
    surface.container.addEventListener("mousedown", function (e) { dn = { x: e.clientX, y: e.clientY }; }, { passive: true });
    surface.container.addEventListener("click", function (e) {
      if (!tabActive || !dn || Math.abs(e.clientX - dn.x) > 3 || Math.abs(e.clientY - dn.y) > 3) return;
      var d = hit(e);
      if (d) focusEvent(d.evs[0], d.evs);
    });
  }

  // ================================================================ News tab part
  var tabActive = false, inited = false;
  var list, jstat, dateIn, dateBox, pop, calBtn, refBtn, bdEl;
  var meta = { min: null, max: null };
  var secs = [];                 // [{day, el, rows}] newest first, only days with news
  var loHi = null, loLo = null;  // loaded display-day range [loLo, loHi] (inclusive)
  var loading = false, gen = 0;
  var curDay = null, jumpLock = 0;
  var MAXSECS = 30, CHUNK = 7;
  var weekRows = {};             // week key -> unfiltered rows (for the Pending badge)
  var fresh = {};                // rows whose Actual just arrived (flash)
  var refreshing = false, refreshWeek = null, refreshBefore = null;
  var daysCache = null, daysSig = "";

  function rowKey(r) { return r[1] + "|" + r[3] + "|" + r[4]; }
  function sundayOfDay(iso) { var t = dayTs(iso); return isoOf(t - new Date(t * 1000).getUTCDay() * DAY); }
  function dayOfRow(r, sh) { return r[1] != null ? isoOf(r[1] + dispShift(r[1])) : r[9]; }   // v116: per-event shift

  function fetchRows(d0, d1, impA, curA) {
    var a = api(), sh = dispShift();
    if (!a || !a.get_news_rows) return Promise.resolve([]);
    return a.get_news_rows(dayTs(d0) - shAtDisp(dayTs(d0)), dayTs(d1) + DAY - shAtDisp(dayTs(d1) + DAY), d0, d1, impA, curA).then(function (res) {
      return res && res.ok ? res.rows || [] : [];
    }).catch(function () { return []; });
  }

  function groupDays(rows) {
    var sh = dispShift(), m = {};
    rows.forEach(function (r) { var d = dayOfRow(r, sh); (m[d] || (m[d] = [])).push(r); });
    return Object.keys(m).sort().reverse().map(function (d) {
      m[d].sort(function (a, b) {                                // untimed (All Day / Tentative) pinned on top
        if ((a[1] == null) !== (b[1] == null)) return a[1] == null ? -1 : 1;
        return (b[1] || 0) - (a[1] || 0) || b[2] - a[2];
      });
      return { day: d, rows: m[d] };
    });
  }

  function rowHtml(r, now, sh) {
    var pend = isPending(r, now), c = "var(--imp-" + IKEY[r[2]] + ")";
    var hid = hidA(r);
    if (hid) { var rt0 = relTs(r); if (rt0 < rpNext) rpNext = rt0; }
    var a = hid ? '<b class="none" data-ra="' + esc(r[5]) + '" data-rt="' + relTs(r) + '">-</b>' : r[5] !== "" ? "<b" + (fresh[rowKey(r)] ? ' class="upd"' : "") + ">" + esc(r[5]) + "</b>"
      : pend ? '<b class="pend">pending</b>' : '<b class="none">-</b>';
    var time = r[1] != null ? hhmm(r[1] + dispShift(r[1])) : esc(r[8] || "All Day");
    return '<div class="tp-item nw-item" data-id="' + esc(r[0]) + '" style="--c:' + c + '"><div class="tp-row1"><span><span class="tp-sym">' + esc(r[3]) +
      '</span><span class="nw-name" title="' + esc(r[4]) + '">' + esc(r[4]) + "</span>" +
      (pend ? '<span class="nw-pdot" title="Waiting for the actual value"></span>' : "") +
      '</span><span class="tp-side nw-tag">' + ISHORT[r[2]].toUpperCase() + '</span></div><div class="tp-row2"><span class="nw-vals"><span><i>A</i>' + a +
      "</span><span><i>F</i><b>" + (esc(r[6]) || "-") + "</b></span><span><i>P</i><b>" + (esc(r[7]) || "-") + "</b></span></span><span class=\"nw-time\">" + time + "</span></div></div>";
  }
  function secEl(g) {
    var now = Date.now() / 1000, sh = dispShift(), p = g.day.split("-");
    var el = document.createElement("div");
    el.className = "nw-sec"; el.setAttribute("data-day", g.day);
    el.style.cssText = "display:flex;flex-direction:column;gap:6px;flex:0 0 auto";
    el.innerHTML = '<div class="nw-day">' + MON[+p[1] - 1] + " " + (+p[2]) + ", " + p[0] + "</div>" + g.rows.map(function (r) { return rowHtml(r, now, sh); }).join("");
    return { day: g.day, el: el, rows: g.rows };
  }

  function setStat(t) { jstat.textContent = t || ""; }
  function emptyMsg() {
    if (!secs.length) list.innerHTML = '<div class="nw-empty">' + (meta.min ? "No news matches your filter" : "No news downloaded yet (Setting > Market Data Overview > Economic News)") + "</div>";
  }

  // Load CHUNK display-days older (dir=1) or newer (dir=-1) than what is loaded; skips empty stretches.
  function loadMore(dir) {
    if (loading || filterEmpty() || !meta.min) return Promise.resolve();
    var lastGen = gen, hops = 0;
    loading = true;
    function atEnd() { return dir > 0 ? loLo <= addDays(meta.min, -1) : loHi >= addDays(meta.max, 1); }
    function step() {
      if (atEnd() || hops++ >= 12) { loading = false; return; }
      var d0, d1;
      if (dir > 0) { d1 = addDays(loLo, -1); d0 = addDays(d1, -(CHUNK - 1)); }
      else { d0 = addDays(loHi, 1); d1 = addDays(d0, CHUNK - 1); }
      return fetchRows(d0, d1, impArr(), curArr()).then(function (rows) {
        if (lastGen !== gen) { loading = false; return; }
        if (dir > 0) loLo = d0; else loHi = d1;
        var gs = groupDays(rows);
        if (!gs.length) return step();
        attach(gs, dir);
        loading = false;
      });
    }
    return Promise.resolve(step()).then(function () { loading = false; });
  }

  function attach(gs, dir) {
    var added = gs.map(secEl);
    if (!secs.length) list.innerHTML = "";
    var frag = document.createDocumentFragment();
    added.forEach(function (s) { frag.appendChild(s.el); });
    if (dir > 0) {
      list.appendChild(frag); secs = secs.concat(added);
      while (secs.length > MAXSECS) {                              // trim the newest end, keep the view still
        var top = secs.shift(), hgt = top.el.offsetHeight + 6;
        loHi = addDays(top.day, -1);
        top.el.remove(); list.scrollTop -= hgt;
      }
    } else {
      var before = list.scrollHeight, st = list.scrollTop;
      list.insertBefore(frag, list.firstChild); secs = added.concat(secs);
      list.scrollTop = st + (list.scrollHeight - before);
      while (secs.length > MAXSECS) {                              // trim the oldest end
        var bot = secs.pop(); loLo = addDays(bot.day, 1); bot.el.remove();
      }
    }
    schedulePend();
  }

  function resetWindowAt(day, scrollTo) {
    var g = ++gen;
    loading = false; setExtHover(null);
    secs = []; list.innerHTML = "";
    loHi = addDays(day, 1); loLo = addDays(day, -(CHUNK - 1));
    if (filterEmpty() || !meta.min) { emptyMsg(); return Promise.resolve(); }
    return fetchRows(loLo, loHi, impArr(), curArr()).then(function (rows) {
      if (g !== gen) return;
      var gs = groupDays(rows);
      if (gs.length) attach(gs, 1); else emptyMsg();
      if (scrollTo) scrollToDay(day);
      return fill();
    });
  }
  function fill() {                                                // keep loading until the list can scroll
    if (!secs.length && !loading) {
      if (!filterEmpty() && meta.min) return loadMore(1).then(function () { if (secs.length) return fill(); emptyMsg(); });
      return Promise.resolve();
    }
    if (list.scrollHeight <= list.clientHeight + 40 && !loading) {
      var n = secs.length;
      return loadMore(1).then(function () { if (secs.length > n) return fill(); });
    }
    return Promise.resolve();
  }

  function nearestSec(day) {
    var best = null, bd = 1e18, t = dayTs(day);
    secs.forEach(function (s) { var d = Math.abs(dayTs(s.day) - t); if (d < bd) { bd = d; best = s; } });
    return best;
  }
  function scrollToDay(day) {
    var s = nearestSec(day); if (!s) return null;
    curDay = s.day; dateIn.value = s.day; jumpLock = Date.now() + 500;
    list.scrollTop = s.el.offsetTop;
    var lab = s.el.firstChild; lab.classList.remove("flash"); void lab.offsetWidth; lab.classList.add("flash");
    updateBadge();
    return s;
  }

  // ---- days that have news (calendar dots, previous/next day, jump)
  function loadDays() {
    var sig = filterSig();
    if (daysCache && daysSig === sig) return Promise.resolve(daysCache);
    var a = api();
    if (!a || !a.get_news_days || !meta.min || filterEmpty()) return Promise.resolve([]);
    return a.get_news_days(meta.min, meta.max, impArr(), curArr()).then(function (res) {
      daysCache = (res && res.ok) ? res.days : []; daysSig = sig; return daysCache;
    }).catch(function () { return []; });
  }
  function nearestIn(days, d) {
    var t = dayTs(d), best = null, bd = 1e18;
    days.forEach(function (x) { var df = Math.abs(dayTs(x) - t); if (df < bd || (df === bd && x < best)) { bd = df; best = x; } });
    return best;
  }
  function jumpTo(d) {
    dateBox.classList.remove("bad"); closePop();
    return loadDays().then(function (days) {
      if (!days.length) { setStat("No news matches your filter"); return; }
      var n = nearestIn(days, d);
      setStat(n !== d ? "No news on " + d + " · showing " + fmtDay(n) : "");
      var s = null;
      for (var i = 0; i < secs.length; i++) if (secs[i].day === n) { s = secs[i]; break; }
      if (s && s.el.offsetHeight) { list.scrollTo({ top: s.el.offsetTop, behavior: "smooth" }); curDay = n; dateIn.value = n; jumpLock = Date.now() + 700; updateBadge(); return; }
      return resetWindowAt(n, true);
    });
  }
  // v122: chart dot click -> News list scrolls to that very news (loads its day first when needed)
  function focusEvent(ev, evs) {
    if (!tabActive || !list) return;
    var day = dayOfRow(ev), id = String(ev[0]);
    function go() {
      var el = list.querySelector('.nw-item[data-id="' + id.replace(/["\\]/g, "\\$&") + '"]');
      if (!el) return;
      var sec = el.parentNode;
      list.scrollTop = Math.max(sec.offsetTop, el.offsetTop - 30);
      curDay = day; dateIn.value = day; jumpLock = Date.now() + 500;
      var lab = sec.firstChild; lab.classList.remove("flash"); void lab.offsetWidth; lab.classList.add("flash");
      updateBadge(); listHl(evs);
    }
    for (var i = 0; i < secs.length; i++) if (secs[i].day === day && secs[i].el.offsetHeight) { go(); return; }
    resetWindowAt(day, true).then(go);
  }
  // v122: News list click -> Jump Time to that news on the main chart and every multi-chart panel
  function jumpToRow(id) {
    var r = null;
    for (var i = 0; i < secs.length && !r; i++) for (var j = 0; j < secs[i].rows.length; j++) if (String(secs[i].rows[j][0]) === id) { r = secs[i].rows[j]; break; }
    if (!r || !App.JumpTime || !App.JumpTime.jumpToTimestamp) return;
    var u = r[1] != null ? r[1] : dayTs(r[9]), t = u + brokerUtc(u);   // chart time = broker clock, like the dot placement
    App.JumpTime.jumpToTimestamp(t).then(function (ok) {
      if (!ok && App.DrawingEngine && App.DrawingEngine.showHint) App.DrawingEngine.showHint("Can't jump \u2014 outside the available data range");
    });
    if (App.MultiPanel && App.MultiPanel.jumpAllToTimestamp) App.MultiPanel.jumpAllToTimestamp(t);
  }
  function stepDay(dir) {
    loadDays().then(function (days) {
      if (!days.length) return;
      var i = days.indexOf(curDay);
      if (i < 0) i = days.indexOf(nearestIn(days, curDay));
      var j = Math.max(0, Math.min(days.length - 1, i + dir));
      jumpTo(days[j]);
    });
  }
  function todayTarget() {                                         // last day that has live data
    // v120: in Replay "Today" is the replayed trading day (display clock).
    if (rpNow !== null) return Promise.resolve(isoOf(rpNow + dispShift(rpNow)));
    var a = api(), fallback = isoOf(Date.now() / 1000 + dispShift());
    if (!a || !a.get_history_bounds) return Promise.resolve(fallback);
    return a.get_history_bounds(App.currentTf || 1).then(function (b) {
      if (b && b.last_time != null) return isoOf(Number(b.last_time) + (App.Tz ? App.Tz.offset() : 0));
      return fallback;
    }).catch(function () { return fallback; });
  }

  // ---- Pending badge / Refresh
  function weekOf(day) { return sundayOfDay(day); }
  function pendCount(rows) { var now = Date.now() / 1000, n = 0; rows.forEach(function (r) { if (isPending(r, now)) n++; }); return n; }
  function updateBadge() {
    if (!curDay) return;
    var wk = weekOf(curDay);
    function show(rows) {
      var n = pendCount(rows);
      refBtn.classList.toggle("has", n > 0);
      bdEl.textContent = n;
      refBtn.title = n ? "Refresh actual values (" + n + " waiting)" : "Refresh actual values";
      schedulePend();
    }
    if (weekRows[wk]) { show(weekRows[wk]); return; }
    var sh = dispShift(), d0 = wk, d1 = addDays(wk, 6);
    fetchRows(d0, d1, null, null).then(function (rows) {
      var keys = Object.keys(weekRows);
      if (keys.length > 3) delete weekRows[keys[0]];
      weekRows[wk] = rows;
      if (curDay && weekOf(curDay) === wk) show(rows);
    });
  }
  // v115: one timer flips Pending + Refresh badge exactly PEND_DELAY s after a news time (no polling)
  var pendTimer = 0;
  function nextPendAt(rows, now, best) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r[1] == null || r[10] || r[5] !== "" || (r[6] === "" && r[7] === "")) continue;
      var t = r[1] + PEND_DELAY;
      if (t > now && t < best) best = t;
    }
    return best;
  }
  function schedulePend() {
    clearTimeout(pendTimer); pendTimer = 0;
    if (!tabActive) return;
    var now = Date.now() / 1000, best = Infinity, wr = curDay ? weekRows[weekOf(curDay)] : null;
    if (wr) best = nextPendAt(wr, now, best);
    for (var i = 0; i < secs.length; i++) best = nextPendAt(secs[i].rows, now, best);
    if (best === Infinity) return;
    pendTimer = setTimeout(pendTick, Math.min(Math.max((best - now) * 1000 + 30, 30), 3600000));
  }
  function patchPending() {                                       // list rows that just became Pending, patched in place
    var now = Date.now() / 1000, sh = dispShift();
    for (var i = 0; i < secs.length; i++) {
      var rs = secs[i].rows;
      for (var j = 0; j < rs.length; j++) {
        var r = rs[j];
        if (r[1] == null || now - r[1] < PEND_DELAY || !isPending(r, now)) continue;
        var el = secs[i].el.querySelector('.nw-item[data-id="' + r[0] + '"]');
        if (el && !el.querySelector(".nw-pdot")) el.outerHTML = rowHtml(r, now, sh);
      }
    }
  }
  function pendTick() {
    pendTimer = 0;
    if (!tabActive) return;
    patchPending(); updateBadge(); schedulePend();
  }
  function proxyCfg() {
    var p = App.NewsProxy ? App.NewsProxy() : { mode: "auto" };
    return p;
  }
  function doRefresh() {
    var a = api();
    if (!curDay || !a || !a.refresh_news_week || refreshing) return;
    var pend = weekRows[weekOf(curDay)] ? pendCount(weekRows[weekOf(curDay)]) : 0;
    if (!pend) { setStat("All actual values are up to date"); }
    var p = proxyCfg();
    if (!p) { setStat("Invalid Proxy Port (Setting > Economic News)"); return; }
    refreshing = true; refreshWeek = weekOf(curDay);
    refreshBefore = {};
    (weekRows[refreshWeek] || []).forEach(function (r) { refreshBefore[rowKey(r)] = r[5]; });
    refBtn.classList.add("spin"); setStat("Updating this week…");
    a.refresh_news_week(curDay, p).then(function (res) {
      if (res && res.ok) return;
      refreshing = false; refBtn.classList.remove("spin");
      setStat(res && res.busy ? "A news download is already running" : res && res.error === "packages" ? "Install curl_cffi and beautifulsoup4 first" : "Refresh unavailable");
    }).catch(function () { refreshing = false; refBtn.classList.remove("spin"); setStat("Refresh unavailable"); });
  }
  window.onNewsRefresh = function (kind, state, d) {
    if (state !== "done" || !inited) return;
    refreshing = false; refBtn.classList.remove("spin");
    delete weekRows[refreshWeek];
    dropCaches();                                                   // chart tooltips show the new Actual
    if (!d || !d.ok) { setStat("Couldn't reach Forex Factory"); return; }
    var wk = refreshWeek || (d && d.week) || weekOf(curDay), before = refreshBefore || {};
    fetchRows(wk, addDays(wk, 6), null, null).then(function (rows) {
      weekRows[wk] = rows;
      fresh = {}; var got = 0;
      rows.forEach(function (r) { if (r[5] !== "" && before[rowKey(r)] === "") { fresh[rowKey(r)] = 1; got++; } });
      var left = pendCount(rows);
      setStat(got ? "Updated " + got + (got === 1 ? " event" : " events") + (left ? " · " + left + " still waiting" : "") : "No new values published yet");
      reloadWindow();
    });
  };
  // re-read the loaded days in place (new Actual values), keeping the scroll position
  function reloadWindow() {
    if (!secs.length) return;
    var g = ++gen, keep = list.scrollTop, d1 = loHi, d0 = loLo;
    fetchRows(d0, d1, impArr(), curArr()).then(function (rows) {
      if (g !== gen) return;
      var gs = groupDays(rows);
      setExtHover(null); secs = []; list.innerHTML = "";
      if (gs.length) attach(gs, 1); else emptyMsg();
      list.scrollTop = keep; updateBadge();
    });
  }

  // ---- calendar popover (same .rbd-cal-* look as Replay / Jump Time)
  var calY = 0, calM = 0;
  var CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  function closePop() { pop.classList.remove("open"); calBtn.classList.remove("on"); }
  function drawCal(days) {
    var has = {}; days.forEach(function (d) { has[d] = 1; });
    var loK = meta.min ? (+meta.min.slice(0, 4)) * 12 + (+meta.min.slice(5, 7) - 1) : 0;
    var hiK = meta.max ? (+meta.max.slice(0, 4)) * 12 + (+meta.max.slice(5, 7) - 1) : 0, k = calY * 12 + calM;
    var h = '<div class="rbd-cal-nav"><button type="button" class="rbd-cal-nav-btn rbd-cal-prev" data-m="-1"' + (k <= loK ? " disabled" : "") + ">" + CHEV +
      '</button><span class="rbd-cal-title">' + MONL[calM] + " " + calY + '</span><button type="button" class="rbd-cal-nav-btn rbd-cal-next" data-m="1"' + (k >= hiK ? " disabled" : "") + ">" + CHEV + '</button></div><div class="rbd-cal-grid">';
    ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach(function (w) { h += '<div class="rbd-cal-dow">' + w + "</div>"; });
    var lead = (new Date(Date.UTC(calY, calM, 1)).getUTCDay() + 6) % 7, dim = new Date(Date.UTC(calY, calM + 1, 0)).getUTCDate();
    for (var i = 0; i < lead; i++) h += '<div class="rbd-cal-day rbd-cal-day-out"></div>';
    var today = isoOf(Date.now() / 1000 + dispShift());
    for (var d = 1; d <= dim; d++) {
      var iso = calY + "-" + pad2(calM + 1) + "-" + pad2(d);
      h += '<button type="button" class="rbd-cal-day' + (has[iso] ? " nw-has" : " nw-off") + (iso === today ? " nw-today-d" : "") + (iso === curDay ? " rbd-cal-day-selected" : "") + '" data-d="' + iso + '">' + d + "</button>";
    }
    pop.innerHTML = h + "</div>";
  }
  function openCal() {
    if (pop.classList.contains("open")) { closePop(); return; }
    loadDays().then(function (days) {
      var d = curDay || meta.max || isoOf(Date.now() / 1000);
      calY = +d.slice(0, 4); calM = +d.slice(5, 7) - 1;
      drawCal(days); pop.classList.add("open"); calBtn.classList.add("on");
    });
  }

  // ---- chips
  function drawChips() {
    var ic = $("nw-imp"), cc = $("nw-cur");
    ic.innerHTML = [4, 3, 2, 1].map(function (k) {
      return '<div class="tp-chip' + (imp[k] ? " selected" : "") + '" data-k="' + k + '"><span class="nw-sq" style="--c:var(--imp-' + IKEY[k] + ')"></span>' + ISHORT[k] + "</div>";
    }).join("");
    cc.innerHTML = curList.map(function (c) { return '<div class="tp-chip' + (curOn[c] ? " selected" : "") + '" data-c="' + esc(c) + '">' + esc(c) + "</div>"; }).join("");
  }
  var filterTimer = 0;
  function filtersChanged() {
    saveFilters(); drawChips(); daysCache = null; redraw();
    clearTimeout(filterTimer);
    filterTimer = setTimeout(function () { if (tabActive) resetWindowAt(curDay || meta.max || isoOf(Date.now() / 1000), true); }, 80);
  }

  // ---- scroll: lazy load + keep the date box in sync
  var scrollRaf = 0;
  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      if (!secs.length) return;
      if (list.scrollTop + list.clientHeight > list.scrollHeight - 320) loadMore(1);
      else if (list.scrollTop < 240) loadMore(-1);
      if (Date.now() < jumpLock) return;
      var top = list.scrollTop + 6, cur = null;
      for (var i = 0; i < secs.length; i++) { if (secs[i].el.offsetTop <= top) cur = secs[i].day; else break; }
      if (cur && cur !== curDay) { curDay = cur; if (document.activeElement !== dateIn) dateIn.value = cur; updateBadgeSoon(); }
    });
  }
  var badgeTimer = 0;
  function updateBadgeSoon() { clearTimeout(badgeTimer); badgeTimer = setTimeout(updateBadge, 250); }

  function init() {
    if (inited) return;
    inited = true;
    list = $("nw-list"); jstat = $("nw-jstat"); dateIn = $("nw-date"); dateBox = $("nw-jin");
    pop = $("nw-pop"); calBtn = $("nw-cal"); refBtn = $("nw-ref"); bdEl = $("nw-bd");
    drawChips();
    $("nw-imp").addEventListener("click", function (e) {
      var c = e.target.closest(".tp-chip"); if (!c) return;
      var k = c.getAttribute("data-k"); imp[k] = imp[k] ? 0 : 1; filtersChanged();
    });
    $("nw-cur").addEventListener("click", function (e) {
      var c = e.target.closest(".tp-chip"); if (!c) return;
      var k = c.getAttribute("data-c"); if (curOn[k]) delete curOn[k]; else curOn[k] = 1; filtersChanged();
    });
    $("tp-tab-news").querySelectorAll(".nw-quick span").forEach(function (s) {
      s.addEventListener("click", function () {
        var a = s.getAttribute("data-a"), on = a.indexOf("all") > 0;
        if (a.indexOf("imp") === 0) { [1, 2, 3, 4].forEach(function (k) { imp[k] = on ? 1 : 0; }); }
        else { curOn = {}; if (on) curList.forEach(function (c) { curOn[c] = 1; }); }
        filtersChanged();
      });
    });
    $("nw-prev").onclick = function () { stepDay(-1); };      // earlier day with news
    $("nw-next").onclick = function () { stepDay(1); };       // later day with news
    $("nw-today").onclick = function () { todayTarget().then(function (d) { jumpTo(meta.max && d > meta.max ? meta.max : d); }); };
    refBtn.onclick = doRefresh;
    calBtn.onclick = function (e) { e.stopPropagation(); openCal(); };
    pop.addEventListener("click", function (e) {
      var m = e.target.closest("[data-m]"), d = e.target.closest("[data-d]");
      if (m && !m.disabled) {
        calM += +m.getAttribute("data-m");
        if (calM < 0) { calM = 11; calY--; } if (calM > 11) { calM = 0; calY++; }
        loadDays().then(drawCal);
      } else if (d) jumpTo(d.getAttribute("data-d"));
    });
    document.addEventListener("mousedown", function (e) {
      if (pop.classList.contains("open") && !pop.contains(e.target) && !calBtn.contains(e.target)) closePop();
    });
    dateIn.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var v = dateIn.value.replace(/[./]/g, "-").trim().split("-").map(function (x, i) { return i ? ("0" + x).slice(-2) : x; }).join("-");
        if (!validDay(v)) { dateBox.classList.add("bad"); setStat("Use format YYYY-MM-DD"); return; }
        jumpTo(v); dateIn.blur();
      } else if (e.key === "Escape") { dateIn.value = curDay || ""; dateBox.classList.remove("bad"); setStat(""); dateIn.blur(); }
      e.stopPropagation();                                          // typing here must not trigger chart shortcuts
    });
    dateIn.addEventListener("input", function () { dateBox.classList.remove("bad"); });
    list.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("mouseover", function (e) {               // v112: hover a news box -> mark it on the chart
      var it = e.target.closest ? e.target.closest(".nw-item") : null;
      setExtHover(it ? it.getAttribute("data-id") : null);
    });
    list.addEventListener("mouseleave", function () { setExtHover(null); });
    list.addEventListener("click", function (e) {                     // v122
      var it = e.target.closest ? e.target.closest(".nw-item") : null;
      if (it) jumpToRow(it.getAttribute("data-id"));
    });
  }

  function open() {
    init();
    var a = api();
    if (!a || !a.get_news_meta) { emptyMsg(); return; }
    a.get_news_meta().then(function (m) {
      if (m && m.ok) { meta = { min: m.min, max: m.max }; setCurList(m.cur); drawChips(); }
      if (secs.length) { patchPending(); updateBadge(); return; }
      todayTarget().then(function (d) {
        if (meta.max && d > meta.max) d = meta.max;
        curDay = d; dateIn.value = d;
        resetWindowAt(d, true);
      });
    }).catch(function () { emptyMsg(); });
  }

  // chart needs the currency list too (filters) - fetch once, quietly
  function loadMetaForChart() {
    var a = api();
    if (!a || !a.get_news_meta) return;
    a.get_news_meta().then(function (m) { if (m && m.ok) { meta = { min: m.min, max: m.max }; setCurList(m.cur); redraw(); } }).catch(function () {});
  }
  function startChart() {
    loadSavedFilters().then(function (got) {
      if (got) { daysCache = null; if (inited) { drawChips(); if (tabActive) resetWindowAt(curDay || meta.max || isoOf(Date.now() / 1000), true); } }
      loadMetaForChart();
    });
  }
  if (window.pywebview && window.pywebview.api) startChart();
  else window.addEventListener("pywebviewready", startChart);

  document.addEventListener("App:timeOffsetChanged", redraw);

  // v119: replay playhead (broker time -> UTC); reveal Actuals as price reaches them.
  function rpUtc(t) {
    if (Math.abs(t - rpOffT) > 3600) { rpOffT = t; rpOff = App.Tz && App.Tz.brokerOffsetAtUtc ? App.Tz.brokerOffsetAtUtc(t) || 0 : 0; }
    return t - rpOff;
  }
  function rpRerender() {
    rpNext = Infinity; rpDirty = !(tabActive && inited && list);
    // v120: Replay start / exit -> show the replay day (or the live day) around the list.
    if (!rpDirty) todayTarget().then(function (d) {
      if (meta.max && d > meta.max) d = meta.max;
      curDay = d; if (dateIn) dateIn.value = d;
      resetWindowAt(d, true);
    });
  }
  function rpReveal() {
    rpNext = Infinity;
    if (!list) return;
    var els = list.querySelectorAll("b[data-rt]");
    for (var i = 0; i < els.length; i++) {
      var b = els[i], t = +b.getAttribute("data-rt");
      if (t <= rpNow) { b.textContent = b.getAttribute("data-ra"); b.className = "upd"; b.removeAttribute("data-rt"); b.removeAttribute("data-ra"); }
      else if (t < rpNext) rpNext = t;
    }
  }
  document.addEventListener("App:replayStarted", function (e) {
    var d = e.detail || {};
    rpNow = rpUtc(Number(d.at) || (Number(d.ts) || 0) + (Number(d.tf) || 1) - 1);
    rpRerender();
  });
  document.addEventListener("App:replayCandle", function (e) {
    if (rpNow === null || !e.detail) return;
    rpNow = rpUtc(Number(e.detail.time) || 0);
    if (rpNow >= rpNext) rpReveal();
  });
  document.addEventListener("App:replayExited", function () { if (rpNow === null) return; rpNow = null; rpRerender(); });

  App.News = {
    paint: paint,
    setTabActive: function (on) {
      tabActive = !!on; if (!on) { setExtHover(null); listHl(null); clearTimeout(pendTimer); pendTimer = 0; }
      if (on) { open(); if (rpDirty) rpRerender(); } else if (pop) closePop();
    },
    refreshChart: dropCaches,
    // v126: weekly auto-sync stored new weeks -> drop caches, re-read meta, reload the open list
    dataChanged: function () {
      dropCaches(); weekRows = {}; daysCache = null; loadMetaForChart();
      if (inited && tabActive) reloadWindow();
    },
  };
})();
