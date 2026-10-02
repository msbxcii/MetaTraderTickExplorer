// V81: "time to candle close" countdown under the live price label
// (TradingView / MT5 style), primary chart only.
//
// The clock is the BROKER's, not the PC's: every live-edge candle push carries
// the newest tick time (server_msc). Between ticks we extrapolate from that
// anchor with performance.now() (monotonic, immune to PC clock changes), but
// only for MAX_EXTRAPOLATE_MS. If no tick arrives for longer (internet/MT5
// dropped, market closed) or the backend reports offline/syncing, the counter
// freezes and resumes from the real broker time on the next tick.
// Cost: one tiny DOM node, one timer per second, repositioning only on events.
(function () {
  "use strict";
  var App = window.App;
  var MAX_EXTRAPOLATE_MS = 15000;

  var anchorMsc = null;   // broker time of newest tick
  var anchorPerf = 0;     // performance.now() when it arrived
  var shownMsc = null;    // last broker time displayed (keeps it monotonic)
  var timer = null;

  function frozen() {
    return App.backendStatus === "offline" || App.backendStatus === "syncing";
  }

  function brokerNow() {
    if (anchorMsc === null) return null;
    var elapsed = performance.now() - anchorPerf;
    if (frozen()) elapsed = 0;
    else if (elapsed > MAX_EXTRAPOLATE_MS) elapsed = MAX_EXTRAPOLATE_MS;
    var now = anchorMsc + elapsed;
    // A late tick must not make the counter jump backwards by a second or two.
    if (shownMsc !== null && now < shownMsc && shownMsc - now < 2000) now = shownMsc;
    return now;
  }

  function fmt(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    var mm = (m < 10 ? "0" : "") + m, ss = (s < 10 ? "0" : "") + s;
    return h > 0 ? (h < 10 ? "0" : "") + h + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  // V81.2: ONE label = price + countdown per chart panel, drawn by a series
  // primitive straight onto the library's price-axis canvas. It is painted in
  // the SAME frame as the price line, so the gap to the price can never jitter,
  // and it costs nothing between repaints (no DOM, no per-frame loop). The
  // library's own axis label of the live price line is hidden while ours is on.
  // Text is left-aligned like TradingView; no countdown on 1s/5s.
  var MIN_TF_FOR_COUNTDOWN = 15;
  var LEFT_PAD = 7;
  var prims = [];   // one per series

  function makePrimitive(getState) {
    var api = null;
    var view = {
      // V81.3: "normal" = above the axis tick numbers (so they never show
      // through) but below price-line labels (selected hline) and the
      // crosshair label, which the library paints later / on its top layer.
      zOrder: function () { return "normal"; },
      renderer: function () { return renderer; },
    };
    var renderer = {
      draw: function (target) {
        var st = getState();
        if (!st || !api) return;
        // live price read at paint time: always the same frame as the price line
        var price = st.getPrice();
        if (!Number.isFinite(price)) return;
        var priceText;
        try { priceText = api.series.priceFormatter().format(price); } catch (x) { priceText = String(price); }
        var y = api.series.priceToCoordinate(price);
        if (y === null) return;
        target.useMediaCoordinateSpace(function (sc) {
          var ctx = sc.context, w = sc.mediaSize.width;
          var lo = api.chart.options().layout || {};
          var fs = Number(lo.fontSize) || 12;
          var rowH = Math.round(fs * 1.5);
          var rows = st.time ? 2 : 1;
          var top = Math.round(y) - Math.round(rowH / 2);
          var theme = App.priceLineTheme || {};
          ctx.fillStyle = theme.color || "#8b95a5";
          ctx.fillRect(0, top, w, rowH * rows);
          ctx.fillStyle = theme.textColor || "#0a0e17";
          ctx.font = fs + "px " + App.FONT_FAMILY;
          ctx.textBaseline = "middle";
          ctx.textAlign = "left";
          ctx.fillText(priceText, LEFT_PAD, top + rowH / 2);
          if (st.time) {
            ctx.fillText(st.time, LEFT_PAD, top + rowH * 1.5);
          }
        });
      },
    };
    return {
      attached: function (p) { api = p; },
      detached: function () { api = null; },
      updateAllViews: function () {},
      priceAxisPaneViews: function () { return [view]; },
      requestUpdate: function () { if (api && api.requestUpdate) api.requestUpdate(); },
    };
  }

  function targets() {
    var list = [];
    if (App.chart && App.series) {
      list.push({ series: App.series, getPrice: function () { return App.livePrice; }, price: App.livePrice, tf: App.currentTf, line: App.livePriceLine });
    }
    var mp = App.MultiPanel && App.MultiPanel.getPanels ? App.MultiPanel.getPanels() : [];
    mp.forEach(function (p) {
      if (!p || p.isPrimary || !p.series) return;
      list.push({ series: p.series, getPrice: function () { return p.livePrice; }, price: p.livePrice, tf: p.tf, line: p.priceLine });
    });
    return list;
  }

  function setLibLabel(line, visible) {
    if (line && line.options().axisLabelVisible !== visible) line.applyOptions({ axisLabelVisible: visible });
  }

  function entryFor(series) {
    for (var i = 0; i < prims.length; i++) if (prims[i].series === series) return prims[i];
    var e = { series: series, state: null, key: "" };
    e.prim = makePrimitive(function () { return e.state; });
    try { series.attachPrimitive(e.prim); } catch (err) { return null; }
    prims.push(e);
    return e;
  }

  // Cheap: recomputes the text; asks for a repaint only if it changed.
  function update() {
    var list = targets();
    prims = prims.filter(function (e) {
      return list.some(function (t) { return t.series === e.series; });
    });
    var off = App.replayActive || anchorMsc === null;
    var now = off ? null : brokerNow();
    list.forEach(function (t) {
      var e = entryFor(t.series);
      if (!e) return;
      var state = null;
      if (!off && Number.isFinite(t.price) && t.tf) {
        var time = "";
        if (t.tf >= MIN_TF_FOR_COUNTDOWN) {
          var tfMs = t.tf * 1000;
          // Same bucketing as the backend aggregator: floor(time / tf).
          var closeMsc = Math.floor(now / tfMs) * tfMs + tfMs;
          time = fmt(Math.max(1, Math.ceil((closeMsc - now) / 1000)));
        }
        state = { getPrice: t.getPrice, time: time };
      }
      setLibLabel(t.line, !state);
      var key = state ? "on|" + state.time : "";
      e.state = state;
      if (key !== e.key) { e.key = key; e.prim.requestUpdate(); }
    });
  }

  function render() {
    if (anchorMsc !== null) shownMsc = brokerNow();
    update();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    var now = brokerNow();
    // Fire right after the next broker-second boundary.
    var delay = now === null ? 1000 : 1000 - (now % 1000) + 5;
    timer = setTimeout(function () { render(); schedule(); }, delay);
  }

  function onBrokerTime(serverMsc) {
    var t = Number(serverMsc);
    if (Number.isFinite(t) && t > 0 && (anchorMsc === null || t >= anchorMsc)) {
      anchorMsc = t;
      anchorPerf = performance.now();
      if (!timer) schedule();
    }
    render();
  }

  function bindRepositionEvents() {
    document.addEventListener("App:replayStarted", render);
    document.addEventListener("App:replayExited", render);
  }

  var bound = false;
  function init() {
    if (bound || !App.chart) return;
    bound = true;
    bindRepositionEvents();
  }
  // App.chart is created by ChartCore.init() (main.js); bind on first use too.
  document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 0); });

  App.CandleCountdown = {
    onBrokerTime: function (t) { init(); onBrokerTime(t); },
    refresh: render,
  };
})();
