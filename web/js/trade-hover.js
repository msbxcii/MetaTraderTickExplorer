// =============================================================================
// trade-hover.js — V91: hovering a History card draws that trade on every
// visible chart panel (primary + multi-chart companions); clicking it jumps
// all panels to the trade's mid-time (same path as Object Tree's Object jump).
// One light overlay canvas per panel, created on hover and removed on leave.
// While a trade is shown a rAF loop redraws only when its pixel geometry
// changed (pan/zoom/jump/live candle/resize/theme); nothing runs when idle.
// V91 Update 1: price labels = native axis price lines (same look/stacking as LIVE / open-trade
// labels, never hide each other); time labels = full-height axis pills, pushed apart when close.
// =============================================================================
(function () {
  "use strict";

  var App = window.App || {};
  var container = document.getElementById("chart-surface");
  if (!container) return;

  var cur = null;      // {t, net} currently shown
  var raf = 0;
  var views = [];      // {el, cv, ctx, C, p, sig, size, lines, lid}
  var curId = 0;       // bumps on every show() so native price lines rebuild once per trade

  // ---- panels ---------------------------------------------------------------
  function panelList() {
    var ps = App.MultiPanel && App.MultiPanel.getPanels ? App.MultiPanel.getPanels() : null, out = [];
    (ps && ps.length ? ps : [{ isPrimary: true }]).forEach(function (p) {
      var el = p.isPrimary ? container : p.mount;
      var chart = p.isPrimary ? App.chart : p.chart, series = p.isPrimary ? App.series : p.series;
      if (!el || !chart || !series || !el.clientWidth) return; // hidden / maximized-away panels skip
      var getTf = p.isPrimary ? function () { return App.currentTf; } : function () { return p.tf; };
      var getCandles = p.isPrimary
        ? function () { return App.currentTf !== null && App.candlesByTf ? App.candlesByTf[App.currentTf] : null; }
        : function () { return p.candles; };
      if (!getTf()) return;
      out.push({ el: el, chart: chart, series: series, getTf: getTf, getCandles: getCandles });
    });
    return out;
  }

  function viewFor(p) {
    for (var i = 0; i < views.length; i++) if (views[i].el === p.el) { views[i].p = p; return views[i]; }
    var cv = document.createElement("canvas");
    cv.className = "th-canvas";
    p.el.appendChild(cv);
    var v = {
      el: p.el, cv: cv, ctx: cv.getContext("2d"), p: p, sig: "", size: "", lines: [], lid: 0,
      C: App.Coords.createSurfaceCoords({
        getChart: function () { return v.p.chart; }, getSeries: function () { return v.p.series; },
        getTf: function () { return v.p.getTf(); }, getCandles: function () { return v.p.getCandles(); },
      }),
    };
    views.push(v);
    return v;
  }

  // Real time -> logical index, sub-candle precise (bar centre = integer, so a
  // bar's open time sits on its left edge, like a real time axis).
  function tLogical(arr, tf, t) {
    var n = arr.length;
    if (t <= arr[0].time) return (t - arr[0].time) / tf - 0.5;
    var last = arr[n - 1].time;
    if (t >= last) return (n - 1) + (t - last) / tf - 0.5;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (arr[m].time <= t) lo = m; else hi = m; }
    return lo + Math.min((t - arr[lo].time) / tf, 1) - 0.5;
  }

  function fmtT(t) { return new Date(t * 1000).toISOString().substr(11, 8); } // broker time, UTC getters

  // ---- drawing (follows history.html) ---------------------------------------
  function killLines(v) {
    v.lines.forEach(function (x) { try { x[0].removePriceLine(x[1]); } catch (e) { /* series gone */ } });
    v.lines = []; v.lid = 0;
  }
  // Entry/exit price labels are native price lines (label only): identical size/font to the
  // LIVE label and the library itself keeps close labels apart instead of hiding one.
  function ensureLines(v, c) {
    if (v.lid === curId && v.lines.length) return;
    killLines(v);
    var fg = "#ffffff";
    [cur.t.ep, cur.t.xp].forEach(function (price) {
      try {
        v.lines.push([v.p.series, v.p.series.createPriceLine({
          price: price, color: c, lineVisible: false, lineWidth: 1, lineStyle: 0,
          axisLabelVisible: true, axisLabelColor: c, axisLabelTextColor: fg, title: "",
        })]);
      } catch (e) { /* ignore */ }
    });
    v.lid = curId;
  }

  // Time labels: full-height axis pills; overlapping ones are pushed apart (left/right), not stacked over.
  function timeTags(ctx, items, pw, top, h, bg, fg) {
    var GAP = 2, boxes = items.map(function (it) {
      var w = Math.ceil(ctx.measureText(it.txt).width) + 16;
      return { txt: it.txt, w: w, l: it.x - w / 2 };
    }).sort(function (a, b) { return a.l - b.l; });
    var i;
    for (i = 0; i < boxes.length; i++) {
      if (boxes[i].l < 0) boxes[i].l = 0;
      if (i && boxes[i].l < boxes[i - 1].l + boxes[i - 1].w + GAP) boxes[i].l = boxes[i - 1].l + boxes[i - 1].w + GAP;
    }
    var last = boxes[boxes.length - 1];
    if (last && last.l + last.w > pw) {
      last.l = pw - last.w;
      for (i = boxes.length - 2; i >= 0; i--) if (boxes[i].l + boxes[i].w + GAP > boxes[i + 1].l) boxes[i].l = boxes[i + 1].l - boxes[i].w - GAP;
    }
    ctx.fillStyle = bg;
    boxes.forEach(function (b) { ctx.fillRect(b.l, top, b.w, h); });
    ctx.fillStyle = fg; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    boxes.forEach(function (b) { ctx.fillText(b.txt, b.l + b.w / 2, top + h / 2 + 0.5); });
  }

  function renderView(v) {
    var p = v.p, t = cur.t, arr = p.getCandles(), tf = p.getTf();
    var ctx = v.ctx, cv = v.cv, W = v.el.clientWidth, H = v.el.clientHeight;
    var hide = function () { if (v.lines.length) killLines(v); if (v.sig !== "h") { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); v.sig = "h"; } };
    if (!arr || !arr.length || !tf) return hide();
    var x1 = v.C.logicalToX(tLogical(arr, tf, t.et)), x2 = v.C.logicalToX(tLogical(arr, tf, t.xt));
    var y1 = v.C.priceToY(t.ep), y2 = v.C.priceToY(t.xp);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return hide();
    var pw, ph;
    try { var s = p.chart.paneSize(0); pw = s.width; ph = s.height; }
    catch (e) { pw = p.chart.timeScale().width(); ph = H - p.chart.timeScale().height(); }
    if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > pw || Math.max(y1, y2) < 0 || Math.min(y1, y2) > ph) return hide(); // not in view
    var dpr = window.devicePixelRatio || 1, cs = getComputedStyle(document.body);
    var up = cs.getPropertyValue("--up").trim() || "#3fb68b", dn = cs.getPropertyValue("--down").trim() || "#e5484d";
    var c0 = cur.net >= 0 ? up : dn;
    ensureLines(v, c0);
    var sig = [x1, x2, y1, y2, pw, ph, W, H, dpr, curId].map(function (n) { return Math.round(n * 10); }).join(",") + up + dn;
    if (sig === v.sig) return;
    v.sig = sig;
    var size = W + "x" + H + "@" + dpr;
    if (size !== v.size) { v.size = size; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + "px"; cv.style.height = H + "px"; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var c = cur.net >= 0 ? up : dn;
    var L = Math.min(x1, x2), R = Math.max(x1, x2), T = Math.min(y1, y2), B = Math.max(y1, y2);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // guide lines (entry/exit price = horizontal, entry/exit time = vertical)
    ctx.setLineDash([3, 3]); ctx.strokeStyle = c; ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y1); ctx.lineTo(pw, y1); ctx.moveTo(0, y2); ctx.lineTo(pw, y2);
    ctx.moveTo(x1, 0); ctx.lineTo(x1, ph); ctx.moveTo(x2, 0); ctx.lineTo(x2, ph);
    ctx.stroke();
    ctx.globalAlpha = 1; ctx.setLineDash([]);
    // box: green = profit, red = loss
    ctx.fillStyle = c; ctx.globalAlpha = 0.16; ctx.fillRect(L, T, R - L, Math.max(B - T, 1)); ctx.globalAlpha = 1;
    ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.strokeRect(L, T, R - L, Math.max(B - T, 1));
    // corners: entry = solid, exit = ring with white fill
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x1, y1, 4, 0, 7); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(x2, y2, 4, 0, 7); ctx.fill();
    ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    // time axis labels (price labels are the native price lines above)
    ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
    var items = [];
    if (x1 >= 0 && x1 <= pw) items.push({ x: x1, txt: fmtT(t.et) });
    if (x2 >= 0 && x2 <= pw) items.push({ x: x2, txt: fmtT(t.xt) });
    if (items.length) timeTags(ctx, items, pw, ph, Math.max(H - ph, 16), c, "#ffffff");
  }

  function frame() {
    raf = 0;
    if (!cur) return;
    var ps = panelList();
    views = views.filter(function (v) {
      var keep = ps.some(function (p) { return p.el === v.el; });
      if (!keep) { killLines(v); v.cv.remove(); }
      return keep;
    });
    ps.forEach(function (p) { renderView(viewFor(p)); });
    raf = requestAnimationFrame(frame);
  }

  // ---- public ---------------------------------------------------------------
  function show(t, net) {
    // Only a trade of the chart's own symbol can be drawn (prices must match).
    if (!t || !t.time_open || !t.time_close || (App.symbol && t.symbol && t.symbol !== App.symbol)) { hide(); return; }
    cur = { t: { et: Number(t.time_open), xt: Number(t.time_close), ep: Number(t.price_open), xp: Number(t.price_close), digits: t.digits }, net: Number(net) || 0 };
    curId++;
    views.forEach(function (v) { v.sig = ""; });
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function hide() {
    cur = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    views.forEach(function (v) { killLines(v); v.cv.remove(); });
    views = [];
  }
  // Same jump path as Object Tree rows: primary via JumpTime, companions via MultiPanel.
  function jump(t) {
    if (!t) return;
    if (App.symbol && t.symbol && t.symbol !== App.symbol) {
      if (App.Trade && App.Trade.toast) App.Trade.toast("This trade is on " + t.symbol + ", not the chart symbol", "info");
      return;
    }
    var a = Number(t.time_open) || 0, b = Number(t.time_close) || 0;
    if (!a && !b) return;
    var mid = a && b ? Math.floor((a + b) / 2) : (a || b);
    if (App.JumpTime && App.JumpTime.jumpToTimestamp) {
      App.JumpTime.jumpToTimestamp(mid).then(function (ok) {
        if (!ok && App.DrawingEngine && App.DrawingEngine.showHint) App.DrawingEngine.showHint("Can't jump — outside the available data range");
      });
    }
    if (App.MultiPanel && App.MultiPanel.jumpAllToTimestamp) App.MultiPanel.jumpAllToTimestamp(mid);
  }

  App.TradeHover = { show: show, hide: hide, jump: jump };
})();
