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

  // v70.7 Update 2: "Timeframe Based Hidden or Show" — every object may
  // carry a `timeframes` map (key = timeframe in seconds, value = boolean)
  // saying which of the app's 9 fixed timeframes it's allowed to appear
  // on. `undefined`/missing means "not configured yet" and is always
  // treated as fully visible (every existing saved chart, and every newly
  // drawn object, keeps behaving exactly as before this feature existed —
  // the map is only ever materialized once the user actually opens the
  // Timeframes editor for that object). A timeframe the app doesn't offer
  // a checkbox for (any custom/future tf not in this list) also fails
  // open (visible) rather than silently hiding objects a user never got a
  // control for. This applies identically to every chart panel — single
  // or Multi-Chart — because visibility is decided per-surface from that
  // surface's OWN timeframe (surface.getTf()), not the primary chart's.
  var TF_SECONDS = [1, 5, 15, 60, 300, 900, 3600, 14400, 86400];
  function defaultTimeframesMap() {
    var map = {};
    TF_SECONDS.forEach(function (tf) { map[tf] = true; });
    return map;
  }
  // Lazily attaches the default (all-on) map the first time it's needed —
  // called by the Timeframes editor UI right before it starts reading/
  // writing checkboxes, so an object is never persisted with this field
  // until a user actually touches that editor.
  function ensureTimeframesMap(obj) {
    if (!obj.timeframes) obj.timeframes = defaultTimeframesMap();
    return obj.timeframes;
  }
  function isObjectVisibleAtTf(obj, tf) {
    if (!obj.timeframes || tf === null || tf === undefined) return true;
    var v = obj.timeframes[tf];
    return v === undefined ? true : !!v;
  }
  function surfaceTf(surface) {
    return (surface && surface.getTf) ? surface.getTf() : App.currentTf;
  }

  // v71 Update 1/2: "Auto" — when an object's `autoTf` flag is on, its
  // Timeframes map (above) is derived from its own time span instead of
  // being hand-edited. hline/vline are excluded everywhere (no time span,
  // no Auto concept for them at all — see drawing-context-menu.js).
  // Thresholds are strictly "more than" (per spec), so a duration exactly
  // on a boundary stays in the lower bucket.
  var AUTO_THRESHOLDS = [60, 300, 900, 3600, 14400, 86400];
  function computeAutoMap(durationSeconds) {
    var enabledCount = 3; // Seconds row (1s/5s/15s) is always included
    AUTO_THRESHOLDS.forEach(function (t) { if (durationSeconds > t) enabledCount++; });
    var map = {};
    TF_SECONDS.forEach(function (tf, i) { map[tf] = i < enabledCount; });
    return map;
  }
  // The object's own time span — start/end don't need to be labeled;
  // min/max across whatever real-time points it has (2 for trend/rect/fib,
  // 3 for fibext) is enough and works identically for all of them.
  function objectDuration(obj) {
    if (!obj || obj.type === "hline" || obj.type === "vline" || !obj.points) return null;
    var lo = null, hi = null;
    obj.points.forEach(function (p) {
      if (p && typeof p.time === "number") {
        if (lo === null || p.time < lo) lo = p.time;
        if (hi === null || p.time > hi) hi = p.time;
      }
    });
    if (lo === null || hi === null) return null;
    return Math.abs(hi - lo);
  }
  // Called only at the moments spec allows: a placement's final click, or
  // an existing point's drag ending (resize) — NEVER on a live in-progress
  // placement/drag position or on a whole-object move, which must stay
  // completely free of this calculation (see onCanvasMouseUp/
  // handleCursorMouseUp below).
  function applyAutoTimeframes(obj) {
    if (!obj || !obj.autoTf) return;
    var dur = objectDuration(obj);
    if (dur === null) return;
    obj.timeframes = computeAutoMap(dur);
  }

  // v70.2 Update 1/2/3: holding Shift snaps an in-progress trend-line
  // point (placement OR dragging an existing endpoint) to whichever axis
  // (horizontal/vertical) the cursor is currently closer to, relative to
  // the line's OTHER (anchor) point — recomputed continuously, so it can
  // flip axis mid-drag and always reflects live cursor position. For
  // rectangle/Fib Retracement/Fib Expansion corner points, Shift instead
  // locks the point to a single frozen price (horizontal-only) captured
  // the moment Shift goes down, leaving time free — released the instant
  // Shift comes back up. `shiftDown` is tracked globally (not per-surface)
  // since only one placement/interaction is ever active at a time (see
  // the v38 note above about App.interaction/App.pendingObject staying
  // single global values).
  var shiftDown = false;

  function captureShiftLock() {
    // Rectangle / Fib Retracement / Fib Expansion: freeze the point's
    // CURRENT price as the horizontal lock level. Trend line uses a
    // dynamic anchor-relative axis choice instead (see trendLockedPoint),
    // so it needs no captured state here.
    if (App.pendingObject) {
      var pts = App.pendingObject.points;
      var tool = App.pendingObject.type;
      if ((tool === "rect" || tool === "fib") && pts.length === 2) {
        App.pendingObject._shiftLockPrice = pts[pts.length - 1].price;
      } else if (tool === "fibext" && pts.length === 3) {
        App.pendingObject._shiftLockPrice = pts[pts.length - 1].price;
      }
    }
    if (App.interaction && App.interaction.kind === "resize") {
      var obj = App.interaction.obj;
      var role = App.interaction.role;
      if (obj.type === "rect" && role === "corner") {
        // v102: lock the DRAGGED corner's price, not points[0]'s - points[0] is only the
        // dragged corner after the first mousemove; before that it may be the fixed
        // corner, which collapsed the rect to zero height.
        var fx = App.interaction.fixed, p0 = obj.points[0].price, p1 = obj.points[1].price;
        App.interaction._shiftLockPrice = (fx && Math.abs(p0 - fx.price) < Math.abs(p1 - fx.price)) ? p1 : p0;
      } else if ((obj.type === "fib" || obj.type === "fibext") && role && role.indexOf("pt") === 0) {
        var idx = parseInt(role.slice(2), 10);
        if (!isNaN(idx) && obj.points[idx]) App.interaction._shiftLockPrice = obj.points[idx].price;
      }
      // trend (role "pt0"/"pt1") and rect edge-midpoints ("mid-*") are
      // deliberately excluded — trend is dynamic (no freeze needed), and
      // per spec Shift must have zero effect on rect midpoint handles
      // since they already move along a single axis.
    }
  }

  function releaseShiftLock() {
    if (App.pendingObject) delete App.pendingObject._shiftLockPrice;
    if (App.interaction) delete App.interaction._shiftLockPrice;
  }

  document.addEventListener("keydown", function (evt) {
    if (evt.key !== "Shift" || shiftDown) return;
    shiftDown = true;
    captureShiftLock();
  });
  document.addEventListener("keyup", function (evt) {
    if (evt.key !== "Shift") return;
    shiftDown = false;
    releaseShiftLock();
  });
  // Safety net: a Shift release that happens while the window/tab isn't
  // focused (e.g. Alt-Tab away mid-drag) never reaches keyup — without
  // this the lock could stay stuck on indefinitely.
  window.addEventListener("blur", function () {
    if (shiftDown) { shiftDown = false; releaseShiftLock(); }
  });

  // Trend line's Shift behavior: pick whichever axis (horizontal/
  // vertical) the raw cursor position is currently closer to, relative to
  // the line's fixed anchor point, in PIXEL space (an angle only really
  // means anything visually in pixels, not in mixed time/price units).
  // Ties (exactly diagonal) fall to horizontal.
  function trendLockedPoint(surface, anchor, pos, fallbackTime, fallbackPrice) {
    var C = surface.C;
    var aLogical = C.timeToLogical(anchor.time);
    var ax = aLogical !== null && aLogical !== undefined ? C.logicalToX(aLogical) : null;
    var ay = C.priceToY(anchor.price);
    if (ax === null || ax === undefined || ay === null || ay === undefined) {
      return { time: fallbackTime, price: fallbackPrice };
    }
    var dx = Math.abs(pos.x - ax), dy = Math.abs(pos.y - ay);
    if (dx >= dy) return { time: fallbackTime, price: anchor.price }; // horizontal
    return { time: anchor.time, price: fallbackPrice }; // vertical
  }

  // v109: Ctrl magnet. While placing/dragging a point, Ctrl snaps it to the
  // nearest candle (by X, so between two bars the closer one wins) and to
  // the closest of that candle's High / body-top / body-bottom / Low.
  // Nearest-of-four reproduces every zone rule (above High -> High, below
  // Low -> Low, in-between -> nearer boundary). No candle under the cursor
  // (live data not there yet) -> null, the point simply follows the mouse.
  function magnetPoint(surface, pos) {
    var arr = surface.getCandles ? surface.getCandles() : null;
    if (!arr || !arr.length) return null;
    var lg = surface.C.xToLogical(pos.x);
    var price = surface.C.yToPrice(pos.y);
    if (lg === null || lg === undefined || price === null || price === undefined) return null;
    var i = Math.round(lg);
    if (i < 0 || i > arr.length - 1) { setMagnet(surface, null); return null; }
    var c = arr[i];
    var lv = [c.high, Math.max(c.open, c.close), Math.min(c.open, c.close), c.low];
    var best = lv[0];
    for (var k = 1; k < 4; k++) if (Math.abs(lv[k] - price) < Math.abs(best - price)) best = lv[k];
    var res = { time: c.time, price: best };
    setMagnet(surface, res);
    return res;
  }

  // v109: tell the surface's crosshair to draw on the snapped point instead
  // of the raw mouse position (null = back to normal).
  function setMagnet(surface, pt) {
    var el = surface.container;
    if (!el || (!el._magnet && !pt)) return;
    el._magnet = pt;
    if (el._fcRefresh) el._fcRefresh();
  }
  function clearAllMagnets() {
    for (var i = 0; i < surfaces.length; i++) setMagnet(surfaces[i], null);
  }
  document.addEventListener("keyup", function (evt) { if (evt.key === "Control" || evt.key === "Meta") clearAllMagnets(); });
  window.addEventListener("blur", clearAllMagnets);
  // Ctrl pressed over a still mouse, tool armed but no first point yet.
  document.addEventListener("keydown", function (evt) {
    if ((evt.key !== "Control" && evt.key !== "Meta") || shiftDown || App.pendingObject || App.currentTool === "cursor") return;
    if (!lastHover) return;
    magnetPoint(lastHover.surface, mousePos(lastHover.surface, lastHover));
  });

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

  // v89 Update 6: Rectangle fill is painted by a chart series-primitive on
  // the 'bottom' z-order, i.e. UNDER the candles (the overlay canvas sits
  // above them, so a fill there dimmed the chart). It reads the live objects
  // and this surface's own mapping at draw time, so pan/zoom needs no work
  // from us; the overlay only calls requestUpdate() when a fill changed
  // (see syncFillPrimitive). Borders/handles/hit-testing stay on the overlay.
  function makeFillPrimitive(surface) {
    var reqUpdate = null;
    var renderer = {
      draw: function (target) {
        if (App.jumpRenderSuppressed) return;
        target.useMediaCoordinateSpace(function (scope) {
          paintSessions(surface, scope.context, scope.mediaSize.width, scope.mediaSize.height);  // v93
          paintRectFills(surface, scope.context);
        });
      },
    };
    var view = { zOrder: function () { return "bottom"; }, renderer: function () { return renderer; } };
    return {
      paneViews: function () { return [view]; },
      attached: function (p) { reqUpdate = p && p.requestUpdate; },
      detached: function () { reqUpdate = null; },
      requestUpdate: function () { if (reqUpdate) reqUpdate(); },
    };
  }

  // v93: trading sessions = low-opacity background bands under the candles
  // (no top strip / name label). Edges use the same time->logical->pixel
  // path as rectangle boxes (C.timeToLogical + C.logicalToX), so a boundary
  // sits exactly on its time at every timeframe. Session times are the session's own
  // zone (v117, x.z) or, for rows without a zone, display time (system time when Local Timezone is on, broker time otherwise).
  var SESSION_MAX_TF = 3600;
  function paintSessions(surface, ctx, w, h) {
    var list = App.sessions;
    if (!list || !list.length || App.jumpRenderSuppressed || !surface.getCandles) return;
    var tf = surfaceTf(surface);
    if (!tf || tf > SESSION_MAX_TF) return;
    var arr = surface.getCandles();
    if (!arr || !arr.length) return;
    var range = null;
    try { range = surface.chart.timeScale().getVisibleLogicalRange(); } catch (_) {}
    if (!range) return;
    var C = surface.C, n = arr.length;
    var tMin = C.logicalToTime(range.from - 1), tMax = C.logicalToTime(range.to + 1);
    if (tMin === null || tMax === null) return;
    // v116: the display shift now varies with DST, so day buckets/borders go through App.Tz
    var toUser = App.Tz ? App.Tz.toUser : function (t) { return t; };
    var toBroker = App.Tz ? App.Tz.toBroker : function (t) { return t; };
    var gapMax = Math.max(tf * 2, 3600);
    var d0 = Math.floor(toUser(tMin) / 86400) - 1, d1 = Math.floor(toUser(tMax) / 86400) + 1;

    // Time -> logical like boxes do; a time inside a market-closed gap
    // snaps to the joint between the two candles around it. Clamped to the
    // data edges (half a bar past the first/last candle).
    function edge(t) {
      var l = C.timeToLogical(t);
      if (l === null) return null;
      var lo = Math.floor(l);
      if (lo >= 0 && lo < n - 1 && l > lo && arr[lo + 1].time - arr[lo].time > gapMax) l = lo + 0.5;
      return Math.max(-0.5, Math.min(n - 0.5, l));
    }

    ctx.save();
    for (var k = 0; k < list.length; k++) {
      var x = list[k], len = (x.s < x.e ? x.e - x.s : x.e + 1440 - x.s) * 60;
      ctx.fillStyle = hexToRgba(x.color, x.opacity);
      // v117: x.z = the session's own zone (e.g. Europe/London): start/end are that zone's wall clock,
      // converted per day (its DST included) to broker time. Needs the broker clock rule.
      var dA = d0, dB = d1;
      if (x.z) { dA = Math.floor(tMin / 86400) - 2; dB = Math.floor(tMax / 86400) + 2; }
      for (var d = dA; d <= dB; d++) {
        var t0, t1;
        if (x.z) {
          t0 = App.Tz ? App.Tz.zoneWallToBroker(x.z, d * 86400 + x.s * 60) : null;
          t1 = App.Tz ? App.Tz.zoneWallToBroker(x.z, d * 86400 + x.s * 60 + len) : null;
          if (t0 === null || t1 === null) break;   // no broker rule yet / unknown zone: nothing to draw
        } else {
          t0 = toBroker(d * 86400 + x.s * 60); t1 = toBroker(d * 86400 + x.s * 60 + len);
        }
        if (t1 < tMin || t0 > tMax) continue;
        var la = edge(t0), lb = edge(t1);
        if (la === null || lb === null || lb <= la) continue;
        var xa = C.logicalToX(la), xb = C.logicalToX(lb);
        if (xa === null || xb === null) continue;
        var l = Math.max(0, xa), r = Math.min(w, xb);
        if (r > l) ctx.fillRect(l, 0, r - l, h);
      }
    }
    ctx.restore();
  }
  function refreshSessions() {
    surfaces.forEach(function (sf) { if (sf._fillPrim) sf._fillPrim.requestUpdate(); });
  }
  document.addEventListener("App:timeOffsetChanged", function () { refreshSessions(); });

  function fillableRect(obj, tf) {
    return obj && obj.type === "rect" && !obj.hidden && obj.style && obj.style.fillOpacity > 0 &&
      isObjectVisibleAtTf(obj, tf);
  }

  function paintRectFills(surface, ctx) {
    var tf = surfaceTf(surface);
    function one(obj) {
      if (!fillableRect(obj, tf)) return;
      var px = computeObjectPixels(surface, obj);
      if (!px) return;
      ctx.fillStyle = hexToRgba(obj.style.fillColor, obj.style.fillOpacity);
      ctx.fillRect(Math.min(px.x1, px.x2), Math.min(px.y1, px.y2), Math.abs(px.x2 - px.x1), Math.abs(px.y2 - px.y1));
    }
    App.drawObjects.forEach(one);
    one(App.pendingObject);
  }

  // Cheap: only asks the chart to redraw when something that affects a fill
  // changed since the last overlay paint (no fills on screen => constant "").
  function syncFillPrimitive(surface) {
    var prim = surface._fillPrim;
    if (!prim) return;
    var tf = surfaceTf(surface), sig = "";
    function add(o) {
      if (!fillableRect(o, tf)) return;
      sig += o.style.fillColor + o.style.fillOpacity + ":" +
        o.points.map(function (p) { return p.time + "/" + p.price; }).join(",") + ";";
    }
    App.drawObjects.forEach(add);
    add(App.pendingObject);
    if (sig) sig += surface._paintedSignature + (App.jumpRenderSuppressed ? "J" : "");
    if (sig === surface._fillSig) return;
    surface._fillSig = sig;
    prim.requestUpdate();
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
      // v70.3 Update 1: obj.id -> {obj, line, price, color} for this
      // surface's own native price-line axis labels (selected hlines
      // only — see syncHlineAxisLabels()).
      _hlineAxisLines: {},
      // v70.7: exposed directly on the surface (not just buried inside its
      // C coords context) so per-panel Timeframe-Based Hidden/Show
      // filtering (see isObjectVisibleAtTf() below) can ask "what
      // timeframe is THIS panel on" without reaching into App.currentTf —
      // which is only ever the primary panel's timeframe, wrong for every
      // Multi-Chart companion panel.
      getTf: opts.getTf,
      C: App.Coords.createSurfaceCoords({
        getChart: function () { return surface.chart; },
        getSeries: function () { return surface.series; },
        getTf: opts.getTf,
        getCandles: opts.getCandles,
      }),
    };
    surfaces.push(surface);
    // v89 Update 6: fill layer under the candles.
    try {
      surface._fillPrim = makeFillPrimitive(surface);
      surface.series.attachPrimitive(surface._fillPrim);
    } catch (e) { surface._fillPrim = null; }
    return surface;
  }

  function destroySurface(surface) {
    var idx = surfaces.indexOf(surface);
    if (idx !== -1) surfaces.splice(idx, 1);
    delete activityUntil[surfaceKey(surface)];
    delete dirtyConsumedBy[surfaceKey(surface)];
    if (App.interaction && App.interaction.surface === surface) App.interaction = null;
    if (App.selectionBox && App.selectionBox.surface === surface) App.selectionBox = null;
    if (surface._fillPrim) {
      try { surface.series.detachPrimitive(surface._fillPrim); } catch (e) { /* series already gone */ }
      surface._fillPrim = null;
    }
    // v70.3 Update 1: drop any native price lines this surface still owns
    // for a selected hline — best-effort, since a closed companion
    // panel's series may already be gone by the time this runs.
    if (surface._hlineAxisLines) {
      Object.keys(surface._hlineAxisLines).forEach(function (id) {
        try { surface.series.removePriceLine(surface._hlineAxisLines[id].line); } catch (e) { /* already gone */ }
      });
      surface._hlineAxisLines = {};
    }
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
    // v70.4 Update 2: the tool-selection guide text (only this hint — the
    // Delete/Undo toasts elsewhere are unaffected) can be turned off from
    // Setting → Configuration. See app-config.js's SHOW_TOOL_HINTS field;
    // App.AppConfig.isToolHintEnabled() reads its live in-memory value, so
    // toggling the checkbox takes effect immediately, with no restart.
    if (toolId !== "cursor" && (!App.AppConfig || App.AppConfig.isToolHintEnabled())) {
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

  function returnToCursor() { clearAllMagnets(); setTool("cursor"); }

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

  // v70.5 Update 2: selection is now always border-only, regardless of
  // fill — a filled rectangle used to be selectable by clicking anywhere
  // inside it, which made it impossible to click "through" a filled
  // rectangle to whatever was underneath/behind it. The border itself
  // stays hit-testable at zero opacity too (an invisible border is still
  // a real border for selection purposes; only the fill's own opacity
  // ever hid a hit-target before, and that "hidden but real" idea now
  // applies to the border as well). fillOpacity is no longer read here
  // at all — kept as a parameter for now so callers don't need updating.
  function hitTestRectRegion(px, x, y, fillOpacity) {
    var minX = Math.min(px.x1, px.x2), maxX = Math.max(px.x1, px.x2);
    var minY = Math.min(px.y1, px.y2), maxY = Math.max(px.y1, px.y2);
    var nearLeft = Math.abs(x - minX) <= App.HIT_TOLERANCE && y >= minY - App.HIT_TOLERANCE && y <= maxY + App.HIT_TOLERANCE;
    var nearRight = Math.abs(x - maxX) <= App.HIT_TOLERANCE && y >= minY - App.HIT_TOLERANCE && y <= maxY + App.HIT_TOLERANCE;
    var nearTop = Math.abs(y - minY) <= App.HIT_TOLERANCE && x >= minX - App.HIT_TOLERANCE && x <= maxX + App.HIT_TOLERANCE;
    var nearBottom = Math.abs(y - maxY) <= App.HIT_TOLERANCE && x >= minX - App.HIT_TOLERANCE && x <= maxX + App.HIT_TOLERANCE;
    return nearLeft || nearRight || nearTop || nearBottom;
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
      if (!isObjectVisibleAtTf(obj, surfaceTf(surface))) continue;
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
      // v108: the text of a trend/h/v line is part of that line.
      if (obj.lineText && obj.lineText.text && supportsLineText(obj)) {
        var ltg = lineTextGeom(surface, obj, px);
        if (ltg && ltg.mode === "text" && hitLineTextGeom(ltg, x, y)) return obj;
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
      // v89: deep-copy the whole style (was a field list that dropped borderOpacity / middleLine.opacity).
      style: JSON.parse(JSON.stringify(obj.style)),
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
      // v70.7: a clone keeps the source's per-timeframe visibility too.
      timeframes: obj.timeframes ? Object.assign({}, obj.timeframes) : undefined,
      // v71 Update 1: a clone also keeps the source's Auto on/off state —
      // it's still a copy of "this exact object's settings".
      autoTf: !!obj.autoTf,
      // v108: a clone keeps the line's text too.
      lineText: obj.lineText ? { text: obj.lineText.text, size: obj.lineText.size, place: obj.lineText.place, align: obj.lineText.align } : undefined,
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
    // v108: "+ Add text" pill of the selected trend/h/v line.
    var ps = App.selectedObject;
    if (ps && !textEdit && !ps.locked && !ps.hidden && supportsLineText(ps) && !(ps.lineText && ps.lineText.text) &&
        App.drawObjects.indexOf(ps) !== -1 && isObjectVisibleAtTf(ps, surfaceTf(surface))) {
      var pxs = objectPixels(surface, ps);
      var ptg = pxs ? lineTextGeom(surface, ps, pxs) : null;
      if (ptg && ptg.mode === "pill" && hitLineTextGeom(ptg, x, y)) return { obj: ps, kind: "addtext" };
    }
    var obj = hitTest(surface, x, y);
    if (obj) return { obj: obj, kind: "move" };
    return null;
  }

  function cursorForHit(hit) {
    if (!hit) return "";
    if (hit.kind === "resize") return "crosshair";
    if (hit.kind === "addtext") return "pointer";
    // Fix (item 2): this used to also return "crosshair" for a plain
    // *body* hover on a trend line (hit.kind === "move"), which is
    // visually identical to lightweight-charts' own default crosshair
    // cursor over the chart — so hovering a trend line looked like nothing
    // happened, even though it silently was arming for a move. Every other
    // object type already fell through to "move" for a body hover; trend
    // should too — "crosshair" is reserved for an actual resize handle.
    // v70.5 Update 1: a plain body hover now shows "pointer" (the link-
    // select hand) instead of "move" — the move-style cursor implied a
    // free-drag anywhere, while a hover-armed object is actually selected
    // via a click, like a link.
    return "pointer";
  }

  function updateHoverArming(surface, pos) {
    var hit = computeCursorHit(surface, pos.x, pos.y);
    surface.canvas.style.pointerEvents = hit ? "auto" : "";
    surface.canvas.style.cursor = cursorForHit(hit);
    // v108: brighten the pill while hovered (repaint only when it changes).
    var hp = hit && hit.kind === "addtext" ? hit.obj : null;
    if (hp !== hoverPillObj) { hoverPillObj = hp; requestRender(); }
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
    if (!isObjectVisibleAtTf(obj, surfaceTf(surface))) return false;
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
    // v108: clicking the "+ Add text" pill opens the inline editor (default
    // action prevented so the editor keeps the focus it is given here).
    if (hit.kind === "addtext") {
      evt.preventDefault();
      startTextEdit(surface, hit.obj);
      return;
    }
    var workObj = hit.obj;

    var startLogical = C.xToLogical(pos.x);
    var startPrice = C.yToPrice(pos.y);
    if (startLogical === null || startLogical === undefined || startPrice === null || startPrice === undefined) {
      return;
    }

    if (hit.kind === "resize") {
      App.interaction = { kind: "resize", obj: workObj, role: hit.role, fixed: hit.fixed, axis: hit.axis, midPointIndex: hit.midPointIndex, surface: surface };
      // v70.2: Shift may already be held down before the handle is picked
      // up (same "before or during" allowance as a fresh placement).
      if (shiftDown) captureShiftLock();
      return;
    }

    // Alt+drag clones the object instead of moving the original — the
    // clone becomes the thing that's dragged and selected; only a
    // whole-object move does (checked above: handles are tested first and
    // return early).
    if (evt.altKey) {
      workObj = cloneObjectDeep(hit.obj);
      workObj.id = App.nextObjectId++;
      if (App.replayActive) workObj.folderId = ensureReplayFolder().id; // v120
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
      // v109: Ctrl magnet while dragging a horizontal/vertical line - the
      // line jumps to the snapped point as if it were the floating mouse.
      var mgM = ((obj.type === "hline" || obj.type === "vline") && (evt.ctrlKey || evt.metaKey) && !shiftDown)
        ? magnetPoint(surface, pos) : null;
      if (!mgM) setMagnet(surface, null);
      if (mgM && obj.type === "hline") {
        obj.points[0].price = mgM.price;
      } else if (mgM && obj.type === "vline") {
        obj.points[0].time = mgM.time;
      } else if (obj.type === "hline") {
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
      if ((evt.ctrlKey || evt.metaKey) && !shiftDown) { // v109: Ctrl magnet
        var mgR = magnetPoint(surface, pos);
        if (mgR) { curTimeR = mgR.time; curPrice = mgR.price; }
      } else setMagnet(surface, null);
      if (obj.type === "trend") {
        // v70.2 Update 1: same dynamic horizontal/vertical snap as
        // placement, relative to the OTHER (still-fixed) endpoint.
        var idxT = parseInt(String(App.interaction.role).slice(2), 10);
        if (!isNaN(idxT) && obj.points[idxT]) {
          var anchorT = obj.points[1 - idxT];
          obj.points[idxT] = shiftDown
            ? trendLockedPoint(surface, anchorT, pos, curTimeR, curPrice)
            : { time: curTimeR, price: curPrice };
        }
      } else if (obj.type === "fib" || obj.type === "fibext") {
        // v53: role is "pt0"/"pt1"/(fibext only) "pt2" — see hitTestHandles().
        // v70.2 Update 2: Shift freezes this point's price (horizontal-only
        // lock) at whatever it was when Shift went down.
        var idx = parseInt(String(App.interaction.role).slice(2), 10);
        if (!isNaN(idx) && obj.points[idx]) {
          obj.points[idx] = (shiftDown && App.interaction._shiftLockPrice !== undefined)
            ? { time: curTimeR, price: App.interaction._shiftLockPrice }
            : { time: curTimeR, price: curPrice };
        }
      } else if (obj.type === "rect" && App.interaction.role && App.interaction.role.indexOf("mid-") === 0) {
        // v36.9 Fix 2: directional edge-midpoint drag — only the single
        // stored point on the dragged edge moves, and only along that
        // edge's own axis. v70.2 Update 2: Shift is explicitly a no-op
        // here — these handles already move along a single axis.
        var mi = App.interaction.midPointIndex;
        if (App.interaction.axis === "x") {
          obj.points[mi].time = curTimeR;
        } else {
          obj.points[mi].price = curPrice;
        }
      } else if (obj.type === "rect") {
        // The dragged corner becomes point 0; the diagonally-opposite
        // corner (fixed at drag-start) becomes point 1.
        // v70.2 Update 2: Shift freezes the dragged corner's price
        // (horizontal-only lock) at whatever it was when Shift went down.
        var cornerPrice = (shiftDown && App.interaction._shiftLockPrice !== undefined)
          ? App.interaction._shiftLockPrice
          : curPrice;
        obj.points[0] = { time: curTimeR, price: cornerPrice };
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
    if (App.interaction && App.interaction.surface === surface) {
      // v71 Update 1/2 (نکته چهارم): recompute Auto's timeframe map only
      // when a single anchor POINT was just dragged ("resize") — a
      // whole-object MOVE changes both endpoints' coordinates together
      // while leaving the span essentially unchanged, and per spec must
      // never trigger this calculation at all.
      if (App.interaction.kind === "resize") applyAutoTimeframes(App.interaction.obj);
      persistChange();
    }
    App.interaction = null;
    clearAllMagnets();
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

  // ---- v108: Text on trend / horizontal / vertical lines -------------------
  // obj.lineText = {text, size, place, align} (kept OUT of obj.style so presets
  // and per-type default styles never carry text). Drawn straight on the
  // overlay canvas (works on every panel); only the inline editor is DOM.
  // hline text pins to the plot's left/right end, vline text to its top/bottom
  // end, so both stay visible while the chart scrolls. Colour = line colour.
  var LT_MIN = 8, LT_MAX = 64, LT_DEFAULT = 14;
  var LT_FONT = "Inter, \"Segoe UI\", system-ui, sans-serif";
  var ltMeasureCtx = document.createElement("canvas").getContext("2d");
  var ltDefaults = {};
  var textEdit = null;   // {obj, surface, el, live}
  var hoverPillObj = null;

  function supportsLineText(obj) {
    return !!obj && (obj.type === "trend" || obj.type === "hline" || obj.type === "vline");
  }
  function makeLineText(type) {
    return { text: "", size: LT_DEFAULT, place: "center", align: type === "hline" ? "end" : type === "vline" ? "start" : "center" };
  }
  function ensureLineText(obj) {
    if (!obj.lineText) obj.lineText = makeLineText(obj.type);
    return obj.lineText;
  }
  function clampTextSize(v) { return Math.max(LT_MIN, Math.min(LT_MAX, Math.round(v))); }
  function plotOf(surface) {
    return surface._paintPlot || plotAreaSize(surface, surface.canvas.width / App.dpr, surface.canvas.height / App.dpr);
  }

  // Cached on the text object (key = size|text) so repaints don't re-measure.
  function ltMetrics(t, str, size) {
    var key = size + "|" + str;
    if (t._mk === key) return;
    ltMeasureCtx.font = "600 " + size + "px " + LT_FONT;
    var lines = (str || "W").split("\n"), mw = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = ltMeasureCtx.measureText(lines[i] || "W").width;
      if (m > mw) mw = m;
    }
    t._mk = key; t._ml = lines; t._mw = mw;
  }

  // Where the text (or the "+ Add text" pill / the live editor) sits.
  // Returns null when nothing is shown for this object right now.
  function lineTextGeom(surface, obj, px) {
    var t = obj.lineText;
    var isEd = !!(textEdit && textEdit.obj === obj);
    var has = !!(t && t.text);
    var isSel = App.selectedObject === obj && !obj.locked && !obj._preview && App.currentTool === "cursor";
    var mode = isEd ? "edit" : has ? "text" : isSel ? "pill" : null;
    if (!mode) return null;
    if (!t) t = ltDefaults[obj.type] || (ltDefaults[obj.type] = makeLineText(obj.type));
    var plot = plotOf(surface);
    var A, B;
    if (obj.type === "hline") { A = [0, px.y]; B = [plot.w, px.y]; }
    else if (obj.type === "vline") { A = [px.x, 0]; B = [px.x, plot.h]; }
    else { A = [px.x1, px.y1]; B = [px.x2, px.y2]; }
    var vert = Math.abs(B[0] - A[0]) < Math.abs(B[1] - A[1]) * 0.035;
    if (vert ? A[1] > B[1] : A[0] > B[0]) { var tmp = A; A = B; B = tmp; }
    var dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    var ang = 0, side = 0;
    if (!vert) { ang = Math.atan2(dy, dx); side = t.place === "above" ? -1 : t.place === "below" ? 1 : 0; }
    var str = mode === "edit" ? textEdit.live : mode === "text" ? t.text : "+ Add text";
    var sz = mode === "pill" ? LT_DEFAULT : t.size;
    ltMetrics(t, str, sz);
    var n = t._ml.length;
    var w = t._mw + (has ? 16 : 12), h = sz * 1.35 * n + sz * 0.15;
    var ext = vert ? h : w, m = 14;
    var d = t.align === "start" ? m + ext / 2 : t.align === "end" ? L - m - ext / 2 : L / 2;
    d = Math.max(ext / 2, Math.min(L - ext / 2, d));
    var mx = A[0] + ux * d, my = A[1] + uy * d;
    var gap = (vert || t.place === "center") ? Math.min(ext, L * 0.9) : 0;
    var off = vert ? 0 : (h / 2 + 4);
    return {
      mode: mode, t: t, A: A, B: B, mx: mx, my: my, gap: gap, ux: ux, uy: uy, vert: vert,
      cx: mx - Math.sin(ang) * off * side, cy: my + Math.cos(ang) * off * side,
      ang: vert ? 0 : ang, w: w, h: h, sz: sz, lines: str.split("\n"),
    };
  }

  function hitLineTextGeom(tg, x, y) {
    var dx = x - tg.cx, dy = y - tg.cy;
    if (tg.ang) {
      var c = Math.cos(-tg.ang), s = Math.sin(-tg.ang);
      var rx = dx * c - dy * s, ry = dx * s + dy * c;
      dx = rx; dy = ry;
    }
    return Math.abs(dx) <= tg.w / 2 + 2 && Math.abs(dy) <= tg.h / 2 + 2;
  }

  function drawLineText(ctx, obj, tg) {
    if (tg.mode === "edit") return; // the DOM editor paints it
    var style = obj.style;
    var op = style.borderOpacity == null ? 100 : style.borderOpacity;
    ctx.save();
    ctx.translate(tg.cx, tg.cy);
    if (tg.ang) ctx.rotate(tg.ang);
    ctx.textBaseline = "middle";
    if (tg.mode === "pill") {
      ctx.fillStyle = hexToRgba(style.borderColor, op * (hoverPillObj === obj ? 0.9 : 0.55));
      ctx.textAlign = "left";
      ctx.font = "300 " + (tg.sz * 1.6) + "px " + LT_FONT;
      var plusW = ctx.measureText("+").width;
      ctx.font = "400 " + tg.sz + "px " + LT_FONT;
      var wordW = ctx.measureText("Add text").width;
      var x0 = -(plusW + 2 + wordW) / 2;
      ctx.font = "300 " + (tg.sz * 1.6) + "px " + LT_FONT;
      ctx.fillText("+", x0, 1);
      ctx.font = "400 " + tg.sz + "px " + LT_FONT;
      ctx.fillText("Add text", x0 + plusW + 2, 0);
    } else {
      ctx.fillStyle = hexToRgba(style.borderColor, op);
      ctx.textAlign = "center";
      ctx.font = "600 " + tg.sz + "px " + LT_FONT;
      var lh = tg.sz * 1.3, y0 = -(tg.lines.length - 1) * lh / 2;
      for (var i = 0; i < tg.lines.length; i++) ctx.fillText(tg.lines[i], 0, y0 + i * lh);
    }
    ctx.restore();
  }

  // A line stroked in two pieces, leaving a gap where the text sits.
  function strokeSeg(ctx, x1, y1, x2, y2) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // Light update path (typing / wheel): repaint + debounced save only.
  function lineTextTouched() {
    requestRender();
    if (App.DrawingPersistence) App.DrawingPersistence.scheduleSave();
  }
  function syncTextPanel(obj) {
    if (App.DrawingContextMenu && App.DrawingContextMenu.syncText && App.activeMenuObject === obj) App.DrawingContextMenu.syncText();
  }

  function positionTextEditor() {
    var te = textEdit;
    if (!te) return;
    var px = objectPixels(te.surface, te.obj);
    var tg = px ? lineTextGeom(te.surface, te.obj, px) : null;
    if (!tg) { te.el.style.display = "none"; return; }
    var s = te.el.style, st = te.obj.style;
    s.display = "block";
    s.left = tg.cx + "px";
    s.top = tg.cy + "px";
    s.transform = "translate(-50%,-50%) rotate(" + (tg.ang * 180 / Math.PI) + "deg)";
    s.fontSize = tg.t.size + "px";
    s.color = hexToRgba(st.borderColor, st.borderOpacity == null ? 100 : st.borderOpacity);
  }

  function startTextEdit(surface, obj) {
    if (!supportsLineText(obj) || obj.locked) return;
    if (textEdit) endTextEdit(true);
    var t = ensureLineText(obj);
    var el = document.createElement("div");
    el.className = "line-text-editor";
    el.contentEditable = "true";
    el.spellcheck = false;
    el.textContent = t.text;
    ["mousedown", "mouseup", "click", "dblclick", "contextmenu"].forEach(function (n) {
      el.addEventListener(n, function (e) { e.stopPropagation(); });
    });
    el.addEventListener("input", function () {
      if (!textEdit || textEdit.el !== el) return;
      textEdit.live = el.textContent;
      requestRender();
    });
    el.addEventListener("paste", function (e) {
      e.preventDefault();
      var txt = (e.clipboardData || window.clipboardData).getData("text") || "";
      document.execCommand("insertText", false, txt);
    });
    el.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); document.execCommand("insertText", false, "\n"); }
      else if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); el.blur(); }
    });
    el.addEventListener("blur", function () { if (textEdit && textEdit.el === el) endTextEdit(true); });
    surface.container.appendChild(el);
    textEdit = { obj: obj, surface: surface, el: el, live: t.text };
    positionTextEditor();
    el.focus();
    var r = document.createRange();
    r.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    requestRender();
  }

  function endTextEdit(commit) {
    var te = textEdit;
    if (!te) return;
    textEdit = null;
    if (commit && te.obj.lineText) te.obj.lineText.text = te.el.textContent.replace(/\u00a0/g, " ").trim();
    if (te.el.parentNode) te.el.parentNode.removeChild(te.el);
    persistChange();
    syncTextPanel(te.obj);
  }

  function drawOneObject(surface, ctx, obj, w, h, skipText) {
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

    // v108: text geometry (null for everything but a trend/h/v line that
    // shows text, the "+ Add text" pill or the inline editor).
    var tg = (obj._preview || !supportsLineText(obj)) ? null : lineTextGeom(surface, obj, px);

    if (obj.type === "hline") {
      if (hasBorder) {
        if (tg && tg.gap > 0) {
          var hhg = tg.gap / 2;
          strokeSeg(ctx, 0, px.y + 0.5, tg.mx - hhg, px.y + 0.5);
          strokeSeg(ctx, tg.mx + hhg, px.y + 0.5, w, px.y + 0.5);
        } else {
          ctx.beginPath();
          ctx.moveTo(0, px.y + 0.5);
          ctx.lineTo(w, px.y + 0.5);
          ctx.stroke();
        }
      }
      if (tg && !skipText) drawLineText(ctx, obj, tg);
    } else if (obj.type === "vline") {
      if (hasBorder) {
        if (tg && tg.gap > 0) {
          var vhg = tg.gap / 2;
          strokeSeg(ctx, px.x + 0.5, 0, px.x + 0.5, tg.my - vhg);
          strokeSeg(ctx, px.x + 0.5, tg.my + vhg, px.x + 0.5, h);
        } else {
          ctx.beginPath();
          ctx.moveTo(px.x + 0.5, 0);
          ctx.lineTo(px.x + 0.5, h);
          ctx.stroke();
        }
      }
      if (tg && !skipText) drawLineText(ctx, obj, tg);
    } else if (obj.type === "trend") {
      if (hasBorder) {
        if (tg && tg.gap > 0) {
          var thg = tg.gap / 2;
          strokeSeg(ctx, tg.A[0], tg.A[1], tg.mx - tg.ux * thg, tg.my - tg.uy * thg);
          strokeSeg(ctx, tg.mx + tg.ux * thg, tg.my + tg.uy * thg, tg.B[0], tg.B[1]);
        } else {
          ctx.beginPath();
          ctx.moveTo(px.x1, px.y1);
          ctx.lineTo(px.x2, px.y2);
          ctx.stroke();
        }
      }
      if (tg && !skipText) drawLineText(ctx, obj, tg);
    } else if (obj.type === "rect") {
      var rx = Math.min(px.x1, px.x2), ry = Math.min(px.y1, px.y2);
      var rw = Math.abs(px.x2 - px.x1), rh = Math.abs(px.y2 - px.y1);
      // v89: the fill is no longer painted here (it covered the candles) -
      // see makeFillPrimitive(): it is drawn UNDER the candles by the chart.
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
          ctx.font = "9px " + App.FONT_FAMILY;
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
            ctx.font = "9px " + App.FONT_FAMILY;
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

  // V99 Update 2/3: every selection handle (trend/fib/fibext endpoints, rect
  // corners + edge midpoints, hline/vline anchor dot) is now the SAME small
  // square: white fill, border in the object's own line color.
  function handleStrokeColor(obj) {
    var c = obj && obj.style && obj.style.borderColor;
    return (typeof c === "string" && c) ? c : "#c9a227";
  }
  function drawSquareHandle(ctx, x, y, color) {
    var sz = App.HANDLE_S;
    ctx.beginPath();
    ctx.rect(Math.round(x - sz / 2) + 0.5, Math.round(y - sz / 2) + 0.5, sz, sz);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
  }

  // Draws the selection box for the currently-selected object: draggable
  // handles for trend/rect (which support resize), and a soft highlight
  // band along the line for hline/vline (which only support move).
  function drawSelectionHandles(surface, ctx, obj, w, h) {
    var px = objectPixels(surface, obj);
    if (!px) return;

    ctx.save();
    var hc = handleStrokeColor(obj);
    if (obj.type === "trend" || obj.type === "fib" || obj.type === "fibext") {
      // v53: draws 2 handles for trend/fib, 3 for a fully-placed fibext.
      getTrendHandles(surface, obj).forEach(function (pt) {
        drawSquareHandle(ctx, pt.x, pt.y, hc);
      });
    } else if (obj.type === "rect") {
      var minX = Math.min(px.x1, px.x2), maxX = Math.max(px.x1, px.x2);
      var minY = Math.min(px.y1, px.y2), maxY = Math.max(px.y1, px.y2);
      // v70.8 Update 4: no dashed outline on select, only handles.
      [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]].forEach(function (pt) {
        drawSquareHandle(ctx, pt[0], pt[1], hc);
      });
      // v36.9 Fix 2: edge-midpoint handles.
      getRectMidHandles(surface, obj).forEach(function (pt) {
        drawSquareHandle(ctx, pt.x, pt.y, hc);
      });
    }
    // v70.3 Update 3: hline/vline no longer get the soft highlight band —
    // their selected look is now just the axis-border anchor dot (see
    // drawAxisDecorations() below), matching the handle styling the other
    // tools already use instead of a glow around the whole line.
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

  // v70.6: at 4h/1D+ a broker "day" is one candle or less, so the old
  // one-line-per-day logic would draw a line at (almost) every bar - a
  // solid wall, not a useful break marker, and needlessly expensive to
  // boot. Daily Break is simply disabled at those timeframes rather than
  // trying to draw something meaningful there.
  var DAILY_BREAK_MAX_TF_SECONDS = 3 * 3600; // above this (4h, 1D), skip entirely

  function drawDailyBreaks(surface, ctx, plotW, plotH) {
    var db = App.dailyBreak;
    if (!db || !db.enabled || !surface.getCandles) return;
    if (surface.getTf && surface.getTf() > DAILY_BREAK_MAX_TF_SECONDS) return;
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
    surface._paintPlot = plot; // v108: shared with the line-text geometry
    ctx.beginPath();
    ctx.rect(0, 0, plot.w, plot.h);
    ctx.clip();
    // V64.2: Daily Break lines sit underneath every drawn object.
    drawDailyBreaks(surface, ctx, plot.w, plot.h);
    if (App.News) App.News.paint(surface, ctx, plot.w, plot.h);  // v111: news lines + dots
    var panelTf = surfaceTf(surface);
    App.drawObjects.forEach(function (obj) {
      if (!obj.hidden && isObjectVisibleAtTf(obj, panelTf)) drawOneObject(surface, ctx, obj, cssW, cssH);
    });
    // v33.2 fix 4: a Ctrl/Shift multi-selection in the Object Tree panel
    // highlights EVERY selected object on the chart, not just the single
    // App.selectedObject — matching the panel's own uniform yellow
    // highlight for the whole selection. Falls back to the single
    // App.selectedObject when there's no active panel multi-selection
    // (the normal single-click case).
    var selectedForChart = ((App.panelSelectedObjects && App.panelSelectedObjects.length)
      ? App.panelSelectedObjects
      : (App.selectedObject ? [App.selectedObject] : [])
    ).filter(function (obj) { return obj && isObjectVisibleAtTf(obj, panelTf); });
    selectedForChart.forEach(function (obj) {
      if (!obj || obj.hidden || App.drawObjects.indexOf(obj) === -1) return;
      // The highlight band for hline/vline goes underneath the line itself
      // so it doesn't obscure it; draw it first for those two types.
      if (obj.type === "hline" || obj.type === "vline") {
        drawSelectionHandles(surface, ctx, obj, cssW, cssH);
        drawOneObject(surface, ctx, obj, cssW, cssH, true);
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
    // v70.3.1 Fix: the ctx.restore() just above also undoes the DPR
    // setTransform() from the top of this function (it was inside the
    // same save/restore pair as the plot-area clip), so without its own
    // save/setTransform this pass would paint in raw device pixels
    // against CSS-pixel coordinates — landing wildly off (small and
    // shifted toward the top-left on any display with dpr != 1). Axis
    // decorations get their own transform, independent of the clip.
    ctx.save();
    ctx.setTransform(App.dpr, 0, 0, App.dpr, 0, 0);
    drawAxisDecorations(surface, ctx, selectedForChart, plot, cssW, cssH);
    ctx.restore();
    syncHlineAxisLabels(surface, selectedForChart);
    syncFillPrimitive(surface);
    if (textEdit && textEdit.surface === surface) positionTextEditor();
    } finally {
      surface._paintPlot = null;
      // The memo must never outlive the paint it belongs to: an interactive
      // call site (hit-testing mid-drag) reading a memoized value would be
      // reading coordinates from before the drag moved the object.
      endPixelMemo();
    }
  }

  // ---- v70.3 Update 1/3: hline/vline axis decorations ----------------------
  // Small, cheap, selection-only additions — nothing here runs unless at
  // least one hline/vline is currently selected on this surface.

  function drawAxisAnchorDot(ctx, x, y, color) {
    // V99: same square handle as every other object.
    ctx.save();
    drawSquareHandle(ctx, x, y, color || "#c9a227");
    ctx.restore();
  }

  function axisPad2(n) { return (n < 10 ? "0" : "") + n; }

  // Matches the UTC formatting rect/vline's own time-editor fields already
  // use elsewhere (drawing-context-menu.js) — Unix seconds -> UTC date
  // parts, no local-timezone shift, so this label always agrees with the
  // rest of the app's own time fields for the same object.
  function formatAxisTime(t) {
    var d = new Date((window.App && App.Tz ? App.Tz.toUser(t) : Number(t)) * 1000);  // v92
    return d.getUTCFullYear() + "-" + axisPad2(d.getUTCMonth() + 1) + "-" + axisPad2(d.getUTCDate()) +
      " " + axisPad2(d.getUTCHours()) + ":" + axisPad2(d.getUTCMinutes()) + ":" + axisPad2(d.getUTCSeconds());
  }

  // Cheap perceived-brightness check to pick readable label text (white on
  // a dark line color, near-black on a light one) without a full color
  // library — same hex shape hexToRgba() above already parses.
  function contrastTextColor(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    if (!m) return "#ffffff";
    var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    var yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 140 ? "#0a0e17" : "#ffffff";
  }

  // Draws a vline's selected time label directly over the time-axis strip,
  // styled like a small axis pill in the line's own color — the closest
  // canvas-only equivalent of what createPriceLine()'s axisLabelVisible
  // gives an hline for free on the price axis (lightweight-charts has no
  // matching "time line" API, so this one has to be hand-painted).
  function drawVlineTimeLabel(ctx, obj, x, plotTop, timeScaleH, cssW) {
    if (timeScaleH < 10) return;
    var text = formatAxisTime(obj.points[0].time);
    var color = (obj.style && obj.style.borderColor) || "#2962ff";
    ctx.save();
    ctx.font = "11px " + App.FONT_FAMILY;
    var padX = 6;
    var boxW = Math.ceil(ctx.measureText(text).width) + padX * 2;
    var boxH = Math.min(timeScaleH - 4, 20);
    var boxX = Math.min(Math.max(0, x - boxW / 2), Math.max(0, cssW - boxW));
    var boxY = plotTop + Math.max(0, (timeScaleH - boxH) / 2);
    ctx.fillStyle = color;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = contrastTextColor(color);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, boxX + boxW / 2, boxY + boxH / 2 + 0.5);
    ctx.restore();
  }

  function drawAxisDecorations(surface, ctx, selectedForChart, plot, cssW, cssH) {
    if (!selectedForChart || !selectedForChart.length) return;
    var timeScaleH = cssH - plot.h;
    selectedForChart.forEach(function (obj) {
      if (!obj || obj.hidden || App.drawObjects.indexOf(obj) === -1) return;
      if (obj.type === "hline") {
        var px = objectPixels(surface, obj);
        if (!px || px.y < 0 || px.y > plot.h) return;
        drawAxisAnchorDot(ctx, plot.w, px.y, handleStrokeColor(obj));
      } else if (obj.type === "vline") {
        var pv = objectPixels(surface, obj);
        if (!pv || pv.x < 0 || pv.x > plot.w) return;
        drawAxisAnchorDot(ctx, pv.x, plot.h, handleStrokeColor(obj));
        drawVlineTimeLabel(ctx, obj, pv.x, plot.h, timeScaleH, cssW);
      }
    });
  }

  // v70.3 Update 1: an hline's price label uses the library's own price
  // line (same mechanism as the live BID/ASK lines in chart-core.js) so it
  // gets real axis space and native rendering instead of us drawing text
  // on top of lightweight-charts' own price scale. One native price line
  // per selected hline per surface, created lazily and kept in step with
  // the object's current price/color every frame; removed the moment that
  // hline stops being selected (or is deleted) so nothing lingers.
  function syncHlineAxisLabels(surface, selectedForChart) {
    if (!surface.series) return;
    var lines = surface._hlineAxisLines || (surface._hlineAxisLines = {});
    var stillSelected = {};
    (selectedForChart || []).forEach(function (obj) {
      if (!obj || obj.type !== "hline" || obj.hidden || App.drawObjects.indexOf(obj) === -1) return;
      stillSelected[obj.id] = true;
      var price = obj.points[0].price;
      var color = (obj.style && obj.style.borderColor) || "#c9a227";
      var entry = lines[obj.id];
      if (!entry) {
        var line = surface.series.createPriceLine({
          price: price,
          color: color,
          lineWidth: 1,
          lineStyle: 0,
          lineVisible: false, // the object's own line (drawOneObject) is what's actually seen
          axisLabelVisible: true,
          axisLabelColor: color,
          axisLabelTextColor: contrastTextColor(color),
          title: "",
        });
        lines[obj.id] = { obj: obj, line: line, price: price, color: color };
      } else if (entry.price !== price || entry.color !== color) {
        entry.line.applyOptions({ price: price, color: color, axisLabelColor: color, axisLabelTextColor: contrastTextColor(color) });
        entry.price = price;
        entry.color = color;
      }
    });
    Object.keys(lines).forEach(function (id) {
      if (stillSelected[id]) return;
      try { surface.series.removePriceLine(lines[id].line); } catch (e) { /* series/surface already gone */ }
      delete lines[id];
    });
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
    // v120: objects drawn during Replay are kept (no longer temporary) in
    // the shared "On Replay" folder (hidden outside Replay, see below).
    if (App.replayActive) obj.folderId = ensureReplayFolder().id;
    // v71 Update 1/2: placement just finished (this is the exact "not
    // during drawing, only after confirmation" moment spec calls for) —
    // if Auto is on for this object, compute its timeframe map now, once.
    applyAutoTimeframes(obj);
    App.drawObjects.push(obj);
    App.pendingObject = null;
    App.dragStart = null;
    persistChange();
  }

  // v120: the single "On Replay" folder (created once, reused by every replay).
  function ensureReplayFolder() {
    var list = App.objectFolders, i;
    for (i = 0; i < list.length; i++) if (list[i].replay) return list[i];
    var f = { id: App.nextFolderId++, name: "Replay Objects", collapsed: false, replay: true };
    list.push(f);
    return f;
  }

  // v120: Replay on -> folder objects visible; Replay off -> hidden.
  function setReplayFolderHidden(hidden) {
    var ids = {}, any = false, i;
    App.objectFolders.forEach(function (f) { if (f.replay) { ids[f.id] = true; any = true; } });
    if (!any) return;
    for (i = 0; i < App.drawObjects.length; i++) {
      var o = App.drawObjects[i];
      if (ids[o.folderId] && !!o.hidden !== hidden) {
        o.hidden = hidden;
        if (hidden) {
          if (App.selectedObject === o) { App.selectedObject = null; App.interaction = null; }
          if (App.activeMenuObject === o) App.DrawingContextMenu.close();
        }
      }
    }
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
    obj._replayHid = false; // v126: the user's own choice replaces Replay's temporary hide
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

  // v70.2 Fix: shared by the live-preview mousemove AND the confirming
  // click itself, so the confirmed point always matches whatever the
  // preview was showing the instant before the click (previously the
  // confirming click recomputed straight from the raw mouse position,
  // silently discarding an active Shift lock — the preview looked locked
  // but the finalized object snapped back to the unlocked cursor spot).
  function computePendingPointValue(surface, pos, t, price, evt) {
    var tool = App.pendingObject.type;
    if (evt && (evt.ctrlKey || evt.metaKey) && !shiftDown) { // v109: Ctrl magnet
      var mgP = magnetPoint(surface, pos);
      if (mgP) return mgP;
    } else setMagnet(surface, null);
    var lastIdx = App.pendingObject.points.length - 1;
    if (shiftDown && tool === "trend") {
      return trendLockedPoint(surface, App.pendingObject.points[0], pos, t, price);
    }
    if (shiftDown && (tool === "rect" || tool === "fib") && lastIdx === 1 && App.pendingObject._shiftLockPrice !== undefined) {
      return { time: t, price: App.pendingObject._shiftLockPrice };
    }
    if (shiftDown && tool === "fibext" && lastIdx === 2 && App.pendingObject._shiftLockPrice !== undefined) {
      return { time: t, price: App.pendingObject._shiftLockPrice };
    }
    return { time: t, price: price };
  }

  function onCanvasMouseDown(surface, evt) {
    if (App.currentTool === "cursor") { handleCursorMouseDown(surface, evt); return; }
    if (evt.button !== 0) return; // left button only for drawing
    var C = surface.C;
    var pos = mousePos(surface, evt);
    var logical = C.xToLogical(pos.x);
    var price = C.yToPrice(pos.y);
    if (logical === null || logical === undefined || price === null || price === undefined) return;

    var mgL = (evt.ctrlKey || evt.metaKey) && !shiftDown && (App.currentTool === "hline" || App.currentTool === "vline")
      ? magnetPoint(surface, pos) : null; // v109: Ctrl magnet for hline/vline placement
    if (App.currentTool === "hline") {
      if (mgL) price = mgL.price;
      finalizeObject({ type: "hline", points: [{ logical: logical, price: price }], style: defaultStyle("hline") });
      returnToCursor();
    } else if (App.currentTool === "vline") {
      // v21: store real time (like trend/rect), not a timeframe-relative
      // logical index, so the line stays put on every timeframe/panel.
      var vt0 = C.logicalToTime(logical);
      if (vt0 === null) return;
      if (mgL) { vt0 = mgL.time; price = mgL.price; }
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
        if (evt.ctrlKey || evt.metaKey) { // v109: Ctrl magnet on the first point too
          var mg0 = magnetPoint(surface, pos);
          if (mg0) { t0 = mg0.time; price = mg0.price; }
        }
        App.dragStart = { time: t0, price: price, surface: surface };
        App.pendingObject = {
          type: App.currentTool,
          points: [{ time: t0, price: price }, { time: t0, price: price }],
          style: defaultStyle(App.currentTool),
          // v71 Update 1: a freshly drawn object of this type starts with
          // whatever Auto on/off state was last set for that type (per-type
          // memory, same pattern as defaultStyle() above) — hline/vline
          // never reach this branch (they finalize on a single click via
          // placeInstant()), so no exclusion needed here.
          autoTf: App.StyleDefaults ? App.StyleDefaults.getAutoDefault(App.currentTool) : false,
          _preview: true,
        };
        // v70.2: Shift may already be held down before this very first
        // click (per Update 1/3's "before or during the first click").
        if (shiftDown) captureShiftLock();
        return;
      }
      // A later click: confirm the pending object's current live point
      // (the last one in `points`) at the mouse position. Only the same
      // surface the placement started on tracks/confirms it.
      if (App.dragStart && App.dragStart.surface !== surface) return;
      var tN = C.logicalToTime(logical);
      if (tN !== null) App.pendingObject.points[App.pendingObject.points.length - 1] = computePendingPointValue(surface, pos, tN, price, evt);

      if (App.currentTool === "fibext" && App.pendingObject.points.length === 2) {
        // That was the 2nd click (Level -1) — Level -2/-1 are now both
        // fixed; start tracking the 3rd click (E2, level 0) as a new live
        // point instead of finalizing.
        App.pendingObject.points.push({ time: tN !== null ? tN : App.pendingObject.points[1].time, price: price });
        // v70.2 Update 3: the newly-started 3rd (E2) floating point picks
        // up the same Shift lock mechanism, independently of whatever the
        // first two clicks did (which never lock).
        if (shiftDown) captureShiftLock();
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
    if (!App.pendingObject) {
      // v109: before the first click, Ctrl still shows the magnet crosshair.
      if (App.currentTool !== "cursor" && (evt.ctrlKey || evt.metaKey) && !shiftDown) magnetPoint(surface, mousePos(surface, evt));
      else setMagnet(surface, null);
      return;
    }
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
    var lastIdx = App.pendingObject.points.length - 1;
    App.pendingObject.points[lastIdx] = computePendingPointValue(surface, pos, t, price, evt);
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
    // v108: text of the selected line — double-click edits it, the mouse
    // wheel over it (only while the line is selected) changes the font size.
    function selectedTextAt(evt) {
      var o = App.selectedObject;
      if (App.currentTool !== "cursor" || textEdit || !o || o.locked || o.hidden || !supportsLineText(o)) return null;
      if (!o.lineText || !o.lineText.text || App.drawObjects.indexOf(o) === -1) return null;
      if (!isObjectVisibleAtTf(o, surfaceTf(surface))) return null;
      var p = objectPixels(surface, o);
      var tg = p ? lineTextGeom(surface, o, p) : null;
      var pos = mousePos(surface, evt);
      return (tg && tg.mode === "text" && hitLineTextGeom(tg, pos.x, pos.y)) ? o : null;
    }
    surface.canvas.addEventListener("dblclick", function (evt) {
      var o = selectedTextAt(evt);
      if (o) { evt.preventDefault(); startTextEdit(surface, o); }
    });
    // v108: the wheel changes the font size only when the line is selected
    // AND its whole text is selected (inline editor, all text highlighted).
    // In every other state the wheel keeps its normal chart behaviour.
    surface.container.addEventListener("wheel", function (evt) {
      var te = textEdit;
      if (!te || te.surface !== surface || !te.el.contains(evt.target)) return;
      var o = te.obj;
      if (!o.lineText || App.selectedObject !== o) return;
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed || !te.el.contains(sel.anchorNode)) return;
      var strip = function (s) { return s.replace(/\s/g, ""); };
      var all = strip(te.el.textContent);
      if (!all || strip(sel.toString()) !== all) return;
      evt.preventDefault();
      evt.stopPropagation();
      o.lineText.size = clampTextSize(o.lineText.size + (evt.deltaY < 0 ? 1 : -1));
      lineTextTouched();
      syncTextPanel(o);
    }, { passive: false, capture: true });
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
      // Right-click while a tool is armed / mid-placement: treat it as "cancel", matching Escape.
      // v89 Update 1: also before the first click (the document-level handler below normally gets there first).
      if (App.dragStart || App.currentTool !== "cursor") { cancelPendingObject(); returnToCursor(); requestRender(); return; }

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

  // v89 Update 1: with any drawing tool selected, a right-click ANYWHERE in
  // the app (before the 1st click, or while a floating point is being
  // placed) cancels the drawing and returns to the normal Cursor. Capture
  // phase + stopPropagation so no context menu opens for that click.
  document.addEventListener("contextmenu", function (evt) {
    if (App.currentTool === "cursor" && !App.pendingObject) return;
    evt.preventDefault();
    evt.stopPropagation();
    cancelPendingObject();
    returnToCursor();
    requestRender();
  }, true);

  // v89 Update 4/5 helpers (used by ruler.js and trade-lines.js).
  function surfaceForEvent(evt) {
    var t = evt.target;
    for (var i = 0; i < surfaces.length; i++) if (surfaces[i].container.contains(t)) return surfaces[i];
    return null;
  }
  function drawingBusy() {
    return App.currentTool !== "cursor" || !!App.pendingObject || !!App.interaction || !!App.selectionBox;
  }
  function pointerHit(evt) {
    var sf = surfaceForEvent(evt);
    if (!sf) return null;
    var pos = mousePos(sf, evt);
    return computeCursorHit(sf, pos.x, pos.y);
  }
  // Update 4: true when Shift+click must NOT start the Ruler (a tool is
  // armed, an object is being drawn/edited, or the click would grab a
  // resize handle of the selected object).
  function isDrawingBusy(evt) {
    if (drawingBusy()) return true;
    var h = pointerHit(evt);
    return !!h && h.kind === "resize";
  }
  // Update 5: true when a left press here belongs to the drawing layer
  // (tool armed / object being edited / pointer over an object or its
  // handles) and therefore must not grab the Stoploss/TakeProfit lines.
  function ownsPointer(evt) {
    return drawingBusy() || !!pointerHit(evt);
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
    // v89 Updates 4/5 (see isDrawingBusy / ownsPointer above).
    isDrawingBusy: isDrawingBusy,
    ownsPointer: ownsPointer,
    showHint: showHint,
    persistChange: persistChange,
    removeObject: removeObject,
    setLocked: setLocked,
    setHidden: setHidden,
    setReplayFolderHidden: setReplayFolderHidden, // v120
    getAnchorTime: getAnchorTime,
    // v41 perf: any external code that changes what should appear on the
    // overlay (chart pan/zoom range changes, live/replay ticks landing,
    // an object created/edited/selected from the Object Tree panel or the
    // right-click editor, resize, etc.) calls this so the next frame
    // actually repaints. See the dirty-render note above `surfaces`.
    requestRender: requestRender,
    refreshSessions: refreshSessions,  // v93
    getSurfaces: function () { return surfaces; },  // v111
    // v70.7 Update 2: Timeframe Based Hidden/Show — used by drawing-
    // context-menu.js's new Timeframes editor to read/mutate an object's
    // per-timeframe visibility map and get it re-rendered everywhere.
    TF_SECONDS: TF_SECONDS,
    ensureTimeframesMap: ensureTimeframesMap,
    isObjectVisibleAtTf: isObjectVisibleAtTf,
    applyAutoTimeframes: applyAutoTimeframes,
    // v108: Text on trend/h/v lines — used by drawing-context-menu.js.
    LINE_TEXT_MIN: LT_MIN,
    LINE_TEXT_MAX: LT_MAX,
    supportsLineText: supportsLineText,
    ensureLineText: ensureLineText,
    lineTextTouched: lineTextTouched,
    isLineTextVertical: function (obj) {
      if (!obj || obj.type === "vline") return true;
      if (obj.type === "hline") return false;
      var s = primarySurface, p = s ? objectPixels(s, obj) : null;
      return !!p && Math.abs(p.x2 - p.x1) < Math.abs(p.y2 - p.y1) * 0.035;
    },
  };
})();
