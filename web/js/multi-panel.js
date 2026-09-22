// =============================================================================
// multi-panel.js — v37: side-by-side multi-timeframe chart panels for the
// SAME symbol. v42: companion normal-mode navigation now uses the same
// bounded two-slot Sliding Window as Replay. v38: panels are fully independent
// (no crosshair/range sync —
// see below) and every panel is a full drawing surface of its own.
//
// Scope: panel 1 stays exactly what it always was (full Sliding-Window
// history, drawing tools, Object Tree, Auto Fit, live-tick merge — see
// chart-core.js). Companion panels 2 and 3 get their own timeframe picker,
// their own Lightweight Charts instance and candlestick series, enough
// history/live-tick plumbing to stay current, AND (v38) their own full
// drawing-tool overlay — see App.DrawingEngine.createPanelSurface(). That
// keeps the already-intricate primary-chart code in chart-core.js completely
// untouched (this file only *reads* App.chart/App.series/App.currentTf; it
// never writes them), while still giving every panel a real, independently
// selectable timeframe and full parity for drawing objects.
//
// v38 — independence (اصلاحیه 2): earlier versions of this file synced every
// panel's crosshair position and visible time range to whichever panel the
// user was interacting with (TradingView-style "linked" panes). That has
// been removed on purpose: each panel now keeps its own crosshair, its own
// pan/zoom, and its own timeframe, completely independent of the others —
// there is no cross-panel broadcasting left at all. Lightweight Charts
// already gives each chart instance its own crosshair and time scale by
// default, so independence needs no code here beyond simply not wiring a
// sync between them.
//
// v38 — global objects (اصلاحیه 3): every panel (primary and companions
// alike) is now a full "drawing surface" (see drawing-engine.js). Draw
// objects are stored once, globally, as real {time, price} points — never
// per-panel pixel coordinates — so an object created on ANY panel is simply
// re-rendered by every other panel's own render loop using that panel's own
// chart mapping. That is what makes an object drawn on a 15s companion panel
// also show up correctly on the primary panel's 1s view, and vice versa,
// exactly like objects already carried over across a timeframe switch on a
// single chart.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;

  var LAYOUT_ICONS = {
    1: '<svg viewBox="0 0 16 12" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="0.5" width="15" height="11" rx="1.5" stroke="currentColor"/></svg>',
    2: '<svg viewBox="0 0 16 12" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="0.5" width="15" height="11" rx="1.5" stroke="currentColor"/><line x1="8" y1="0.5" x2="8" y2="11.5" stroke="currentColor"/></svg>',
    3: '<svg viewBox="0 0 16 12" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="0.5" width="15" height="11" rx="1.5" stroke="currentColor"/><line x1="5.67" y1="0.5" x2="5.67" y2="11.5" stroke="currentColor"/><line x1="10.34" y1="0.5" x2="10.34" y2="11.5" stroke="currentColor"/></svg>',
  };

  var layout = 1;                 // 1, 2, or 3 panels visible
  var panels = [];                // panels[0] = primary (always present)
  var panelsRow = null;
  var maximizedPanel = null;      // v39: the one panel shown while the rest
                                   // of the multi-chart is temporarily hidden
                                   // — see the Maximize/Restore section below.

  // ---- v56: shared anchor-shift/preserve-range helpers (companion panels) --
  // v55.4 fixed a one-candle rollover Flicker/AutoShift jump for the primary
  // chart (see chart-core.js's setActiveChartData()/preserveLogicalRange()):
  // series.setData() can let Lightweight Charts internally re-anchor the
  // visible logical range, and restoring the intended range with a second
  // public setVisibleLogicalRange() call can expose that intermediate frame.
  // Companion panels 2/3 never received the same treatment - loadCompanion-
  // Partition() only applied it while an actual mouse drag was in progress,
  // and feedLiveCandles()'s live-tail rollover branch used the plain public
  // call unconditionally. That is the "sometimes jumps back to Live while
  // walking a companion panel toward its oldest partition" bug: exactly the
  // same root cause the primary chart already had, just not patched here.
  // These two helpers port the exact primary-chart fix to any panel.
  function applyPanelDragAnchorShift(panel, shift) {
    var ts = panel.chart.timeScale();
    if (!ts.ia) return false;
    ts.ia.lc = ts.ia.Oc() + shift;
    if (ts.ia.nc) ts.ia.nc.Oc += shift;
    ts.ia.Xu = true;
    if (ts.ia.sn && typeof ts.ia.sn.zc === "function") ts.ia.sn.zc();
    if (ts.ia.sn && typeof ts.ia.sn.mr === "function") ts.ia.sn.mr();
    return true;
  }

  // Restore `target` {from, to} as the panel's visible logical range after a
  // setData() call, preferring a direct anchor correction over a second
  // public range update (see chart-core.js's preserveLogicalRange() for the
  // primary-chart original of this exact function).
  function preservePanelLogicalRange(panel, target) {
    var current = panel.chart.timeScale().getVisibleLogicalRange();
    if (!current ||
        (Math.abs(current.from - target.from) < 1e-9 && Math.abs(current.to - target.to) < 1e-9)) {
      return true;
    }
    var correction = target.from - current.from;
    if (applyPanelDragAnchorShift(panel, correction)) return true;
    try {
      panel.chart.timeScale().setVisibleLogicalRange(target);
      return true;
    } catch (_) {
      return false;
    }
  }

  // v38: kept identical to chart-core.js's formatTfLabel (see its comment
  // there) so the primary chart and every companion panel render the same
  // "1m"/"5m"/"15m"/"1h" style labels for the new minute/hour timeframes,
  // and the same plain "Ns" labels for the sub-minute ones as before.
  function formatTfLabel(tf) {
    if (tf % 3600 === 0) return (tf / 3600) + "h";
    if (tf % 60 === 0) return (tf / 60) + "m";
    return tf + "s";
  }

  // ---- panel abstraction ---------------------------------------------------
  // panels[0] wraps the pre-existing primary chart/series (owned by
  // chart-core.js) so layout/timeframe code can treat all panels uniformly.
  // Its drawing surface is created separately, by chart-core.js calling
  // App.DrawingEngine.init() — this file never touches the primary panel's
  // overlay canvas.

  function makePrimaryPanel() {
    // The wheel-always-zooms / never-pans guarantee applies to the primary
    // chart too — set explicitly rather than relying on whatever chart-
    // core.js's own createChart() options happened to default to, so
    // behavior is identical and deliberate on every panel.
    App.chart.applyOptions({
      handleScroll: { mouseWheel: false },
      handleScale: { mouseWheel: true },
    });
    return {
      index: 1,
      isPrimary: true,
      chart: App.chart,
      series: App.series,
      container: document.getElementById("chart-panel-1"),
      getTf: function () { return App.currentTf; },
      getCandles: function () { return App.candlesByTf[App.currentTf] || []; },
    };
  }

  function pickDefaultTf(forIndex) {
    var tfs = App.TIMEFRAMES || [];
    if (!tfs.length) return App.currentTf;
    var wantIdx = Math.min(forIndex - 1, tfs.length - 1);
    return tfs[wantIdx];
  }

  function createCompanionPanel(index) {
    var container = document.createElement("div");
    container.className = "chart-panel chart-panel-companion";
    container.id = "chart-panel-" + index;

    var header = document.createElement("div");
    header.className = "chart-panel-header";

    var tfWrap = document.createElement("div");
    tfWrap.className = "tf-dropdown mini";
    var tfBtn = document.createElement("button");
    tfBtn.type = "button";
    tfBtn.className = "tf-dropdown-btn";
    var tfLabel = document.createElement("span");
    tfLabel.textContent = "—";
    var caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▼";
    tfBtn.appendChild(tfLabel);
    tfBtn.appendChild(caret);
    var tfList = document.createElement("div");
    tfList.className = "tf-dropdown-list";
    tfWrap.appendChild(tfBtn);
    tfWrap.appendChild(tfList);
    header.appendChild(tfWrap);

    var mount = document.createElement("div");
    mount.className = "chart-panel-mount";

    container.appendChild(header);
    container.appendChild(mount);
    panelsRow.appendChild(container);

    // v39: double-click this panel's chart area to maximize it (see the
    // Maximize/Restore section below) — attached to `mount` specifically,
    // not the whole `container`, so double-clicking the mini timeframe
    // picker in `header` never triggers it.
    // Also excludes the price axis itself: double-clicking the right-hand
    // price scale is lightweight-charts' own gesture for toggling Auto
    // Scale, so if the click lands inside that strip we let it through
    // instead of maximizing on top of it.
    mount.addEventListener("dblclick", function (e) {
      var rect = mount.getBoundingClientRect();
      var priceScaleWidth = chart.priceScale("right").width();
      if (e.clientX >= rect.right - priceScaleWidth) return;
      toggleMaximize(panel);
    });

    var chart = LightweightCharts.createChart(mount, {
      layout: {
        background: { type: "solid", color: "#0a0e17" },
        textColor: "#8b95a5",
        // v56.5 Update 2: same attribution-logo removal as the primary
        // chart (chart-core.js's createChart()) — no bottom-left logo on
        // companion panels 2/3 either.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#161c27" },
        horzLines: { color: "#161c27" },
      },
      rightPriceScale: { borderColor: "#1e2531" },
      timeScale: {
        borderColor: "#1e2531",
        timeVisible: true,
        secondsVisible: true,
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      // Wheel must only ever zoom, exactly like the primary chart.
      handleScroll: { mouseWheel: false },
      handleScale: { mouseWheel: true },
    });

    var series = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: "#3fb68b",
      downColor: "#e5484d",
      borderUpColor: "#3fb68b",
      borderDownColor: "#e5484d",
      wickUpColor: "#3fb68b",
      wickDownColor: "#e5484d",
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // v38: this companion's own drawing overlay — a full surface, on par
    // with the primary chart's. Sits inside `mount` (position:relative),
    // stacked above the chart's own canvas exactly like #draw-canvas does
    // for the primary panel.
    var drawCanvas = document.createElement("canvas");
    drawCanvas.className = "chart-panel-draw-canvas";
    mount.appendChild(drawCanvas);

    var panel = {
      index: index,
      isPrimary: false,
      chart: chart,
      series: series,
      candles: [],
      tf: null,
      container: container,
      mount: mount,
      requestGeneration: 0,
      priceLine: null,
      askLine: null,        // V64: live ASK line (no axis label), see setPanelAskLine()
      livePrice: null,
      // v41: companion panels get their own two-slot Sliding Window while
      // Replay is active. This keeps panels 2/3 bounded independently from
      // the primary panel and preserves their own pan/zoom position.
      window: null,
      loadingDirection: null,
      isPointerDown: false,
      edgeLoadArmed: { older: true, newer: true },
      replayCutoff: null,
      getTf: function () { return panel.tf; },
      getCandles: function () { return panel.candles; },
    };

    // v50.3 Update 1: if the user already customized the Canvas tab this
    // session, apply those settings immediately so a newly-opened panel 2
    // or 3 never briefly shows the factory theme — every future change
    // stays in sync via canvas-settings.js's applyAll(), which broadcasts
    // to every panel in App.MultiPanel.getPanels().
    if (App.CanvasSettings && App.CanvasSettings.applyToPanel) {
      App.CanvasSettings.applyToPanel(panel);
    }

    var drawSurface = App.DrawingEngine.createPanelSurface({
      chart: chart,
      series: series,
      canvas: drawCanvas,
      container: mount,
      getTf: panel.getTf,
      getCandles: panel.getCandles,
    });
    panel.drawSurface = drawSurface;

    // v56.5 Update 1: same "A" (Auto Fit) toggle button as the primary
    // chart (see chart-core.js's initAutoFitButton()/setAutoFit()/
    // syncAutoFitButton()), ported per-panel here. Each companion panel
    // gets its own button, its own `autoFitEnabled` flag and its own
    // right price scale — clicking one panel's button, or manually
    // dragging one panel's price axis, never touches any other panel's
    // Auto Fit state. The interaction logic (click toggles it back on;
    // any pointer drag or the axis double-click-reset can turn it off
    // from inside the charting library, so pointermove/pointerup/dblclick
    // just re-sync the button afterward) is identical to the primary
    // chart's, just scoped to `panel` instead of the single global App.*
    // fields chart-core.js uses.
    initPanelAutoFit(panel);

    var resizeObserver = new ResizeObserver(function (entries) {
      var rect = entries[0].contentRect;
      // v65.5 Update 1: maximize/restore/layout changes already resized this
      // panel synchronously (resyncPanelSize()), and the observer then fires
      // with those exact same numbers one frame later - skip that duplicate
      // resize + canvas clear + repaint instead of paying for it twice.
      var w = Math.round(rect.width);
      var h = Math.round(rect.height);
      if (mount._appliedChartW === w && mount._appliedChartH === h) return;
      markSizeApplied(mount, w, h);
      chart.resize(rect.width, rect.height);
      drawSurface.resize(rect.width, rect.height);
      if (App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
    });
    resizeObserver.observe(mount);
    panel.resizeObserver = resizeObserver;

    function onWindowPointerUp() { panel.isPointerDown = false; }
    mount.addEventListener("pointerdown", function () { panel.isPointerDown = true; });
    // v56.3: captured (rather than anonymous) so destroyCompanionPanel() can
    // remove these - window-level listeners never get garbage-collected on
    // their own just because `mount`/`container` were removed from the DOM,
    // and each one's closure keeps this whole `panel` object (and, through
    // it, `panel.candles`/`panel.window`) alive for as long as the app runs.
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerUp);
    panel._onWindowPointerUp = onWindowPointerUp;

    // v42: companion charts use the same edge-triggered, timestamp-based
    // Sliding Window in BOTH normal and Replay modes. The primary chart
    // keeps its existing chart-core.js implementation untouched.
    chart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
      // v41 perf: this companion's overlay must repaint on every range
      // change too (pan/zoom on THIS panel), independent of whether Replay
      // is active - the early return below is only about the Sliding
      // Window edge-load logic, not the overlay repaint.
      if (App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
      if (!range || panel.tf === null || !panel.window) return;
      var arr = panel.candles || [];
      var atLeft = range.from < App.LAZY_LOAD_EDGE_BARS;
      var atRight = range.to > (arr.length - 1 - App.LAZY_LOAD_EDGE_BARS);

      if (!atLeft) panel.edgeLoadArmed.older = true;
      if (!atRight) panel.edgeLoadArmed.newer = true;
      if (panel.loadingDirection) return;

      // v42: the right edge is terminal when the resident newer slot is
      // already the real-live slot (normal mode) or the Replay edge (Replay).
      // This mirrors chart-core.js/loadPartition() without touching Chart 1.
      if (atLeft && panel.edgeLoadArmed.older && !panel.window.exhaustedOlder) {
        panel.edgeLoadArmed.older = false;
        if (App.replayActive) {
          loadCompanionReplayPartition(panel, "older");
        } else {
          loadCompanionPartition(panel, "older");
        }
      } else if (atRight && panel.edgeLoadArmed.newer && !panel.window.rightIsLive && !panel.window.rightIsReplay) {
        panel.edgeLoadArmed.newer = false;
        if (App.replayActive) {
          loadCompanionReplayPartition(panel, "newer");
        } else {
          loadCompanionPartition(panel, "newer");
        }
      }
    });

    function closeList() { tfWrap.classList.remove("open"); }
    function openList() { tfWrap.classList.add("open"); }
    tfBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (tfWrap.classList.contains("open")) closeList(); else openList();
    });
    // v57 Update 11 (memory leak fix): this document-level listener was the
    // one destroyCompanionPanel() below never removed. v56.3/v56.5 carefully
    // tore down the ResizeObserver, the window pointer listeners and the
    // Auto Fit document listeners for exactly this reason - a document/window
    // listener's closure keeps `tfWrap` alive, and through it this panel's
    // whole container/chart DOM subtree, so nothing the rest of that teardown
    // released could actually be reclaimed. Turning Multi Chart on and off
    // repeatedly therefore still grew RAM by one full companion panel each
    // time. Captured on the panel so it can be removed with the others.
    function onDocumentClickCloseList(e) {
      if (!tfWrap.contains(e.target)) closeList();
    }
    document.addEventListener("click", onDocumentClickCloseList);
    panel._onDocumentClickCloseList = onDocumentClickCloseList;

    function buildTfList() {
      tfList.innerHTML = "";
      (App.TIMEFRAMES || []).forEach(function (tf) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = formatTfLabel(tf);
        btn.dataset.tf = tf;
        btn.addEventListener("click", function () {
          closeList();
          setCompanionTf(panel, tf);
        });
        tfList.appendChild(btn);
      });
      updateTfUI();
    }

    function updateTfUI() {
      tfLabel.textContent = panel.tf === null ? "—" : formatTfLabel(panel.tf);
      Array.prototype.forEach.call(tfList.children, function (btn) {
        btn.classList.toggle("active", Number(btn.dataset.tf) === panel.tf);
      });
    }
    panel.updateTfUI = updateTfUI;
    panel.buildTfList = buildTfList;

    // App.TIMEFRAMES is filled asynchronously (get_config()) and may not be
    // populated yet the moment a panel is first created. Poll briefly
    // rather than requiring callers to sequence around that.
    var attempts = 0;
    (function waitForTimeframes() {
      if (App.TIMEFRAMES && App.TIMEFRAMES.length) {
        buildTfList();
        setCompanionTf(panel, pickDefaultTf(index));
        return;
      }
      if (++attempts > 100) return; // ~15s: give up quietly, dropdown stays empty
      setTimeout(waitForTimeframes, 150);
    })();

    return panel;
  }

  // ---- v39: live price line, one per companion panel ------------------------
  // Same design as chart-core.js's initLivePriceLine()/updateLivePriceLine()
  // for the primary panel: a standalone PriceLine driven by the actual live
  // tick price, independent of which historical partition the candle series
  // happens to be showing, so panning into old history never changes what
  // the dashed line means. ensurePanelPriceLineFallback() mirrors chart-
  // core.js's ensureLivePriceFallback() — a startup-only fallback (last
  // candle's close) for the brief gap before the first live tick arrives;
  // once a real tick sets panel.livePrice, history reloads can never
  // overwrite it.
  // ---- v56.5: per-panel Auto Fit ("A") toggle button -----------------------
  // See the call site above for why this exists. Kept as its own small
  // block (mirroring chart-core.js's equivalent section) rather than folded
  // into panel creation, so it stays easy to find/compare against the
  // primary-chart original.
  function initPanelAutoFit(panel) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "panel-autofit-btn active";
    btn.title = "Auto Fit";
    btn.textContent = "A";
    panel.mount.appendChild(btn);
    panel.autofitBtn = btn;

    // Always start with Auto Fit ON, same default as Lightweight Charts
    // itself and as chart-core.js's own initAutoFitButton().
    panel.chart.priceScale("right").applyOptions({ autoScale: true });
    panel.autoFitEnabled = true;

    function updateBtnUI() {
      btn.classList.toggle("active", panel.autoFitEnabled);
    }

    function setAutoFit(enabled) {
      if (!panel.chart) return;
      panel.chart.priceScale("right").applyOptions({ autoScale: enabled });
      panel.autoFitEnabled = enabled;
      updateBtnUI();
    }
    // v58.1 Update 1: exposed on the panel itself so external callers
    // (jumpPanelToTimestamp() below) can turn Auto Fit back on and have
    // this panel's own "A" button reflect it, instead of poking
    // priceScale().applyOptions() directly and leaving the button stale.
    panel.setAutoFit = setAutoFit;

    // Keeps the button in sync with the price scale's actual autoScale
    // state after a manual price-axis drag (which flips that state inside
    // the charting library with no event of its own) — same reasoning as
    // chart-core.js's syncAutoFitButton(), just reading THIS panel's own
    // chart/flag instead of the global App.chart/App.autoFitEnabled.
    function syncAutoFitUI() {
      if (!panel.chart) return;
      var enabled = panel.chart.priceScale("right").options().autoScale;
      if (enabled === panel.autoFitEnabled) return;
      panel.autoFitEnabled = enabled;
      updateBtnUI();
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      setAutoFit(!panel.autoFitEnabled);
    });

    // Document-level, exactly like chart-core.js's version: cheap to check
    // (just reads a chart option) and the only way to catch the moment a
    // drag on THIS panel's own price axis disables autoScale, since that
    // happens entirely inside the charting library with no dedicated event.
    function onPointerMove(e) { if (e.buttons) syncAutoFitUI(); }
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", syncAutoFitUI);
    document.addEventListener("dblclick", syncAutoFitUI);

    // v56.5: torn down by destroyCompanionPanel() on "Multi Chart off" —
    // these are document-level listeners, so (per the same v56.3 leak
    // reasoning as the panel's other window/document listeners) they would
    // otherwise keep this whole panel object reachable forever.
    panel._autoFitCleanup = function () {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", syncAutoFitUI);
      document.removeEventListener("dblclick", syncAutoFitUI);
    };
  }

  function initPanelPriceLine(panel) {
    if (!panel.series || panel.priceLine) return;
    // v50.3 Update 2: companion panels share the exact same Price Line
    // theme (color/style/width, and the always-Background price-box text
    // color) as the primary panel — see App.priceLineOptionsFromTheme() in
    // chart-core.js, kept in sync by canvas-settings.js.
    panel.priceLine = panel.series.createPriceLine(
      Object.assign({ price: 0 }, App.priceLineOptionsFromTheme())
    );
    // V64: a panel created after the ASK arrived starts with the ASK line too.
    if (App.askTheme.enabled && Number.isFinite(App.liveAsk) && !App.replayActive) setPanelAskLine(panel, App.liveAsk);
  }

  // ---- V64: live ASK line, one per companion panel ---------------------------
  // Same look as the primary panel's ASK line (chart-core.js): the Price Line
  // theme, without the price-axis label. The price is pushed here by chart-
  // core.js (at most once per animation frame), so this file has no timer of
  // its own. It applies to every companion, active or not, so a panel that
  // becomes visible later never shows a stale ASK.
  function setPanelAskLine(panel, price) {
    if (!panel.series) return;
    if (!panel.askLine) {
      panel.askLine = panel.series.createPriceLine(
        Object.assign({ price: price }, App.askLineOptionsFromTheme())
      );
    } else {
      panel.askLine.applyOptions({ price: price });
    }
  }

  function removePanelAskLine(panel) {
    if (panel.askLine && panel.series) {
      try { panel.series.removePriceLine(panel.askLine); } catch (e) { /* already gone */ }
    }
    panel.askLine = null;
  }

  function setAskOnCompanions(price) {
    panels.forEach(function (p) { if (!p.isPrimary && p.series) setPanelAskLine(p, price); });
  }

  function clearAskOnCompanions() {
    panels.forEach(function (p) { if (!p.isPrimary) removePanelAskLine(p); });
  }

  function updatePanelPriceLine(panel, price) {
    var numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || !panel.series) return;
    if (!panel.priceLine) initPanelPriceLine(panel);
    if (!panel.priceLine) return;
    panel.livePrice = numericPrice;
    panel.priceLine.applyOptions({ price: numericPrice });
  }

  function ensurePanelPriceLineFallback(panel, price) {
    var numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || panel.livePrice !== null) return;
    updatePanelPriceLine(panel, numericPrice);
  }

  function setCompanionTf(panel, tf) {
    if (tf === null || tf === undefined) return;
    panel.tf = tf;
    panel.updateTfUI();
    panel.replayBuilding = null;
    if (!App.replayActive) {
      panel.window = null;
      panel.loadingDirection = null;
      panel.replayCutoff = null;
    }

    // v40 Update 2: while Bar Replay is active, a companion panel must show
    // the SAME replayed point in time (just on its own timeframe) instead
    // of the real live market — otherwise a multi-chart layout would mix a
    // replayed past moment (panel 1) with the true present (panels 2/3).
    if (App.replayActive) {
      loadCompanionReplayHistory(panel);
      return;
    }

    var requestGeneration = ++panel.requestGeneration;
    window.pywebview.api.get_history_set(tf).then(function (data) {
      if (requestGeneration !== panel.requestGeneration) return; // superseded
      var candles = (data && data[String(tf)]) || [];
      // v42: seed the companion's bounded window at the live edge. The old
      // implementation stored this whole page as an unbounded/plain array;
      // subsequent cache/live refreshes then had no partition state to evict.
      panel.window = App.SlidingWindow.initialLive(candles);
      panel.candles = App.SlidingWindow.combine(panel.window);
      panel.edgeLoadArmed.older = true;
      panel.edgeLoadArmed.newer = true;
      panel.loadingDirection = null;
      panel.series.setData(panel.candles);
      if (candles.length) {
        panel.chart.timeScale().scrollToRealTime();
        ensurePanelPriceLineFallback(panel, candles[candles.length - 1].close);
      }
    }).catch(function (err) {
      console.error("Companion panel history load failed:", tf, err);
    });
  }

  // ---- v42: normal-mode companion Sliding Window ---------------------------
  // Panels 2/3 now use the same bounded two-partition state machine as the
  // primary chart and the already-working Replay companion path. This code is
  // intentionally scoped to non-primary panels; Chart 1 remains in
  // chart-core.js exactly as before.
  function loadCompanionPartition(panel, direction) {
    if (App.replayActive || panel.loadingDirection || !panel.window) return;
    if (direction === "older" && panel.window.exhaustedOlder) return;
    if (direction === "newer" && (panel.window.rightIsLive || panel.window.rightIsReplay)) return;

    var source = direction === "older"
      ? (panel.window.older || panel.window.newer)
      : ((panel.window.oldestRenderBuffer && panel.window.oldestRenderBuffer.length)
          ? panel.window.oldestRenderBuffer
          : (panel.window.newer || panel.window.older));
    if (!source || !source.length) return;

    var requestGeneration = panel.requestGeneration;
    panel.loadingDirection = direction;
    var request = direction === "older"
      ? window.pywebview.api.get_history_page(panel.tf, source[0].time, App.LAZY_LOAD_CHUNK)
      : window.pywebview.api.get_history_page_after(panel.tf, source[source.length - 1].time, App.LAZY_LOAD_CHUNK);

    request.then(function (payload) {
      if (requestGeneration !== panel.requestGeneration || App.replayActive || panel.tf === null) return;

      var candles = Array.isArray(payload) ? payload : ((payload && payload.candles) || []);
      var pageIsLatest = !!(payload && !Array.isArray(payload) && payload.is_latest);
      var pageIsOldest = !!(payload && !Array.isArray(payload) && payload.is_oldest);

      if (!candles.length) {
        if (direction === "older") {
          panel.window.exhaustedOlder = pageIsOldest;
        } else if (pageIsLatest) {
          panel.window.rightIsLive = true;
          panel.window.rightIsReplay = false;
        }
        panel.loadingDirection = null;
        return;
      }

      var visible = panel.chart.timeScale().getVisibleLogicalRange();
      var dragPatch = !!panel.isPointerDown;
      var transition = App.SlidingWindow.applyHistoryPage(panel.window, direction, candles, {
        pageIsLatest: pageIsLatest,
        pageIsOldest: pageIsOldest,
        pageIsReplayLatest: false
      });

      panel.window = transition.window;
      panel.candles = App.SlidingWindow.combineRender
        ? App.SlidingWindow.combineRender(panel.window)
        : App.SlidingWindow.combine(panel.window);
      panel.series.setData(panel.candles);

      if (visible) {
        var firstOldestToTwoSlotPatch = !!transition.firstOldestToTwoSlotPatch;
        var firstLiveToTwoSlotPatch = !!transition.firstLiveToTwoSlotPatch;
        var explicitShift = transition.shift || 0;
        var desiredRange = { from: visible.from + explicitShift, to: visible.to + explicitShift };

        if (!dragPatch) {
          // v56: same fix as chart-core.js's setActiveChartData() for the
          // primary chart (v55.4) - prefer correcting the library's internal
          // time-scale anchor over a second public setVisibleLogicalRange()
          // call, so no intermediate (pre-correction) frame is ever painted.
          // This is the edge-load path a user actually walks while scrolling
          // toward the oldest partition without holding the mouse down, i.e.
          // exactly the "jumps back to Live" scenario reported for panels 2/3.
          preservePanelLogicalRange(panel, desiredRange);
        } else if (firstOldestToTwoSlotPatch) {
          var implicitFirstRightShift = -(panel.window.older ? panel.window.older.length : 0);
          if (!applyPanelDragAnchorShift(panel, implicitFirstRightShift)) {
            panel.chart.timeScale().setVisibleLogicalRange({ from: visible.from, to: visible.to });
          }
        } else if (!firstLiveToTwoSlotPatch && applyPanelDragAnchorShift(panel, explicitShift)) {
          // Anchor shift already preserves the live drag position.
        } else {
          panel.chart.timeScale().setVisibleLogicalRange(desiredRange);
        }
      }

      panel.edgeLoadArmed.older = true;
      panel.edgeLoadArmed.newer = true;
      panel.loadingDirection = null;
    }).catch(function (err) {
      panel.loadingDirection = null;
      console.error("Companion partition load failed:", direction, panel.tf, err);
    });
  }

  // ---- v40 Update 2: Bar Replay integration for companion panels -----------
  // Companion panels never talk to the live feed while Replay is active
  // (see the App.replayActive guards on feedLiveCandles/onCacheReady
  // below). Instead each one re-aggregates the exact same finest-
  // granularity 1-second stream replay-bar.js is already fetching for the
  // primary panel — via the "App:replayCandle" event — onto its own
  // timeframe, the same way replay-bar.js builds the primary panel's
  // active timeframe out of that stream.
  function setCompanionReplayWindow(panel, candles, atReplayEdge, pageIsOldest) {
    var w = App.SlidingWindow.create();
    w.newer = candles || [];
    w.rightIsLive = false;
    w.rightIsReplay = !!atReplayEdge;
    w.exhaustedOlder = !!pageIsOldest;
    panel.window = w;
    panel.candles = App.SlidingWindow.combine(w);
    panel.edgeLoadArmed.older = true;
    panel.edgeLoadArmed.newer = true;
  }

  function loadCompanionReplayHistory(panel) {
    var tf = panel.tf;
    if (tf === null || !App.ReplayBar || !window.pywebview || !window.pywebview.api) return;
    var cutoff = App.ReplayBar.getReplayPointTime ? App.ReplayBar.getReplayPointTime() : null;
    if (cutoff === null || cutoff === undefined) return;

    var requestGeneration = ++panel.requestGeneration;
    panel.loadingDirection = "newer";
    window.pywebview.api.get_history_page(tf, Number(cutoff) + 1, App.LAZY_LOAD_CHUNK).then(function (payload) {
      if (requestGeneration !== panel.requestGeneration) return;
      if (!App.replayActive || panel.tf !== tf) return;
      var candles = Array.isArray(payload) ? payload : ((payload && payload.candles) || []);
      var pageIsOldest = !!(payload && !Array.isArray(payload) && payload.is_oldest);
      panel.replayCutoff = Number(cutoff);
      setCompanionReplayWindow(panel, candles, true, pageIsOldest);
      panel.replayBuilding = candles.length ? candles[candles.length - 1] : null;
      panel.series.setData(panel.candles);
      if (panel.candles.length) {
        panel.chart.timeScale().scrollToRealTime();
        updatePanelPriceLine(panel, panel.candles[panel.candles.length - 1].close);
      }
      panel.loadingDirection = null;
    }).catch(function (err) {
      panel.loadingDirection = null;
      console.error("Companion Replay history load failed:", tf, err);
    });
  }

  function loadCompanionReplayPartition(panel, direction) {
    if (!App.replayActive || panel.loadingDirection || !panel.window) return;
    // Mirror chart-core.js exactly at the oldest-partition boundary.
    // When the oldest page is partial, SlidingWindow keeps a small
    // `oldestRenderBuffer` from the previously-newer slot so the rendered
    // series does not shrink during the drag. On the way back to the right,
    // the continuation request MUST start after that buffer, not after the
    // visible `newer` slot. Using the visible slot here skips the buffered
    // boundary and can duplicate its first candle / lose the Replay edge.
    var source = direction === "older"
      ? (panel.window.older || panel.window.newer)
      : ((panel.window.oldestRenderBuffer && panel.window.oldestRenderBuffer.length)
          ? panel.window.oldestRenderBuffer
          : (panel.window.newer || panel.window.older));
    if (!source || !source.length) return;

    var requestGeneration = panel.requestGeneration;
    panel.loadingDirection = direction;
    var cutoff = Number(App.ReplayBar && App.ReplayBar.getReplayPointTime
      ? App.ReplayBar.getReplayPointTime() : panel.replayCutoff);
    var request = direction === "older"
      ? window.pywebview.api.get_history_page(panel.tf, source[0].time, App.LAZY_LOAD_CHUNK)
      : window.pywebview.api.get_history_page_after(panel.tf, source[source.length - 1].time, App.LAZY_LOAD_CHUNK);

    request.then(function (payload) {
      if (requestGeneration !== panel.requestGeneration || !App.replayActive) return;
      var raw = Array.isArray(payload) ? payload : ((payload && payload.candles) || []);
      var backendPageIsLatest = !!(payload && !Array.isArray(payload) && payload.is_latest);
      var pageIsLatest = backendPageIsLatest;
      var pageIsOldest = !!(payload && !Array.isArray(payload) && payload.is_oldest);
      var pageIsReplayLatest = false;

      if (direction === "newer" && Number.isFinite(cutoff)) {
        raw = raw.filter(function (c) { return Number(c.time) <= cutoff; });
        var rawCandles = payload && !Array.isArray(payload) && Array.isArray(payload.candles) ? payload.candles : [];
        var lastRaw = rawCandles.length
          ? Number(rawCandles[rawCandles.length - 1].time)
          : (raw.length ? Number(raw[raw.length - 1].time) : NaN);
        pageIsReplayLatest = Number.isFinite(lastRaw) && lastRaw >= cutoff;
        // Use the shared latest/partial-page transition at the Replay edge;
        // SlidingWindow separates it from the real Live flag.
        pageIsLatest = pageIsReplayLatest;
        if (backendPageIsLatest && rawCandles.length && !raw.length) pageIsReplayLatest = true;
      }

      if (!raw.length) {
        if (direction === "older") {
          panel.window.exhaustedOlder = pageIsOldest;
        } else if (pageIsReplayLatest || (Number.isFinite(cutoff) && panel.window.newer && panel.window.newer.length && panel.window.newer[panel.window.newer.length - 1].time >= cutoff)) {
          panel.window.rightIsReplay = true;
          panel.window.rightIsLive = false;
        }
        panel.loadingDirection = null;
        return;
      }

      var visible = panel.chart.timeScale().getVisibleLogicalRange();
      var dragPatch = !!panel.isPointerDown;
      var transition = App.SlidingWindow.applyHistoryPage(panel.window, direction, raw, {
        pageIsLatest: pageIsLatest,
        pageIsOldest: pageIsOldest,
        pageIsReplayLatest: direction === "newer" && pageIsReplayLatest
      });
      panel.window = transition.window;
      // Primary-chart parity: render the oldest-boundary buffer when the
      // final historical partition is partial. `combine()` is the logical
      // two-slot state; `combineRender()` is the physical series presented to
      // Lightweight Charts so setData() does not suddenly shrink and move
      // logical indices at the oldest edge. Panels 2/3 previously used only
      // combine(), which was the source of the boundary jump / blank return.
      panel.candles = App.SlidingWindow.combineRender
        ? App.SlidingWindow.combineRender(panel.window)
        : App.SlidingWindow.combine(panel.window);
      panel.series.setData(panel.candles);

      if (visible) {
        var firstOldestToTwoSlotPatch = !!transition.firstOldestToTwoSlotPatch;
        var firstLiveToTwoSlotPatch = !!transition.firstLiveToTwoSlotPatch;
        function applyCompanionDragAnchorShift(shift) {
          var ts = panel.chart.timeScale();
          if (!ts.ia) return false;
          ts.ia.lc = ts.ia.Oc() + shift;
          if (ts.ia.nc) ts.ia.nc.Oc += shift;
          ts.ia.Xu = true;
          if (ts.ia.sn && typeof ts.ia.sn.zc === "function") ts.ia.sn.zc();
          if (ts.ia.sn && typeof ts.ia.sn.mr === "function") ts.ia.sn.mr();
          return true;
        }
        if (dragPatch && firstOldestToTwoSlotPatch) {
          var implicitFirstRightShift = -(panel.window.older ? panel.window.older.length : 0);
          if (!applyCompanionDragAnchorShift(implicitFirstRightShift)) {
            panel.chart.timeScale().setVisibleLogicalRange({ from: visible.from, to: visible.to });
          }
        } else if (dragPatch && !firstLiveToTwoSlotPatch && applyCompanionDragAnchorShift(transition.shift)) {
          // Primary parity: the anchor shift is what moves the view. V64.2: if
          // the slots differ in size (a short live slot) setData() has moved the
          // view by that difference, so correct the anchor by whatever error
          // remains (zero -> no-op).
          var landed = panel.chart.timeScale().getVisibleLogicalRange();
          if (landed && Math.abs(landed.from - (visible.from + transition.shift)) > 0.5) {
            applyCompanionDragAnchorShift((visible.from + transition.shift) - landed.from);
          }
        } else {
          // First-live -> two-slot is already repositioned by setData(), just
          // like the primary chart. All other non-drag transitions use the
          // shared logical shift from SlidingWindow.
          var explicitShift = transition.shift;
          panel.chart.timeScale().setVisibleLogicalRange({
            from: visible.from + explicitShift,
            to: visible.to + explicitShift
          });
        }
      }

      // Never reattach the moving Replay edge after an OLDER transition.
      // While the user inspects history, replayBuilding may be far to the
      // right; merging it here would immediately yank the companion back to
      // the Replay edge. Reattach only when navigation is moving right.
      if (direction === "newer") syncCompanionReplayWindow(panel);
      panel.edgeLoadArmed.older = true;
      panel.edgeLoadArmed.newer = true;
      panel.loadingDirection = null;
    }).catch(function (err) {
      panel.loadingDirection = null;
      console.error("Companion Replay partition load failed:", direction, panel.tf, err);
    });
  }

  function feedCompanionReplayCandle(panel, c) {
    if (panel.tf === null || !panel.series) return;
    var tf = panel.tf;
    var bucket = Math.floor(c.time / tf) * tf;

    // The replay aggregate is global to the panel, not to the currently
    // visible partition. This lets playback continue while the user inspects
    // older history without mutating that historical viewport.
    if (!panel.replayBuilding || panel.replayBuilding.time !== bucket) {
      panel.replayBuilding = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      if (c.high > panel.replayBuilding.high) panel.replayBuilding.high = c.high;
      if (c.low < panel.replayBuilding.low) panel.replayBuilding.low = c.low;
      panel.replayBuilding.close = c.close;
    }

    if (!panel.window || !panel.window.rightIsReplay) return;
    var visible = panel.chart.timeScale().getVisibleLogicalRange();
    // Update 1 (V67): hand mergeReplayTail a snapshot, not the shared
    // mutable panel.replayBuilding object itself - see the matching note in
    // replay-bar.js's feedOneCandle(). Reusing the same reference every tick
    // made the change-detection compare that object to itself once it had
    // been stored in panel.window, so every tick after a bucket's first was
    // silently dropped and the companion's forming bar froze on its first
    // tick's O/H/L/C until the bucket rolled over - most visible at high
    // Replay speeds, where a whole bar streams by in about one real second.
    var buildingSnapshot = {
      time: panel.replayBuilding.time,
      open: panel.replayBuilding.open,
      high: panel.replayBuilding.high,
      low: panel.replayBuilding.low,
      close: panel.replayBuilding.close
    };
    var transition = App.SlidingWindow.mergeReplayTail(panel.window, [buildingSnapshot], App.LAZY_LOAD_CHUNK);
    if (!transition.changed) return;
    panel.window = transition.window;
    panel.candles = App.SlidingWindow.combine(panel.window);

    if (transition.rolled.length) {
      panel.series.setData(panel.candles);
      if (visible) {
        var shift = transition.window.older ? 0 : -transition.rolled.length;
        panel.chart.timeScale().setVisibleLogicalRange({
          from: visible.from + shift, to: visible.to + shift
        });
      }
    } else {
      panel.series.update(buildingSnapshot);
    }
    updatePanelPriceLine(panel, buildingSnapshot.close);
  }

  function syncCompanionReplayWindow(panel) {
    if (!App.replayActive || !panel.window || !panel.window.newer || !panel.window.newer.length || !panel.replayBuilding) return;
    var last = panel.window.newer[panel.window.newer.length - 1];
    if (last && last.time === panel.replayBuilding.time) {
      panel.replayBuilding = last;
      return;
    }
    if (last && last.time < panel.replayBuilding.time) {
      var visible = panel.chart.timeScale().getVisibleLogicalRange();
      // Same reasoning as feedCompanionReplayCandle() above: snapshot, never
      // the shared mutable object.
      var buildingSnapshot2 = {
        time: panel.replayBuilding.time,
        open: panel.replayBuilding.open,
        high: panel.replayBuilding.high,
        low: panel.replayBuilding.low,
        close: panel.replayBuilding.close
      };
      var result = App.SlidingWindow.mergeReplayTail(panel.window, [buildingSnapshot2], App.LAZY_LOAD_CHUNK);
      if (result.changed) {
        panel.window = result.window;
        panel.candles = App.SlidingWindow.combineRender
          ? App.SlidingWindow.combineRender(panel.window)
          : App.SlidingWindow.combine(panel.window);
        panel.series.setData(panel.candles);
        if (visible) {
          var shift = result.window.older ? 0 : -result.rolled.length;
          panel.chart.timeScale().setVisibleLogicalRange({
            from: visible.from + shift, to: visible.to + shift
          });
        }
        updatePanelPriceLine(panel, panel.replayBuilding.close);
      }
    }
  }

  document.addEventListener("App:replayCandle", function (evt) {
    var c = evt && evt.detail;
    if (!c) return;
    getActivePanels().forEach(function (p) {
      if (p.isPrimary || p.tf === null) return;
      feedCompanionReplayCandle(p, c);
    });
  });

  // Fires once Select Date has truncated/positioned the primary panel —
  // reload every currently-visible companion at that same point, on its
  // own timeframe. Also covers re-picking a new Select Date point while
  // already in Replay with a multi-chart layout open.
  document.addEventListener("App:replayStarted", function () {
    getActivePanels().forEach(function (p) {
      if (p.isPrimary || p.tf === null) return;
      setCompanionTf(p, p.tf);
    });
  });

  // Fires once Replay mode is closed — hand every companion panel back to
  // the ordinary real-live-data path.
  document.addEventListener("App:replayExited", function () {
    getActivePanels().forEach(function (p) {
      if (p.isPrimary || p.tf === null) return;
      p.replayBuilding = null;
      p.window = null;
      p.loadingDirection = null;
      p.replayCutoff = null;
      setCompanionTf(p, p.tf);
    });
  });

  function getActivePanels() {
    return panels.slice(0, layout);
  }

  // ---- v39: Home/End/Jump-Time now act on every multi-chart panel ----------
  // Previously SPACE (Jump Time), END and HOME only ever touched the primary
  // panel (chart-core.js / jump-time.js own App.chart/App.currentTf globals),
  // so on any layout with companion panels visible, pressing one of these
  // shortcuts silently did nothing to whichever companion the user was
  // actually looking at. Companion panels keep no Sliding-Window state of
  // their own (see createCompanionPanel() above — they just do a flat
  // setData() per timeframe switch), so these are simpler, self-contained
  // equivalents of chart-core.js's jumpToLatest()/jumpToOldest() and
  // jump-time.js's executeJump(), scoped to one companion panel at a time.

  function jumpPanelToLatest(panel) {
    if (!panel || panel.tf === null) return;
    var tf = panel.tf;
    var requestGeneration = ++panel.requestGeneration;
    window.pywebview.api.get_history_set(tf).then(function (data) {
      if (requestGeneration !== panel.requestGeneration) return; // superseded
      var candles = (data && data[String(tf)]) || [];
      if (!candles.length) return;
      panel.window = App.SlidingWindow.initialLive(candles);
      panel.candles = App.SlidingWindow.combine(panel.window);
      panel.edgeLoadArmed.older = true;
      panel.edgeLoadArmed.newer = true;
      panel.loadingDirection = null;
      panel.series.setData(panel.candles);
      panel.chart.timeScale().scrollToRealTime();
    }).catch(function (err) {
      console.error("Companion END jump failed:", tf, err);
    });
  }

  function jumpPanelToOldest(panel) {
    if (!panel || panel.tf === null) return;
    var tf = panel.tf;
    var requestGeneration = ++panel.requestGeneration;
    window.pywebview.api.get_oldest_history_partition(tf, App.LAZY_LOAD_CHUNK).then(function (candles) {
      if (requestGeneration !== panel.requestGeneration) return; // superseded
      candles = candles || [];
      if (!candles.length) return;
      panel.window = App.SlidingWindow.initialOldest(candles);
      panel.candles = App.SlidingWindow.combine(panel.window);
      panel.edgeLoadArmed.older = true;
      panel.edgeLoadArmed.newer = true;
      panel.loadingDirection = null;
      panel.series.setData(panel.candles);
      var visible = panel.chart.timeScale().getVisibleLogicalRange();
      var barsOnScreen = visible ? (visible.to - visible.from) : (candles.length - 1);
      if (!(barsOnScreen > 0)) barsOnScreen = candles.length - 1;
      panel.chart.timeScale().setVisibleLogicalRange({ from: 0, to: barsOnScreen });
    }).catch(function (err) {
      console.error("Companion HOME jump failed:", tf, err);
    });
  }

  // `ts` is an absolute, timeframe-independent real-time timestamp (same
  // contract as jump-time.js's jumpToTimestamp) — each panel floors it to
  // its own timeframe and clamps it to its own timeframe's data bounds,
  // since a companion can be on a different timeframe (and therefore a
  // different available range) than the primary panel or its siblings.
  function jumpPanelToTimestamp(panel, ts) {
    if (!panel || panel.tf === null) return;
    var tf = panel.tf;
    var requestGeneration = ++panel.requestGeneration;
    window.pywebview.api.get_history_bounds(tf).then(function (bounds) {
      if (requestGeneration !== panel.requestGeneration) return; // superseded
      if (!bounds || bounds.first_time === null || bounds.last_time === null) return;
      var clamped = Math.max(Number(bounds.first_time), Math.min(Number(bounds.last_time), ts));
      var target = Math.floor(clamped / tf) * tf;
      return window.pywebview.api.get_history_window(tf, target, App.LAZY_LOAD_CHUNK).then(function (payload) {
        if (requestGeneration !== panel.requestGeneration) return; // superseded
        var before = payload && Array.isArray(payload.before) ? payload.before : [];
        var after = payload && Array.isArray(payload.after) ? payload.after : [];
        if (!before.length) return;
        var candles = before.concat(after);
        panel.window = App.SlidingWindow.fromJump(before, after, {
          firstTime: Number(bounds.first_time),
          lastTime: Number(bounds.last_time)
        });
        panel.candles = App.SlidingWindow.combineRender(panel.window);
        panel.edgeLoadArmed.older = true;
        panel.edgeLoadArmed.newer = true;
        panel.loadingDirection = null;

        // v58.1 Update 1: Jump Time / Object Jump must turn Auto Scale
        // back on for companion panels too (2nd/3rd chart in Multi-Chart
        // mode), same as the primary panel now does. Enabled BEFORE
        // setData(), same ordering reasoning as jump-time.js's own
        // autoFit — so the panel never paints the new candles with a
        // stale/manual vertical range. Goes through panel.setAutoFit()
        // (not applyOptions() directly) so this panel's own "A" button
        // stays in sync with the price scale's real state.
        if (panel.setAutoFit) panel.setAutoFit(true);

        panel.series.setData(panel.candles);

        // Center the target in the view, matching jump-time.js's own
        // centered framing (see executeJump()'s v33.5 note there).
        var targetIndex = before.length - 1;
        var visible = panel.chart.timeScale().getVisibleLogicalRange();
        var barsOnScreen = visible ? (visible.to - visible.from) : Math.min(before.length - 1, 100);
        if (!(barsOnScreen > 0)) barsOnScreen = Math.min(before.length - 1, 100);
        var half = barsOnScreen / 2;
        var from = targetIndex - half;
        var to = targetIndex + half;
        if (from < 0) { to -= from; from = 0; }
        panel.chart.timeScale().setVisibleLogicalRange({ from: from, to: to });
      });
    }).catch(function (err) {
      console.error("Companion Jump Time failed:", tf, err);
    });
  }

  // Public: apply the same jump to every currently-visible companion panel.
  // The primary panel is deliberately excluded here — callers (keyboard-
  // shortcuts.js, jump-time.js) already drive the primary panel themselves
  // through chart-core.js/jump-time.js and call these right alongside that.
  function jumpAllToLatest() {
    getActivePanels().forEach(function (p) { if (!p.isPrimary) jumpPanelToLatest(p); });
  }

  function jumpAllToOldest() {
    getActivePanels().forEach(function (p) { if (!p.isPrimary) jumpPanelToOldest(p); });
  }

  function jumpAllToTimestamp(ts) {
    getActivePanels().forEach(function (p) { if (!p.isPrimary) jumpPanelToTimestamp(p, ts); });
  }

  // ---- live-tick + cache-refresh feed for companion panels ------------------
  // Piggybacks on chart-core.js's existing window.onLiveCandles/onCacheReady
  // hooks rather than duplicating the sync-process/queue plumbing.

  function feedLiveCandles(candleSetByTf) {
    if (!candleSetByTf) return;
    // v40 Update 2: real live ticks must never reach a companion panel
    // while Bar Replay is active — "App:replayCandle" drives them instead.
    if (App.replayActive) return;
    getActivePanels().forEach(function (p) {
      if (p.isPrimary) return; // chart-core.js already handles the primary
      var tail = candleSetByTf[String(p.tf)] || candleSetByTf[p.tf];
      if (!tail || !tail.length) return;
      var liveBar = tail[tail.length - 1];
      // v39: keep this panel's live price line current from the same
      // authoritative tail, unconditionally — matches chart-core.js's
      // mergeLiveCandleSet(), which updates the price line every tick
      // regardless of whether the candle series itself changed below.
      updatePanelPriceLine(p, liveBar.close);
      if (!p.window) return;
      var visibleLogical = p.chart.timeScale().getVisibleLogicalRange();
      var result = App.SlidingWindow.mergeLiveTail(p.window, tail, App.LAZY_LOAD_CHUNK);
      if (!result.changed) return;
      p.window = result.window;

      if (result.rolled.length) {
        p.candles = App.SlidingWindow.combineRender(p.window);
        p.series.setData(p.candles);
        // v56: match chart-core.js's mergeAuthoritativeTail() (v55.4) -
        // shift the viewport on live rollover only when the panel is
        // actually sitting at the Live edge. Previously this always shifted
        // by -rolled.length regardless of where the user had scrolled to,
        // and did so with a plain setVisibleLogicalRange() after setData()
        // (see preservePanelLogicalRange() above for why that alone can
        // produce a one-frame anchor hop). Together those are what let a
        // companion panel appear to "jump back to Live" while the user was
        // walking it toward its oldest partition.
        var dataLength = p.candles ? p.candles.length : 0;
        var atLiveEdge = !!(visibleLogical && dataLength > 0 &&
          visibleLogical.to >= (dataLength - 1 - 0.5));
        var logicalShift = p.window.older
          ? 0
          : (atLiveEdge ? -result.rolled.length : 0);
        if (visibleLogical) {
          preservePanelLogicalRange(p, {
            from: visibleLogical.from + logicalShift,
            to: visibleLogical.to + logicalShift
          });
        }
        return;
      }

      p.candles = App.SlidingWindow.combineRender(p.window);
      var active = p.window.newer || [];
      var livePart = active.length ? active[active.length - 1] : null;
      if (livePart) p.series.update(livePart);
    });
  }

  function refreshCompanionsFromCache() {
    // v40 Update 2: a cache-ready refresh is real live data — must not
    // overwrite a companion panel's replayed view.
    if (App.replayActive) return;
    getActivePanels().forEach(function (p) {
      if (p.isPrimary || p.tf === null) return;
      var visibleLogical = p.chart.timeScale().getVisibleLogicalRange();
      var requestGeneration = ++p.requestGeneration;
      window.pywebview.api.get_history_set(p.tf).then(function (data) {
        if (requestGeneration !== p.requestGeneration) return;
        var candles = (data && data[String(p.tf)]) || [];
        if (!candles.length || !p.window || !p.window.rightIsLive) return;
        p.window.newer = candles;
        p.candles = App.SlidingWindow.combineRender(p.window);
        p.series.setData(p.candles);
        if (visibleLogical) {
          try { p.chart.timeScale().setVisibleLogicalRange(visibleLogical); } catch (e) {}
        }
      }).catch(function (err) {
        console.error("Companion panel cache refresh failed:", p.tf, err);
      });
    });
  }

  var originalOnLiveCandles = window.onLiveCandles;
  window.onLiveCandles = function (candleSetByTf) {
    if (originalOnLiveCandles) originalOnLiveCandles(candleSetByTf);
    feedLiveCandles(candleSetByTf);
  };

  var originalOnCacheReady = window.onCacheReady;
  window.onCacheReady = function () {
    if (originalOnCacheReady) originalOnCacheReady();
    refreshCompanionsFromCache();
  };

  // ---- layout switcher UI ---------------------------------------------------

  function buildLayoutSwitcher() {
    var el = document.getElementById("layout-switcher");
    if (!el) return;
    [1, 2, 3].forEach(function (n) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill-btn";
      btn.title = n === 1 ? "Single chart" : n + " charts side by side";
      btn.innerHTML = LAYOUT_ICONS[n];
      btn.addEventListener("click", function () { setLayout(n); });
      el.appendChild(btn);
    });
    updateLayoutSwitcherUI();
  }

  function updateLayoutSwitcherUI() {
    var el = document.getElementById("layout-switcher");
    if (!el) return;
    Array.prototype.forEach.call(el.children, function (btn, i) {
      btn.classList.toggle("active", i + 1 === layout);
    });
  }

  // Companion-container visibility for the current `layout`, as its own
  // function so both setLayout() and restoreFromMaximize() (below) can
  // reach the exact same "which panels should be visible right now" logic
  // instead of duplicating it.
  function applyLayoutVisibility() {
    panels.forEach(function (p, i) {
      if (i === 0) return; // primary panel's container isn't ours to hide
      p.container.style.display = (i + 1 <= layout) ? "flex" : "none";
    });
    // v41 perf: a panel's overlay canvas doesn't repaint while its
    // container is display:none (no ResizeObserver firing, no mouse
    // activity possible), so re-showing one after a layout change needs an
    // explicit repaint request rather than waiting on the idle heartbeat.
    // v65.5 Update 1: and it needs its new size applied synchronously, for
    // exactly the same reason maximize/restore does - see resyncPanelSize()
    // below. This covers layout switches (1/2/3) and restore-from-maximize.
    resyncVisiblePanels();
  }

  // v56.3: full teardown for a companion panel (2/3) — the counterpart of
  // chart-core.js's showTimeframe() deleting App.windowByTf[oldTf]/
  // App.candlesByTf[oldTf] on a primary timeframe switch. Turning Multi
  // Chart off entirely (back to layout 1) previously only hid panels 2/3
  // via display:none - their Lightweight Charts instances, candle arrays,
  // Sliding Window state, ResizeObserver and window-level pointer listeners
  // all stayed alive and resident in RAM for the rest of the session (and
  // a hidden panel's ResizeObserver/pointer listeners keep its whole
  // `panel` object - and through it panel.candles/panel.window - reachable
  // forever, so even the JS engine could never reclaim them on its own).
  // This releases all of it: the chart library's own internal buffers
  // (chart.remove()), our own references to its candle data, and every
  // listener that would otherwise keep the panel object alive.
  function destroyCompanionPanel(panel) {
    if (!panel || panel.isPrimary) return;
    if (panel.resizeObserver) panel.resizeObserver.disconnect();
    if (panel._onWindowPointerUp) {
      window.removeEventListener("pointerup", panel._onWindowPointerUp);
      window.removeEventListener("pointercancel", panel._onWindowPointerUp);
    }
    if (panel.drawSurface && panel.drawSurface.destroy) panel.drawSurface.destroy();
    // v56.5: same reasoning as _onWindowPointerUp above — these are
    // document-level listeners from initPanelAutoFit(), so they must be
    // explicitly removed or they'd keep this panel object alive forever.
    if (panel._autoFitCleanup) panel._autoFitCleanup();
    if (panel._onDocumentClickCloseList) {
      document.removeEventListener("click", panel._onDocumentClickCloseList);
    }
    if (panel.chart && panel.chart.remove) {
      try { panel.chart.remove(); } catch (e) { /* already torn down */ }
    }
    if (panel.container && panel.container.parentNode) {
      panel.container.parentNode.removeChild(panel.container);
    }
    panel.candles = null;
    panel.window = null;
    panel.chart = null;
    panel.series = null;
    panel.drawSurface = null;
    panel.priceLine = null;
    panel.askLine = null;
    panel.resizeObserver = null;
    panel._onWindowPointerUp = null;
    panel._autoFitCleanup = null;
    panel._onDocumentClickCloseList = null;
    panel.autofitBtn = null;
    panel.mount = null;
  }

  function setLayout(n) {
    n = Math.max(1, Math.min(3, n));
    var previousLayout = layout;
    layout = n;
    panelsRow.className = "chart-panels-row chart-panels-row-" + n;

    for (var i = 2; i <= n; i++) {
      if (!panels[i - 1]) panels[i - 1] = createCompanionPanel(i);
    }
    // Switching layout while a panel is maximized would otherwise leave
    // stale, maximize-only inline styles behind (e.g. the primary panel
    // still display:none) — exit maximize first so the new layout starts
    // from a clean, fully-visible state.
    if (maximizedPanel) restoreFromMaximize();
    // v56.3: turning Multi Chart off entirely (any n>1 -> 1) fully tears
    // down panels 2/3 instead of just hiding them - see
    // destroyCompanionPanel() above. Going from 1 -> 1 (redundant click) or
    // between two multi-panel layouts (e.g. 3 -> 2) does not: panel 2 stays
    // exactly as-is when only panel 3 is being dropped down to hidden by
    // applyLayoutVisibility() below (matching that a user re-expanding back
    // to 3 expects panel 2 to still be exactly how they left it, not
    // reloaded from scratch). Run after the restoreFromMaximize() call
    // above so a panel that happened to be maximized is cleanly restored
    // (and its settle-resize/visibility handling runs against a still-
    // intact panel) before anything is torn down.
    if (n === 1 && previousLayout !== 1) {
      for (var j = panels.length - 1; j >= 1; j--) {
        destroyCompanionPanel(panels[j]);
      }
      panels.length = 1;
    }
    applyLayoutVisibility();

    updateLayoutSwitcherUI();
  }

  // ---- v39: double-click a panel to maximize it, ESC to restore -------------
  // Maximizing hides every other panel's container (primary included) so the
  // double-clicked panel alone fills the row — visually identical to viewing
  // it in "Single chart" (layout 1) — without touching `layout` itself or
  // rebuilding anything, so restoring is just re-running the normal
  // layout-1/2/3 visibility rule above. ESC restores (wired from
  // keyboard-shortcuts.js via isMaximized()/restoreFromMaximize()); double-
  // clicking the already-maximized panel again also restores, as a
  // convenience toggle.

  // v65.5 Update 1: maximizing/restoring a panel changes its width by a
  // large amount in one step (e.g. 1/3 -> 100% of the row, or back).
  // Previously the chart + drawing overlay only learned about that from
  // their ResizeObserver, which the spec fires AFTER that frame's layout
  // and after that frame's requestAnimationFrame callbacks - so the
  // browser could paint one or two frames in which the candles and the
  // drawn objects still used the OLD geometry at the NEW panel size. That
  // is the visible "objects appear somewhere else for a few milliseconds,
  // blink, then land in their real place" artifact.
  //
  // v56.2 worked around it by hiding the panel for two frames
  // (visibility:hidden -> reveal) and hoping everything had settled by
  // then; that is what produced the blink, and it did not cover the
  // primary panel at all.
  //
  // This replaces the hide/reveal with a synchronous re-sync: right after
  // the display change, measure the panel's real new box (the
  // getBoundingClientRect() below forces the pending layout, so the value
  // is already final) and push it straight into chart.resize(w, h, true)
  // - the third argument makes the chart library repaint immediately
  // instead of on its next frame - and then into the overlay canvas,
  // which repaints synchronously too (drawing-engine.js's
  // resizeSurfaceCanvasAndRepaint). Resize and repaint therefore land in
  // the same task as the layout change, before the browser paints
  // anything, so no intermediate state is ever shown: no shift, no blink,
  // and no hidden frames. Cost is one forced layout plus exactly one
  // repaint per visible panel - strictly less work than the old two extra
  // frames.
  function panelSizeHost(panel) {
    if (!panel) return null;
    // The primary panel's chart/overlay are owned by chart-core.js and
    // sized from #chart-surface (App.dom.chartContainer); companions use
    // their own mount element.
    return panel.isPrimary ? (App.dom && App.dom.chartContainer) : panel.mount;
  }

  // Marks a size as already applied to this element's chart+overlay, so the
  // ResizeObserver callback that inevitably follows with the very same
  // numbers becomes a cheap no-op instead of a second resize + repaint.
  // Also used by chart-core.js's own observer for the primary chart.
  function markSizeApplied(el, w, h) {
    if (!el) return;
    el._appliedChartW = w;
    el._appliedChartH = h;
  }

  function resyncPanelSize(panel) {
    var el = panelSizeHost(panel);
    if (!el || !panel.chart) return;
    var rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // hidden panel: nothing to size
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);
    if (el._appliedChartW === w && el._appliedChartH === h) return;
    markSizeApplied(el, w, h);
    // forceRepaint = true -> the chart library redraws now, not next frame.
    try { panel.chart.resize(w, h, true); }
    catch (e) { panel.chart.resize(w, h); }
    if (panel.isPrimary) {
      if (App.DrawingEngine && App.DrawingEngine.resizeDrawCanvas) {
        App.DrawingEngine.resizeDrawCanvas(w, h);
      }
    } else if (panel.drawSurface && panel.drawSurface.resize) {
      panel.drawSurface.resize(w, h);
    }
  }

  // Re-syncs every panel that is currently on screen. Hidden panels are
  // skipped (zero-sized) and pick their size up from their own
  // ResizeObserver the moment they are shown again.
  function resyncVisiblePanels() {
    panels.forEach(resyncPanelSize);
    if (App.DrawingEngine && App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
  }

  function maximizePanel(panel) {
    if (layout === 1 || !panel) return; // nothing to maximize — already alone
    maximizedPanel = panel;
    panels.forEach(function (p) {
      p.container.style.display = (p === panel) ? "flex" : "none";
    });
    resyncVisiblePanels();
  }

  function restoreFromMaximize() {
    if (!maximizedPanel) return;
    maximizedPanel = null;
    panels[0].container.style.display = "flex";
    applyLayoutVisibility();
  }

  function toggleMaximize(panel) {
    // Only the plain cursor tool double-click-maximizes — an active drawing
    // tool (trend/rect/etc.) uses two quick clicks to place a second point,
    // and that gesture fires a native "dblclick" too; maximizing on top of
    // that would yank the panel away mid-draw.
    if (App.currentTool !== "cursor") return;
    if (maximizedPanel === panel) restoreFromMaximize();
    else maximizePanel(panel);
  }

  function isMaximized() { return maximizedPanel !== null; }

  function init() {
    panelsRow = document.getElementById("chart-panels-row");
    if (!panelsRow || !App.chart) return;
    panels[0] = makePrimaryPanel();
    buildLayoutSwitcher();

    var primarySurface = document.getElementById("chart-surface");
    if (primarySurface) {
      // Same price-axis exclusion as the companion panels above — the
      // primary chart's own right-hand price scale must keep its native
      // Auto Scale double-click toggle instead of maximizing.
      primarySurface.addEventListener("dblclick", function (e) {
        var rect = primarySurface.getBoundingClientRect();
        var priceScaleWidth = App.chart.priceScale("right").width();
        if (e.clientX >= rect.right - priceScaleWidth) return;
        toggleMaximize(panels[0]);
      });
    }
  }

  App.MultiPanel = {
    init: init,
    setLayout: setLayout,
    isMaximized: isMaximized,
    restoreFromMaximize: restoreFromMaximize,
    jumpAllToLatest: jumpAllToLatest,
    jumpAllToOldest: jumpAllToOldest,
    jumpAllToTimestamp: jumpAllToTimestamp,
    // v50.3 Update 1: lets canvas-settings.js broadcast Canvas tab changes
    // (background/crosshair/text/grid/candle colors, Price Line) to every
    // companion panel, not just the primary chart.
    getPanels: function () { return panels; },
    // v65.5 Update 1: lets chart-core.js's ResizeObserver share the same
    // "this size is already applied" bookkeeping for the primary chart.
    markSizeApplied: markSizeApplied,
    // V64: live ASK line on every companion panel (driven by chart-core.js).
    setAsk: setAskOnCompanions,
    clearAsk: clearAskOnCompanions,
  };
})();
