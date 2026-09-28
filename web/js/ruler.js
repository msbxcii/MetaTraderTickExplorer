// V82: MT5-style Ruler. Shift+Left Click on any chart panel sets the anchor;
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
  function timeAtX(panel, x) {
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
    return Math.floor(t);
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

  function start(hit) {
    document.documentElement.classList.add("ruler-active");
    var host = hit.panel.host;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    var cv = document.createElement("canvas");
    cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:6;";
    host.appendChild(cv);
    var price = hit.panel.series.coordinateToPrice(hit.y);
    r = { panel: hit.panel, cv: cv, price: price, time: timeAtX(hit.panel, hit.x), x: hit.x,
      last: null, raf: false };
    resize();
    draw(hit.x, hit.y);
  }

  function resize() {
    var h = r.panel.host, dpr = window.devicePixelRatio || 1;
    r.cv.width = Math.round(h.clientWidth * dpr);
    r.cv.height = Math.round(h.clientHeight * dpr);
    r.cv.style.width = h.clientWidth + "px";
    r.cv.style.height = h.clientHeight + "px";
    r.dpr = dpr;
  }

  function stop() {
    document.documentElement.classList.remove("ruler-active");
    if (!r) return;
    if (r.cv.parentNode) r.cv.parentNode.removeChild(r.cv);
    r = null;
  }

  function draw(x, y) {
    var p = r.panel, ctx = r.cv.getContext("2d");
    var W = p.host.clientWidth, H = p.host.clientHeight;
    var plotW = W - p.chart.priceScale("right").width();
    var plotH = H - p.chart.timeScale().height();
    if (r.cv.width !== Math.round(W * r.dpr) || r.cv.height !== Math.round(H * r.dpr)) resize();
    ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // anchor re-projected each paint so it stays glued to its price/time
    var ax = anchorX(), ay = p.series.priceToCoordinate(r.price);
    if (ax === null || ay === null) return;
    x = Math.min(x, plotW - 1); y = Math.min(y, plotH - 1);
    var lo = p.chart.options().layout || {};
    var fs = Number(lo.fontSize) || 12;
    var ch = (p.chart.options().crosshair || {}).vertLine || {};
    var color = ch.color || lo.textColor || "#8b95a5";

    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(ay) + 0.5); ctx.lineTo(plotW, Math.round(ay) + 0.5); // anchor h-line
    ctx.moveTo(Math.round(ax) + 0.5, 0); ctx.lineTo(Math.round(ax) + 0.5, plotH); // anchor v-line
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(x, y); ctx.stroke(); // ruler line

    var price = p.series.coordinateToPrice(y);
    var t = timeAtX(p, x);
    if (price === null || !Number.isFinite(r.price)) return;
    var dec = decimalsOf(p, r.price);
    var points = Math.round((price - r.price) * Math.pow(10, dec));
    var pct = r.price ? (price - r.price) / r.price * 100 : 0;
    var dur = (t !== null && r.time !== null) ? fmtDuration(t - r.time) : "--:--:--";
    var text = dur + ",  " + (points > 0 ? "+" : "") + points + " pts,  " +
      (pct > 0 ? "+" : "") + pct.toFixed(2) + "%";

    ctx.font = fs + "px " + (lo.fontFamily || "-apple-system,BlinkMacSystemFont,'Trebuchet MS',Roboto,Ubuntu,sans-serif");
    ctx.textBaseline = "top";
    var tw = ctx.measureText(text).width, pad = 4, bh = fs + 6;
    var lx = x + 10, ly = y + 10;
    if (lx + tw + pad * 2 > plotW) lx = x - 10 - tw - pad * 2;
    if (ly + bh > plotH) ly = y - 10 - bh;
    ctx.fillStyle = (lo.background && lo.background.color) || "#0a0e17";
    ctx.globalAlpha = 0.85;
    ctx.fillRect(lx, ly, tw + pad * 2, bh);
    ctx.globalAlpha = 1;
    ctx.fillStyle = lo.textColor || "#d1d4dc";
    ctx.fillText(text, lx + pad, ly + 3);
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
