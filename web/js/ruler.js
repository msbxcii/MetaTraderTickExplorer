// V82: MT5-style Ruler. Shift+Left Click on any chart panel sets the anchor
// (v89: previewed on every multi-chart panel; disabled while drawing/editing an object);
// moving the mouse shows a line + label "time, points, %"; the next Left Click
// ends it. Drawn on one lightweight overlay canvas per ruler session (only
// repainted on mousemove), clicks are swallowed so drawing tools never react.
(function () {
  "use strict";
  var App = window.App;
  var r = null; // active ruler session
  var eatUntilClick = false; // swallow the rest of the start/end click

  function panelsList() {
    var list = [];
    if (App.chart && App.series && App.dom && App.dom.chartContainer) {
      list.push({ chart: App.chart, series: App.series, host: App.dom.chartContainer,
        tf: function () { return App.currentTf; },
        candles: function () { return App.candlesByTf[App.currentTf] || []; } });
    }
    var mp = App.MultiPanel && App.MultiPanel.getPanels ? App.MultiPanel.getPanels() : [];
    mp.forEach(function (p) {
      if (!p || p.isPrimary || !p.chart || !p.mount) return;
      list.push({ chart: p.chart, series: p.series, host: p.mount,
        tf: function () { return p.tf; }, candles: function () { return p.candles || []; } });
    });
    return list;
  }

  function panelAt(evt) {
    var list = panelsList();
    for (var i = 0; i < list.length; i++) {
      var h = list[i].host;
      if (!h.offsetParent) continue;
      var rc = h.getBoundingClientRect();
      var w = list[i].chart.priceScale("right").width();
      var th = list[i].chart.timeScale().height();
      if (evt.clientX >= rc.left && evt.clientX < rc.right - w &&
          evt.clientY >= rc.top && evt.clientY < rc.bottom - th) {
        return { panel: list[i], x: evt.clientX - rc.left, y: evt.clientY - rc.top };
      }
    }
    return null;
  }

  // x -> unix seconds, continuous (V82.1): fractional bar index from two bar
  // coordinates, interpolated inside the real gap to the next bar (same math
  // as free-crosshair.js), so the duration is second-accurate on any TF.
  // v89: timeAtXf keeps the fraction (used to mirror the point on the other
  // panels); timeAtX floors it exactly like before.
  function timeAtXf(panel, x) {
    var ts = panel.chart.timeScale();
    var c = panel.candles();
    var tf = Number(panel.tf()) || 60;
    var ref = ts.coordinateToLogical(x);
    if (ref === null || !isFinite(ref) || !c.length) return null;
    var x0 = ts.logicalToCoordinate(ref), x1 = ts.logicalToCoordinate(ref + 1);
    if (x0 === null || x1 === null || !(x1 - x0)) return null;
    var logical = ref + (x - x0) / (x1 - x0);
    var n = c.length, i = Math.floor(logical), f = logical - i;
    var t;
    if (i < 0) t = Number(c[0].time) + logical * tf;
    else if (i >= n - 1) t = Number(c[n - 1].time) + (logical - (n - 1)) * tf;
    else t = Number(c[i].time) + f * (Number(c[i + 1].time) - Number(c[i].time));
    return t;
  }
  function timeAtX(panel, x) {
    var t = timeAtXf(panel, x);
    return t === null ? null : Math.floor(t);
  }

  // v89: real time -> x on ANY panel (its own candles/timeframe), used to
  // project the ruler onto the other multi-chart panels.
  function timeToX(panel, time) {
    var c = panel.candles(), tf = Number(panel.tf()) || 60, n = c.length;
    if (!n || time === null) return null;
    var logical;
    if (n === 1 || time <= c[0].time) logical = (time - c[0].time) / tf;
    else if (time >= c[n - 1].time) logical = (n - 1) + (time - c[n - 1].time) / tf;
    else {
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (c[mid].time <= time) lo = mid; else hi = mid; }
      var span = c[hi].time - c[lo].time;
      logical = lo + (span > 0 ? (time - c[lo].time) / span : 0);
    }
    var ts = panel.chart.timeScale(), fl = Math.floor(logical);
    var xa = ts.logicalToCoordinate(fl);
    if (xa === null || xa === undefined) return null;
    if (logical === fl) return xa;
    var xb = ts.logicalToCoordinate(fl + 1);
    if (xb === null || xb === undefined) return null;
    return xa + (xb - xa) * (logical - fl);
  }

  function decimalsOf(panel, price) {
    var s;
    try { s = panel.series.priceFormatter().format(price); } catch (e) { s = String(price); }
    var d = s.indexOf(".");
    return d < 0 ? 0 : s.length - d - 1;
  }

  function fmtDuration(sec) {
    sec = Math.abs(Math.round(sec));
    var d = Math.floor(sec / 86400); sec -= d * 86400;
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return (d ? d + "d " : "") + p(h) + ":" + p(m) + ":" + p(s);
  }

  // V82.1: "+" precision cursor while the ruler is active (one CSS rule, so
  // the chart's own canvases cannot override it).
  var cursorStyle = document.createElement("style");
  cursorStyle.textContent = "html.ruler-active, html.ruler-active * { cursor: crosshair !important; }";
  document.head.appendChild(cursorStyle);

  // v89 Update 3: one overlay canvas per visible panel; the panel where the
  // ruler was started drives it, every other panel mirrors the same
  // (time, price) anchor/end point through its own time/price mapping.
  function makeView(p, origin) {
    var host = p.host;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    var cv = document.createElement("canvas");
    cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:6;";
    host.appendChild(cv);
    return { panel: p, cv: cv, origin: origin, dpr: 1 };
  }

  function start(hit) {
    document.documentElement.classList.add("ruler-active");
    var views = [];
    panelsList().forEach(function (p) {
      if (!p.host.offsetParent) return; // hidden / maximized-away panel
      views.push(makeView(p, p.host === hit.panel.host));
    });
    var ov = views.filter(function (v) { return v.origin; })[0];
    var price = ov.panel.series.coordinateToPrice(hit.y);
    r = { panel: ov.panel, views: views, price: price, time: timeAtX(ov.panel, hit.x), timeF: timeAtXf(ov.panel, hit.x),
      x: hit.x, last: null, raf: false };
    draw(hit.x, hit.y);
  }

  function resizeView(v) {
    var h = v.panel.host, dpr = window.devicePixelRatio || 1;
    v.cv.width = Math.round(h.clientWidth * dpr);
    v.cv.height = Math.round(h.clientHeight * dpr);
    v.cv.style.width = h.clientWidth + "px";
    v.cv.style.height = h.clientHeight + "px";
    v.dpr = dpr;
  }

  function stop() {
    document.documentElement.classList.remove("ruler-active");
    if (!r) return;
    r.views.forEach(function (v) { if (v.cv.parentNode) v.cv.parentNode.removeChild(v.cv); });
    r = null;
  }

  // Paints one view: anchor cross-lines, the ruler line and the label.
  // (ax, ay) = anchor in this view's pixels, (x, y) = end point.
  function paintView(v, ax, ay, x, y, text) {
    var p = v.panel, ctx = v.cv.getContext("2d");
    var W = p.host.clientWidth, H = p.host.clientHeight;
    var plotW = W - p.chart.priceScale("right").width();
    var plotH = H - p.chart.timeScale().height();
    if (v.cv.width !== Math.round(W * v.dpr) || v.cv.height !== Math.round(H * v.dpr)) resizeView(v);
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (ax === null || ay === null || x === null || y === null) return;
    var lo = p.chart.options().layout || {};
    var fs = Number(lo.fontSize) || 12;
    var ch = (p.chart.options().crosshair || {}).vertLine || {};
    var color = ch.color || lo.textColor || "#8b95a5";

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, plotW, plotH); ctx.clip(); // keep mirrored lines off the axes
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(ay) + 0.5); ctx.lineTo(plotW, Math.round(ay) + 0.5); // anchor h-line
    ctx.moveTo(Math.round(ax) + 0.5, 0); ctx.lineTo(Math.round(ax) + 0.5, plotH); // anchor v-line
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(x, y); ctx.stroke(); // ruler line
    ctx.restore();

    if (!text) return;
    ctx.font = fs + "px " + App.FONT_FAMILY;
    ctx.textBaseline = "top";
    var tw = ctx.measureText(text).width, pad = 4, bh = fs + 6;
    var cx = Math.max(0, Math.min(x, plotW - 1)), cy = Math.max(0, Math.min(y, plotH - 1));
    var lx = cx + 10, ly = cy + 10;
    if (lx + tw + pad * 2 > plotW) lx = cx - 10 - tw - pad * 2;
    if (ly + bh > plotH) ly = cy - 10 - bh;
    ctx.fillStyle = (lo.background && lo.background.color) || "#0a0e17";
    ctx.globalAlpha = 0.85;
    ctx.fillRect(lx, ly, tw + pad * 2, bh);
    ctx.globalAlpha = 1;
    ctx.fillStyle = lo.textColor || "#d1d4dc";
    ctx.fillText(text, lx + pad, ly + 3);
  }

  function draw(x, y) {
    var o = r.panel, ov = r.views.filter(function (v) { return v.origin; })[0];
    if (!ov) return;
    var W = o.host.clientWidth, H = o.host.clientHeight;
    var plotW = W - o.chart.priceScale("right").width();
    var plotH = H - o.chart.timeScale().height();
    x = Math.min(x, plotW - 1); y = Math.min(y, plotH - 1);

    var price = o.series.coordinateToPrice(y);
    var tF = timeAtXf(o, x);
    var t = tF === null ? null : Math.floor(tF);
    var text = null;
    if (price !== null && Number.isFinite(r.price)) {
      var dec = decimalsOf(o, r.price);
      var points = Math.round((price - r.price) * Math.pow(10, dec));
      var pct = r.price ? (price - r.price) / r.price * 100 : 0;
      var dur = (t !== null && r.time !== null) ? fmtDuration(t - r.time) : "--:--:--";
      text = dur + ",  " + (points > 0 ? "+" : "") + points + " pts,  " +
        (pct > 0 ? "+" : "") + pct.toFixed(2) + "%";
    }

    r.views.forEach(function (v) {
      if (v.origin) {
        // anchor re-projected each paint so it stays glued to its price
        paintView(v, anchorX(), o.series.priceToCoordinate(r.price), x, y, text);
      } else {
        var p = v.panel;
        paintView(v, timeToX(p, r.timeF), p.series.priceToCoordinate(r.price),
          timeToX(p, tF), price === null ? null : p.series.priceToCoordinate(price), text);
      }
    });
  }

  // V82.1 Fix: just return the stored x coordinate. Anchor stays pinned to
  // its time/price via those coordinates, which works correctly across
  // pan (changes relative x) and zoom (time-based). Simpler and more robust
  // than trying to reverse-engineer the coordinate from time via binary search.
  function anchorX() {
    return r.x !== null ? r.x : null;
  }

  function schedule(evt) {
    r.last = evt;
    if (r.raf) return;
    r.raf = true;
    window.requestAnimationFrame(function () {
      if (!r) return;
      r.raf = false;
      var rc = r.panel.host.getBoundingClientRect();
      draw(r.last.clientX - rc.left, r.last.clientY - rc.top);
    });
  }

  function swallow(e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }

  window.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) { if (r && e.button === 2) { swallow(e); stop(); } return; }
    if (r) { swallow(e); stop(); eatUntilClick = true; return; } // any left click ends the ruler
    if (!e.shiftKey) return;
    // v89 Update 4: while a drawing tool is armed, an object is being drawn
    // or its points are being edited, Shift+click belongs to the drawing
    // (Shift = lock price); the Ruler shortcut is disabled then.
    if (App.DrawingEngine && App.DrawingEngine.isDrawingBusy && App.DrawingEngine.isDrawingBusy(e)) return;
    var hit = panelAt(e);
    if (!hit) return;
    swallow(e);
    eatUntilClick = true;
    start(hit);
  }, true);
  // keep the chart/drawing tools from seeing the rest of the ruler clicks
  ["mousedown", "mouseup", "click", "pointerup"].forEach(function (t) {
    window.addEventListener(t, function (e) {
      if (e.button !== 0 || !eatUntilClick) return;
      swallow(e);
      if (t === "click") eatUntilClick = false;
    }, true);
  });
  window.addEventListener("pointermove", function (e) { if (r) schedule(e); }, true);
  window.addEventListener("wheel", function (e) { if (r) schedule(e); }, { capture: true, passive: true });
  window.addEventListener("keydown", function (e) { if (r && e.key === "Escape") stop(); }, true);
  document.addEventListener("App:replayStarted", stop);

  App.Ruler = { stop: stop, isActive: function () { return !!r; } };
})();
