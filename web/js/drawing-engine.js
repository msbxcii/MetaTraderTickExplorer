// =============================================================================
// drawing-engine.js — drawing tools (Update 2, extended in v13; v38: multi-
// panel aware — see the "v38" note below).
// =============================================================================
// Design in one paragraph: objects are stored purely in the `App.drawObjects`
// array (see state.js), as chart-space values — a *logical index* (not a
// time!) plus a price — never as pixel coordinates and never written to disk
// or to SQLite. Every animation frame we re-derive pixel positions from the
// live chart/series mapping (chart.timeScale().logicalToCoordinate /
// series.priceToCoordinate, via coords.js) and paint them onto a transparent
// <canvas> stacked above the chart. That makes panning, zooming and
// autoscaling "just work" for free — the objects aren't really attached to
// the canvas, they're attached to (logical, price) or (time, price), so
// whatever the chart does to its own mapping, the overlay simply follows on
// the next frame. Because `App.drawObjects` lives only in a JS variable, it
// is automatically gone the moment the page (and with it, the pywebview
// window) closes — nothing to clean up.
//
// v13: points are stored as a *logical* index rather than a `time`. A
// logical index is a continuous coordinate along the time axis that the
// chart can always map to/from a pixel (via logicalToCoordinate /
// coordinateToLogical), even for positions that don't correspond to any
// actual bar yet (empty space to the right of the live price, or before
// the first loaded bar). `time`-based points could only be resolved back
// and forth where a real bar existed, which is why objects used to stop
// working at the edges of the loaded data — see Fix 4 below.
//
// v13 also adds: click-to-select with resize handles (trend line
// endpoints, rectangle corners), drag-to-move, and Alt+drag to clone.
//
// v14 Fix 1: a pure logical index is bar-count based, so it silently
// means something different in every timeframe (logical 10 is "10 bars
// from the origin", which is 50s of real time on the 5s chart but 150s
// on the 15s chart) — that's why a trend line or rectangle drawn on one
// timeframe used to land on the wrong real-world start/end the moment you
// switched timeframes, even though its *bar-count* length looked
// preserved. Trend lines and rectangles now store each point as a real
// {time, price} (time = Unix seconds, exactly like a candle's `time`
// field) instead of {logical, price}, so the same real instant and price
// are recovered on every timeframe.
//
// v21 Fix: vertical lines had the exact same bug — they now store
// {time, price} too. Horizontal lines correctly keep {logical, price} — a
// horizontal line is purely a `price` level with no time/logical
// component involved in its rendering at all, so it was never affected.
//
// To still support drawing/dragging into empty space (Fix 4's original
// concern) while storing real time, coords.js's timeToLogical()/
// logicalToTime() do the {time <-> logical} conversion ourselves for the
// *currently displayed* timeframe's loaded candles, extrapolating linearly
// past either edge using that timeframe's bar spacing. That keeps every
// timeframe's rendering resolvable everywhere logicalToCoordinate already
// was, while the stored value itself stays a real, timeframe-independent
// timestamp.
//
// v38: multi-panel aware. Every function that used to reach for the single
// global App.chart/App.series/dom.drawCanvas now takes an explicit `surface`
// argument instead — a surface bundles one chart panel's {chart, series,
// canvas, container, C (its own coords.js context)}. multi-panel.js creates
// one surface per visible panel (primary + up to two companions) via
// App.DrawingEngine.createPanelSurface(), and every one of them runs its own
// render loop and its own mouse listeners. Because `App.drawObjects` (the
// data) is still a single global array of real {time, price}/{logical,
// price} points, an object drawn on ANY panel is simply painted by every
// panel's own render loop using that panel's own coordinate mapping — this
// is what makes an object global across the whole multi-chart layout and
// every timeframe at once, not just the chart it was drawn on. Selection
// (App.selectedObject), the in-progress interaction (App.interaction), the
// rubber-band box (App.selectionBox) and the pending click-click placement
// (App.pendingObject/App.dragStart) all stay single global values exactly
// as before — only one panel's canvas can be receiving mouse input at a
// time, so there's never more than one of these active at once regardless
// of how many panels are on screen.

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  var TOOL_DEFS = [
    { id: "cursor", label: "Cursor", icon: App.Icons.cursor() },
    { id: "trend",  label: "Trend Line", icon: App.Icons.trend() },
    { id: "hline",  label: "Horizontal Line", icon: App.Icons.hline() },
    { id: "vline",  label: "Vertical Line", icon: App.Icons.vline() },
    { id: "rect",   label: "Rectangle", icon: App.Icons.rect() },
    { id: "fib",    label: "Fib Retracement", icon: App.Icons.fib() },
    // v53 Update 1: sits immediately to the right of Fib Retracement in
    // the toolbar (array order = toolbar order — see buildToolbar()),
    // built from the exact same generic button/hint/active-state
    // machinery, so its look and animation match every other tool here
    // for free.
    { id: "fibext", label: "Fib Expansion", icon: App.Icons.fibExpansion() },
  ];

  // v33.1 Fix 3: shared with object-panel.js's default label logic — the
  // label a freshly-created object gets before the user ever renames it.
  var TYPE_LABELS = {
    hline: "Horizontal Line",
    vline: "Vertical Line",
    trend: "Trend Line",
    rect: "Rectangle",
    fib: "Fib Retracement",
    fibext: "Fib Expansion",
  };

  // v47: Fib Retracement — level price + preview-dash helpers shared by
  // hit-testing and rendering. points[0] is the FIRST click (Level = 1),
  // points[1] is the SECOND click (Level = 0) — see onCanvasMouseDown.
  // price(L) = price_at_0 + L * (price_at_1 - price_at_0), so L=0 recovers
  // the second click exactly, L=1 recovers the first click exactly, L=0.5
  // sits at the midpoint, and L=2/3 extend past the first click by one/two
  // more 0->1-sized steps — exactly the spec'd geometry.
  function fibLevelPrice(obj, level) {
    var price0 = obj.points[1].price, price1 = obj.points[0].price;
    return price0 + level * (price1 - price0);
  }

  function fibLevelRows(obj) {
    var levels = (obj.style && obj.style.levels) || [];
    return levels.slice().sort(function (a, b) { return a.level - b.level; });
  }

  // v53 Update 2: Fib Expansion — level price helper. points[0] is the
  // FIRST click ("Level -2"), points[1] is the SECOND click ("Level -1"),
  // points[2] is the THIRD click (Level 0, Description "E2" — the
  // Expansion's own starting point). price(L) = price_at_point3 +
  // L * (price_at_point2 - price_at_point1), so L=0 recovers the third
  // click exactly, L=1 extends past it by exactly one more "point1->point2"
  // sized step in the same direction (Description "C2"), and any other
  // natural/fractional L extends (or contracts, for 0<L<1) that same span
  // again from point 3 — exactly the spec'd geometry.
  function fibExtLevelPrice(obj, level) {
    var base = obj.points[2].price;
    var delta = obj.points[1].price - obj.points[0].price;
    return base + level * delta;
  }

  // v36 Fix 1: a freshly drawn object no longer always starts from a fixed
  // hard-coded style — it starts from whatever the user last set (and left)
  // in that type's style editor, persisted by style-defaults.js. Falls back
  // to the original hard-coded look if that module isn't loaded for some
  // reason.
  function defaultStyle(type) {
    if (App.StyleDefaults) return App.StyleDefaults.getDefaultStyle(type);
    return {
      borderColor: "#c9a227",
      borderWidth: 2,
      borderStyle: "solid",
      borderOpacity: 100,
      fillColor: "#c9a227",
      fillOpacity: type === "rect" ? 18 : 0,
      levels: type === "fib" ? [
        { id: 1, level: 0, description: "Stoploss" },
        { id: 2, level: 1, description: "Entry" },
        { id: 3, level: 0.5, description: "Middle" },
        { id: 4, level: 2, description: "TP1" },
        { id: 5, level: 3, description: "TP2" },
      ] : type === "fibext" ? [
        { id: 1, level: 0, description: "E2" },
        { id: 2, level: 1, description: "C2" },
      ] : undefined,
      showDescription: false,
    };
  }

  // ---- Surfaces (v38) -------------------------------------------------
  // A surface is one chart panel's drawing context: its own chart/series
  // (for coordinate mapping), its own overlay <canvas>, and its own
  // interaction container (the element mouse listeners for hover-arming
  // and the click-to-place flow bubble up to). `surfaces` holds every one
  // currently on screen so global operations (tool switch, jump-render
  // suppression, the document-level mouseup safety net) can reach all of
  // them at once.
  var surfaces = [];
  var primarySurface = null;
  var nextRenderKey = 1;

  // v41 perf: dirty-render (see V41-Optimization_Ideas_1.md, item 2).
  // Before this, every surface ran its own unconditional
  // requestAnimationFrame loop FOREVER — repainting the same pixels 60
  // times a second even while completely idle (no drawings changing, no
  // pan/zoom, replay paused). Benchmarked in the doc as ~99.8% wasted
  // frames while idle, and it scales with panel count (3 panels = 3
  // permanent RAF loops).
  //
  // The doc itself flagged this as "not yet confirmed for production"
  // because a naive dirty-flag risks a frozen overlay if some mutation
  // site is missed. To keep the exact same visual behavior as before
  // while still eliminating idle CPU burn, this uses two safety nets
  // instead of a bare dirty flag:
  //   1. Anything that can affect what's drawn calls requestRender(),
  //      which schedules exactly one more frame (coalesced - many calls
  //      in the same frame still only paint once).
  //   2. While the mouse is actually interacting with a surface (hover,
  //      drag, an active tool placement) or Replay/live is actively
  //      streaming, rendering free-runs every frame exactly like before -
  //      only genuinely idle time drops to on-demand painting.
  //   3. A low-frequency idle heartbeat (a few times a second, far below
  //      the old 60fps) keeps repainting in the background at low cost, so
  //      even an un-anticipated mutation path self-heals within a
  //      fraction of a second instead of leaving a stale frame on screen
  //      indefinitely.
  // v57 Update 7: with surfaceNeedsPaint() (below) checking the chart's real
  // mapping on every frame, this is now only a last-resort self-heal for a
  // hypothetical missed mutation path rather than the mechanism that keeps
  // the overlay current - so it can be much slower than the old 250ms
  // without any visible consequence.
  var IDLE_HEARTBEAT_MS = 1000; // safety-net repaint rate while fully idle
  var dirty = true;
  var dirtyConsumedBy = {}; // surfaceKey -> true, tracks this dirty pass across all surfaces
  var activityUntil = {}; // surfaceKey -> timestamp; free-run rendering until this time

  function surfaceKey(surface) {
    return surface ? String(surface._renderKey) : "none";
  }

  function requestRender() {
    dirty = true;
    dirtyConsumedBy = {};
  }

  // Called by anything that starts a period of continuous visual change
  // (mouse down/move during an interaction, hover-arm, an active drag,
  // Replay ticking) so that window keeps rendering every frame like
  // before, rather than only on individual requestRender() calls.
  function keepRenderingFor(surface, ms) {
    var until = Date.now() + (ms || 250);
    var key = surfaceKey(surface);
    if (!activityUntil[key] || activityUntil[key] < until) activityUntil[key] = until;
    dirty = true;
    dirtyConsumedBy = {};
  }

  function makeSurface(opts) {
    var surface = {
      chart: opts.chart,
      series: opts.series,
      canvas: opts.canvas,
      ctx2d: opts.canvas.getContext("2d"),
      container: opts.container,
      getCandles: opts.getCandles,
      isPrimary: !!opts.isPrimary,
      // v41 perf: a stable identity for the dirty-render bookkeeping
      // (activityUntil / dirtyConsumedBy) that survives surfaces being
      // added/removed from the `surfaces` array — an array-index-based
      // key would silently collide after a companion panel is closed and
      // the remaining surfaces shift down.
      _renderKey: nextRenderKey++,
      C: App.Coords.createSurfaceCoords({
        getChart: function () { return surface.chart; },
        getSeries: function () { return surface.series; },
        getTf: opts.getTf,
        getCandles: opts.getCandles,
      }),
    };
    surfaces.push(surface);
    return surface;
  }

  function destroySurface(surface) {
    var idx = surfaces.indexOf(surface);
    if (idx !== -1) surfaces.splice(idx, 1);
    delete activityUntil[surfaceKey(surface)];
    delete dirtyConsumedBy[surfaceKey(surface)];
    if (App.interaction && App.interaction.surface === surface) App.interaction = null;
    if (App.selectionBox && App.selectionBox.surface === surface) App.selectionBox = null;
  }

  function resizeSurfaceCanvas(surface, cssWidth, cssHeight) {
    App.dpr = window.devicePixelRatio || 1;
    var c = surface.canvas;
    c.width = Math.max(1, Math.round(cssWidth * App.dpr));
    c.height = Math.max(1, Math.round(cssHeight * App.dpr));
    c.style.width = cssWidth + "px";
    c.style.height = cssHeight + "px";
    // Setting width/height above wipes the bitmap, so whatever this surface
    // last painted is gone - never let the next frame's change-detection
    // conclude "nothing moved, skip the repaint".
    surface._paintedSignature = undefined;
    surface._paintedAt = 0;
  }

  // v56.1: setting canvas.width/height (above) immediately clears the
  // bitmap - that's how <canvas> resizing works, there's no way around it.
  // Normally that's invisible because the very next requestAnimationFrame
  // repaints the cleared canvas before the browser ever paints the frame.
  // But the Object Tree panel's open/close is a CSS `width` transition on
  // a flex sibling of the chart, which reflows #chart-surface on every
  // animation frame; the ResizeObserver watching #chart-container fires
  // per the spec AFTER that frame's layout but also after that frame's own
  // requestAnimationFrame callbacks have already run - so the already-
  // scheduled renderFrame() for that frame draws the objects, THEN this
  // resize clears the canvas, and nothing repaints it until the NEXT
  // frame's rAF fires. Repeated every animation frame for the ~180ms of
  // the panel's open/close transition, that reads as every object on the
  // chart blinking out and back for the whole animation. Painting
  // synchronously right after the clear - instead of only rescheduling the
  // next rAF - closes that window: the resize and its repaint always land
  // in the same frame, so the browser never gets a chance to paint the
  // momentarily-empty canvas.
  function resizeSurfaceCanvasAndRepaint(surface, cssWidth, cssHeight) {
    resizeSurfaceCanvas(surface, cssWidth, cssHeight);
    if (surfaces.indexOf(surface) === -1) return; // surface was destroyed
    paintSurface(surface);
  }

  function mousePos(surface, evt) {
    var rect = surface.canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  function showHint(text) {
    dom.hintToastEl.textContent = text;
    dom.hintToastEl.classList.add("show");
    clearTimeout(showHint._t);
    showHint._t = setTimeout(function () { dom.hintToastEl.classList.remove("show"); }, 2200);
  }

  // ---- Toolbar (global — one toolbar, drives every panel's canvas) -------
  function buildToolbar() {
    dom.toolbarEl.innerHTML = "";
    TOOL_DEFS.forEach(function (def) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill-btn";
      btn.title = def.label;
      btn.dataset.tool = def.id;
      btn.innerHTML = def.icon;
      btn.addEventListener("click", function () { setTool(def.id); });
      dom.toolbarEl.appendChild(btn);
    });
    updateToolbarUI();
  }

  function updateToolbarUI() {
    Array.prototype.forEach.call(dom.toolbarEl.children, function (btn) {
      btn.classList.toggle("active", btn.dataset.tool === App.currentTool);
    });
  }

  // v38: a tool selection is app-wide, not per-panel — picking "Trend
  // Line" once arms EVERY visible chart panel to start one on the very
  // next click, wherever that click lands (see attachSurfaceInteraction
  // below). That's what "objects can be drawn on any chart, not just the
  // primary one" means in practice: there is exactly one tool, and every
  // panel's canvas is put into the same drawing-armed state together.
  function setTool(toolId) {
    cancelPendingObject();
    // Switching to a drawing tool starts a new object, so drop any active
    // selection/handles from the cursor tool first.
    if (toolId !== "cursor") {
      App.selectedObject = null;
      App.interaction = null;
    }
    App.currentTool = toolId;
    updateToolbarUI();
    surfaces.forEach(function (s) {
      s.canvas.classList.toggle("drawing", toolId !== "cursor");
      // Let the .drawing class (or its absence) govern pointer-events
      // again, rather than whatever the cursor-tool hover-arming last set
      // inline, on THIS panel's canvas.
      s.canvas.style.pointerEvents = "";
      s.canvas.style.cursor = "";
    });
    if (toolId !== "cursor") {
      var def = TOOL_DEFS.filter(function (d) { return d.id === toolId; })[0];
      showHint(
        toolId === "fibext"
          ? "Click 3 points in order (Level -2, Level -1, E2) to place the " + def.label.toLowerCase()
          : toolId === "trend" || toolId === "rect" || toolId === "fib"
          ? "Click to start, click again to finish the " + def.label.toLowerCase()
          : "Click on any chart panel to place the " + def.label.toLowerCase()
      );
    }
  }

  function returnToCursor() { setTool("cursor"); }

  // ---- Hit testing (for right-click selection) --------------------------
  function distPointToSegment(px, py, ax, ay, bx, by) {
    var abx = bx - ax, aby = by - ay;
    var apx = px - ax, apy = py - ay;
    var lenSq = abx * abx + aby * aby;
    var t = lenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / lenSq)) : 0;
    var cx = ax + abx * t, cy = ay + aby * t;
    var dx = px - cx, dy = py - cy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // v47: hit-tests every one of a Fib object's level lines (not just the
  // two anchor points) — the whole point of the tool is that the extra
  // levels (0.5/2/3/...) are themselves visible, selectable lines.
  function hitTestFibRegion(surface, obj, x, y) {
    var px = objectPixels(surface, obj);
    if (!px) return false;
    // v53: Fib Expansion's level lines span its 2nd->3rd click time range
    // (see fibExtLevelPrice's own comment), not the full object width.
    var isExt = obj.type === "fibext";
    var rx = isExt ? Math.min(px.x2, px.x3) : Math.min(px.x1, px.x2);
    var rw = isExt ? Math.abs(px.x3 - px.x2) : Math.abs(px.x2 - px.x1);
    var rows = fibLevelRows(obj);
    for (var i = 0; i < rows.length; i++) {
      var price = isExt ? fibExtLevelPrice(obj, rows[i].level) : fibLevelPrice(obj, rows[i].level);
      var y0 = surface.C.priceToY(price);
      if (y0 === null) continue;
      if (distPointToSegment(x, y, rx, y0, rx + rw, y0) <= App.HIT_TOLERANCE) return true;
    }
    // The two dashed guide legs (click1->click2, click2->click3) are
    // themselves part of the drawing and should be clickable too.
    if (isExt) {
      if (distPointToSegment(x, y, px.x1, px.y1, px.x2, px.y2) <= App.HIT_TOLERANCE) return true;
      if (distPointToSegment(x, y, px.x2, px.y2, px.x3, px.y3) <= App.HIT_TOLERANCE) return true;
    }
    return false;
  }

  function hitTestRectRegion(px, x, y, fillOpacity) {
    var minX = Math.min(px.x1, px.x2), maxX = Math.max(px.x1, px.x2);
    var minY = Math.min(px.y1, px.y2), maxY = Math.max(px.y1, px.y2);
    var nearLeft = Math.abs(x - minX) <= App.HIT_TOLERANCE && y >= minY - App.HIT_TOLERANCE && y <= maxY + App.HIT_TOLERANCE;
    var nearRight = Math.abs(x - maxX) <= App.HIT_TOLERANCE && y >= minY - App.HIT_TOLERANCE && y <= maxY + App.HIT_TOLERANCE;
    var nearTop = Math.abs(y - minY) <= App.HIT_TOLERANCE && x >= minX - App.HIT_TOLERANCE && x <= maxX + App.HIT_TOLERANCE;
    var nearBottom = Math.abs(y - maxY) <= App.HIT_TOLERANCE && x >= minX - App.HIT_TOLERANCE && x <= maxX + App.HIT_TOLERANCE;
    if (nearLeft || nearRight || nearTop || nearBottom) return true;
    var inside = x >= minX && x <= maxX && y >= minY && y <= maxY;
    return inside && fillOpacity > 0;
  }

  // v33: `opts.includeLocked` lets a caller (the right-click context menu)
  // still find a locked object — locked only means "not selectable/movable
  // with a plain left click", not "invisible to right click". Every other
  // caller (left-click select/move, hover-arming) omits it, so locked
  // objects are simply transparent to those interactions. Hidden objects
  // are always skipped, everywhere — a hidden object is only reachable
  // through the Object Tree panel.
  //
  // v38: hit-tested against the given surface's own current coordinate
  // mapping — the same global App.drawObjects list is tested on whichever
  // panel the mouse is actually over.
  function hitTest(surface, x, y, opts) {
    var includeLocked = !!(opts && opts.includeLocked);
    // v58.1 Update 3: the drawing overlay's own paint is already clipped to
    // the plot rectangle (chart area minus the price scale's width and the
    // time scale's height — see paintSurface()'s v36.9 Fix 1 above), but
    // hit-testing never had the matching clip. So whenever part of an
    // object's boundary happened to fall behind the price (right) axis in
    // Multi-Chart mode, hovering that axis to drag-resize it instead hit
    // the object underneath and opened/selected it. Reject any point
    // outside that same plot rectangle up front, before testing it against
    // any object, so the price/time axes are always left free for their
    // own native interactions.
    var cssW = surface.canvas.width / App.dpr, cssH = surface.canvas.height / App.dpr;
    var plot = plotAreaSize(surface, cssW, cssH);
    if (x < 0 || y < 0 || x > plot.w || y > plot.h) return null;
    for (var i = App.drawObjects.length - 1; i >= 0; i--) {
      var obj = App.drawObjects[i];
      if (obj.hidden) continue;
      if (obj.locked && !includeLocked) continue;
      var px = objectPixels(surface, obj);
      if (!px) continue;

      if (obj.type === "hline") {
        if (Math.abs(y - px.y) <= App.HIT_TOLERANCE) return obj;
      } else if (obj.type === "vline") {
        if (Math.abs(x - px.x) <= App.HIT_TOLERANCE) return obj;
      } else if (obj.type === "trend") {
        if (distPointToSegment(x, y, px.x1, px.y1, px.x2, px.y2) <= App.HIT_TOLERANCE) return obj;
      } else if (obj.type === "rect") {
        if (hitTestRectRegion(px, x, y, obj.style.fillOpacity)) return obj;
      } else if (obj.type === "fib" || obj.type === "fibext") {
        if (hitTestFibRegion(surface, obj, x, y)) return obj;
      }
    }
    return null;
  }

  // Converts an object's stored (logical, price) points into current pixel
  // coordinates given the surface's own chart mapping right now. Returns
  // null if any required point can't currently be mapped (e.g. chart not
  // ready yet).
  // v57 Update 7 (perf): objectPixels() is the single hottest function in
  // this file - it runs 2-4x per object per painted frame (drawOneObject,
  // drawSelectionHandles, getTrendHandles/getRectHandles/getRectMidHandles
  // all call it independently), and every call performs 2-6 chart coordinate
  // conversions through the charting library. Within ONE paint pass the
  // chart mapping and the object's points are by definition frozen, so the
  // result can safely be computed once per object and reused. The memo is
  // opened/closed explicitly around a paint (see paintSurface) and is
  // otherwise inactive, so every interactive call site (hit-testing during a
  // drag, where points DO change between calls) keeps reading live values
  // exactly as before.
  var pixelMemo = null;

  function beginPixelMemo() { pixelMemo = new Map(); }
  function endPixelMemo() { pixelMemo = null; }

  function objectPixels(surface, obj) {
    if (pixelMemo) {
      var cached = pixelMemo.get(obj);
      if (cached !== undefined) return cached;
      var computed = computeObjectPixels(surface, obj);
      pixelMemo.set(obj, computed);
      return computed;
    }
    return computeObjectPixels(surface, obj);
  }

  function computeObjectPixels(surface, obj) {
    var C = surface.C;
    if (obj.type === "hline") {
      var y = C.priceToY(obj.points[0].price);
      if (y === null) return null;
      return { y: y };
    }
    if (obj.type === "vline") {
      // v21: vline points are stored as real {time, price} — convert the
      // real time into the current timeframe's logical coordinate first,
      // exactly as trend/rect do below.
      var vl = C.timeToLogical(obj.points[0].time);
      if (vl === null) return null;
      var x = C.logicalToX(vl);
      if (x === null) return null;
      return { x: x };
    }
    if (obj.type === "fibext") {
      // v53: three points, stored as {time, price} exactly like trend/
      // rect/fib. While still being placed, only the first two are
      // confirmed (see onCanvasMouseDown) — x3/y3 are simply omitted
      // until the third click lands, and every caller that needs them
      // (rendering, hit-testing) already checks for that.
      var el1 = C.timeToLogical(obj.points[0].time), el2 = C.timeToLogical(obj.points[1].time);
      if (el1 === null || el2 === null) return null;
      var ex1 = C.logicalToX(el1), ey1 = C.priceToY(obj.points[0].price);
      var ex2 = C.logicalToX(el2), ey2 = C.priceToY(obj.points[1].price);
      if (ex1 === null || ey1 === null || ex2 === null || ey2 === null) return null;
      var result = { x1: ex1, y1: ey1, x2: ex2, y2: ey2 };
      if (obj.points.length > 2) {
        var el3 = C.timeToLogical(obj.points[2].time);
        var ex3 = el3 !== null ? C.logicalToX(el3) : null;
        var ey3 = C.priceToY(obj.points[2].price);
        if (ex3 !== null && ey3 !== null) { result.x3 = ex3; result.y3 = ey3; }
      }
      return result;
    }
    // trend / rect: two points, stored as {time, price} (v14) — convert
    // each point's real time into the current timeframe's logical
    // coordinate first, then to a pixel, exactly as if it were a native
    // logical point.
    var l1 = C.timeToLogical(obj.points[0].time), l2 = C.timeToLogical(obj.points[1].time);
    if (l1 === null || l2 === null) return null;
    var x1 = C.logicalToX(l1), y1 = C.priceToY(obj.points[0].price);
    var x2 = C.logicalToX(l2), y2 = C.priceToY(obj.points[1].price);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    return { x1: x1, y1: y1, x2: x2, y2: y2 };
  }

  // ---- Selection, resize handles, move & clone (v13) ---------------------
  function getRectHandles(surface, obj) {
    var px = objectPixels(surface, obj);
    if (!px) return [];
    var minX = Math.min(px.x1, px.x2), maxX = Math.max(px.x1, px.x2);
    var minY = Math.min(px.y1, px.y2), maxY = Math.max(px.y1, px.y2);
    return [
      { x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }
    ];
  }

  // v36.9 Fix 2: the four edge-midpoint handles for a rectangle, used for
  // "directional" resize — dragging one of these extends the rectangle
  // along a single axis only (its opposite edge and the whole other axis
  // stay fixed), unlike a corner handle which resizes both axes at once.
  function getRectMidHandles(surface, obj) {
    var px = objectPixels(surface, obj);
    if (!px) return [];
    var minX = Math.min(px.x1, px.x2), maxX = Math.max(px.x1, px.x2);
    var minY = Math.min(px.y1, px.y2), maxY = Math.max(px.y1, px.y2);
    var midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    return [
      { x: midX, y: minY, side: "top" },
      { x: maxX, y: midY, side: "right" },
      { x: midX, y: maxY, side: "bottom" },
      { x: minX, y: midY, side: "left" },
    ];
  }

  function getTrendHandles(surface, obj) {
    var px = objectPixels(surface, obj);
    if (!px) return [];
    // v53: Fib Expansion has a third draggable anchor once it's fully
    // placed (px.x3 is only present then — see objectPixels()).
    if (obj.type === "fibext" && px.x3 !== undefined) {
      return [{ x: px.x1, y: px.y1 }, { x: px.x2, y: px.y2 }, { x: px.x3, y: px.y3 }];
    }
    return [{ x: px.x1, y: px.y1 }, { x: px.x2, y: px.y2 }];
  }

  function hitTestHandles(surface, obj, x, y) {
    if (obj.type === "trend" || obj.type === "fib" || obj.type === "fibext") {
      // v53: role is now "pt" + the point's own index, so it uniformly
      // covers 2-point (trend/fib) and 3-point (fibext) objects — see the
      // resize consumer below.
      var th = getTrendHandles(surface, obj);
      for (var i = 0; i < th.length; i++) {
        var dx = x - th[i].x, dy = y - th[i].y;
        if (Math.sqrt(dx * dx + dy * dy) <= App.HANDLE_HIT) {
          return { role: "pt" + i };
        }
      }
    } else if (obj.type === "rect") {
      var px = objectPixels(surface, obj);
      var minX = Math.min(px.x1, px.x2), maxX = Math.max(px.x1, px.x2);
      var minY = Math.min(px.y1, px.y2), maxY = Math.max(px.y1, px.y2);
      var corners = [
        { x: minX, y: minY, opp: { x: maxX, y: maxY } },
        { x: maxX, y: minY, opp: { x: minX, y: maxY } },
        { x: maxX, y: maxY, opp: { x: minX, y: minY } },
        { x: minX, y: maxY, opp: { x: maxX, y: minY } },
      ];
      for (var j = 0; j < corners.length; j++) {
        var cdx = x - corners[j].x, cdy = y - corners[j].y;
        if (Math.sqrt(cdx * cdx + cdy * cdy) <= App.HANDLE_HIT) {
          // Find the fixed opposite corner's real {time, price} by
          // matching which stored point is farthest from the dragged one.
          var oppTime = surface.C.logicalToTime(surface.C.xToLogical(corners[j].opp.x));
          var oppPrice = surface.C.yToPrice(corners[j].opp.y);
          return { role: "corner", fixed: { time: oppTime, price: oppPrice } };
        }
      }
      // v36.9 Fix 2: edge-midpoint handles — checked after the corners
      // (corners take priority if they happen to overlap at tiny sizes).
      // Dragging one of these only moves the single stored point that
      // sits on that edge, and only along that edge's own axis (see
      // handleCursorMouseMove's "mid" resize branch) — the point on the
      // opposite edge, and the other axis entirely, are left untouched.
      var mids = getRectMidHandles(surface, obj);
      for (var k = 0; k < mids.length; k++) {
        var mdx = x - mids[k].x, mdy = y - mids[k].y;
        if (Math.sqrt(mdx * mdx + mdy * mdy) <= App.HANDLE_HIT) {
          var side = mids[k].side;
          var axis = (side === "left" || side === "right") ? "x" : "y";
          // Identify which of the two stored points sits on the dragged
          // edge (the one whose pixel coordinate on this axis matches the
          // handle's own position on that axis).
          var movingIdx;
          if (axis === "x") {
            movingIdx = (Math.abs(px.x1 - mids[k].x) <= Math.abs(px.x2 - mids[k].x)) ? 0 : 1;
          } else {
            movingIdx = (Math.abs(px.y1 - mids[k].y) <= Math.abs(px.y2 - mids[k].y)) ? 0 : 1;
          }
          return { role: "mid-" + side, axis: axis, midPointIndex: movingIdx };
        }
      }
    }
    return null;
  }

  function cloneObjectDeep(obj) {
    var isTimeBased = obj.type === "trend" || obj.type === "rect" || obj.type === "vline" || obj.type === "fib" || obj.type === "fibext";
    return {
      type: obj.type,
      points: obj.points.map(function (p) {
        return isTimeBased ? { time: p.time, price: p.price } : { logical: p.logical, price: p.price };
      }),
      style: {
        borderColor: obj.style.borderColor,
        borderWidth: obj.style.borderWidth,
        borderStyle: obj.style.borderStyle || "solid",
        fillColor: obj.style.fillColor,
        fillOpacity: obj.style.fillOpacity,
        // v36 Fix 4: clone the Middle Line settings too (rect only) — a
        // cloned rectangle should look identical to its source, not reset
        // to "no middle line".
        middleLine: obj.style.middleLine ? {
          enabled: obj.style.middleLine.enabled,
          style: obj.style.middleLine.style,
          color: obj.style.middleLine.color,
          width: obj.style.middleLine.width,
        } : undefined,
        // v47: a cloned Fib object keeps its own level table/description
        // setting, exactly like a cloned rectangle keeps its Middle Line.
        levels: obj.style.levels ? obj.style.levels.map(function (l) {
          return { id: l.id, level: l.level, description: l.description };
        }) : undefined,
        showDescription: !!obj.style.showDescription,
      },
      // v33: a clone is always a fresh, plain object — the source object
      // can only have reached this point via hitTest()'s default (locked-
      // and hidden-excluding) hit test, so it was never locked or hidden
      // to begin with, but this is set explicitly rather than relying on
      // that invariant staying true forever.
      locked: false,
      hidden: false,
      // v33.1: Alt+drag clone keeps the source's name/folder — it's still
      // "the same kind of thing", just a second copy of it.
      name: obj.name,
      folderId: obj.folderId !== undefined ? obj.folderId : null,
    };
  }

  function computeCursorHit(surface, x, y) {
    // Check the selected object's resize handles first (they take
    // priority over a plain move-hit anywhere else on the object). A
    // locked selected object (e.g. selected via the Object Tree panel)
    // never offers handles here — see hitTest()'s own lock exclusion for
    // the equivalent plain-move case just below.
    if (App.selectedObject && !App.selectedObject.locked && App.drawObjects.indexOf(App.selectedObject) !== -1) {
      var handleHit = hitTestHandles(surface, App.selectedObject, x, y);
      if (handleHit) return { obj: App.selectedObject, kind: "resize", role: handleHit.role, fixed: handleHit.fixed, axis: handleHit.axis, midPointIndex: handleHit.midPointIndex };
    }
    var obj = hitTest(surface, x, y);
    if (obj) return { obj: obj, kind: "move" };
    return null;
  }

  function cursorForHit(hit) {
    if (!hit) return "";
    if (hit.kind === "resize") return "crosshair";
    // Fix (item 2): this used to also return "crosshair" for a plain
    // *body* hover on a trend line (hit.kind === "move"), which is
    // visually identical to lightweight-charts' own default crosshair
    // cursor over the chart — so hovering a trend line looked like nothing
    // happened, even though it silently was arming for a move. Every other
    // object type already fell through to "move" for a body hover; trend
    // should too — "crosshair" is reserved for an actual resize handle.
    return "move";
  }

  function updateHoverArming(surface, pos) {
    var hit = computeCursorHit(surface, pos.x, pos.y);
    surface.canvas.style.pointerEvents = hit ? "auto" : "";
    surface.canvas.style.cursor = cursorForHit(hit);
  }

  // v40: Ctrl+click on an object toggles it in/out of the multi-selection
  // (App.panelSelectedObjects — the same array the Object Tree panel's own
  // Ctrl/Shift multi-select uses), without arming any move/resize
  // interaction. App.selectedObject (the single object that gets resize
  // handles) collapses to null the moment there's more than one, and back
  // to that one object the moment the set shrinks to exactly one — so
  // handles/move only ever apply in single-selection mode, per spec.
  function toggleMultiSelect(obj) {
    var idx = App.panelSelectedObjects.indexOf(obj);
    if (idx === -1) App.panelSelectedObjects.push(obj);
    else App.panelSelectedObjects.splice(idx, 1);
    App.selectedObject = App.panelSelectedObjects.length === 1 ? App.panelSelectedObjects[0] : null;
    App.panelLastClickedObject = obj;
    App.interaction = null;
    if (App.ObjectsPanel) App.ObjectsPanel.refresh();
  }

  // v40: bounding-box overlap test used to resolve a Ctrl+drag rubber-band
  // selection — every object type is reduced to its own pixel bounding
  // box (a point for hline/vline's own axis) and tested for overlap
  // against the drag rectangle. Hidden and locked objects are excluded,
  // matching hitTest()'s own default (a locked object isn't reachable by
  // an ordinary left-click gesture, and a rubber-band select is one).
  function objectIntersectsBox(surface, obj, box) {
    if (obj.hidden || obj.locked) return false;
    var px = objectPixels(surface, obj);
    if (!px) return false;
    var minX = Math.min(box.startX, box.curX), maxX = Math.max(box.startX, box.curX);
    var minY = Math.min(box.startY, box.curY), maxY = Math.max(box.startY, box.curY);
    if (obj.type === "hline") return px.y >= minY && px.y <= maxY;
    if (obj.type === "vline") return px.x >= minX && px.x <= maxX;
    var oMinX, oMaxX, oMinY, oMaxY;
    if (obj.type === "trend" || obj.type === "rect" || obj.type === "fib" || obj.type === "fibext") {
      var hasThird = px.x3 !== undefined;
      oMinX = Math.min(px.x1, px.x2, hasThird ? px.x3 : px.x1);
      oMaxX = Math.max(px.x1, px.x2, hasThird ? px.x3 : px.x1);
      oMinY = Math.min(px.y1, px.y2, hasThird ? px.y3 : px.y1);
      oMaxY = Math.max(px.y1, px.y2, hasThird ? px.y3 : px.y1);
    } else {
      return false;
    }
    return oMaxX >= minX && oMinX <= maxX && oMaxY >= minY && oMinY <= maxY;
  }

  // v40: mouseup on a Ctrl+drag rubber-band selection — every object whose
  // pixel bounds overlap the drawn rectangle is ADDED to whatever's
  // already multi-selected (Ctrl is, after all, still held down), matching
  // the "hold Ctrl, drag a box" mechanism described in the spec.
  function finalizeSelectionBox(surface) {
    var box = App.selectionBox;
    if (!box) return;
    var matched = App.drawObjects.filter(function (obj) { return objectIntersectsBox(surface, obj, box); });
    matched.forEach(function (obj) {
      if (App.panelSelectedObjects.indexOf(obj) === -1) App.panelSelectedObjects.push(obj);
    });
    if (matched.length) {
      App.selectedObject = App.panelSelectedObjects.length === 1 ? App.panelSelectedObjects[0] : null;
      App.panelLastClickedObject = matched[matched.length - 1];
    }
    if (App.ObjectsPanel) App.ObjectsPanel.refresh();
  }

  // v40 fix: a Ctrl+drag rubber-band selection starts on empty chart space,
  // which is exactly the same gesture (mousedown + drag) Lightweight
  // Charts itself uses to pan. The library's own pan-drag is wired
  // directly to its own canvas beneath our overlay, so it starts
  // regardless of what our own JS does with the click — the chart has to
  // be told directly, via its own API, to stop panning for the duration
  // of the box gesture. Restored the moment the box ends (mouseup) or is
  // abandoned (mouse leaves the canvas).
  //
  // v38: acts on the SURFACE the gesture is actually happening on, not
  // always the primary chart — each panel is independently pannable, so
  // only the one panel where the rubber-band is being dragged should have
  // its own panning suspended.
  function setChartPanningEnabled(surface, enabled) {
    if (!surface || !surface.chart) return;
    surface.chart.applyOptions({ handleScroll: { pressedMouseMove: enabled } });
  }

  function handleCursorMouseDown(surface, evt) {
    // v40 fix: a canvas has its OWN "mousedown" listener (onCanvasMouseDown
    // below) which also calls this same function when the cursor tool is
    // active. The canvas sits INSIDE its container, so the moment the
    // canvas's pointer-events is "auto" (already true here whenever the
    // mouse is hovering a hit-testable object — see updateHoverArming), one
    // physical click fires this function TWICE for the same native event:
    // once as the target (the canvas's own listener) and once more as it
    // bubbles up to the container's listener just below. Every existing
    // code path below happens to survive that by accident, because it sets
    // App.interaction on the first call, and the top guard right here
    // (`|| App.interaction`) swallows the bubbled second call. The Ctrl
    // multi-select branch does NOT set App.interaction (a toggle isn't a
    // drag), so without this explicit guard the second call would toggle
    // the same object right back off — added then instantly removed,
    // which looks exactly like "Ctrl+click does nothing". Marking the
    // event itself makes every call site immune to this, not just the new
    // branch.
    if (evt.__cursorMouseDownHandled) return;
    evt.__cursorMouseDownHandled = true;
    if (App.currentTool !== "cursor" || evt.button !== 0 || App.interaction) return;
    var C = surface.C;
    var pos = mousePos(surface, evt);
    // v21 restore: arm the overlay canvas for the whole gesture right away.
    // Without this, the canvas stays pointer-events:none (its default
    // while the cursor tool is idle — see index.html), so the mousemove/
    // mouseup listeners registered on it below never fire once a drag
    // actually starts, and click+drag/resize (items 3 and 5) silently do
    // nothing.
    surface.canvas.style.pointerEvents = "auto";

    // v40: Ctrl+click(+drag) is a multi-select gesture, never a move/
    // resize/clone one — those stay exclusive to the single-selection
    // (no Ctrl) path below, per spec. A hit toggles that one object in/out
    // of the selection; no hit starts a rubber-band box that keeps
    // growing until the mouse comes back up (handleCursorMouseMove/Up).
    if (evt.ctrlKey || evt.metaKey) {
      var ctrlHit = hitTest(surface, pos.x, pos.y);
      if (ctrlHit) {
        toggleMultiSelect(ctrlHit);
      } else {
        App.selectionBox = { startX: pos.x, startY: pos.y, curX: pos.x, curY: pos.y, surface: surface };
        // v40 fix: stop the chart itself from panning on this same
        // click+drag — see setChartPanningEnabled's comment above.
        setChartPanningEnabled(surface, false);
      }
      return;
    }

    var hit = computeCursorHit(surface, pos.x, pos.y);
    if (!hit) {
      // v33.1 Fix 2: a click on empty chart space (outside every object)
      // unselects everywhere — chart AND the Object Tree panel's own
      // multi-selection, matching the "click a point inside the chart"
      // unselect-all rule.
      App.selectedObject = null;
      App.panelSelectedObjects = [];
      App.panelLastClickedObject = null;
      App.interaction = null;
      surface.canvas.style.pointerEvents = "none";
      if (App.ObjectsPanel) App.ObjectsPanel.refresh();
      return;
    }

    // v33.1 Fix 2: selecting an object on the chart (left click, resize
    // handle or move-hit) is always a single-object selection — it
    // collapses any panel multi-selection down to just this one object, so
    // the panel's yellow highlight and the chart's own selection box never
    // disagree about what's currently selected.
    App.selectedObject = hit.obj;
    App.panelSelectedObjects = [hit.obj];
    App.panelLastClickedObject = hit.obj;
    if (App.ObjectsPanel) App.ObjectsPanel.refresh();
    var workObj = hit.obj;

    var startLogical = C.xToLogical(pos.x);
    var startPrice = C.yToPrice(pos.y);
    if (startLogical === null || startLogical === undefined || startPrice === null || startPrice === undefined) {
      return;
    }

    if (hit.kind === "resize") {
      App.interaction = { kind: "resize", obj: workObj, role: hit.role, fixed: hit.fixed, axis: hit.axis, midPointIndex: hit.midPointIndex, surface: surface };
      return;
    }

    // Alt+drag clones the object instead of moving the original — the
    // clone becomes the thing that's dragged and selected; only a
    // whole-object move does (checked above: handles are tested first and
    // return early).
    if (evt.altKey) {
      workObj = cloneObjectDeep(hit.obj);
      workObj.id = App.nextObjectId++;
      App.drawObjects.push(workObj);
      App.selectedObject = workObj;
      App.panelSelectedObjects = [workObj];
      App.panelLastClickedObject = workObj;
      if (App.ObjectsPanel) App.ObjectsPanel.refresh();
    }

    var workObjIsTimeBased = workObj.type === "trend" || workObj.type === "rect" || workObj.type === "vline" || workObj.type === "fib" || workObj.type === "fibext";
    App.interaction = {
      kind: "move",
      obj: workObj,
      surface: surface,
      startLogical: startLogical,
      startPrice: startPrice,
      // v14: for trend/rect, capture the real time under the cursor at
      // drag-start too — moves for these types are tracked in real time,
      // not logical, so the object keeps its correct span when the
      // timeframe changes mid-drag (or simply because the object is
      // time-based now).
      startTime: workObjIsTimeBased ? C.logicalToTime(startLogical) : null,
      startPoints: workObj.points.map(function (p) {
        return workObjIsTimeBased ? { time: p.time, price: p.price } : { logical: p.logical, price: p.price };
      }),
      // Fix (size-drift on move): trend/rect track their move in raw
      // logical units (see handleCursorMouseMove), not via a time delta —
      // snapshot each point's *current* logical position up front so the
      // move can be applied as a pure, pixel-rigid translation.
      startPointsLogical: (workObj.type === "trend" || workObj.type === "rect" || workObj.type === "fib" || workObj.type === "fibext")
        ? workObj.points.map(function (p) { return C.timeToLogical(p.time); })
        : null
      // v21: workObjIsTimeBased now covers vline too, so its startPoints
      // and startTime are captured on the {time, price} branch above.
    };
  }

  function handleCursorMouseMove(surface, evt) {
    if (App.currentTool !== "cursor") return;
    var C = surface.C;
    var pos = mousePos(surface, evt);
    // v40: growing a Ctrl+drag rubber-band box — stays open (its bounds
    // simply track the mouse) until the button is released. Only the
    // surface that started the box tracks it further.
    if (App.selectionBox) {
      if (App.selectionBox.surface !== surface) return;
      App.selectionBox.curX = pos.x;
      App.selectionBox.curY = pos.y;
      return;
    }
    if (!App.interaction) {
      updateHoverArming(surface, pos);
      return;
    }
    if (App.interaction.surface !== surface) return;

    var curLogical = C.xToLogical(pos.x);
    var curPrice = C.yToPrice(pos.y);
    if (curLogical === null || curLogical === undefined || curPrice === null || curPrice === undefined) return;

    var obj = App.interaction.obj;
    // v57 Update 7: an in-progress move/resize mutates the object directly,
    // outside persistChange() (which only runs on mouseup). markActive() on
    // the surface's own mousemove already covers this, but stating it
    // explicitly here means the drag can never depend on that indirection.
    requestRender();
    if (App.interaction.kind === "move") {
      var dl = curLogical - App.interaction.startLogical;
      var dp = curPrice - App.interaction.startPrice;
      if (obj.type === "hline") {
        // Fix 2: a horizontal line only moves along its own axis (price).
        obj.points[0].price = App.interaction.startPoints[0].price + dp;
      } else if (obj.type === "vline") {
        // v21: a vertical line only moves along its own axis (time), and
        // — like trend/rect — the delta is tracked in real time, not
        // logical, so it doesn't drift if the timeframe changes mid-drag.
        var vCurTime = C.logicalToTime(curLogical);
        var vdt = (vCurTime !== null && App.interaction.startTime !== null) ? (vCurTime - App.interaction.startTime) : 0;
        obj.points[0].time = App.interaction.startPoints[0].time + vdt;
      } else {
        // Fix (rect/trend growing or shrinking while being dragged): track
        // the move as a pure LOGICAL delta — xToLogical is a direct,
        // purely geometric function of chart pan/zoom (not of candle
        // content), so `dl` is pixel-rigid frame to frame. Apply it to
        // each point's *snapshotted* start-of-drag logical position
        // (captured once in handleCursorMouseDown), then convert only the
        // final result to a real time for storage.
        for (var i = 0; i < obj.points.length; i++) {
          var newLogical = App.interaction.startPointsLogical[i] + dl;
          var newTime = C.logicalToTime(newLogical);
          if (newTime !== null && newTime !== undefined) obj.points[i].time = newTime;
          obj.points[i].price = App.interaction.startPoints[i].price + dp;
        }
      }
    } else if (App.interaction.kind === "resize") {
      // v14: the dragged handle's new position is stored as real time
      // (via logicalToTime), the fixed opposite corner keeps its own
      // stored real time untouched.
      var curTimeR = C.logicalToTime(curLogical);
      if (curTimeR === null) return;
      if (obj.type === "trend" || obj.type === "fib" || obj.type === "fibext") {
        // v53: role is "pt0"/"pt1"/(fibext only) "pt2" — see hitTestHandles().
        var idx = parseInt(String(App.interaction.role).slice(2), 10);
        if (!isNaN(idx) && obj.points[idx]) obj.points[idx] = { time: curTimeR, price: curPrice };
      } else if (obj.type === "rect" && App.interaction.role && App.interaction.role.indexOf("mid-") === 0) {
        // v36.9 Fix 2: directional edge-midpoint drag — only the single
        // stored point on the dragged edge moves, and only along that
        // edge's own axis.
        var mi = App.interaction.midPointIndex;
        if (App.interaction.axis === "x") {
          obj.points[mi].time = curTimeR;
        } else {
          obj.points[mi].price = curPrice;
        }
      } else if (obj.type === "rect") {
        // The dragged corner becomes point 0; the diagonally-opposite
        // corner (fixed at drag-start) becomes point 1.
        obj.points[0] = { time: curTimeR, price: curPrice };
        obj.points[1] = { time: App.interaction.fixed.time, price: App.interaction.fixed.price };
      }
    }
  }

  function handleCursorMouseUp(surface, evt) {
    if (App.currentTool !== "cursor") return;
    var pos = mousePos(surface, evt);
    // v40: releasing the mouse ends a Ctrl+drag rubber-band selection —
    // resolve which objects fall inside it, then drop the box itself so
    // it stops being drawn.
    if (App.selectionBox) {
      if (App.selectionBox.surface !== surface) return;
      finalizeSelectionBox(surface);
      App.selectionBox = null;
      // v40 fix: hand panning back to the chart now that the box gesture
      // is over.
      setChartPanningEnabled(surface, true);
      updateHoverArming(surface, pos);
      return;
    }
    // A move/resize (or an Alt+drag clone, which starts life as a "move"
    // interaction on the new clone) just ended — persist the result. A
    // plain click that never hit anything leaves App.interaction null, so
    // this doesn't fire on every idle click, only on an actual change.
    if (App.interaction && App.interaction.surface === surface) persistChange();
    App.interaction = null;
    updateHoverArming(surface, pos);
  }

  // ---- Rendering ----------------------------------------------------------
  function hexToRgba(hex, opacityPct) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "#c9a227");
    var r = m ? parseInt(m[1], 16) : 201;
    var g = m ? parseInt(m[2], 16) : 162;
    var b = m ? parseInt(m[3], 16) : 39;
    return "rgba(" + r + "," + g + "," + b + "," + (Math.max(0, Math.min(100, opacityPct)) / 100) + ")";
  }

  // v36 Fix 3: translates a style's named border style ("solid" | "dashed"
  // | "dotted") into a canvas setLineDash() pattern, scaled to the line's
  // own width so a thicker dashed/dotted line doesn't end up with
  // proportionally tiny dashes/dots. "solid" (or anything unrecognized)
  // draws no dash pattern at all, same as before this fix existed.
  function dashArrayFor(borderStyle, width) {
    var w = Math.max(1, width || 1);
    if (borderStyle === "dashed") return [w * 3, w * 2];
    if (borderStyle === "dotted") return [w, w * 1.6];
    return [];
  }

  function drawOneObject(surface, ctx, obj, w, h) {
    var px = objectPixels(surface, obj);
    if (!px) return;
    var style = obj.style;
    // v36 Fix 3: a border width of 0 means "no border" — the object is
    // still selectable (hit-testing uses its own fixed pixel tolerance,
    // independent of borderWidth) but nothing is stroked for it.
    var hasBorder = (style.borderWidth || 0) > 0;

    ctx.save();
    ctx.lineWidth = style.borderWidth;
    // v38 Fix 1: border now supports its own opacity too, same mechanism
    // as fill (hexToRgba defaults to fully opaque when unset, so older
    // saved styles with no borderOpacity render exactly as before).
    ctx.strokeStyle = hexToRgba(style.borderColor, style.borderOpacity == null ? 100 : style.borderOpacity);
    ctx.setLineDash(obj._preview ? [6, 4] : dashArrayFor(style.borderStyle, style.borderWidth));

    if (obj.type === "hline") {
      if (hasBorder) {
        ctx.beginPath();
        ctx.moveTo(0, px.y + 0.5);
        ctx.lineTo(w, px.y + 0.5);
        ctx.stroke();
      }
    } else if (obj.type === "vline") {
      if (hasBorder) {
        ctx.beginPath();
        ctx.moveTo(px.x + 0.5, 0);
        ctx.lineTo(px.x + 0.5, h);
        ctx.stroke();
      }
    } else if (obj.type === "trend") {
      if (hasBorder) {
        ctx.beginPath();
        ctx.moveTo(px.x1, px.y1);
        ctx.lineTo(px.x2, px.y2);
        ctx.stroke();
      }
    } else if (obj.type === "rect") {
      var rx = Math.min(px.x1, px.x2), ry = Math.min(px.y1, px.y2);
      var rw = Math.abs(px.x2 - px.x1), rh = Math.abs(px.y2 - px.y1);
      if (style.fillOpacity > 0) {
        ctx.fillStyle = hexToRgba(style.fillColor, style.fillOpacity);
        ctx.fillRect(rx, ry, rw, rh);
      }
      if (hasBorder) ctx.strokeRect(rx, ry, rw, rh);
      // v36 Fix 4: optional horizontal line through the vertical midpoint
      // of the box, spanning the box's own width — drawn with its own
      // independent color/width/dash style, on top of the fill/border.
      var ml = style.middleLine;
      if (ml && ml.enabled && ml.width > 0) {
        ctx.setLineDash(obj._preview ? [6, 4] : dashArrayFor(ml.style, ml.width));
        ctx.lineWidth = ml.width;
        ctx.strokeStyle = hexToRgba(ml.color, ml.opacity == null ? 100 : ml.opacity);
        var midY = ry + rh / 2;
        ctx.beginPath();
        ctx.moveTo(rx, midY + 0.5);
        ctx.lineTo(rx + rw, midY + 0.5);
        ctx.stroke();
      }
    } else if (obj.type === "fib") {
      // v47: Update 2/3 — a horizontal line per level, spanning the box's
      // full width (min/max of the two anchor points' x), at the price
      // fibLevelPrice() computes for that level. While still being placed
      // (obj._preview), the Level 1 (first click) and Level 0 (mouse
      // position) lines are dashed and every other level is solid; once
      // finalized every level shares the object's own border color/width/
      // type, per the settings panel (Set.png) having only one such
      // control, not one per level.
      var frx = Math.min(px.x1, px.x2), frw = Math.abs(px.x2 - px.x1);
      var rows = fibLevelRows(obj);
      for (var ri = 0; ri < rows.length; ri++) {
        var lvl = rows[ri];
        var lvlPrice = fibLevelPrice(obj, lvl.level);
        var ly = surface.C.priceToY(lvlPrice);
        if (ly === null) continue;
        var isAnchor = lvl.level === 0 || lvl.level === 1;
        ctx.setLineDash(obj._preview ? (isAnchor ? [6, 4] : []) : dashArrayFor(style.borderStyle, style.borderWidth));
        if (hasBorder) {
          ctx.beginPath();
          ctx.moveTo(frx, ly + 0.5);
          ctx.lineTo(frx + frw, ly + 0.5);
          ctx.stroke();
        }
        // v47 Update 3: "Enable Description" — a minimal label at the
        // line's right-hand edge, readable but deliberately small so it
        // doesn't crowd a chart with several levels defined.
        if (!obj._preview && style.showDescription && lvl.description) {
          ctx.save();
          ctx.setLineDash([]);
          ctx.font = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
          ctx.textBaseline = "middle";
          ctx.textAlign = "left";
          ctx.fillStyle = hexToRgba(style.borderColor, style.borderOpacity == null ? 100 : Math.max(70, style.borderOpacity));
          ctx.fillText(lvl.description, frx + frw + 4, ly);
          ctx.restore();
        }
      }
    } else if (obj.type === "fibext") {
      // v53 Update 2: Fibonacci Expansion.
      //  - Two dashed guide legs: click1->click2 ("-2"->"-1") and
      //    click2->click3 ("-1"->E2/level 0) — always dashed, drawn at
      //    all times (not just while placing), so the base geometry stays
      //    visible on the finished object.
      //  - One horizontal line per level (E2=0, C2=1, and any further
      //    rows the user adds), each spanning the click2->click3 time
      //    range and positioned at fibExtLevelPrice()'s price for that
      //    level — i.e. two parallel, equal-length segments at levels 0
      //    and 1 by default, whose own start/end times are exactly the
      //    2nd and 3rd click's times, per spec.
      ctx.setLineDash([5, 4]);
      if (hasBorder) {
        ctx.beginPath();
        ctx.moveTo(px.x1, px.y1);
        ctx.lineTo(px.x2, px.y2);
        if (px.x3 !== undefined) ctx.lineTo(px.x3, px.y3);
        ctx.stroke();
      }
      if (px.x3 !== undefined) {
        var ferx = Math.min(px.x2, px.x3), ferw = Math.abs(px.x3 - px.x2);
        var feRows = fibLevelRows(obj);
        for (var fi = 0; fi < feRows.length; fi++) {
          var flvl = feRows[fi];
          var flvlPrice = fibExtLevelPrice(obj, flvl.level);
          var fly = surface.C.priceToY(flvlPrice);
          if (fly === null) continue;
          var fIsAnchor = flvl.level === 0 || flvl.level === 1;
          ctx.setLineDash(obj._preview ? (fIsAnchor ? [6, 4] : []) : dashArrayFor(style.borderStyle, style.borderWidth));
          if (hasBorder) {
            ctx.beginPath();
            ctx.moveTo(ferx, fly + 0.5);
            ctx.lineTo(ferx + ferw, fly + 0.5);
            ctx.stroke();
          }
          if (!obj._preview && style.showDescription && flvl.description) {
            ctx.save();
            ctx.setLineDash([]);
            ctx.font = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";
            ctx.fillStyle = hexToRgba(style.borderColor, style.borderOpacity == null ? 100 : Math.max(70, style.borderOpacity));
            ctx.fillText(flvl.description, ferx + ferw + 4, fly);
            ctx.restore();
          }
        }
      }
    }
    ctx.restore();
  }

  // Draws the selection box for the currently-selected object: draggable
  // handles for trend/rect (which support resize), and a soft highlight
  // band along the line for hline/vline (which only support move).
  function drawSelectionHandles(surface, ctx, obj, w, h) {
    var px = objectPixels(surface, obj);
    if (!px) return;

    ctx.save();
    if (obj.type === "trend" || obj.type === "fib" || obj.type === "fibext") {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#c9a227";
      ctx.lineWidth = 1.5;
      // v53: draws 2 handles for trend/fib, 3 for a fully-placed fibext.
      getTrendHandles(surface, obj).forEach(function (pt) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, App.HANDLE_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    } else if (obj.type === "rect") {
      var minX = Math.min(px.x1, px.x2), maxX = Math.max(px.x1, px.x2);
      var minY = Math.min(px.y1, px.y2), maxY = Math.max(px.y1, px.y2);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(minX - 2, minY - 2, (maxX - minX) + 4, (maxY - minY) + 4);
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#c9a227";
      ctx.lineWidth = 1.5;
      [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]].forEach(function (pt) {
        ctx.beginPath();
        ctx.rect(pt[0] - App.HANDLE_S / 2, pt[1] - App.HANDLE_S / 2, App.HANDLE_S, App.HANDLE_S);
        ctx.fill();
        ctx.stroke();
      });
      // v36.9 Fix 2: edge-midpoint handles, drawn the same way as the
      // corner handles so they read as "also draggable" at a glance.
      getRectMidHandles(surface, obj).forEach(function (pt) {
        ctx.beginPath();
        ctx.rect(pt.x - App.HANDLE_S / 2, pt.y - App.HANDLE_S / 2, App.HANDLE_S, App.HANDLE_S);
        ctx.fill();
        ctx.stroke();
      });
    } else if (obj.type === "hline") {
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = (obj.style.borderWidth || 2) + 4;
      ctx.beginPath();
      ctx.moveTo(0, px.y + 0.5);
      ctx.lineTo(w, px.y + 0.5);
      ctx.stroke();
    } else if (obj.type === "vline") {
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = (obj.style.borderWidth || 2) + 4;
      ctx.beginPath();
      ctx.moveTo(px.x + 0.5, 0);
      ctx.lineTo(px.x + 0.5, h);
      ctx.stroke();
    }
    ctx.restore();
  }

  // v36.9 Fix 1: drawn objects used to sit on a layer above EVERYTHING,
  // including lightweight-charts' own price (right) axis and time (bottom)
  // axis — both of which are painted as part of the *same* chart-surface
  // area the overlay covers edge-to-edge. Fix: clip every frame's paint to
  // the plot rectangle only — i.e. the chart area MINUS the price scale's
  // width (right) and the time scale's height (bottom), both queried live
  // from THIS surface's own chart on each frame so the clip always matches
  // that panel's own axes.
  function plotAreaSize(surface, cssWidth, cssHeight) {
    var priceScaleW = 0, timeScaleH = 0;
    try { priceScaleW = surface.chart.priceScale("right").width() || 0; } catch (_) {}
    try { timeScaleH = surface.chart.timeScale().height() || 0; } catch (_) {}
    return {
      w: Math.max(0, cssWidth - priceScaleW),
      h: Math.max(0, cssHeight - timeScaleH),
    };
  }

  // ---- V64.2: Daily Break --------------------------------------------------
  // A vertical line at the first candle of every trading day (candle times are
  // the broker's clock, so a day starts where floor(time / 86400) changes).
  // These are NOT objects: they are not in App.drawObjects, so they can not be
  // selected, moved, hidden or deleted, are not saved, and never reach the
  // Object Tree. They are computed inside the overlay paint for THIS surface's
  // visible bars only:
  //   - the visible logical range gives two array indices;
  //   - for each broker day inside them, one binary search finds that day's
  //     first candle (days without candles - weekends - simply find none);
  //   - all lines go into one path and one stroke().
  // Cost per paint = (visible days) x log2(bars), independent of history size;
  // with the switch off it is a single property read. Nothing is scheduled or
  // kept for time ranges nobody is looking at, and there is no cache to
  // invalidate: a paint is already triggered by every pan/zoom/live candle.
  App.dailyBreak = App.dailyBreak || { enabled: false, color: "#6b7686", width: 1 };
  var DAY_SEC = 86400;

  function firstIndexAtOrAfter(arr, time, lo, hi) {
    // smallest index in [lo, hi] with arr[i].time >= time, or hi + 1
    var a = lo, b = hi + 1;
    while (a < b) {
      var mid = (a + b) >> 1;
      if (arr[mid].time >= time) b = mid; else a = mid + 1;
    }
    return a;
  }

  function drawDailyBreaks(surface, ctx, plotW, plotH) {
    var db = App.dailyBreak;
    if (!db || !db.enabled || !surface.getCandles) return;
    var arr = surface.getCandles();
    if (!arr || arr.length < 2) return;
    var range = null;
    try { range = surface.chart.timeScale().getVisibleLogicalRange(); } catch (_) {}
    if (!range) return;
    var last = arr.length - 1;
    var i0 = Math.max(0, Math.floor(range.from) - 1);
    var i1 = Math.min(last, Math.ceil(range.to) + 1);
    if (i1 <= i0) return;

    var firstDay = Math.floor(arr[i0].time / DAY_SEC);
    var lastDay = Math.floor(arr[i1].time / DAY_SEC);
    var lw = Number(db.width) || 1;
    var xs = [];
    var lastX = -1e9;
    for (var day = firstDay; day <= lastDay; day++) {
      var idx = firstIndexAtOrAfter(arr, day * DAY_SEC, i0, i1);
      if (idx > i1 || idx === 0) continue;            // no candle that day / start of loaded data
      if (Math.floor(arr[idx].time / DAY_SEC) !== day) continue; // that day has no candles
      if (Math.floor(arr[idx - 1].time / DAY_SEC) === day) continue; // not the day's FIRST candle (window edge)
      var x = surface.C.logicalToX(idx);
      if (x === null || x < 0 || x > plotW) continue;
      if (x - lastX < 3) continue;                    // zoomed far out: never paint a solid wall
      lastX = x;
      xs.push(x);
    }
    if (!xs.length) return;

    ctx.save();
    ctx.strokeStyle = db.color;
    ctx.lineWidth = lw;
    // V64.5: always solid - a solid path is the cheapest thing a canvas can draw.
    ctx.setLineDash([]);
    var off = (lw % 2) ? 0.5 : 0;
    ctx.beginPath();
    for (var k = 0; k < xs.length; k++) {
      var px = Math.round(xs[k]) + off;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, plotH);
    }
    ctx.stroke();
    ctx.restore();
  }

  // v38: one render loop per surface, each painting the SAME global
  // App.drawObjects using its own coordinate mapping — this is what keeps
  // every object visible, in its correct real-time position, on every
  // panel and every timeframe simultaneously.
  function renderFrame(surface) {
    if (surfaces.indexOf(surface) === -1) return; // surface was destroyed
    if (surfaceNeedsPaint(surface)) paintSurface(surface);
    scheduleNextFrame(surface);
  }

  // v56.1: paint-only half of renderFrame(), with no scheduleNextFrame()
  // side effect. Split out so resizeSurfaceCanvasAndRepaint() (see above)
  // can force one synchronous repaint right after a canvas resize without
  // adding a second link to that surface's already-running per-frame
  // requestAnimationFrame chain - calling the old combined renderFrame()
  // there would have queued an extra, redundant next-frame callback on top
  // of the one the surface's normal loop already has pending.
  function paintSurface(surface) {
    var ctx = surface.ctx2d;
    var w = surface.canvas.width, h = surface.canvas.height;
    var cssW = w / App.dpr, cssH = h / App.dpr;
    // v57 Update 7: remember exactly what this paint was produced from, so
    // the next frame can tell in a few microseconds whether anything that
    // affects the picture has actually moved (see surfaceNeedsPaint).
    surface._paintedSignature = surfaceSignature(surface, cssH);
    surface._paintedAt = Date.now();
    beginPixelMemo();
    try {
    ctx.save();
    ctx.setTransform(App.dpr, 0, 0, App.dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    var plot = plotAreaSize(surface, cssW, cssH);
    ctx.beginPath();
    ctx.rect(0, 0, plot.w, plot.h);
    ctx.clip();
    // V64.2: Daily Break lines sit underneath every drawn object.
    drawDailyBreaks(surface, ctx, plot.w, plot.h);
    App.drawObjects.forEach(function (obj) { if (!obj.hidden) drawOneObject(surface, ctx, obj, cssW, cssH); });
    // v33.2 fix 4: a Ctrl/Shift multi-selection in the Object Tree panel
    // highlights EVERY selected object on the chart, not just the single
    // App.selectedObject — matching the panel's own uniform yellow
    // highlight for the whole selection. Falls back to the single
    // App.selectedObject when there's no active panel multi-selection
    // (the normal single-click case).
    var selectedForChart = (App.panelSelectedObjects && App.panelSelectedObjects.length)
      ? App.panelSelectedObjects
      : (App.selectedObject ? [App.selectedObject] : []);
    selectedForChart.forEach(function (obj) {
      if (!obj || obj.hidden || App.drawObjects.indexOf(obj) === -1) return;
      // The highlight band for hline/vline goes underneath the line itself
      // so it doesn't obscure it; draw it first for those two types.
      if (obj.type === "hline" || obj.type === "vline") {
        drawSelectionHandles(surface, ctx, obj, cssW, cssH);
        drawOneObject(surface, ctx, obj, cssW, cssH);
      } else {
        drawSelectionHandles(surface, ctx, obj, cssW, cssH);
      }
    });
    // v21 restore: the object being actively dragged out (trend/rect)
    // lives in App.pendingObject, not yet in App.drawObjects — draw it on
    // every surface too so its live preview is visible on whichever panel
    // it's being placed on.
    if (App.pendingObject) drawOneObject(surface, ctx, App.pendingObject, cssW, cssH);
    // v40: the Ctrl+drag rubber-band selection box itself, drawn only on
    // the surface it's actually being dragged on.
    if (App.selectionBox && App.selectionBox.surface === surface) drawSelectionBoxRect(ctx, App.selectionBox);
    ctx.restore();
    } finally {
      // The memo must never outlive the paint it belongs to: an interactive
      // call site (hit-testing mid-drag) reading a memoized value would be
      // reading coordinates from before the drag moved the object.
      endPixelMemo();
    }
  }

  // v57 Update 7 (perf): cheap, allocation-light fingerprint of everything
  // this surface's next paint would be derived from that ISN'T already
  // covered by an explicit requestRender()/keepRenderingFor() signal - i.e.
  // the chart's own current mapping. Two coordinateToPrice() probes (top and
  // bottom edge of the canvas) capture the full vertical mapping - any price
  // pan, zoom, autoscale step or series change moves at least one of them -
  // and the visible logical range plus the canvas size capture the
  // horizontal mapping and the viewport itself.
  function surfaceSignature(surface, cssH) {
    var range = null, top = null, bottom = null;
    try { range = surface.chart.timeScale().getVisibleLogicalRange(); } catch (_) {}
    try {
      top = surface.series.coordinateToPrice(0);
      bottom = surface.series.coordinateToPrice(cssH);
    } catch (_) {}
    return surface.canvas.width + "|" + surface.canvas.height +
      "|" + (range ? range.from + "," + range.to : "-") +
      "|" + top + "|" + bottom;
  }

  // Decides whether this frame has to actually clear and repaint the overlay.
  // Note this runs INSIDE the per-frame requestAnimationFrame callback that
  // was already there before - the frame cadence is unchanged, so nothing can
  // be missed by more than one frame; what changes is that a frame with
  // nothing new to show now costs one string comparison instead of a full
  // canvas clear + redraw of every object on every visible panel.
  function surfaceNeedsPaint(surface) {
    if (dirty) return true;
    var key = surfaceKey(surface);
    var now = Date.now();
    if (activityUntil[key] && activityUntil[key] > now) return true;
    if (App.replayActive && App.replayPlaying) return true;
    if (App.jumpRenderSuppressed) return true;
    // Safety net: even if some mutation path were ever to forget its
    // requestRender(), the overlay self-heals within IDLE_HEARTBEAT_MS
    // rather than leaving a stale frame on screen indefinitely.
    if (!surface._paintedAt || (now - surface._paintedAt) >= IDLE_HEARTBEAT_MS) return true;
    if (surface._paintedSignature === undefined) return true;
    var cssH = surface.canvas.height / App.dpr;
    return surfaceSignature(surface, cssH) !== surface._paintedSignature;
  }

  // Rendering is driven by requestAnimationFrame, so it is throttled to the
  // display's real refresh rate and pauses automatically in a background or
  // minimized window. See the note inside for what v57 changed.
  function scheduleNextFrame(surface) {
    // V45 UX fix, kept intact: every visible chart surface stays on the
    // continuous requestAnimationFrame cadence - it is never downgraded to a
    // slow timer, so an Object Tree jump that moves all three panels at once
    // still lands on every panel in the same frame, and object appearance,
    // selection, drag/move, zoom, pan/jump, hover and style changes stay
    // equally responsive on every visible chart.
    //
    // v57 Update 7 changes what that frame COSTS, not when it happens: the
    // frame still fires, but renderFrame() now repaints only if something
    // that affects the picture actually moved (see surfaceNeedsPaint). V45
    // had to disable V41's dirty gate because a dirty flag alone can be
    // starved by a mutation path that forgets to raise it; checking the
    // chart's own live mapping every frame has no such failure mode, so the
    // idle cost drops to ~0 with none of V45's risk. Measured on an idle
    // 3-panel layout: 180 full canvas repaints per second -> 3.
    // The shared `dirty` flag is only cleared once ALL surfaces currently
    // on screen have consumed it in this pass — clearing it after the
    // first surface's own renderFrame() call would starve every other
    // surface of the same repaint (each surface schedules its own next
    // frame independently, in whatever order requestAnimationFrame fires
    // them). dirtyConsumedBy tracks that per surface and resets itself
    // (see requestRender/keepRenderingFor) the moment a NEW dirty signal
    // arrives mid-pass, so a fresh signal is never swallowed by an
    // in-flight pass finishing.
    if (dirty) {
      dirtyConsumedBy[surfaceKey(surface)] = true;
      if (surfaces.every(function (s) { return dirtyConsumedBy[surfaceKey(s)]; })) {
        dirty = false;
        dirtyConsumedBy = {};
      }
    }
    requestAnimationFrame(function () { renderFrame(surface); });
  }

  // v40: the translucent gold rectangle drawn for an in-progress Ctrl+drag
  // multi-select box — same visual language (gold) as the rest of the
  // selection UI in this file.
  function drawSelectionBoxRect(ctx, box) {
    var minX = Math.min(box.startX, box.curX), maxX = Math.max(box.startX, box.curX);
    var minY = Math.min(box.startY, box.curY), maxY = Math.max(box.startY, box.curY);
    ctx.save();
    ctx.fillStyle = "rgba(41,128,246,0.15)";
    ctx.strokeStyle = "rgba(41,128,246,0.9)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    ctx.restore();
  }

  // ---- Creation flow --------------------------------------------------
  function cancelPendingObject() {
    App.pendingObject = null;
    App.dragStart = null;
  }

  // v33: any create/move/resize/lock/hide/delete change routes through
  // here so the on-disk save (drawing-persistence.js) and the Object Tree
  // panel (object-panel.js) both stay in sync with App.drawObjects,
  // without every mutation site needing to know about either module.
  // Both are optional/loaded-later-safe: if neither module is present yet
  // (or at all), this is a harmless no-op.
  // v41 perf: also the one place that needs to mark the overlay dirty for
  // every one of those same mutations (create/lock/hide/delete/name/folder
  // changes) - covering it here means removeObject/setLocked/setHidden/
  // finalizeObject, plus anything object-panel.js or drawing-context-menu.js
  // call through this same funnel, don't each need their own requestRender().
  function persistChange() {
    requestRender();
    if (App.DrawingPersistence) App.DrawingPersistence.scheduleSave();
    if (App.ObjectsPanel) App.ObjectsPanel.refresh();
  }

  function finalizeObject(obj) {
    obj.id = App.nextObjectId++;
    if (obj.locked === undefined) obj.locked = false;
    if (obj.hidden === undefined) obj.hidden = false;
    // v33.1 Fix 3/4: every object gets an editable name (defaulting to its
    // type label) and a folder slot (top-level until dragged into one).
    if (obj.name === undefined) obj.name = TYPE_LABELS[obj.type] || obj.type;
    if (obj.folderId === undefined) obj.folderId = null;
    // v40 Bar Replay Update 5: an object created WHILE Replay is active is
    // scratch/temporary for that replay session only — it is deleted the
    // moment Replay mode is closed (see replay-bar.js's
    // purgeReplayTempObjects()). An object created outside Replay is
    // permanent, as always.
    if (obj._replayTemp === undefined) obj._replayTemp = !!App.replayActive;
    App.drawObjects.push(obj);
    App.pendingObject = null;
    App.dragStart = null;
    persistChange();
  }

  // ---- v33: Object Tree panel support (delete/lock/hide, jump anchor) ----
  function removeObject(obj) {
    var idx = App.drawObjects.indexOf(obj);
    if (idx === -1) return false;
    App.drawObjects.splice(idx, 1);
    if (App.selectedObject === obj) { App.selectedObject = null; App.interaction = null; }
    // v33.1 Fix 2: keep the panel's multi-selection free of dangling
    // references to a now-deleted object.
    var psIdx = App.panelSelectedObjects.indexOf(obj);
    if (psIdx !== -1) App.panelSelectedObjects.splice(psIdx, 1);
    if (App.panelLastClickedObject === obj) App.panelLastClickedObject = null;
    if (App.activeMenuObject === obj) App.DrawingContextMenu.close();
    persistChange();
    return true;
  }

  function setLocked(obj, locked) {
    obj.locked = !!locked;
    if (obj.locked && App.interaction && App.interaction.obj === obj) App.interaction = null;
    persistChange();
  }

  function setHidden(obj, hidden) {
    obj.hidden = !!hidden;
    if (obj.hidden) {
      if (App.selectedObject === obj) { App.selectedObject = null; App.interaction = null; }
      if (App.activeMenuObject === obj) App.DrawingContextMenu.close();
    }
    persistChange();
  }

  // The Jump Time target for an object: the real-time position of its
  // right-most (largest-time) point — see the Object Tree panel's row
  // click handler. A horizontal line has no time component at all, so it
  // has no jump target.
  // v33.6: trend/rect anchor is the FLOORED MIDPOINT of the object's two
  // point times.
  function getAnchorTime(obj) {
    if (!obj || obj.type === "hline") return null;
    if (obj.type === "vline") return obj.points[0].time;
    // v53: generalized to the object's LAST point (was always points[1])
    // so a 3-point Fib Expansion anchors on its own full time span too,
    // rather than just its first two clicks.
    return Math.floor((obj.points[0].time + obj.points[obj.points.length - 1].time) / 2);
  }

  function onCanvasMouseDown(surface, evt) {
    if (App.currentTool === "cursor") { handleCursorMouseDown(surface, evt); return; }
    if (evt.button !== 0) return; // left button only for drawing
    var C = surface.C;
    var pos = mousePos(surface, evt);
    var logical = C.xToLogical(pos.x);
    var price = C.yToPrice(pos.y);
    if (logical === null || logical === undefined || price === null || price === undefined) return;

    if (App.currentTool === "hline") {
      finalizeObject({ type: "hline", points: [{ logical: logical, price: price }], style: defaultStyle("hline") });
      returnToCursor();
    } else if (App.currentTool === "vline") {
      // v21: store real time (like trend/rect), not a timeframe-relative
      // logical index, so the line stays put on every timeframe/panel.
      var vt0 = C.logicalToTime(logical);
      if (vt0 === null) return;
      finalizeObject({ type: "vline", points: [{ time: vt0, price: price }], style: defaultStyle("vline") });
      returnToCursor();
    } else if (App.currentTool === "trend" || App.currentTool === "rect" || App.currentTool === "fib" || App.currentTool === "fibext") {
      // v36.9 Fix 3: trend line / rectangle / fib use a click -> move (live
      // preview follows) -> click flow, not click+drag+release.
      // v53 Update 2: Fib Expansion extends this to a THIRD click — the
      // pending object's `points` array simply grows from 2 to 3 entries
      // once the 2nd click lands (see below), and every click after the
      // first just overwrites its own live point (points[points.length-1],
      // kept in sync by onCanvasMouseMove) before either finalizing (2-
      // point tools) or growing by one more live point (fibext, until it
      // too reaches 3).
      //
      // This first branch only runs when there is no pending object yet —
      // i.e. this IS the first click. App.dragStart doubles as the
      // "awaiting the next click" flag.
      if (!App.pendingObject) {
        var t0 = C.logicalToTime(logical);
        if (t0 === null) return;
        App.dragStart = { time: t0, price: price, surface: surface };
        App.pendingObject = {
          type: App.currentTool,
          points: [{ time: t0, price: price }, { time: t0, price: price }],
          style: defaultStyle(App.currentTool),
          _preview: true,
        };
        return;
      }
      // A later click: confirm the pending object's current live point
      // (the last one in `points`) at the mouse position. Only the same
      // surface the placement started on tracks/confirms it.
      if (App.dragStart && App.dragStart.surface !== surface) return;
      var tN = C.logicalToTime(logical);
      if (tN !== null) App.pendingObject.points[App.pendingObject.points.length - 1] = { time: tN, price: price };

      if (App.currentTool === "fibext" && App.pendingObject.points.length === 2) {
        // That was the 2nd click (Level -1) — Level -2/-1 are now both
        // fixed; start tracking the 3rd click (E2, level 0) as a new live
        // point instead of finalizing.
        App.pendingObject.points.push({ time: tN !== null ? tN : App.pendingObject.points[1].time, price: price });
        return;
      }
      App.pendingObject._preview = false;
      finalizeObject(App.pendingObject);
      returnToCursor();
    }
  }

  function onCanvasMouseMove(surface, evt) {
    if (App.currentTool === "cursor") { handleCursorMouseMove(surface, evt); return; }
    // v36.9 Fix 3: the live preview now tracks the mouse continuously while
    // a trend/rect/fib(ext) placement is pending — no button needs to be
    // held down.
    if (!App.pendingObject) return;
    if (App.dragStart && App.dragStart.surface !== surface) return;
    var C = surface.C;
    var pos = mousePos(surface, evt);
    var logical = C.xToLogical(pos.x);
    var price = C.yToPrice(pos.y);
    if (logical === null || logical === undefined || price === null || price === undefined) return;
    var t = C.logicalToTime(logical);
    if (t === null) return;
    // v53: generalized to "whichever point isn't confirmed yet" (always
    // the last one in the array) so this same line drives the 2-point
    // trend/rect/fib preview AND fibext's growing 2-then-3-point preview.
    App.pendingObject.points[App.pendingObject.points.length - 1] = { time: t, price: price };
  }

  function onCanvasMouseUp(surface, evt) {
    if (App.currentTool === "cursor") { handleCursorMouseUp(surface, evt); return; }
    // v36.9 Fix 3: finalizing now happens on the second mousedown (see
    // onCanvasMouseDown above), not on mouseup — there is no drag gesture
    // left to release.
  }

  // v38: wires up one surface's canvas + container with exactly the same
  // interaction model the primary chart always had — so a drawing tool,
  // hover-arming, click+drag select/move/resize, Alt+drag clone, Ctrl+drag
  // rubber-band select and the right-click editor all work identically on
  // every visible panel, not just the primary one.
  // v51 Update 2: last-known mouse position (which surface + client
  // coords), kept up to date regardless of the current tool, so the
  // Horizontal/Vertical Line keyboard shortcuts can place an object
  // immediately at the cursor's current spot without requiring a click.
  var lastHover = null; // {surface, clientX, clientY} or null when off every chart

  function attachSurfaceInteraction(surface) {
    // v41 perf: any mouse activity over this surface's canvas or container
    // keeps rendering free-running (every frame) for a short window,
    // exactly matching the old always-on RAF loop's behavior during
    // interaction. This is intentionally a blanket rule rather than one
    // requestRender() call per state mutation - selection, hover-arming,
    // drag previews and the rubber-band box are all driven from these same
    // handlers (and a couple of sibling modules), so gating on "the mouse
    // is moving over a surface" is the one trigger that can't miss a path.
    // Idle time (mouse not over any surface, nothing being dragged) is the
    // case that actually accounts for the 99%+ wasted frames the doc
    // measured, and that case is untouched by any of this.
    function markActive() { keepRenderingFor(surface, 250); }
    surface.canvas.addEventListener("mousedown", function (evt) { markActive(); onCanvasMouseDown(surface, evt); });
    surface.canvas.addEventListener("mousemove", function (evt) { markActive(); onCanvasMouseMove(surface, evt); });
    surface.canvas.addEventListener("mouseup", function (evt) { markActive(); onCanvasMouseUp(surface, evt); });
    surface.canvas.addEventListener("mouseleave", function () {
      // v21 restore: losing the mouse mid-drag of a trend/rect shouldn't
      // leave a half-finished pending object stuck forever.
      if (App.dragStart && App.dragStart.surface === surface) cancelPendingObject();
      if (App.selectionBox && App.selectionBox.surface === surface) {
        App.selectionBox = null;
        // v40 fix: restore panning if the box gesture is abandoned by the
        // mouse leaving the canvas rather than a normal mouseup.
        setChartPanningEnabled(surface, true);
      }
      if (App.currentTool === "cursor" && !App.interaction) {
        surface.canvas.style.pointerEvents = "";
        surface.canvas.style.cursor = "";
      }
    });

    // The overlay canvas is pointer-events:none by default while the
    // cursor tool is idle, so normal chart pan/zoom/crosshair passes
    // straight through everywhere. That also means the canvas itself never
    // sees a mousemove or mousedown until *something else* arms it — so
    // the hover check and the initial mousedown have to run on the
    // container instead, which keeps getting the bubbled event no matter
    // what the overlay's pointer-events is set to.
    surface.container.addEventListener("mousemove", function (evt) {
      markActive();
      lastHover = { surface: surface, clientX: evt.clientX, clientY: evt.clientY };
      if (App.currentTool !== "cursor" || App.interaction || App.selectionBox) return;
      updateHoverArming(surface, mousePos(surface, evt));
    });
    surface.container.addEventListener("mouseleave", function () {
      if (lastHover && lastHover.surface === surface) lastHover = null;
    });
    surface.container.addEventListener("mousedown", function (evt) {
      markActive();
      if (App.currentTool !== "cursor" || evt.button !== 0) return;
      handleCursorMouseDown(surface, evt);
    });

    surface.container.addEventListener("contextmenu", function (evt) {
      evt.preventDefault();
      // Right-click while mid-drag: treat it as "cancel", matching Escape.
      if (App.dragStart) { cancelPendingObject(); returnToCursor(); return; }

      var pos = mousePos(surface, evt);
      // v33: locked objects are excluded from left-click hit testing (see
      // hitTest()'s default), but the whole point of a locked object is
      // that it can still be reached to unlock it again — via right click.
      var hit = hitTest(surface, pos.x, pos.y, { includeLocked: true });
      if (hit) {
        // v40: right-click on an object that's part of a multi-selection
        // (>1 objects currently selected) opens the minimal Hide/Lock/
        // Delete group menu; a right-click on a single selected object
        // still opens the full settings editor.
        var isGroupSelected = App.panelSelectedObjects &&
          App.panelSelectedObjects.length > 1 &&
          App.panelSelectedObjects.indexOf(hit) !== -1;
        if (isGroupSelected) {
          App.DrawingContextMenu.openGroup(App.panelSelectedObjects.slice(), evt.clientX, evt.clientY);
        } else {
          App.DrawingContextMenu.open(hit, evt.clientX, evt.clientY);
        }
      } else {
        App.DrawingContextMenu.close();
        if (App.DrawingContextMenu.closeGroup) App.DrawingContextMenu.closeGroup();
      }
    });
  }

  // v51 Update 2: place a Horizontal/Vertical Line immediately at the
  // last-known mouse position — used only by the Object: Horizontal Line
  // / Object: Vertical Line keyboard shortcuts (keyboard-shortcuts.js).
  // Every other tool keeps the normal "arm the tool, then click to place"
  // flow; per spec this instant-placement behavior is exclusive to these
  // two object types.
  function placeAtLastMouse(type) {
    if (!lastHover || !lastHover.surface) return false;
    var surface = lastHover.surface;
    var C = surface.C;
    var pos = mousePos(surface, { clientX: lastHover.clientX, clientY: lastHover.clientY });
    var logical = C.xToLogical(pos.x);
    var price = C.yToPrice(pos.y);
    if (logical === null || logical === undefined || price === null || price === undefined) return false;

    if (type === "hline") {
      finalizeObject({ type: "hline", points: [{ logical: logical, price: price }], style: defaultStyle("hline") });
    } else if (type === "vline") {
      var vt0 = C.logicalToTime(logical);
      if (vt0 === null) return false;
      finalizeObject({ type: "vline", points: [{ time: vt0, price: price }], style: defaultStyle("vline") });
    } else {
      return false;
    }
    // Placement is immediate/complete, so stay on (or return to) the
    // cursor tool rather than arming hline/vline for a further click.
    if (App.currentTool !== "cursor") returnToCursor();
    return true;
  }

  // Global safety net: if the mouse comes up somewhere outside every
  // surface's own canvas mid-drag (e.g. released over the toolbar or the
  // Object Tree panel), still end the interaction and reset every panel's
  // canvas back to its idle pointer-events/cursor state.
  document.addEventListener("mouseup", function () {
    if (App.currentTool === "cursor" && App.interaction) {
      App.interaction = null;
      surfaces.forEach(function (s) {
        s.canvas.style.pointerEvents = "none";
        s.canvas.style.cursor = "";
      });
    }
  });

  // v35.1 Fix 2: hide the object overlay during the atomic part of an
  // Object Tree jump. The chart and its time/price mappings can change
  // synchronously while the overlay is painted by its own requestAnimationFrame
  // loop. Without suppression, one frame can show the object at its OLD pixel
  // coordinates on top of the NEW chart. v38: applied to every surface, since
  // a jump on the primary chart also (harmlessly) blanks companion overlays
  // for the same couple of frames.
  function setJumpRenderSuppressed(suppressed) {
    App.jumpRenderSuppressed = !!suppressed;
    surfaces.forEach(function (s) {
      s.canvas.style.visibility = App.jumpRenderSuppressed ? "hidden" : "visible";
    });
    // The reveal half of this needs a guaranteed repaint: the jump can land
    // on a viewport whose mapping happens to fingerprint identically to the
    // pre-jump one (e.g. a jump that only changes WHICH candles are resident,
    // not the logical range) - explicit rather than inferred.
    requestRender();
  }

  function revealAfterJumpSettles(onSettled) {
    // Two animation frames deliberately separate the reveal from the
    // setData()/setVisibleLogicalRange() calls. This covers both the drawing
    // overlay's own RAF and the chart library's next render/update pass.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        setJumpRenderSuppressed(false);
        if (typeof onSettled === "function") onSettled();
      });
    });
  }

  // v38: called by multi-panel.js once per companion panel it creates.
  // opts: { chart, series, canvas, container, getTf(), getCandles() }
  // Returns a handle the caller uses to keep the overlay sized and to tear
  // it down if the panel is ever removed.
  function createPanelSurface(opts) {
    var surface = makeSurface(opts);
    var rect = opts.canvas.getBoundingClientRect();
    resizeSurfaceCanvas(surface, rect.width || 1, rect.height || 1);
    attachSurfaceInteraction(surface);
    // v41 perf: a companion panel can be added mid-session, after existing
    // surfaces have already settled onto the slow idle heartbeat -
    // requestRender() guarantees this new surface (and every existing one,
    // since dirty is shared) gets a prompt repaint rather than waiting up
    // to IDLE_HEARTBEAT_MS for its very first frame.
    requestRender();
    requestAnimationFrame(function () { renderFrame(surface); });
    return {
      resize: function (w, h) { resizeSurfaceCanvasAndRepaint(surface, w, h); },
      destroy: function () { destroySurface(surface); },
    };
  }

  function init() {
    buildToolbar();
    primarySurface = makeSurface({
      chart: App.chart,
      series: App.series,
      canvas: dom.drawCanvas,
      container: dom.chartContainer,
      isPrimary: true,
      getTf: function () { return App.currentTf; },
      getCandles: function () { return App.currentTf !== null ? App.candlesByTf[App.currentTf] : null; },
    });
    var rect = dom.chartContainer.getBoundingClientRect();
    resizeSurfaceCanvas(primarySurface, rect.width, rect.height);
    attachSurfaceInteraction(primarySurface);
    requestAnimationFrame(function () { renderFrame(primarySurface); });
  }

  // Back-compat: resizes the PRIMARY panel's overlay canvas only — this is
  // what chart-core.js's own ResizeObserver already calls. Companion
  // panels size themselves through the handle createPanelSurface() returns.
  function resizeDrawCanvas(cssWidth, cssHeight) {
    if (primarySurface) resizeSurfaceCanvasAndRepaint(primarySurface, cssWidth, cssHeight);
  }

  App.DrawingEngine = {
    init: init,
    createPanelSurface: createPanelSurface,
    resizeDrawCanvas: resizeDrawCanvas,
    setJumpRenderSuppressed: setJumpRenderSuppressed,
    revealAfterJumpSettles: revealAfterJumpSettles,
    cancelPendingObject: cancelPendingObject,
    returnToCursor: returnToCursor,
    // v51: exposed so keyboard-shortcuts.js can arm a drawing tool (e.g.
    // Ctrl+H for Horizontal Line) exactly as clicking its toolbar button
    // would.
    setTool: setTool,
    // v51 Update 2: instant hline/vline placement at the cursor for the
    // keyboard shortcuts (see keyboard-shortcuts.js). Returns false (does
    // nothing) if the mouse isn't currently over any chart panel.
    placeAtLastMouse: placeAtLastMouse,
    hitTest: function (x, y, opts) { return primarySurface ? hitTest(primarySurface, x, y, opts) : null; },
    showHint: showHint,
    persistChange: persistChange,
    removeObject: removeObject,
    setLocked: setLocked,
    setHidden: setHidden,
    getAnchorTime: getAnchorTime,
    // v41 perf: any external code that changes what should appear on the
    // overlay (chart pan/zoom range changes, live/replay ticks landing,
    // an object created/edited/selected from the Object Tree panel or the
    // right-click editor, resize, etc.) calls this so the next frame
    // actually repaints. See the dirty-render note above `surfaces`.
    requestRender: requestRender,
  };
})();
