// =============================================================================
// trade-lines.js — V84: Fast Market Order + trade lines on the primary chart.
//   Middle-click  : arm. A solid SL line (with price label) follows the mouse,
//                   a solid TP line follows too (TP lock x distance entry->SL).
//                   SL below BID = LONG (entry rides ASK), above ASK = SHORT
//                   (entry rides BID), inside the spread = nothing.
//   Left-click    : send the market order with that SL/TP (lot from risk).
//   Right-click / Esc / middle-click again : cancel.
//   Open positions of this symbol are drawn as dashed Entry/SL/TP lines;
//   dragging SL or TP modifies the position in MT5 on release.
// V88: Shift+middle-click = pending order: 1st left-click locks the entry,
//   2nd places it (type LIMIT/STOP picked from entry vs price). Risk/reward
//   boxes (TradingView style) show while armed. Pending entry drag moves
//   SL/TP with it (same lots); SL drag re-sizes lots.
// V88: every line is mirrored on all multi-chart panels (same symbol); the
//   gestures and the risk/reward box work on whichever panel is under the mouse.
// Uses the series' native price lines (no extra canvas, no per-frame work
// when idle). Events are caught in the capture phase so the chart does not
// pan and the drawing tools do not react while a trade gesture is active.
// =============================================================================
(function () {
  "use strict";

  var App = window.App || {};
  var container = document.getElementById("chart-surface");
  if (!container || !window.LightweightCharts) return;

  var SOLID = 0, DOTTED = 1, DASHED = 2, HIT_PX = 6;
  var mode = "market", pendEntry = null; // V88
  var armed = false, mouseY = null, rafPending = false, tickTimer = null;
  var preview = { sl: null, tp: null, entry: null, series: null };
  var placed = {};         // req_id -> {lines:[...], series}
  var posLines = {};       // key ("p"/"o" + ticket) -> {entry, sl, tp, key, p}
  var linesSeries = null;
  var positions = [];
  var drag = null;         // {ticket, which, line, price}
  var swallow = false;     // eat the mouse events that follow a handled pointerdown
  var hoverHit = null;

  function T() { return App.Trade; }
  function cssVar(n, fb) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return v || fb;
  }
  function colors() { return { sl: cssVar("--down", "#ef5350"), tp: cssVar("--up", "#26a69a"), entry: cssVar("--muted", "#8b95a5"), be: cssVar("--gold", "#d4a017") }; }
  function digits() { var s = T() && T().specs(); return s ? s.digits : 5; }
  function fmt(p) { return Number(p).toFixed(digits()); }
  function bid() { return Number(App.livePrice); }
  function ask() { var a = Number(App.liveAsk), b = bid(); return isFinite(a) && a >= b ? a : b; }
  function series() { return App.series || null; }

  // ---- V88: panels + mirrored lines ----------------------------------------
  function panelList() {
    var ps = App.MultiPanel && App.MultiPanel.getPanels ? App.MultiPanel.getPanels() : null, out = [];
    (ps && ps.length ? ps : [{ isPrimary: true }]).forEach(function (p) {
      var s = p.isPrimary ? App.series : p.series;
      var el = p.isPrimary ? container : p.mount;
      if (s && el) out.push({ series: s, chart: p.isPrimary ? App.chart : p.chart, el: el });
    });
    return out;
  }
  var active = null; // panel under the mouse / where the gesture started
  function panelAt(e) {
    var ps = panelList();
    for (var i = 0; i < ps.length; i++) if (ps[i].el.contains(e.target)) return ps[i];
    return null;
  }
  // One logical line = one native price line per panel series.
  function VLine(o) { this.o = o; this.m = []; this.sync(); }
  VLine.prototype.sync = function () {
    var ss = panelList().map(function (p) { return p.series; }), self = this;
    this.m = this.m.filter(function (x) {
      if (ss.indexOf(x[0]) >= 0) return true;
      try { x[0].removePriceLine(x[1]); } catch (e) {}
      return false;
    });
    ss.forEach(function (s) {
      if (!self.m.some(function (x) { return x[0] === s; })) {
        try { self.m.push([s, s.createPriceLine(Object.assign({}, self.o))]); } catch (e) {}
      }
    });
  };
  VLine.prototype.applyOptions = function (patch) {
    Object.assign(this.o, patch);
    this.m.forEach(function (x) { try { x[1].applyOptions(patch); } catch (e) {} });
  };
  VLine.prototype.options = function () { return this.o; };
  VLine.prototype.remove = function () {
    this.m.forEach(function (x) { try { x[0].removePriceLine(x[1]); } catch (e) {} });
    this.m = [];
  };
  var allLines = [];
  function mkLine(price, color, style, title) {
    if (!series()) return null;
    var l = new VLine({ price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title || "" });
    allLines.push(l);
    return l;
  }
  function rmLine(l) { if (l) { l.remove(); var i = allLines.indexOf(l); if (i >= 0) allLines.splice(i, 1); } }
  // Panels open/close or get rebuilt: cheap 1 s check re-mirrors every line.
  var lastSig = "";
  setInterval(function () {
    var sig = panelList().length + ":" + (App.series ? 1 : 0);
    var ps = panelList();
    for (var i = 0; i < ps.length; i++) sig += ps[i].series ? "s" : "-";
    if (sig === lastSig && !allLines.some(function (l) { return l.m.length !== ps.length; })) return;
    lastSig = sig;
    allLines.forEach(function (l) { l.sync(); });
  }, 1000);

  function yToPrice(clientY, pnl) {
    pnl = pnl || active; if (!pnl) return null;
    var r = pnl.el.getBoundingClientRect();
    var p = pnl.series.coordinateToPrice(clientY - r.top);
    return p == null || !isFinite(p) ? null : p;
  }
  function inside(e) { return !!panelAt(e); }

  // ---- preview (armed) -----------------------------------------------------
  function compute(price) {
    var b = bid(), a = ask();
    if (!isFinite(b) || price == null) return null;
    var rr = Number(T().settings().rr) || 0;
    if (mode === "pending") {
      if (pendEntry == null) return { stage: "entry", entry: price, dir: null, sl: null, tp: null };
      var en = pendEntry;
      if (price === en) return { dir: null, entry: en, sl: price, tp: null };
      var buy = price < en, kind = buy ? (en < a ? "BUY LIMIT" : "BUY STOP") : (en > b ? "SELL LIMIT" : "SELL STOP");
      return { dir: buy ? "BUY" : "SELL", kind: kind, entry: en, sl: price, tp: rr > 0 ? en + (en - price) * rr : null };
    }
    if (price < b) { var e = a; return { dir: "BUY", entry: e, sl: price, tp: rr > 0 ? e + (e - price) * rr : null }; }
    if (price > a) { var e2 = b; return { dir: "SELL", entry: e2, sl: price, tp: rr > 0 ? e2 - (price - e2) * rr : null }; }
    return { dir: null, entry: null, sl: price, tp: null };
  }

  function drawPreview() {
    rafPending = false;
    if (!armed || mouseY == null) return;
    var c = compute(yToPrice(mouseY));
    if (!c) return;
    var col = colors(), s = series();
    preview.series = s;
    if (mode === "pending") {
      var et = c.stage === "entry" ? "ENTRY " + fmt(c.entry) : (c.kind || "ENTRY");
      if (!preview.entry) preview.entry = mkLine(c.entry, col.entry, SOLID, et); else preview.entry.applyOptions({ price: c.entry, title: et });
      if (c.stage === "entry") {
        if (preview.sl) { rmLine(preview.sl, preview.series); preview.sl = null; }
        if (preview.tp) { rmLine(preview.tp, preview.series); preview.tp = null; }
        drawBox(null); return;
      }
    }
    var title = "SL";
    if (c.dir) {
      var lc = T().calcLots(c.entry, c.sl);
      title = lc && lc.tooSmall ? "SL < min lot" : "SL"; // V88: short label (lot/risk shown in panel)
      T().setPreview(c.entry, c.sl);
    } else {
      title = "inside spread";
      T().setPreview(null, null);
    }
    var slOpts = { price: c.sl, color: c.dir ? col.sl : col.entry, title: title };
    if (!preview.sl) preview.sl = mkLine(c.sl, slOpts.color, SOLID, title); else preview.sl.applyOptions(slOpts);
    if (c.tp != null) {
      var tpOpts = { price: c.tp, color: col.tp, title: "TP " + T().settings().rr + "R" };
      if (!preview.tp) preview.tp = mkLine(c.tp, col.tp, SOLID, tpOpts.title); else preview.tp.applyOptions(tpOpts);
    } else if (preview.tp) { rmLine(preview.tp, preview.series); preview.tp = null; }
    drawBox(c.dir ? c : null);
  }
  // V88: risk (red) / reward (green) boxes: two absolutely placed divs,
  // repositioned only while armed (no canvas, nothing when idle).
  var boxes = []; // V88: one box per panel, spans the whole pane width
  function drawBox(c) {
    var ps = c ? panelList() : [];
    boxes = boxes.filter(function (bx) {
      var keep = ps.some(function (p) { return p.el === bx.host; });
      if (!keep) bx.el.remove();
      return keep;
    });
    if (!c) { boxes.forEach(function (bx) { bx.el.style.display = "none"; }); return; }
    ps.forEach(function (p) {
      var bx = boxes.filter(function (x) { return x.host === p.el; })[0];
      if (!bx) {
        var el = document.createElement("div"); el.className = "tl-box";
        el.innerHTML = '<div class="tl-box-r"></div><div class="tl-box-g"></div>';
        p.el.appendChild(el);
        bx = { host: p.el, el: el }; boxes.push(bx);
      }
      var s = p.series, yE = s.priceToCoordinate(c.entry), yS = s.priceToCoordinate(c.sl);
      var yT = c.tp != null ? s.priceToCoordinate(c.tp) : null;
      if (yE == null || yS == null) { bx.el.style.display = "none"; return; }
      var w = p.chart && p.chart.timeScale ? p.chart.timeScale().width() : p.el.clientWidth;
      bx.el.style.display = ""; bx.el.style.width = w + "px";
      var r = bx.el.firstChild, g = bx.el.lastChild;
      r.style.top = Math.min(yE, yS) + "px"; r.style.height = Math.abs(yS - yE) + "px";
      if (yT != null) { g.style.display = ""; g.style.top = Math.min(yE, yT) + "px"; g.style.height = Math.abs(yT - yE) + "px"; }
      else g.style.display = "none";
    });
  }
  function schedule() { if (!rafPending) { rafPending = true; requestAnimationFrame(drawPreview); } }
  function clearPreview() {
    rmLine(preview.sl, preview.series); rmLine(preview.tp, preview.series); rmLine(preview.entry, preview.series);
    preview.sl = preview.tp = preview.entry = null;
    drawBox(null);
  }

  function arm(e, pending) {
    if (App.replayActive) { T().toast("Trading is disabled in Bar Replay", "info"); return; }
    if (!T().specs()) { T().toast("Waiting for MT5 symbol data…", "info"); return; }
    if (!isFinite(bid())) { T().toast("No live price yet", "info"); return; }
    armed = true;
    mode = pending ? "pending" : "market"; pendEntry = null;
    mouseY = e.clientY;
    document.body.classList.add("tl-armed");
    tickTimer = setInterval(schedule, 100); // entry rides the live ASK/BID
    schedule();
  }
  function disarm() {
    armed = false; pendEntry = null;
    document.body.classList.remove("tl-armed");
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    clearPreview();
    T().setPreview(null, null);
  }

  function place(e) {
    if (mode === "pending" && pendEntry == null) { // V88: lock the entry first
      var pe = yToPrice(e.clientY); if (pe == null) return;
      var sp0 = T().specs(), ts0 = sp0 && sp0.tick_size > 0 ? sp0.tick_size : 0;
      pendEntry = ts0 ? Math.round(pe / ts0) * ts0 : pe;
      schedule(); return;
    }
    var c = compute(yToPrice(e.clientY));
    if (!c || !c.dir) { T().toast("Stop loss inside the spread: no trade", "info"); return; }
    var st = T().settings(), sp = T().specs();
    var lc = T().calcLots(c.entry, c.sl);
    if (!lc) { T().toast("Set a valid risk first", "err"); return; }
    if (lc.tooSmall) { T().toast("Risk too small: min lot " + sp.vol_min + " would risk " + lc.minRisk.toFixed(2), "err"); return; }
    var lim = T().maxRiskLimit();
    if (lim > 0 && sp) {
      if (sp.unbounded && sp.unbounded.length) { T().toast("Max risk: a position has no stop loss", "err"); return; }
      if ((Number(sp.open_risk) || 0) + lc.risk > lim + 1e-6) { T().toast("Max risk reached: trade blocked", "err"); return; }
    }
    var comm = parseFloat(String(st.commission).replace(",", "."));
    var pendingOrder = mode === "pending";
    var id = T().send(pendingOrder ? "trade_pending" : "trade_open", {
      symbol: App.symbol || undefined, sl: c.sl, entry: pendingOrder ? c.entry : undefined, risk_mode: st.riskMode, risk: st.risk,
      commission: isFinite(comm) && comm >= 0 ? comm : null, commission_mode: st.commMode || "lot", tp_rr: st.rr,
      max_risk_mode: st.maxMode, max_risk: st.maxRisk,
    }, pendingOrder ? "Pending order" : "Market order");
    disarm();
    if (!id) return;
    // Optimistic dashed lines until MT5 answers / the position shows up.
    var col = colors(), ls = [mkLine(c.sl, col.sl, DASHED, "SL (sending)")];
    if (pendingOrder) ls.push(mkLine(c.entry, col.entry, DASHED, "ENTRY (sending)"));
    if (c.tp != null) ls.push(mkLine(c.tp, col.tp, DASHED, "TP (sending)"));
    placed[id] = { lines: ls, series: series() };
  }

  // ---- open positions ------------------------------------------------------
  function clearPositionLines() {
    Object.keys(posLines).forEach(function (t) {
      var L = posLines[t]; rmLine(L.entry, linesSeries); rmLine(L.sl, linesSeries); rmLine(L.tp, linesSeries);
    });
    posLines = {};
  }
  // V86: TP label = reward/initial-risk multiple, e.g. "TP#2.54".
  var PT = { 2: "BUY LIMIT", 3: "SELL LIMIT", 4: "BUY STOP", 5: "SELL STOP" }; // V88
  function pkey(p) { return (p.kind === "pending" ? "o" : "p") + p.ticket; }
  function isBuyT(t) { return t % 2 === 0; }
  function tpTitle(p, tp) {
    var r0 = Number(p.r0) || 0;
    return r0 > 0 && tp > 0 ? "TP#" + (Math.abs(tp - p.price_open) / r0).toFixed(2) : "TP";
  }
  function renderPositions() {
    var s = series();
    if (!s || App.replayActive) { if (linesSeries) clearPositionLines(); return; }
    linesSeries = s; // V88: lines follow all panels on their own
    var col = colors(), seen = {};
    positions.forEach(function (p) {
      if (App.symbol && p.symbol !== App.symbol) return;
      var k = pkey(p);
      seen[k] = true;
      var L = posLines[k] || (posLines[k] = {});
      L.p = p;
      if (drag && drag.key === k) return;                    // user is moving it
      if (L.hold && Date.now() < L.hold) return;             // modify in flight
      var key = [p.type, p.volume, p.price_open, p.sl, p.tp, p.r0].join("|");
      if (key === L.key) return;
      L.key = key;
      var et = PT[p.type] || (p.type === 0 ? "BUY" : "SELL"); // V87: no lot size in label
      if (!L.entry) L.entry = mkLine(p.price_open, col.entry, DOTTED, et); else L.entry.applyOptions({ price: p.price_open, title: et });
      [["sl", col.sl, "SL"], ["tp", col.tp, tpTitle(p, p.tp)]].forEach(function (d) {
        var v = Number(p[d[0]]);
        if (v > 0) { if (!L[d[0]]) L[d[0]] = mkLine(v, d[1], DASHED, d[2]); else L[d[0]].applyOptions({ price: v, title: d[2] }); }
        else if (L[d[0]]) { rmLine(L[d[0]], linesSeries); L[d[0]] = null; }
      });
      L.titles = { entry: et, sl: "SL", tp: tpTitle(p, p.tp) };
      if (focusT != null) styleLines(k);
    });
    Object.keys(posLines).forEach(function (t) {
      if (!seen[t]) { var L = posLines[t]; rmLine(L.entry, linesSeries); rmLine(L.sl, linesSeries); rmLine(L.tp, linesSeries); delete posLines[t]; }
    });
  }

  // V87: panel hover focus. Other trades fade (alpha) and lose labels.
  var focusT = null;
  function fade(c) {
    var m = /^#([0-9a-f]{6})$/i.exec(c);
    if (!m) return c;
    var n = parseInt(m[1], 16);
    return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + ",0.22)";
  }
  function styleLines(t) {
    var L = posLines[t]; if (!L || !L.titles) return;
    var col = colors(), dim = focusT != null && t !== focusT;
    [["entry", col.entry], ["sl", col.sl], ["tp", col.tp]].forEach(function (d) {
      if (!L[d[0]]) return;
      L[d[0]].applyOptions({ color: dim ? fade(d[1]) : d[1], title: dim ? "" : L.titles[d[0]], axisLabelVisible: !dim });
    });
  }
  function setFocus(t) {
    t = t == null ? null : String(t);
    if (t === focusT) return;
    focusT = t;
    Object.keys(posLines).forEach(styleLines);
  }

  function hitTest(clientY) {
    var s = series(); if (!s) return null;
    var pnl = active; if (!pnl) return null;
    s = pnl.series;
    var y = clientY - pnl.el.getBoundingClientRect().top, best = null;
    Object.keys(posLines).forEach(function (t) {
      var L = posLines[t];
      (L.p && L.p.kind === "pending" ? ["entry", "sl", "tp"] : ["sl", "tp"]).forEach(function (w) {
        if (!L[w] || !L.p) return;
        var ly = s.priceToCoordinate(Number(L[w].options().price));
        if (ly == null) return;
        var d = Math.abs(ly - y);
        if (d <= HIT_PX && (!best || d < best.d)) best = { d: d, key: t, ticket: L.p.ticket, which: w, line: L[w] };
      });
    });
    return best;
  }

  function finishDrag() {
    var d = drag; drag = null;
    document.body.classList.remove("tl-hover");
    if (!d || d.price == null) return;
    var L = posLines[d.key];
    if (!L || !L.p) return;
    var p = L.p, isBuy = isBuyT(p.type), v = d.price;
    if (p.kind === "pending") return finishPendingDrag(d, L, p, isBuy, v);
    // Keep it sane before sending: SL/TP must sit on the correct side.
    var cur = isBuy ? bid() : ask();
    var bad = d.which === "sl" ? (isBuy ? v >= cur : v <= cur) : (isBuy ? v <= cur : v >= cur);
    if (bad) { T().toast((d.which === "sl" ? "SL" : "TP") + " on the wrong side of price", "err"); L.key = ""; renderPositions(); return; }
    var params = { ticket: d.ticket }; params[d.which] = v;
    L.hold = Date.now() + 10000;
    var id = T().send("trade_modify", params, "Modify " + d.which.toUpperCase());
    if (!id) { L.hold = 0; L.key = ""; renderPositions(); return; }
    L.req = id;
  }

  // V88: pending drag. Entry drag shifts SL/TP by the same distance (lots
  // unchanged); SL drag re-sizes lots from the current risk settings.
  function finishPendingDrag(d, L, p, isBuy, v) {
    var params = { ticket: p.ticket, pending: true }, en = Number(p.price_open);
    if (d.which === "entry") {
      var dl = v - en;
      params.price = v;
      if (p.sl) params.sl = Number(p.sl) + dl;
      if (p.tp) params.tp = Number(p.tp) + dl;
    } else if (d.which === "sl") {
      if (isBuy ? v >= en : v <= en) { T().toast("SL on the wrong side of entry", "err"); L.key = ""; renderPositions(); return; }
      var st = T().settings(), cm = parseFloat(String(st.commission).replace(",", "."));
      params.sl = v; params.resize = true; params.risk_mode = st.riskMode; params.risk = st.risk;
      params.commission = isFinite(cm) && cm >= 0 ? cm : null; params.commission_mode = st.commMode || "lot";
    } else {
      if (isBuy ? v <= en : v >= en) { T().toast("TP on the wrong side of entry", "err"); L.key = ""; renderPositions(); return; }
      params.tp = v;
    }
    L.hold = Date.now() + 10000;
    var id = T().send("trade_modify", params, "Modify order");
    if (!id) { L.hold = 0; L.key = ""; renderPositions(); return; }
    L.req = id;
  }

  // ---- event wiring (capture phase) ---------------------------------------
  window.addEventListener("pointerdown", function (e) {
    if (e.pointerType && e.pointerType !== "mouse") return;
    var pn = panelAt(e);
    if (!pn) { if (armed && e.button === 2) disarm(); return; }
    if (!armed || e.button === 1) active = pn; // V88: gesture stays on its panel
    var handled = false;
    if (e.button === 1) { if (armed) disarm(); else arm(e, e.shiftKey); handled = true; }
    else if (armed && e.button === 0) { place(e); handled = true; }
    else if (armed && e.button === 2) { disarm(); handled = true; }
    else if (e.button === 0 && !App.replayActive) {
      var h = hitTest(e.clientY);
      if (h) { drag = { key: h.key, ticket: h.ticket, which: h.which, line: h.line, price: null }; handled = true; }
    }
    if (handled) { swallow = true; e.stopPropagation(); }
  }, true);

  ["mousedown", "mouseup", "click", "auxclick", "dblclick"].forEach(function (n) {
    window.addEventListener(n, function (e) {
      if (!swallow && !(armed && inside(e))) return;
      if (n === "mousedown" && e.button === 1) e.preventDefault(); // no autoscroll
      e.stopPropagation();
      if (n === "click" || n === "auxclick" || n === "dblclick") swallow = false;
    }, true);
  });
  window.addEventListener("pointerup", function (e) {
    if (drag) { finishDrag(); e.stopPropagation(); }
    if (swallow) { e.stopPropagation(); setTimeout(function () { swallow = false; }, 0); }
  }, true);
  window.addEventListener("contextmenu", function (e) {
    if (swallow || armed) { e.preventDefault(); e.stopPropagation(); swallow = false; }
  }, true);

  window.addEventListener("pointermove", function (e) {
    if (armed) { var pa = panelAt(e); if (pa) active = pa; mouseY = e.clientY; schedule(); return; }
    if (drag) {
      var p = yToPrice(e.clientY);
      if (p != null) {
        var sp = T().specs(), ts = sp && sp.tick_size > 0 ? sp.tick_size : 0;
        if (ts) p = Math.round(p / ts) * ts;
        drag.price = p;
        var Ld = posLines[drag.key], Lp = Ld && Ld.p;
        if (drag.which === "entry" && Lp) { // V88: SL/TP ride along
          var dl = p - Number(Lp.price_open);
          drag.line.applyOptions({ price: p, title: (PT[Lp.type] || "ENTRY") + " " + fmt(p) });
          if (Ld.sl && Lp.sl) Ld.sl.applyOptions({ price: Number(Lp.sl) + dl });
          if (Ld.tp && Lp.tp) Ld.tp.applyOptions({ price: Number(Lp.tp) + dl });
        } else drag.line.applyOptions({ price: p, title: drag.which === "sl" ? "SL " + fmt(p) : (Lp ? tpTitle(Lp, p) : "TP") });
      }
      e.stopPropagation();
      return;
    }
    if (!inside(e) || e.buttons) { if (hoverHit) { hoverHit = null; document.body.classList.remove("tl-hover"); } return; }
    if (!Object.keys(posLines).length) return;
    active = panelAt(e) || active;
    var h = hitTest(e.clientY);
    if (!!h !== !!hoverHit) document.body.classList.toggle("tl-hover", !!h);
    hoverHit = h;
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (armed) { disarm(); e.stopPropagation(); }
    else if (drag) { var L = posLines[drag.key]; drag = null; if (L) { L.key = ""; renderPositions(); } }
  }, true);
  window.addEventListener("blur", function () { if (armed) disarm(); if (drag) { drag = null; renderPositions(); } });

  document.addEventListener("App:replayStarted", function () { if (armed) disarm(); clearPositionLines(); });
  document.addEventListener("App:replayExited", function () { renderPositions(); });

  // ---- feed callbacks ------------------------------------------------------
  function onResult(r) {
    var pl = placed[r.req_id];
    if (pl) {
      // On success keep the dashed lines a moment; the position feed (pushed
      // right after the trade) replaces them with the real ones.
      var kill = function () { pl.lines.forEach(function (l) { rmLine(l, pl.series); }); };
      if (r.ok) setTimeout(kill, 400); else kill();
      delete placed[r.req_id];
    }
    Object.keys(posLines).forEach(function (t) {
      var L = posLines[t];
      if (L.req && L.req === r.req_id) { L.req = null; L.hold = 0; L.key = ""; }
    });
    renderPositions();
  }

  App.TradeLines = {
    onPositions: function (list) { positions = list; renderPositions(); },
    onSpecs: function () { if (armed) schedule(); },
    onResult: onResult,
    isArmed: function () { return armed; },
    focus: setFocus,
  };
})();
