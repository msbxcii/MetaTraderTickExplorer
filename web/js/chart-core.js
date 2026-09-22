// =============================================================================
// chart-core.js — chart creation, timeframe switching, history loading, and
// live tick-driven updates. Nothing about drawing tools lives here.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  // Diagnostic hooks are intentionally silent in release builds.  The
  // logging API remains available for compatibility, but routine chart/
  // Sliding Window activity is no longer written to the CMD log.
  function diag() {}
  function diagState(extra) {
    var tf = App.currentTf;
    var w = tf !== null && App.windowByTf ? App.windowByTf[tf] : null;
    var range = App.chart ? App.chart.timeScale().getVisibleLogicalRange() : null;
    var state = {
      tf: tf, pointerDown: !!App.isPointerDownOnChart,
      range: range ? {from: range.from, to: range.to} : null,
      activeLen: tf !== null && App.candlesByTf[tf] ? App.candlesByTf[tf].length : 0,
      olderLen: w && w.older ? w.older.length : 0,
      newerLen: w && w.newer ? w.newer.length : 0,
      oldestBufferLen: w && w.oldestRenderBuffer ? w.oldestRenderBuffer.length : 0,
      rightIsLive: !!(w && w.rightIsLive),
      exhaustedOlder: !!(w && w.exhaustedOlder),
      loading: tf !== null && App.loadingDirectionByTf ? App.loadingDirectionByTf[tf] : null,
      edgeArmed: App.edgeLoadArmed ? {older: !!App.edgeLoadArmed.older, newer: !!App.edgeLoadArmed.newer} : null
    };
    return Object.assign(state, extra || {});
  }
  App.diagLog = function(event, details) {
    try {
      if (window.pywebview && window.pywebview.api && window.pywebview.api.log_frontend) {
        window.pywebview.api.log_frontend('V51RF.' + event, JSON.stringify(diagState(details || {})));
      }
    } catch (_) {}
  };

  // ---- Chart setup -------------------------------------------------------
  function createChart() {
    App.chart = LightweightCharts.createChart(dom.chartContainer, {
      layout: {
        background: { type: "solid", color: "#0a0e17" },
        textColor: "#8b95a5",
        // v56.5 Update 2: Lightweight Charts' own bottom-left attribution
        // logo, on by default. Removed for the primary chart the same way
        // as every companion panel — see multi-panel.js's createCompanion-
        // Panel() for the identical option on panels 2/3.
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
    });

    // v27: lightweight-charts v5 removed the per-type helpers
    // (addCandlestickSeries/addLineSeries/...). Series are now created via
    // the generic addSeries(SeriesTypeDefinition, options) call, passing the
    // exported CandlestickSeries definition. Options themselves are
    // unchanged, so none of the calculation/rendering behavior below moves.
    App.series = App.chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: "#3fb68b",
      downColor: "#e5484d",
      borderUpColor: "#3fb68b",
      borderDownColor: "#e5484d",
      wickUpColor: "#3fb68b",
      wickDownColor: "#e5484d",
      // v30.1: the built-in last-price line follows the last candle in
      // setData(). That is wrong while the user is viewing older partitions.
      // Its replacement is a standalone PriceLine driven by the actual live
      // price, so horizontal navigation never changes what the line means.
      lastValueVisible: false,
      priceLineVisible: false,
    });

    new ResizeObserver(function (entries) {
      var rect = entries[0].contentRect;
      // v65.5 Update 1: multi-panel.js resizes the primary chart
      // synchronously when a maximize/restore/layout change alters its
      // width (see resyncPanelSize() there), and this observer then fires
      // one frame later with the very same numbers - skip that duplicate
      // resize + overlay clear + repaint.
      var w = Math.round(rect.width);
      var h = Math.round(rect.height);
      if (dom.chartContainer._appliedChartW === w && dom.chartContainer._appliedChartH === h) return;
      if (App.MultiPanel && App.MultiPanel.markSizeApplied) {
        App.MultiPanel.markSizeApplied(dom.chartContainer, w, h);
      } else {
        dom.chartContainer._appliedChartW = w;
        dom.chartContainer._appliedChartH = h;
      }
      App.chart.resize(rect.width, rect.height);
      App.DrawingEngine.resizeDrawCanvas(rect.width, rect.height);
      if (App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
    }).observe(dom.chartContainer);

    // Any time the visible range or price scale changes (pan, zoom,
    // autoscale from live data), the overlay's own render loop (in
    // drawing-engine.js) redraws from the current chart mapping, so drawn
    // objects always track the chart. v41: the overlay now renders
    // on-demand rather than every frame unconditionally, so this callback
    // (and every other range-change subscription below/elsewhere) explicitly
    // asks for the next frame via requestRender() instead of relying on an
    // always-on RAF loop to eventually pick the new range up.

    // v32: trigger Sliding Window as soon as the visible range ENTERS
    // LAZY_LOAD_EDGE_BARS. MouseUp is no longer the trigger.
    App.edgeLoadArmed = { older: true, newer: true };
    App.chart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
      if (App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
      if (!range || App.currentTf === null) return;
      diag("viewport.rangeChange", { range: {from: range.from, to: range.to} });
      // v35.1 Fix 3: range changes caused by an Object Tree Jump are an
      // internal part of the jump transaction, not a user navigation edge.
      // Never start Sliding Window I/O from those transient callbacks.
      if (App.jumpTransactionActive) return;
      // v41.1: Replay deliberately participates in the same Sliding Window
      // edge loader. loadPartition() clamps newer pages to the current Replay
      // playhead, so navigation can move freely both directions without ever
      // revealing the hidden future. Replay has its own right-edge flag; the
      // ordinary Live flag is never borrowed by Replay.
      var arr = App.candlesByTf[App.currentTf] || [];
      var atLeft = range.from < App.LAZY_LOAD_EDGE_BARS;
      var atRight = range.to > (arr.length - 1 - App.LAZY_LOAD_EDGE_BARS);

      // Re-arm only after the visible range has actually moved away from
      // that edge. A range callback emitted by setData() while the same
      // page is being patched must not create another request.
      if (!atLeft) App.edgeLoadArmed.older = true;
      if (!atRight) App.edgeLoadArmed.newer = true;

      if (App.loadingDirectionByTf[App.currentTf]) return;

      if (atLeft && App.edgeLoadArmed.older) {
        App.edgeLoadArmed.older = false;
        loadPartition("older", App.currentTf);
      } else if (atRight && App.edgeLoadArmed.newer) {
        App.edgeLoadArmed.newer = false;
        loadPartition("newer", App.currentTf);
      }
    });

    dom.chartContainer.addEventListener("pointerdown", function (e) {
      App.isPointerDownOnChart = true;
      diag("pointer.down", {pointerId:e.pointerId, button:e.button, buttons:e.buttons, x:e.clientX, y:e.clientY});
    });
    document.addEventListener("pointerup", function (e) {
      diag("pointer.up", {pointerId:e.pointerId, button:e.button, buttons:e.buttons, x:e.clientX, y:e.clientY, beforeRelease:!!App.isPointerDownOnChart});
      App.isPointerDownOnChart = false;
      diag("pointer.up.afterRelease", {});
    });

    initAutoFitButton();
  }


  // ---- v50.3 Update 2: shared Price Line theme ---------------------------
  // canvas-settings.js writes into App.priceLineTheme (color/style/width +
  // the current Background color, used as the price-box TEXT color per
  // spec) any time the Canvas tab's Price Line controls change. Both the
  // primary panel's live price line (below) and every companion panel's
  // own price line (see multi-panel.js) read this same object so all
  // panels always agree on one Price Line look. Defaults here exactly
  // match the pre-v50.3 hardcoded line, so nothing changes visually until
  // the user actually touches the new controls.
  var PL_LINE_STYLE_MAP = { solid: 0, dotted: 1, dashed: 2 };
  App.priceLineTheme = App.priceLineTheme || {
    color: "#8b95a5",
    style: "dashed",
    width: 1,
    textColor: "#0a0e17",
  };
  App.priceLineOptionsFromTheme = function () {
    var theme = App.priceLineTheme;
    var lineStyle = PL_LINE_STYLE_MAP[theme.style];
    if (lineStyle === undefined) lineStyle = PL_LINE_STYLE_MAP.dashed;
    return {
      color: theme.color,
      lineWidth: Number(theme.width) || 1,
      lineStyle: lineStyle,
      axisLabelVisible: true,
      axisLabelColor: theme.color,
      axisLabelTextColor: theme.textColor,
      title: "",
    };
  };

  // V64.1: the live ASK line has its own switch and look (Setting > Canvas >
  // "Enable Ask Price"): color / line type / width, defaults identical to the
  // Price Line's. It never has a label on the price axis. While `enabled` is
  // false (the default) no ASK line exists on any chart.
  App.askTheme = App.askTheme || {
    enabled: false,
    color: "#8b95a5",
    style: "dashed",
    width: 1,
  };
  App.askLineOptionsFromTheme = function () {
    var theme = App.askTheme;
    var lineStyle = PL_LINE_STYLE_MAP[theme.style];
    if (lineStyle === undefined) lineStyle = PL_LINE_STYLE_MAP.dashed;
    return {
      color: theme.color,
      lineWidth: Number(theme.width) || 1,
      lineStyle: lineStyle,
      axisLabelVisible: false,
      title: "",
    };
  };

  // ---- v30.1 live price line ---------------------------------------------
  // Lightweight Charts' built-in last-price line is tied to the last data
  // item in the series. Because V30 deliberately evicts partition 0 while
  // the user walks into older history, that built-in line would silently
  // turn into the close of the oldest resident candle. Keep the line
  // independent from chart history instead: one PriceLine object whose price
  // is updated from the authoritative live candle tail.
  function initLivePriceLine() {
    if (!App.series || App.livePriceLine) return;
    App.livePriceLine = App.series.createPriceLine(
      Object.assign({ price: 0 }, App.priceLineOptionsFromTheme())
    );
  }

  function updateLivePriceLine(price) {
    var numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || !App.series) return;
    if (!App.livePriceLine) initLivePriceLine();
    if (!App.livePriceLine) return;

    App.livePrice = numericPrice;
    App.livePriceLine.applyOptions({ price: numericPrice });
  }

  // History navigation must never replace the remembered live price. This is
  // only a startup fallback for the short interval before the first live tail
  // arrives; once App.livePrice is known, historical candles cannot overwrite
  // it.
  function ensureLivePriceFallback(price) {
    var numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || App.livePrice !== null) return;
    updateLivePriceLine(numericPrice);
  }

  // ---- V64 live ASK line ---------------------------------------------------
  // The BID line follows the candle stream; the ASK line is fed by its own tiny
  // message (window.onLiveAsk) because an ASK-only quote change leaves every
  // candle untouched. The ASK is display-only: it lives in RAM here and in the
  // bridge, and is never written to SQLite.
  //
  // Cost control: quotes can change faster than the screen refreshes, so the
  // latest value is remembered immediately but applied at most once per
  // animation frame, and only when it differs from what is already drawn.
  // (A hidden window pauses requestAnimationFrame, so nothing is drawn while
  // nobody can see it; the newest value is applied when it is shown again.)
  var askFlushPending = false;
  var askDrawnPrice = null;

  function removeLiveAskLines() {
    if (App.liveAskLine && App.series) {
      try { App.series.removePriceLine(App.liveAskLine); } catch (e) { /* already gone */ }
    }
    App.liveAskLine = null;
    askDrawnPrice = null;
    if (App.MultiPanel && App.MultiPanel.clearAsk) App.MultiPanel.clearAsk();
  }

  function flushLiveAsk() {
    askFlushPending = false;
    var price = App.liveAsk;
    // Bar Replay shows a past moment: there is no live ASK to draw then.
    // V64.1: nothing is drawn unless "Enable Ask Price" is checked.
    if (App.replayActive || !App.askTheme.enabled || !Number.isFinite(price) || !App.series) return;
    if (price === askDrawnPrice) return;
    askDrawnPrice = price;
    if (!App.liveAskLine) {
      App.liveAskLine = App.series.createPriceLine(
        Object.assign({ price: price }, App.askLineOptionsFromTheme())
      );
    } else {
      App.liveAskLine.applyOptions({ price: price });
    }
    if (App.MultiPanel && App.MultiPanel.setAsk) App.MultiPanel.setAsk(price);
  }

  function setLiveAsk(price) {
    var numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;
    App.liveAsk = numericPrice;
    // The newest ASK is always remembered (one number), so ticking the
    // checkbox shows the line at once; while it is off nothing is scheduled.
    if (!App.askTheme.enabled || App.replayActive || askFlushPending) return;
    askFlushPending = true;
    window.requestAnimationFrame(flushLiveAsk);
  }

  window.onLiveAsk = setLiveAsk;

  // V64.1: called by canvas-settings.js whenever the Ask Price checkbox or its
  // color / line type / width changes (and at start-up / preset changes).
  function syncAskLine() {
    if (!App.askTheme.enabled) { removeLiveAskLines(); return; }
    var opts = App.askLineOptionsFromTheme();
    if (App.liveAskLine) App.liveAskLine.applyOptions(opts);
    if (App.MultiPanel && App.MultiPanel.getPanels) {
      App.MultiPanel.getPanels().forEach(function (p) {
        if (p && !p.isPrimary && p.askLine) p.askLine.applyOptions(opts);
      });
    }
    // Lines that do not exist yet (just enabled, or a panel opened while the
    // switch was off) are created at the newest known ASK.
    if (Number.isFinite(App.liveAsk) && !App.replayActive) {
      askDrawnPrice = null;
      setLiveAsk(App.liveAsk);
    }
  }

  // Replay hides the ASK line; leaving Replay brings it back at the newest ASK.
  document.addEventListener("App:replayStarted", removeLiveAskLines);
  document.addEventListener("App:replayExited", function () {
    if (Number.isFinite(App.liveAsk)) setLiveAsk(App.liveAsk);
  });

  // A page that loads while the market is quiet has not received an ASK yet:
  // ask the bridge for the newest one it knows (RAM only).
  function loadInitialLiveAsk() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.get_live_ask) return;
    window.pywebview.api.get_live_ask().then(function (ask) {
      if (ask && !Number.isFinite(App.liveAsk)) setLiveAsk(ask);
    }).catch(function () { /* no ASK known yet - the first live tick will supply it */ });
  }

  // ---- (v28) Auto Fit toggle button ---------------------------------------
  // Lightweight Charts already auto-fits the right price scale to visible
  // data by default (`autoScale: true`), and already turns that off on its
  // own the moment the user click+drags the price axis (case 2 below) — it
  // just doesn't ship a visible button for it. This wires up a button that
  // matches TradingView web's own "A" control: reflects the price scale's
  // current autoScale state, and lets clicking it turn Auto Fit back on
  // (case 1).
  function updateAutoFitButtonUI() {
    if (!dom.autofitBtn) return;
    dom.autofitBtn.classList.toggle("active", App.autoFitEnabled);
  }

  function setAutoFit(enabled) {
    if (!App.chart) return;
    App.chart.priceScale("right").applyOptions({ autoScale: enabled });
    App.autoFitEnabled = enabled;
    updateAutoFitButtonUI();
  }

  // Keeps the button in sync with the price scale's actual autoScale
  // state. Needed because dragging the price axis (case 2) flips that
  // state internally inside the charting library, with no event of its
  // own to subscribe to — so we just re-check it on any mouse/touch
  // activity and update the button only when it actually changed.
  function syncAutoFitButton() {
    if (!App.chart) return;
    var enabled = App.chart.priceScale("right").options().autoScale;
    if (enabled === App.autoFitEnabled) return;
    App.autoFitEnabled = enabled;
    updateAutoFitButtonUI();
  }

  function initAutoFitButton() {
    if (!dom.autofitBtn) return;

    // Always start with Auto Fit ON — matches Lightweight Charts' own
    // default (autoScale: true), set explicitly here so it's never
    // silently left however the library's default happens to be.
    App.chart.priceScale("right").applyOptions({ autoScale: true });
    App.autoFitEnabled = true;
    updateAutoFitButtonUI();

    dom.autofitBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      setAutoFit(!App.autoFitEnabled);
    });

    // Pointer events (not mouse-only) so this also tracks touch drags on
    // the price axis. Checking on every move while a button is pressed
    // catches the moment the drag disables autoScale; the pointerup catch
    // handles the case a drag ends between move events.
    document.addEventListener("pointermove", function (e) {
      if (e.buttons) syncAutoFitButton();
    });
    document.addEventListener("pointerup", syncAutoFitButton);
    // Double-clicking the price axis also resets Lightweight Charts'
    // autoScale to true (its own axisDoubleClickReset.price behavior).
    // pointerup already fires for that click, but dblclick is added too
    // as a direct, explicit catch for this exact gesture.
    document.addEventListener("dblclick", syncAutoFitButton);
  }

  // ---- Sliding Window adapters ------------------------------------------
  function getWindow(tf) {
    return App.windowByTf[tf] || null;
  }

  // v57 Update 17 (bug fix): every async history read sets
  // App.loadingDirectionByTf[tf] as an in-flight lock, and loadPartition()
  // refuses to start while that lock is set. The "this response is stale"
  // early returns scattered through those reads all returned WITHOUT
  // releasing it - so a read that got superseded (a Jump, a HOME/END, or a
  // re-selection of the timeframe already being shown, each of which bumps
  // App.historyGeneration) left the lock set forever, and the Sliding Window
  // silently stopped loading any further history for that timeframe until
  // the user switched timeframes and back.
  //
  // Each acquisition gets a unique token, and a release only takes effect
  // while that token is still the current holder - so a superseded read can
  // safely try to release without ever clearing a lock that a newer read has
  // since taken for itself.
  var loadTokenSeq = 0;
  App.loadingTokenByTf = App.loadingTokenByTf || {};

  function acquireLoadingLock(tf, direction) {
    var token = ++loadTokenSeq;
    App.loadingDirectionByTf[tf] = direction;
    App.loadingTokenByTf[tf] = token;
    return token;
  }

  function releaseLoadingLock(tf, token) {
    if (App.loadingTokenByTf[tf] !== token) return;
    App.loadingDirectionByTf[tf] = null;
    App.loadingTokenByTf[tf] = null;
  }

  // Unconditional release, for the paths that reset a timeframe's history
  // state wholesale (a fresh initial partition) rather than completing one
  // specific read.
  function clearLoadingLock(tf) {
    App.loadingDirectionByTf[tf] = null;
    App.loadingTokenByTf[tf] = null;
  }

  function combineActivePartitions(tf) {
    var w = getWindow(tf);
    return App.SlidingWindow.combine(w);
  }

  function applyDragAnchorShift(shift) {
    var ts = App.chart.timeScale();
    diag("dragAnchor.before", {shift:shift, hasInternalAnchor:!!ts.ia});
    if (!ts.ia) {
      return false;
    }
    ts.ia.lc = ts.ia.Oc() + shift;
    if (ts.ia.nc) ts.ia.nc.Oc += shift;
    ts.ia.Xu = true;
    if (ts.ia.sn && typeof ts.ia.sn.zc === "function") ts.ia.sn.zc();
    if (ts.ia.sn && typeof ts.ia.sn.mr === "function") ts.ia.sn.mr();
    diag("dragAnchor.after", {shift:shift, range:ts.getVisibleLogicalRange()});
    return true;
  }

  function setActiveChartData(tf, visibleLogical, logicalShift, dragPatch, firstLiveToTwoSlotPatch, firstOldestToTwoSlotPatch) {
    var arr = combineActivePartitions(tf);
    var w = getWindow(tf);
    var renderArr = App.SlidingWindow.combineRender ? App.SlidingWindow.combineRender(w) : arr;
    App.candlesByTf[tf] = renderArr;
    if (tf !== App.currentTf || !App.series) return;

    diag("setActiveChartData.begin", {
      dataCount: renderArr.length, logicalShift: logicalShift || 0, dragPatch: !!dragPatch,
      firstLiveToTwoSlotPatch: !!firstLiveToTwoSlotPatch, firstOldestToTwoSlotPatch: !!firstOldestToTwoSlotPatch,
      visibleLogical: visibleLogical ? {from: visibleLogical.from, to: visibleLogical.to} : null
    });
    var beforeSetData = App.chart.timeScale().getVisibleLogicalRange();
    App.series.setData(renderArr);
    var afterSetData = App.chart.timeScale().getVisibleLogicalRange();
    diag("setData.rangeEffect", {
      before: beforeSetData ? {from: beforeSetData.from, to: beforeSetData.to} : null,
      after: afterSetData ? {from: afterSetData.from, to: afterSetData.to} : null, dataCount: renderArr.length
    });
    if (!visibleLogical) return;

    var shift = logicalShift || 0;
    var desiredRange = {
      from: visibleLogical.from + shift,
      to: visibleLogical.to + shift,
    };

    // v55.4: setData() can internally re-anchor Lightweight Charts before
    // the browser paints the next frame. Restoring the desired logical range
    // with another public setVisibleLogicalRange() call can therefore expose
    // a one-frame left/right hop (most visible on live-partition rollover,
    // where every drawing object appears to move by exactly one candle and
    // immediately snaps back). When the library exposes its current anchor,
    // correct that anchor by the exact delta needed to reach the target range
    // instead. The fallback keeps the public API path for builds where the
    // private anchor shape is unavailable.
    function preserveLogicalRange(target) {
      var current = App.chart.timeScale().getVisibleLogicalRange();
      if (!current || Math.abs(current.from - target.from) < 1e-9 && Math.abs(current.to - target.to) < 1e-9) {
        return true;
      }
      var correction = target.from - current.from;
      if (applyDragAnchorShift(correction)) return true;
      try {
        App.chart.timeScale().setVisibleLogicalRange(target);
        return true;
      } catch (_) {
        return false;
      }
    }

    if (!dragPatch) {
      preserveLogicalRange(desiredRange);
      return;
    }

    // During a drag, preserve continuity by moving the library's active drag
    // anchor exactly once for the logical shift introduced by the window
    // transition. The only special case is HOME -> first newer partition:
    // setData() itself creates the implicit +oldPartition shift, so compensate
    // the anchor by that implicit amount instead of performing a second shift.
    if (firstOldestToTwoSlotPatch) {
      // HOME -> first newer historical partition: setData() itself creates
      // the implicit +oldestPartition shift. Move only the internal drag
      // anchor back by that implicit amount; do not apply a second range shift.
      var implicitFirstRightShift = -(App.windowByTf[App.currentTf].older?.length || 0);
      if (!applyDragAnchorShift(implicitFirstRightShift)) {
        App.chart.timeScale().setVisibleLogicalRange({
          from: visibleLogical.from,
          to: visibleLogical.to,
        });
      }
      return;
    }

    if (applyDragAnchorShift(shift)) {
      // V64.2: the anchor shift above assumes setData() itself moved nothing,
      // which only holds when the slot that was evicted/kept has exactly the
      // size of the page that arrived. When the two differ (a live slot that
      // holds fewer candles than a full page) the view lands off by that
      // difference and visibly jumps. Measure where the view really is and
      // move the anchor by the remaining error (normally zero -> no-op).
      var landed = App.chart.timeScale().getVisibleLogicalRange();
      if (landed && Math.abs(landed.from - desiredRange.from) > 0.5) {
        applyDragAnchorShift(desiredRange.from - landed.from);
      }
      return;
    }

    App.chart.timeScale().setVisibleLogicalRange({
      from: visibleLogical.from + shift,
      to: visibleLogical.to + shift,
    });
  }

  function rememberInitialPartition(tf, candles) {
    var w = App.SlidingWindow.initialLive(candles || []);
    App.windowByTf[tf] = w;
    clearLoadingLock(tf);
    App.candlesByTf[tf] = candles || [];
  }

  function loadPartition(direction, tf) {
    if (App.loadingDirectionByTf[tf]) return;
    var requestGeneration = App.historyGeneration;
    var w = getWindow(tf);
    if (!w) return;
    if (direction === "older" && w.exhaustedOlder) return;
    if (direction === "newer" && (w.rightIsLive || w.rightIsReplay)) return;

    var source = direction === "older" ? (w.older || w.newer) : ((w.oldestRenderBuffer && w.oldestRenderBuffer.length) ? w.oldestRenderBuffer : (w.newer || w.older));
    if (!source || !source.length) return;

    // v41: Replay uses the exact same timestamp/partition loader as normal
    // history. The only difference is that the Replay playhead is a moving
    // right boundary: a "newer" page may never expose candles beyond it.
    // This deliberately leaves SlidingWindow.applyHistoryPage() untouched,
    // so all of the old first-live/first-oldest/partial-page protections are
    // reused byte-for-byte for Replay navigation.
    var replayCutoff = App.replayActive && App.replayCutoffByTf
      ? Number(App.replayCutoffByTf[tf])
      : NaN;

    diag("partition.request.start", {
      direction:direction, sourceFirst:source[0].time, sourceLast:source[source.length - 1].time,
      sourceLen:source.length, chunk:App.LAZY_LOAD_CHUNK, requestGeneration:requestGeneration,
      replay:App.replayActive, replayCutoff:Number.isFinite(replayCutoff) ? replayCutoff : null
    });

    var loadToken = acquireLoadingLock(tf, direction);

    var request = direction === "newer"
      ? window.pywebview.api.get_history_page_after(tf, source[source.length - 1].time, App.LAZY_LOAD_CHUNK)
      : window.pywebview.api.get_history_page(tf, source[0].time, App.LAZY_LOAD_CHUNK);

    request.then(function (payload) {
      if (requestGeneration !== App.historyGeneration || App.currentTf !== tf) {
        releaseLoadingLock(tf, loadToken);
        return;
      }

      // v57 Update 9 (bug fix): re-read the window instead of trusting the
      // `w` captured before this request went out. window.onLiveCandles ->
      // mergeAuthoritativeTail() REPLACES App.windowByTf[tf] with a fresh
      // object on every live tick, so a page that was requested a few
      // hundred milliseconds ago would otherwise apply its transition to a
      // stale snapshot and write it back - throwing away every live candle
      // that arrived while the page was in flight. Nothing else about the
      // transition changes; it just operates on the window that is actually
      // resident right now.
      w = getWindow(tf) || w;

      var rawCandles = Array.isArray(payload) ? payload : ((payload && payload.candles) || []);
      var candles = rawCandles;
      var backendPageIsLatest = !!(payload && !Array.isArray(payload) && payload.is_latest);
      var pageIsLatest = backendPageIsLatest;
      var pageIsOldest = !!(payload && !Array.isArray(payload) && payload.is_oldest);
      var pageIsReplayLatest = false;

      if (App.replayActive && direction === "newer" && Number.isFinite(replayCutoff)) {
        // Never let a backend page reveal the future of the current Replay
        // playhead. If the backend page crosses the playhead, this is the
        // Replay equivalent of reaching the live edge.
        candles = rawCandles.filter(function (c) { return Number(c.time) <= replayCutoff; });
        var rawLast = rawCandles.length ? Number(rawCandles[rawCandles.length - 1].time) : NaN;
        pageIsReplayLatest = Number.isFinite(rawLast) && rawLast >= replayCutoff;
        // Reuse SlidingWindow's exact latest-page/partial-page transition for
        // the Replay edge. `applyHistoryPage()` keeps rightIsLive=false when
        // pageIsReplayLatest is set, so this does not leak real-Live state.
        pageIsLatest = pageIsReplayLatest;
        if (backendPageIsLatest && rawCandles.length && !candles.length) {
          pageIsReplayLatest = true;
        }
      }
      diag("partition.request.response", {direction:direction, count:candles.length, first:candles.length?candles[0].time:null, last:candles.length?candles[candles.length-1].time:null, pageIsLatest:pageIsLatest, pageIsOldest:pageIsOldest});
      if (!candles.length) {
        if (direction === "older") {
          w.exhaustedOlder = true;
        } else if (App.replayActive && Number.isFinite(replayCutoff)) {
          var currentNewer = w.newer && w.newer.length ? w.newer[w.newer.length - 1].time : NaN;
          if (pageIsReplayLatest || (Number.isFinite(currentNewer) && currentNewer >= replayCutoff)) {
            w.rightIsReplay = true;
            w.rightIsLive = false;
          }
        } else {
          w.rightIsLive = true;
        }
        releaseLoadingLock(tf, loadToken);
        return;
      }

      var visibleLogical = (tf === App.currentTf && App.chart)
        ? App.chart.timeScale().getVisibleLogicalRange()
        : null;
      var dragPatch = !!App.isPointerDownOnChart;
      diag("partition.before.apply", {direction:direction, oldOlderLen:w.older?w.older.length:0, oldNewerLen:w.newer?w.newer.length:0, oldestBufferLen:w.oldestRenderBuffer?w.oldestRenderBuffer.length:0, pageIsLatest:pageIsLatest, pageIsOldest:pageIsOldest});
      var transition = App.SlidingWindow.applyHistoryPage(w, direction, candles, {
        pageIsLatest: pageIsLatest,
        pageIsOldest: pageIsOldest,
        pageIsReplayLatest: App.replayActive && direction === "newer" && pageIsReplayLatest,
      });

      App.windowByTf[tf] = transition.window;
      diag("partition.applied", {direction:direction, transition:{shift:transition.shift, addedCount:transition.addedCount, firstLiveToTwoSlotPatch:!!transition.firstLiveToTwoSlotPatch, firstOldestToTwoSlotPatch:!!transition.firstOldestToTwoSlotPatch}, afterOlderLen:transition.window.older?transition.window.older.length:0, afterNewerLen:transition.window.newer?transition.window.newer.length:0, afterOldestBufferLen:transition.window.oldestRenderBuffer?transition.window.oldestRenderBuffer.length:0});
      setActiveChartData(
        tf,
        visibleLogical,
        transition.shift,
        dragPatch && !transition.firstLiveToTwoSlotPatch,
        transition.firstLiveToTwoSlotPatch,
        transition.firstOldestToTwoSlotPatch
      );

      if (App.replayActive && App.ReplayBar && App.ReplayBar.syncPrimaryWindow) {
        App.ReplayBar.syncPrimaryWindow(tf);
      }

      if (dragPatch) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            releaseLoadingLock(tf, loadToken);
          });
        });
      } else {
        releaseLoadingLock(tf, loadToken);
      }
    }).catch(function (err) {
      releaseLoadingLock(tf, loadToken);
      console.error("loadPartition failed:", direction, tf, err);
    });
  }

  // v23: the 1m/5m/15m/1h/1D (>= 60s) timeframes were removed, so every
  // configured timeframe used to be expressed in whole seconds only.
  //
  // v38: 1m/5m/15m/1h are back (see config.CHART_TIMEFRAMES_SECONDS /
  // candle_cache._TF_TABLES), so this now formats any whole-minute or
  // whole-hour timeframe with the friendlier "1m"/"1h" style instead of
  // an oversized second count, while every remaining sub-minute
  // timeframe keeps the plain "Ns" label it always had.
  function formatTfLabel(tf) {
    if (tf % 3600 === 0) return (tf / 3600) + "h";
    if (tf % 60 === 0) return (tf / 60) + "m";
    return tf + "s";
  }

  // v30: timeframe switches release every old partition before the new
  // timeframe is initialized at partition 0. This keeps RAM usage bounded
  // across timeframe changes as well as within one timeframe.
  function showTimeframe(tf, jumpToLive) {
    if (jumpToLive === undefined) jumpToLive = true;

    var requestGeneration = ++App.historyGeneration;
    var preservedLogical = (!jumpToLive && App.chart)
      ? App.chart.timeScale().getVisibleLogicalRange()
      : null;
    var oldTf = App.currentTf;

    if (oldTf !== null && oldTf !== tf) {
      delete App.windowByTf[oldTf];
      delete App.candlesByTf[oldTf];
      delete App.loadingDirectionByTf[oldTf];
      delete App.loadingTokenByTf[oldTf];
      // v57 Update 9: released with the rest of the outgoing timeframe's
      // state rather than kept for the life of the session.
      if (App.replayCutoffByTf) delete App.replayCutoffByTf[oldTf];
    }
    // v57 Update 9: the edge-load arm flags are global, not per timeframe, so
    // whatever state the PREVIOUS timeframe left them in carried straight
    // over into the new one. Landing at an edge that happened to be disarmed
    // meant the first scroll in that direction did nothing until the viewport
    // moved away from the edge and back again.
    if (App.edgeLoadArmed) { App.edgeLoadArmed.older = true; App.edgeLoadArmed.newer = true; }

    App.currentTf = tf;
    updateTfDropdownUI();
    // v41 perf: a timeframe switch always changes which candles are on
    // screen, and can coincide with a visible-range change that happens to
    // be a no-op (e.g. the preserved logical range numerically matches),
    // which wouldn't reliably fire subscribeVisibleLogicalRangeChange -
    // request the repaint directly rather than depending on that callback.
    if (App.DrawingEngine && App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
    // v33.1 Fix 6: the Object Tree panel's out-of-range grey-out depends
    // on the CURRENTLY DISPLAYED timeframe's bounds — notify it here, the
    // one place every timeframe switch (dropdown click or initial boot)
    // funnels through, rather than duplicating a "did the tf change" check
    // at every call site.
    document.dispatchEvent(new CustomEvent("App:timeframeChanged", { detail: { tf: tf } }));

    if (!App.windowByTf[tf]) {
      window.pywebview.api.get_history_set(tf).then(function (data) {
        if (requestGeneration !== App.historyGeneration || App.currentTf !== tf) return;
        var candles = (data && data[String(tf)]) || [];
        rememberInitialPartition(tf, candles);
        App.series.setData(candles);
        if (candles.length) ensureLivePriceFallback(candles[candles.length - 1].close);
        if (jumpToLive) App.chart.timeScale().scrollToRealTime();
        else if (preservedLogical) App.chart.timeScale().setVisibleLogicalRange(preservedLogical);
        App.chart.applyOptions({ timeScale: { secondsVisible: true } });
      }).catch(function (err) {
        console.error("showTimeframe failed:", err);
      });
      return;
    }

    setActiveChartData(tf, preservedLogical, 0);
    if (jumpToLive) App.chart.timeScale().scrollToRealTime();
    else if (preservedLogical) App.chart.timeScale().setVisibleLogicalRange(preservedLogical);
    App.chart.applyOptions({ timeScale: { secondsVisible: true } });
  }

  // ---- Symbol dropdown (v53) ----------------------------------------------
  // Single-column, keyboard-friendly symbol picker. Search is prefix-based:
  // typing "XA" immediately keeps only symbol names beginning with XA.
  var MAX_RENDERED_SYMBOLS = 300;

  function buildSymbolDropdown(symbols, cachedSymbols) {
    if (!dom.symbolDropdownList) return;
    dom.symbolDropdownList.innerHTML = "";

    // v65.2: symbols that already have a local candle database get pinned to
    // the top of the at-rest list (not while actively searching - a search
    // query is a stronger signal of intent than "what do I already have").
    var cachedSet = {};
    (cachedSymbols || []).forEach(function (s) { cachedSet[String(s).toUpperCase()] = true; });

    var items = (symbols || []).map(function (item) {
      var symbol = (item && typeof item === "object") ? String(item.symbol || "") : String(item || "");
      return {
        symbol: symbol,
        description: (item && typeof item === "object") ? String(item.description || "") : "",
        cached: !!cachedSet[symbol.toUpperCase()]
      };
    }).filter(function (item) { return !!item.symbol; });

    items.sort(function (a, b) {
      if (a.cached !== b.cached) return a.cached ? -1 : 1;
      return a.symbol.localeCompare(b.symbol, undefined, { sensitivity: "base" });
    });

    var searchWrap = document.createElement("div");
    searchWrap.className = "symbol-search-wrap";

    var searchIcon = document.createElement("span");
    searchIcon.className = "symbol-search-icon";
    searchIcon.setAttribute("aria-hidden", "true");
    searchIcon.textContent = "";

    var searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "symbol-search-input";
    searchInput.placeholder = "Search by name...";
    searchInput.setAttribute("aria-label", "Search symbols by name");
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;

    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "symbol-search-clear";
    clearBtn.title = "Clear search";
    clearBtn.setAttribute("aria-label", "Clear search");
    clearBtn.textContent = "×";

    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(clearBtn);
    dom.symbolDropdownList.appendChild(searchWrap);

    var rowsWrap = document.createElement("div");
    rowsWrap.className = "symbol-options";
    dom.symbolDropdownList.appendChild(rowsWrap);

    // v57 Update 10: pre-computed uppercase keys. A broker symbol list is
    // routinely 1000+ entries and the old filter upper-cased every symbol
    // again on every keystroke.
    items.forEach(function (item) {
      item._symbolUpper = item.symbol.toUpperCase();
      item._descUpper = item.description ? item.description.toUpperCase() : "";
    });

    var firstMatch = null;

    function selectSymbol(name) {
      closeSymbolDropdown();
      if (!name || name === App.symbol) return;
      if (window.pywebview && window.pywebview.api && window.pywebview.api.set_symbol) {
        window.pywebview.api.set_symbol(name).then(function (result) {
          if (result && result.ok) window.location.reload();
        });
      }
    }

    // v57 Update 10: ONE delegated listener for the whole list, attached
    // once - instead of one closure per row re-created on every keystroke.
    rowsWrap.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".symbol-option") : null;
      if (!btn || !rowsWrap.contains(btn)) return;
      selectSymbol(btn.dataset.symbol);
    });

    function buildRow(item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "symbol-option";
      if (item.symbol === App.symbol) btn.classList.add("active");
      btn.dataset.symbol = item.symbol;

      var symbolLabel = document.createElement("span");
      symbolLabel.className = "symbol-option-symbol";

      var symbolText = document.createElement("span");
      symbolText.className = "symbol-option-symbol-text";
      symbolText.textContent = item.symbol;
      symbolLabel.appendChild(symbolText);

      if (item.cached) {
        var dot = document.createElement("span");
        dot.className = "symbol-option-db-dot";
        dot.title = "Already synced on this device";
        symbolLabel.appendChild(dot);
      }
      btn.appendChild(symbolLabel);

      if (item.description) {
        var descriptionLabel = document.createElement("span");
        descriptionLabel.className = "symbol-option-description";
        descriptionLabel.textContent = item.description;
        btn.appendChild(descriptionLabel);
      }
      return btn;
    }

    function renderRows(query) {
      var q = String(query || "").trim().toUpperCase();
      // v57 Update 10: search used to be strictly prefix-on-symbol-name, so
      // typing "GOLD" found nothing for an instrument named XAUUSD even
      // though its description says Gold, and typing "USD" found nothing at
      // all for EURUSD. Matching is now: name prefix first (the old
      // behavior, still ranked top so the exact thing you're typing stays
      // first), then anywhere in the name, then anywhere in the description.
      var prefixHits = [];
      var nameHits = [];
      var descHits = [];

      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!q) { prefixHits.push(item); continue; }
        var at = item._symbolUpper.indexOf(q);
        if (at === 0) prefixHits.push(item);
        else if (at > 0) nameHits.push(item);
        else if (item._descUpper && item._descUpper.indexOf(q) !== -1) descHits.push(item);
      }

      var matches = prefixHits.concat(nameHits, descHits);
      firstMatch = matches.length ? matches[0].symbol : null;

      // v65.2: only at rest (no query) is pin-order worth calling out with a
      // divider label - mid-search, relevance order already answers "why is
      // this here", and a divider would just interrupt scanning results.
      var pinnedDividerIndex = -1;
      if (!q && matches.length) {
        var firstUncachedIdx = -1;
        for (var k = 0; k < matches.length; k++) {
          if (!matches[k].cached) { firstUncachedIdx = k; break; }
        }
        if (firstUncachedIdx > 0) pinnedDividerIndex = firstUncachedIdx;
      }

      // v57 Update 10: a broker list can run to several thousand symbols, and
      // rendering all of them builds ~3 DOM nodes each for rows nobody will
      // ever scroll to. Cap what's materialized and say so plainly - typing
      // one more character is both faster and a better way to find a symbol
      // than scrolling a 2000-row list.
      var shown = Math.min(matches.length, MAX_RENDERED_SYMBOLS);

      // One fragment, one DOM insertion - rather than thousands of
      // individual appendChild() reflow opportunities per keystroke.
      var frag = document.createDocumentFragment();
      if (!matches.length) {
        var empty = document.createElement("div");
        empty.className = "symbol-search-empty";
        empty.textContent = "No symbols found";
        frag.appendChild(empty);
      } else {
        for (var j = 0; j < shown; j++) {
          if (j === pinnedDividerIndex) {
            var divider = document.createElement("div");
            divider.className = "symbol-pin-divider";
            divider.textContent = "All symbols";
            frag.appendChild(divider);
          }
          frag.appendChild(buildRow(matches[j]));
        }
        if (matches.length > shown) {
          var more = document.createElement("div");
          more.className = "symbol-search-empty";
          more.textContent = (matches.length - shown) + " more \u2014 keep typing to narrow";
          frag.appendChild(more);
        }
      }
      rowsWrap.innerHTML = "";
      rowsWrap.appendChild(frag);

      var label = document.getElementById("symbol-name");
      if (label) label.textContent = App.symbol || "\u2014";
    }

    searchInput.addEventListener("input", function () {
      renderRows(searchInput.value);
      clearBtn.classList.toggle("visible", !!searchInput.value);
    });
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        searchInput.value = "";
        clearBtn.classList.remove("visible");
        renderRows("");
        searchInput.blur();
      } else if (e.key === "Enter") {
        // v57 Update 10: type a few letters, press Enter - no reaching for
        // the mouse to click the row that's already at the top of the list.
        if (firstMatch) selectSymbol(firstMatch);
      }
      e.stopPropagation();
    });
    searchInput.addEventListener("click", function (e) { e.stopPropagation(); });
    clearBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      searchInput.value = "";
      clearBtn.classList.remove("visible");
      renderRows("");
      searchInput.focus();
    });

    renderRows("");
  }

  function updateSymbolDropdownUI() {
    if (!dom.symbolDropdownLabel) return;
    var label = document.getElementById("symbol-name");
    if (label) label.textContent = App.symbol || "—";
    Array.prototype.forEach.call(dom.symbolDropdownList ? dom.symbolDropdownList.querySelectorAll(".symbol-option") : [], function (btn) {
      btn.classList.toggle("active", btn.dataset.symbol === App.symbol);
    });
  }

  function openSymbolDropdown() {
    if (dom.symbolDropdownEl) {
      dom.symbolDropdownEl.classList.add("open");
      var input = dom.symbolDropdownEl.querySelector(".symbol-search-input");
      if (input) setTimeout(function () { input.focus(); }, 0);
    }
  }
  function closeSymbolDropdown() { if (dom.symbolDropdownEl) dom.symbolDropdownEl.classList.remove("open"); }

  if (dom.symbolDropdownBtn) {
    dom.symbolDropdownBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (dom.symbolDropdownEl.classList.contains("open")) closeSymbolDropdown();
      else openSymbolDropdown();
    });
  }

  // ---- Timeframe dropdown (Update 1) --------------------------------------
  // Replaces the old "one button per timeframe" row with a single button
  // that opens a scrollable list — scales cleanly however many timeframes
  // config.py exposes, without crowding the header.
  function buildTfDropdown() {
    dom.tfDropdownList.innerHTML = "";
    App.TIMEFRAMES.forEach(function (tf) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = formatTfLabel(tf);
      btn.dataset.tf = tf;
      btn.addEventListener("click", function () {
        // v40 Update 4: while Bar Replay is active, the reference timeframe
        // must stay changeable — even mid-Play — without ever falling back
        // to a real backend live fetch (which would break the replay
        // illusion). Route through ReplayBar's own handler instead.
        if (App.replayActive && App.ReplayBar && App.ReplayBar.changeTimeframe) {
          App.ReplayBar.changeTimeframe(tf);
        } else {
          showTimeframe(tf);
        }
        closeTfDropdown();
      });
      dom.tfDropdownList.appendChild(btn);
    });
  }

  function updateTfDropdownUI() {
    dom.tfDropdownLabel.textContent = App.currentTf === null ? "—" : formatTfLabel(App.currentTf);
    Array.prototype.forEach.call(dom.tfDropdownList.children, function (btn) {
      btn.classList.toggle("active", Number(btn.dataset.tf) === App.currentTf);
    });
  }

  function openTfDropdown() { dom.tfDropdownEl.classList.add("open"); }
  function closeTfDropdown() { dom.tfDropdownEl.classList.remove("open"); }

  dom.tfDropdownBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (dom.tfDropdownEl.classList.contains("open")) closeTfDropdown();
    else openTfDropdown();
  });

  document.addEventListener("click", function (e) {
    if (!dom.tfDropdownEl.contains(e.target)) closeTfDropdown();
    if (dom.symbolDropdownEl && !dom.symbolDropdownEl.contains(e.target)) closeSymbolDropdown();
  });

  // ---- Loading history from Python ---------------------------------------
  // v30: only one timeframe is fetched at startup. Other timeframes are
  // loaded on demand when the user switches to them.
  function loadHistorySet(tf) {
    return window.pywebview.api.get_history_set(tf).then(function (data) {
      return (data && data[String(tf)]) || [];
    });
  }

  // ---- Status dot: online (green) / offline (red) / syncing (orange) -----
  // App.backendStatus is the only state used to drive the connection dot.
  function updateStatusDot() {
    var cls;
    if (App.backendStatus === "offline") {
      cls = "offline";
    } else if (App.backendStatus === "syncing") {
      cls = "syncing";
    } else {
      cls = "live";
    }
    dom.liveDotEl.classList.remove("live", "syncing", "offline");
    dom.liveDotEl.classList.add(cls);
  }

  // Sent by the sync process (sync_process.py) any time its own view of
  // the MT5 connection changes - see the "status" message type in
  // app.py's _live_queue_consumer. Purely reflects state the backend
  // already reaches on its own; this never drives any decision, only
  // display.
  window.onStatus = function (status) {
    App.backendStatus = status;
    updateStatusDot();
  };

  // v62: the sync process (the only place that talks to MT5) discovered the
  // broker's symbol list in the background - the window itself started from
  // the last known session without asking MT5 anything.
  window.onSymbolList = function (symbols, cachedSymbols) {
    // v65.2: cachedSymbols is optional - older backends (or the odd caller
    // that only knows about the raw symbol list) simply produce a dropdown
    // with nothing pinned, instead of throwing.
    buildSymbolDropdown(symbols || [], cachedSymbols || []);
    updateSymbolDropdownUI();
  };

  // v62: the logged-in account turned out to be on a different broker server
  // than the startup guess; the backend already switched its database, so
  // reload the page exactly like a manual symbol change does.
  window.onIdentityChanged = function () {
    window.location.reload();
  };

  // Align the latest actual candle with the right chart boundary while
  // preserving the current zoom. scrollToRealTime() can intentionally leave
  // a library right-offset, which made END stop slightly before the live bar.
  function alignLatestCandleToRight() {
    if (!App.chart || App.currentTf === null) return;
    var arr = App.candlesByTf[App.currentTf] || [];
    if (!arr.length) return;
    var visible = App.chart.timeScale().getVisibleLogicalRange();
    var barsOnScreen = visible ? (visible.to - visible.from) : Math.min(arr.length - 1, 100);
    if (!(barsOnScreen > 0)) barsOnScreen = Math.min(arr.length - 1, 100);
    var last = arr.length - 1;
    App.chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, last - barsOnScreen),
      to: last,
    });
  }

  // ---- v31 Home/End + arbitrary-time jumps -------------------------------
  // HOME/END are hard positioning operations. They install one bounded
  // chronological slot and let the normal timestamp-based loader fill the
  // second slot only when the user actually navigates.
  function jumpToLatest() {
    if (!App.chart || App.currentTf === null) return;
    var tf = App.currentTf;
    var requestGeneration = ++App.historyGeneration;
    var w = getWindow(tf);

    // The right slot is authoritative Live only when it explicitly carries
    // rightIsLive. A merely newer historical slot is not enough.
    if (w && w.newer && w.rightIsLive) {
      var arr = App.candlesByTf[tf] || [];
      if (arr.length) alignLatestCandleToRight();
      return;
    }

    var latestToken = acquireLoadingLock(tf, "newer");
    window.pywebview.api.get_history_set(tf).then(function (data) {
      if (requestGeneration !== App.historyGeneration || App.currentTf !== tf) {
        releaseLoadingLock(tf, latestToken);
        return;
      }
      releaseLoadingLock(tf, latestToken);
      var candles = (data && data[String(tf)]) || [];
      if (!candles.length) return;

      var next = App.SlidingWindow.initialLive(candles);
      App.windowByTf[tf] = next;
      App.candlesByTf[tf] = candles;
      App.series.setData(candles);
      if (candles.length) ensureLivePriceFallback(candles[candles.length - 1].close);
      App.edgeLoadArmed.older = true;
      App.edgeLoadArmed.newer = true;
      alignLatestCandleToRight();
    }).catch(function (err) {
      releaseLoadingLock(tf, latestToken);
      console.error("END jump failed:", err);
    });
  }

  function jumpToOldest() {
    if (!App.chart || App.currentTf === null) return;
    var tf = App.currentTf;
    var requestGeneration = ++App.historyGeneration;
    var oldestToken = acquireLoadingLock(tf, "older");

    window.pywebview.api.get_oldest_history_partition(tf, App.LAZY_LOAD_CHUNK).then(function (candles) {
      if (requestGeneration !== App.historyGeneration || App.currentTf !== tf) {
        releaseLoadingLock(tf, oldestToken);
        return;
      }
      releaseLoadingLock(tf, oldestToken);
      candles = candles || [];
      if (!candles.length) return;

      var next = App.SlidingWindow.initialOldest(candles);
      App.windowByTf[tf] = next;
      App.candlesByTf[tf] = candles;
      App.series.setData(candles);
      App.edgeLoadArmed.older = true;
      App.edgeLoadArmed.newer = true;

      var visible = App.chart.timeScale().getVisibleLogicalRange();
      var barsOnScreen = visible ? (visible.to - visible.from) : (candles.length - 1);
      if (!(barsOnScreen > 0)) barsOnScreen = candles.length - 1;
      App.chart.timeScale().setVisibleLogicalRange({ from: 0, to: barsOnScreen });
    }).catch(function (err) {
      releaseLoadingLock(tf, oldestToken);
      console.error("HOME jump failed:", err);
    });
  }

  // v57 Update 14 (UX): the startup path had no failure branch at all - if
  // get_config() or the first history read rejected (bridge not ready, an
  // unreadable data file, a backend exception), the overlay simply sat on
  // "Loading candles…" forever with nothing in the UI to say why. Every
  // other long-running action in this app reports its own outcome; startup
  // should too.
  function showStartupMessage(text) {
    if (!dom.statusBanner) return;
    dom.statusBanner.textContent = text;
    dom.statusBanner.style.display = "";
  }

  function init() {
    createChart();
    App.DrawingEngine.init();
    updateStatusDot();

    window.pywebview.api.get_config().then(function (cfg) {
      App.TIMEFRAMES = cfg.timeframes_seconds;
      if (cfg.lazy_load_chunk) App.LAZY_LOAD_CHUNK = cfg.lazy_load_chunk;
      // v51: selected symbol comes from per-server persistent storage;
      // config.py SYMBOL is only the first-run default.
      App.symbol = cfg.symbol || "";
      buildSymbolDropdown(cfg.symbols || [], cfg.cached_symbols || []);
      updateSymbolDropdownUI();
      buildTfDropdown();

      var firstTf = App.TIMEFRAMES[0];
      loadHistorySet(firstTf).then(function (candles) {
        App.currentTf = firstTf;
        updateTfDropdownUI();
        rememberInitialPartition(firstTf, candles);
        App.series.setData(candles);
        if (candles.length) ensureLivePriceFallback(candles[candles.length - 1].close);
        App.chart.timeScale().scrollToRealTime();
        App.chart.applyOptions({ timeScale: { secondsVisible: true } });
        // v57 Update 14: an empty database isn't an error - it's the normal
        // first-run state while the sync process is still pulling history -
        // so say that rather than showing an empty chart with no explanation.
        // The sync process's own "reload" (window.onCacheReady) clears it as
        // soon as the first candles land.
        if (candles.length) dom.statusBanner.style.display = "none";
        else showStartupMessage("Waiting for market data from MetaTrader 5…");
      }).catch(function (err) {
        console.error("Initial history load failed:", err);
        showStartupMessage("Could not read the stored market data. See the log window for details.");
      });
    }).catch(function (err) {
      console.error("get_config failed:", err);
      showStartupMessage("Could not reach the application backend. See the log window for details.");
    });
  }

  // ---- Cache-ready reload -------------------------------------------------
  // Cache refreshes are allowed to replace only the resident live slot.
  // Historical windows are intentionally untouched.
  window.onCacheReady = function () {
    // v40 Update 1/2: Bar Replay owns App.series/App.candlesByTf for the
    // whole duration of the active timeframe — a cache-ready reload here
    // would silently splice real live candles back in over the replayed
    // ones. replay-bar.js restores normal cache-ready handling itself when
    // Replay mode is closed.
    if (App.replayActive) return;
    var tf = App.currentTf !== null ? App.currentTf : App.TIMEFRAMES[0];
    if (tf === undefined || tf === null) return;

    updateStatusDot();

    window.pywebview.api.get_history_set(tf).then(function (data) {
      var candles = (data && data[String(tf)]) || [];
      if (!candles.length) return;
      // v57 Update 14: first candles of a fresh install have just arrived.
      if (dom.statusBanner) dom.statusBanner.style.display = "none";

      var w = getWindow(tf);
      if (!w) {
        rememberInitialPartition(tf, candles);
        showTimeframe(tf, App.currentTf === null);
        return;
      }

      // Only the explicitly live newer slot may be replaced by cache-ready.
      // A historical newer slot after Jump must remain historical.
      if (w.rightIsLive && w.newer) {
        var visible = App.chart.timeScale().getVisibleLogicalRange();
        w.newer = candles;
        setActiveChartData(tf, visible, 0);
        // v41 perf: a periodic cache-ready refresh is a distinct trigger
        // from window.onLiveCandles (see CANDLE_CACHE_REFRESH_INTERVAL_
        // SECONDS in config.py) and can replace the visible candle data
        // without any live tick or mouse activity in between.
        if (App.DrawingEngine && App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
      }
    }).catch(function (err) {
      console.error("onCacheReady: reload failed:", err);
    });
  };

  // ---- Live updates (pushed from Python via window.evaluate_js) -----------
  // Live state transitions are calculated by SlidingWindow; this adapter only
  // reflects the resulting state into the chart.
  function mergeAuthoritativeTail(tf, tailCandles) {
    if (tf !== App.currentTf || !tailCandles || !tailCandles.length) return;

    var w = getWindow(tf);
    var visibleLogical = App.chart ? App.chart.timeScale().getVisibleLogicalRange() : null;
    var result = App.SlidingWindow.mergeLiveTail(w, tailCandles, App.LAZY_LOAD_CHUNK);
    if (!result.changed) return;

    App.windowByTf[tf] = result.window;

    if (result.rolled.length) {
      App.candlesByTf[tf] = combineActivePartitions(tf);
      // With an older slot resident the total window length stays constant,
      // so live rollover never changes the user's logical viewport. In the
      // live-only case, shift the viewport only when the user is actually at
      // the live edge (the implicit "AutoShift ON" state). When the user has
      // scrolled away from the right edge, keep the viewport fixed instead of
      // stealing it back toward live data on every new candle.
      var dataLength = App.candlesByTf[tf] ? App.candlesByTf[tf].length : 0;
      var atLiveEdge = !!(visibleLogical && dataLength > 0 &&
        visibleLogical.to >= (dataLength - 1 - 0.5));
      var logicalShift = result.window.older
        ? 0
        : (atLiveEdge ? -result.rolled.length : 0);
      setActiveChartData(tf, visibleLogical, logicalShift);
      return;
    }

    var activeArr = App.candlesByTf[tf] || [];
    var livePart = result.window.newer || [];
    var liveBar = livePart.length ? livePart[livePart.length - 1] : null;
    if (liveBar) {
      if (activeArr.length && activeArr[activeArr.length - 1].time === liveBar.time) {
        activeArr[activeArr.length - 1] = liveBar;
      } else if (!activeArr.length || liveBar.time > activeArr[activeArr.length - 1].time) {
        activeArr.push(liveBar);
      }
      if (App.series) App.series.update(liveBar);
    }
  }

  function mergeLiveCandleSet(candleSetByTf) {
    if (!candleSetByTf) return;
    var tf = App.currentTf;
    if (tf === null) return;

    // The independent live price line remains useful while the chart is in
    // historical mode, so it continues to consume the authoritative tail.
    var liveTail = candleSetByTf[String(tf)] || candleSetByTf[tf];
    if (liveTail && liveTail.length) {
      updateLivePriceLine(liveTail[liveTail.length - 1].close);
    }
    if (!liveTail) return;
    mergeAuthoritativeTail(tf, liveTail);
  }

  window.onLiveCandles = function (candleSetByTf) {
    if (!candleSetByTf || App.currentTf === null) return;
    // v40: while Bar Replay is active the chart is deliberately showing a
    // past point in time (replayed forward at a chosen speed) — real live
    // ticks must not be merged in over that, or the replayed candles and
    // the true-live candle would race/interleave on screen. replay-bar.js
    // drives App.series/App.candlesByTf itself for the whole duration and
    // restores normal live merging when Replay is closed.
    if (App.replayActive) return;
    // v41 perf: this is the single funnel every real live tick passes
    // through (see app.py's window.evaluate_js("window.onLiveCandles(...)")
    // call), so it's also the one place that needs to mark the overlay
    // dirty for on-demand rendering to still track live price movement
    // (a moving hline/trend-line-relative price marker, live-price line,
    // etc.) with no mouse activity involved at all.
    if (App.DrawingEngine && App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
    mergeLiveCandleSet(candleSetByTf);
  };

  App.ChartCore = {
    init: init,
    jumpToLatest: jumpToLatest,
    jumpToOldest: jumpToOldest,
    // v33.4: exposed so jump-time.js can turn Auto Fit back on after an
    // Object Tree per-object jump (see jump-time.js's "fit" frame mode) —
    // reuses the exact same autoScale-toggle + button-sync path the "A"
    // button itself uses, so the button's pressed state and the price
    // scale's real autoScale option never disagree.
    setAutoFit: setAutoFit,
    // v40 Update 1: lets replay-bar.js drive the dashed live-price line off
    // the candle it is currently replaying, instead of the real live tick.
    setLivePrice: updateLivePriceLine,
    // V64: live ASK line (display-only). loadInitialLiveAsk() is called once
    // from main.js after init; setLiveAsk() is what window.onLiveAsk maps to.
    setLiveAsk: setLiveAsk,
    syncAskLine: syncAskLine,
    loadInitialLiveAsk: loadInitialLiveAsk,
    // v40 Update 4: lets replay-bar.js update the timeframe dropdown's
    // label/active-state after it changes App.currentTf itself (bypassing
    // showTimeframe(), which would otherwise re-fetch real live data).
    syncTfUI: updateTfDropdownUI,
    // v57 Update 17: jump-time.js takes the same in-flight history lock, so
    // it uses the same token-based acquire/release rather than writing the
    // flag directly.
    acquireLoadingLock: acquireLoadingLock,
    releaseLoadingLock: releaseLoadingLock,
  };
})();
