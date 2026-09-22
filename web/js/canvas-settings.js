// =============================================================================
// canvas-settings.js — v50: the Setting panel's "Canvas" tab. Lets the user
// re-theme the chart itself: Background / Crosshair (+ line style) / Text
// (+ font size) / grid lines on the left, and per-up/down Body / Borders /
// Wick candle colors on the right — matching chart-core.js's current
// hardcoded theme one-for-one, just made editable.
//
// Each color field reuses color-picker.js's swatch popover exactly as the
// drawing tool's own style editor does (App.ColorField.attach), just with
// {opacity:false} — no Opacity slider in this panel, per spec, since these
// are whole-chart surface colors rather than a drawn object's fill.
//
// v50.1 Update 1: two new checkboxes — Enable Horizontal/Vertical Grid
// Line — each checked by default, each showing its own color swatch
// (default = chart-core.js's existing grid-line color) only while checked.
// Unchecking one hides that grid line on the live chart entirely.
//
// v50.1 Update 2/3: persistence moved off plain localStorage-only onto the
// same disk-backed pattern already used for the drawing tool's style
// defaults/presets (see style-defaults.js / src/style_store.py) — this
// tab's field values AND its user-saved named presets (Update 3) are now
// persisted to <project root>/output/canvas_settings/canvas_settings.json
// via ChartBridge.get_canvas_settings/save_canvas_settings (see
// src/canvas_settings_store.py), so they survive closing and reopening the
// app rather than only living in one browser profile. localStorage is kept
// only as the same dev-mode fallback style-defaults.js uses, for whenever
// this file is opened outside pywebview (no window.pywebview.api
// available).
//
// A built-in "Default" preset is always present (not stored on disk, not
// deletable) — selecting it resets every Canvas field back to the factory
// theme chart-core.js was hardcoded with before this panel existed.
//
// v50.2 Update 1: "Enable Dark Theme" now actually does something — see
// applyDarkTheme() below. Unchecking it toggles a `light-theme` class onto
// <body>; every element in index.html is themed off shared CSS custom
// properties (var(--bg)/var(--panel)/var(--border)/var(--text)/
// var(--muted)/var(--up)/var(--down)/var(--gold)/var(--ov*)), and
// index.html's `body.light-theme` rule simply redefines them to a light,
// professional palette that mirrors Dark Mode's structure exactly (same
// contrast relationships, same accent/candle colors) — so this one class
// re-themes the entire app (Setting panel + every tab, drawing-tool
// context menu, Object Tree, Bar Replay, dropdowns) with no other file
// needing to know which theme is active. Kept scoped to the app's own UI
// chrome — it does not touch this tab's own Background/Crosshair/Text/
// Grid/Candle swatches, which stay independently user-configurable chart
// colors either way.
//
// v50.3 Update 1: every field in this tab now also reaches companion
// panels 2/3 in multi-chart mode (see companionPanels()/broadcast*()
// below and multi-panel.js's App.MultiPanel.getPanels()/applyToPanel()).
//
// v50.3 Update 2: new "Price Line" row under Crosshair — same color +
// line-style controls, applied to the live dashed price line AND its
// price-box on the axis (see applyPriceLine() / chart-core.js's
// App.priceLineTheme). The price box's own text is always forced to the
// current Background color rather than being separately configurable, per
// spec. Crosshair and Price Line also both get a minimal thickness
// (1–4px) dropdown.
//
// v50.3 Update 4: new "Selector" row under Text — a color swatch for the
// app-wide var(--gold) accent (active tabs, focus rings, selected-object
// highlight, etc.), default #C9A227, applied via applySelector() as a CSS
// custom property so every existing var(--gold) usage picks it up with no
// other file needing changes.
//
// V64.2: new "Daily Break" row under "Enable Ask Price" (off by default; color /
// width default to the Crosshair's; the line is always solid, V64.5) - a vertical line at the first
// candle of each trading day, painted by the drawing overlay for the visible
// range only (see drawing-engine.js, drawDailyBreaks()).
//
// V64.1: (1) "Enable Dark Theme" moved into the Chart column, directly under
// the Vertical Grid Line row. (2) New "Enable Ask Price" row under it — OFF by
// default; its color / line type / width (same defaults as Price Line) style
// the live ASK line (chart-core.js, App.askTheme); nothing is drawn while it is
// unchecked. (3) Both grid lines are OFF by default. (4) Default Text size is
// 14. The "Default" preset returns to these values. Settings saved before
// V64.1 that still hold the OLD factory values for the grid toggles / text
// size (both grids on, size 8) are moved to the new defaults once (see
// migrateOldDefaults()); anything the user customised is left alone.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  if (!dom.canvasBgSwatch) return;

  var LOCAL_SETTINGS_KEY = "v50-canvas-settings";
  var LOCAL_PRESETS_KEY = "mt5te.canvasPresets.v1";
  var SAVE_DEBOUNCE_MS = 400;

  // Defaults mirror chart-core.js's current hardcoded theme exactly, so
  // turning this panel on changes nothing until the user actually touches
  // a control. Also doubles as the "Default" preset's contents (Update 3).
  var DEFAULTS = {
    background: "#0a0e17",
    crosshairColor: "#6b7686",
    crosshairStyle: "dotted",
    textColor: "#8b95a5",
    textSize: 14,        // V64.1 Update 4 (was 8)
    bodyUp: "#3fb68b",
    bodyDown: "#e5484d",
    borderUp: "#3fb68b",
    borderDown: "#e5484d",
    wickUp: "#3fb68b",
    wickDown: "#e5484d",
    darkTheme: true,
    // v50.1 Update 1: both grid lines on by default, colored the same as
    // chart-core.js's hardcoded grid color ("#161c27" for vert & horz).
    // V64.1 Update 3: both grid lines are now OFF by default (were on).
    gridHorzEnabled: false,
    gridHorzColor: "#161c27",
    gridVertEnabled: false,
    gridVertColor: "#161c27",
    // v50.3 Update 2: Price Line (the dashed live-price line + its price
    // box on the axis) gets the same color/style controls as Crosshair,
    // plus a minimal thickness setting shared by both (Update 2's last
    // sentence). The price box's TEXT is always the current Background
    // color per spec, computed fresh in applyPriceLine() rather than
    // stored here.
    priceLineColor: "#8b95a5",
    priceLineStyle: "dashed",
    priceLineWidth: 1,
    crosshairWidth: 1,
    // v50.3 Update 4: the whole app's "Selector" accent (var(--gold) —
    // active tabs, focus borders, selected-object highlight, etc.).
    selectorColor: "#c9a227",
    // V64.1 Update 2: live ASK line — off by default; look defaults equal the
    // Price Line's (color / Dashed / 1px).
    askEnabled: false,
    askColor: "#8b95a5",
    askStyle: "dashed",
    askWidth: 1,
    // V64.2: Daily Break (a vertical line at the first candle of each trading
    // day) - off by default; color / width default to the Crosshair's. Solid only.
    dailyBreakEnabled: false,
    dailyBreakColor: "#6b7686",
    dailyBreakWidth: 1,
    // Bumped when the factory defaults change (see migrateOldDefaults()).
    defaultsRev: 2,
  };

  var LINE_STYLE_MAP = { solid: 0, dotted: 1, dashed: 2 };
  var THICKNESS_OPTIONS = [1, 2, 3, 4];

  // In-memory cache — populated synchronously from DEFAULTS/localStorage
  // for an immediate first paint, then reconciled from disk (see load(),
  // called from main.js's boot()) the moment that resolves.
  var state = cloneDefaults();
  var presetsCache = [];   // [{id, name, settings}] — "Default" is NOT in here.

  var saveTimer = null;
  var saveInFlight = false;
  var saveAgainAfterInFlight = false;

  function cloneDefaults() {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    return out;
  }

  // V64.1: one-time move of a settings file saved before this version onto the
  // new factory defaults (grid toggles off, Text size 14). Only values that are
  // still EXACTLY the old factory values are changed, so a user who picked
  // another text size keeps it. Returns true if anything was changed.
  function migrateOldDefaults(raw) {
    if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) return false;
    if (Number(raw.defaultsRev) >= 2) return false;
    if (raw.gridHorzEnabled === true) raw.gridHorzEnabled = false;
    if (raw.gridVertEnabled === true) raw.gridVertEnabled = false;
    if (Number(raw.textSize) === 8) raw.textSize = 14;
    raw.defaultsRev = 2;
    return true;
  }

  function sanitizeSettings(raw) {
    var out = cloneDefaults();
    var s = raw && typeof raw === "object" ? raw : {};
    for (var key in DEFAULTS) {
      if (s[key] !== undefined && s[key] !== null) out[key] = s[key];
    }
    return out;
  }

  function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

  // ---- dev-mode fallback (no window.pywebview.api available) ------------
  function readLocalJson(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeLocalJson(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* best-effort */ }
  }

  // ---- v50.1: load from / save to <project root>/output/canvas_settings/
  // Mirrors style-defaults.js's load()/scheduleSave() pattern exactly.
  function load() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.get_canvas_settings) {
      var localRaw = readLocalJson(LOCAL_SETTINGS_KEY);
      var localMigrated = migrateOldDefaults(localRaw);
      state = sanitizeSettings(localRaw);
      presetsCache = readLocalJson(LOCAL_PRESETS_KEY) || [];
      refreshUI();
      if (localMigrated) persist();
      return Promise.resolve();
    }
    return window.pywebview.api.get_canvas_settings().then(function (data) {
      var diskRaw = data && data.settings;
      var diskMigrated = migrateOldDefaults(diskRaw);
      state = sanitizeSettings(diskRaw);
      presetsCache = (data && Array.isArray(data.presets)) ? data.presets : [];
      refreshUI();
      if (diskMigrated) persist();
    }).catch(function (err) {
      console.error("Loading saved Canvas settings failed:", err);
    });
  }

  function doSave() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.save_canvas_settings) {
      writeLocalJson(LOCAL_SETTINGS_KEY, state);
      writeLocalJson(LOCAL_PRESETS_KEY, presetsCache);
      return;
    }
    saveInFlight = true;
    window.pywebview.api.save_canvas_settings({ settings: state, presets: presetsCache })
      .catch(function (err) {
        console.error("Saving Canvas settings failed:", err);
      }).then(function () {
        saveInFlight = false;
        if (saveAgainAfterInFlight) {
          saveAgainAfterInFlight = false;
          scheduleSave();
        }
      });
  }

  function scheduleSave() {
    if (saveInFlight) { saveAgainAfterInFlight = true; return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
  }

  function flushNow() {
    clearTimeout(saveTimer);
    doSave();
  }
  window.addEventListener("beforeunload", flushNow);

  function persist() { scheduleSave(); }

  // ---- apply state to the live chart -------------------------------------
  // v50.3 Update 1: every Canvas control must also reach chart 2/3 in
  // multi-chart mode, not just the primary panel. These two helpers
  // broadcast chart-level / series-level options to App.chart/App.series
  // AND every companion panel currently on screen (App.MultiPanel.
  // getPanels() — see multi-panel.js).
  function companionPanels() {
    if (!App.MultiPanel || !App.MultiPanel.getPanels) return [];
    return App.MultiPanel.getPanels().filter(function (p) { return p && !p.isPrimary && p.chart; });
  }
  function broadcastChartOptions(opts) {
    if (App.chart) App.chart.applyOptions(opts);
    companionPanels().forEach(function (p) { p.chart.applyOptions(opts); });
  }
  function broadcastSeriesOptions(opts) {
    if (App.series) App.series.applyOptions(opts);
    companionPanels().forEach(function (p) { if (p.series) p.series.applyOptions(opts); });
  }

  function applyBackground() {
    broadcastChartOptions({ layout: { background: { type: "solid", color: state.background } } });
  }
  function applyCrosshair() {
    var lineStyle = LINE_STYLE_MAP[state.crosshairStyle];
    if (lineStyle === undefined) lineStyle = LINE_STYLE_MAP.dotted;
    var width = Number(state.crosshairWidth) || 1;
    broadcastChartOptions({
      crosshair: {
        vertLine: { color: state.crosshairColor, style: lineStyle, width: width },
        horzLine: { color: state.crosshairColor, style: lineStyle, width: width },
      },
    });
  }
  function applyText() {
    broadcastChartOptions({ layout: { textColor: state.textColor, fontSize: Number(state.textSize) } });
  }
  function applyCandles() {
    broadcastSeriesOptions({
      upColor: state.bodyUp,
      downColor: state.bodyDown,
      borderUpColor: state.borderUp,
      borderDownColor: state.borderDown,
      wickUpColor: state.wickUp,
      wickDownColor: state.wickDown,
    });
  }
  // v50.2 Update 1: each grid line's `visible` follows its checkbox, and
  // its color follows its own swatch while enabled.
  function applyGrid() {
    broadcastChartOptions({
      grid: {
        horzLines: { color: state.gridHorzColor, visible: !!state.gridHorzEnabled },
        vertLines: { color: state.gridVertColor, visible: !!state.gridVertEnabled },
      },
    });
  }
  // v50.3 Update 2: Price Line — color/style/width, plus the price box's
  // text forced to always equal the current Background color (per spec).
  // App.priceLineTheme/App.priceLineOptionsFromTheme() live in chart-
  // core.js so both the primary panel's price line (created lazily on
  // first live tick) and every companion panel's own price line (multi-
  // panel.js) can build identical options, even for a line created AFTER
  // this runs.
  function applyPriceLine() {
    App.priceLineTheme = {
      color: state.priceLineColor,
      style: state.priceLineStyle,
      width: Number(state.priceLineWidth) || 1,
      textColor: state.background,
    };
    var opts = App.priceLineOptionsFromTheme();
    if (App.livePriceLine) App.livePriceLine.applyOptions(opts);
    companionPanels().forEach(function (p) { if (p.priceLine) p.priceLine.applyOptions(opts); });
  }
  // V64.1 Update 2: the live ASK line — on/off + its own color / line type /
  // width (no axis label). chart-core.js's syncAskLine() creates, restyles or
  // removes the lines on every panel.
  function applyAsk() {
    App.askTheme = {
      enabled: !!state.askEnabled,
      color: state.askColor,
      style: state.askStyle,
      width: Number(state.askWidth) || 1,
    };
    if (App.ChartCore && App.ChartCore.syncAskLine) App.ChartCore.syncAskLine();
  }
  // V64.2: Daily Break. The line is painted by the drawing overlay itself
  // (drawing-engine.js, App.dailyBreak) and only for the visible range, so all
  // this has to do is publish the look and ask for one repaint.
  function applyDailyBreak() {
    App.dailyBreak = {
      enabled: !!state.dailyBreakEnabled,
      color: state.dailyBreakColor,
      width: Number(state.dailyBreakWidth) || 1,
    };
    if (App.DrawingEngine && App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
  }
  // v50.3 Update 4: the app-wide "Selector" accent — every var(--gold)
  // usage across index.html (active tabs, focus rings, selected-object
  // highlight, etc.) picks this up immediately since it's a CSS custom
  // property on the root element.
  function applySelector() {
    document.documentElement.style.setProperty("--gold", state.selectorColor);
  }
  // v50.2 Update 1: applies/removes the `light-theme` class on <body> —
  // every element in index.html is themed off the var(--bg)/var(--panel)/
  // var(--border)/var(--text)/var(--muted)/var(--ov*) custom properties
  // (see index.html's `body.light-theme` rule), so toggling this one
  // class re-themes the entire app (Setting panel, drawing-tool context
  // menu, Object Tree, Bar Replay, dropdowns, etc.) in one place — no
  // other file needs to know which theme is active.
  function applyDarkTheme() {
    document.body.classList.toggle("light-theme", !state.darkTheme);
  }

  // Applies every field to the live chart at once — used at startup (see
  // main.js, called right after App.ChartCore.init()) since the color
  // swatches/selects below are wired up long before App.chart exists.
  function applyAll() {
    applyBackground();
    applyCrosshair();
    applyText();
    applyCandles();
    applyGrid();
    applyDarkTheme();
    applyPriceLine();
    applyAsk();
    applyDailyBreak();
    applySelector();
  }

  // v50.3 Update 1: called by multi-panel.js right after a new companion
  // panel (2 or 3) is created, so it immediately picks up whatever Canvas
  // settings are already in effect this session instead of briefly
  // showing the factory theme. Applies every per-panel-relevant field;
  // background/text/grid/dark-theme/selector are already global (chart-
  // level options + CSS vars) and don't need a per-panel path.
  function applyToPanel(panel) {
    if (!panel || !panel.chart) return;
    var lineStyle = LINE_STYLE_MAP[state.crosshairStyle];
    if (lineStyle === undefined) lineStyle = LINE_STYLE_MAP.dotted;
    var crosshairWidth = Number(state.crosshairWidth) || 1;
    panel.chart.applyOptions({
      layout: {
        background: { type: "solid", color: state.background },
        textColor: state.textColor,
        fontSize: Number(state.textSize),
      },
      grid: {
        horzLines: { color: state.gridHorzColor, visible: !!state.gridHorzEnabled },
        vertLines: { color: state.gridVertColor, visible: !!state.gridVertEnabled },
      },
      crosshair: {
        vertLine: { color: state.crosshairColor, style: lineStyle, width: crosshairWidth },
        horzLine: { color: state.crosshairColor, style: lineStyle, width: crosshairWidth },
      },
    });
    if (panel.series) {
      panel.series.applyOptions({
        upColor: state.bodyUp,
        downColor: state.bodyDown,
        borderUpColor: state.borderUp,
        borderDownColor: state.borderDown,
        wickUpColor: state.wickUp,
        wickDownColor: state.wickDown,
      });
    }
    if (panel.priceLine) panel.priceLine.applyOptions(App.priceLineOptionsFromTheme());
    if (panel.askLine) panel.askLine.applyOptions(App.askLineOptionsFromTheme());
  }

  // ---- UI wiring ----------------------------------------------------------
  function attachSwatch(el, key, onApply) {
    App.ColorField.attach(el, { opacity: false, value: state[key] });
    el.value = state[key];
    el.addEventListener("input", function () {
      state[key] = el.value;
      onApply();
    });
    el.addEventListener("change", function () {
      state[key] = el.value;
      onApply();
      persist();
    });
  }

  attachSwatch(dom.canvasBgSwatch, "background", applyBackground);
  attachSwatch(dom.canvasCrosshairSwatch, "crosshairColor", applyCrosshair);
  attachSwatch(dom.canvasTextSwatch, "textColor", applyText);
  attachSwatch(dom.canvasBodyUpSwatch, "bodyUp", applyCandles);
  attachSwatch(dom.canvasBodyDownSwatch, "bodyDown", applyCandles);
  attachSwatch(dom.canvasBorderUpSwatch, "borderUp", applyCandles);
  attachSwatch(dom.canvasBorderDownSwatch, "borderDown", applyCandles);
  attachSwatch(dom.canvasWickUpSwatch, "wickUp", applyCandles);
  attachSwatch(dom.canvasWickDownSwatch, "wickDown", applyCandles);
  if (dom.canvasGridHorzSwatch) attachSwatch(dom.canvasGridHorzSwatch, "gridHorzColor", applyGrid);
  if (dom.canvasGridVertSwatch) attachSwatch(dom.canvasGridVertSwatch, "gridVertColor", applyGrid);
  // v50.3 Update 2: Price Line color swatch. Its box-text color always
  // tracks Background (see applyPriceLine()), so there's no separate
  // swatch for it.
  if (dom.canvasPriceLineSwatch) attachSwatch(dom.canvasPriceLineSwatch, "priceLineColor", applyPriceLine);
  // V64.1 Update 2: Ask Price color swatch.
  if (dom.canvasAskSwatch) attachSwatch(dom.canvasAskSwatch, "askColor", applyAsk);
  // V64.2: Daily Break color swatch.
  if (dom.canvasDailyBreakSwatch) attachSwatch(dom.canvasDailyBreakSwatch, "dailyBreakColor", applyDailyBreak);
  // v50.3 Update 4: Selector (app-wide accent) color swatch.
  if (dom.canvasSelectorSwatch) attachSwatch(dom.canvasSelectorSwatch, "selectorColor", applySelector);
  // Background also drives the Price Line's box-text color, so re-apply
  // the Price Line any time Background changes.
  if (dom.canvasBgSwatch) {
    dom.canvasBgSwatch.addEventListener("input", applyPriceLine);
    dom.canvasBgSwatch.addEventListener("change", applyPriceLine);
  }

  // Crosshair line-style dropdown — default Dotted per spec.
  dom.canvasCrosshairStyle.value = state.crosshairStyle;
  dom.canvasCrosshairStyle.addEventListener("change", function () {
    state.crosshairStyle = dom.canvasCrosshairStyle.value;
    applyCrosshair();
    persist();
  });

  // v50.3 Update 2: Price Line line-style dropdown — same options/default
  // (Dashed, matching the pre-v50.3 hardcoded line) as Crosshair's.
  if (dom.canvasPriceLineStyle) {
    dom.canvasPriceLineStyle.value = state.priceLineStyle;
    dom.canvasPriceLineStyle.addEventListener("change", function () {
      state.priceLineStyle = dom.canvasPriceLineStyle.value;
      applyPriceLine();
      persist();
    });
  }

  // v50.3 Update 2: minimal thickness dropdowns for Crosshair and Price
  // Line (1–4px).
  function buildThicknessSelect(selectEl) {
    if (!selectEl) return;
    THICKNESS_OPTIONS.forEach(function (px) {
      var opt = document.createElement("option");
      opt.value = String(px);
      opt.textContent = px + "px";
      selectEl.appendChild(opt);
    });
  }
  buildThicknessSelect(dom.canvasCrosshairWidth);
  if (dom.canvasCrosshairWidth) {
    dom.canvasCrosshairWidth.value = String(state.crosshairWidth);
    dom.canvasCrosshairWidth.addEventListener("change", function () {
      state.crosshairWidth = Number(dom.canvasCrosshairWidth.value);
      applyCrosshair();
      persist();
    });
  }
  buildThicknessSelect(dom.canvasAskWidth);
  if (dom.canvasAskWidth) {
    dom.canvasAskWidth.value = String(state.askWidth);
    dom.canvasAskWidth.addEventListener("change", function () {
      state.askWidth = Number(dom.canvasAskWidth.value);
      applyAsk();
      persist();
    });
  }
  if (dom.canvasAskStyle) {
    dom.canvasAskStyle.value = state.askStyle;
    dom.canvasAskStyle.addEventListener("change", function () {
      state.askStyle = dom.canvasAskStyle.value;
      applyAsk();
      persist();
    });
  }
  if (dom.canvasAskCheckbox) {
    dom.canvasAskCheckbox.checked = !!state.askEnabled;
    dom.canvasAskCheckbox.addEventListener("change", function () {
      state.askEnabled = dom.canvasAskCheckbox.checked;
      applyAsk();
      persist();
    });
  }
  buildThicknessSelect(dom.canvasDailyBreakWidth);
  if (dom.canvasDailyBreakWidth) {
    dom.canvasDailyBreakWidth.value = String(state.dailyBreakWidth);
    dom.canvasDailyBreakWidth.addEventListener("change", function () {
      state.dailyBreakWidth = Number(dom.canvasDailyBreakWidth.value);
      applyDailyBreak();
      persist();
    });
  }
  if (dom.canvasDailyBreakCheckbox) {
    dom.canvasDailyBreakCheckbox.checked = !!state.dailyBreakEnabled;
    dom.canvasDailyBreakCheckbox.addEventListener("change", function () {
      state.dailyBreakEnabled = dom.canvasDailyBreakCheckbox.checked;
      applyDailyBreak();
      persist();
    });
  }
  buildThicknessSelect(dom.canvasPriceLineWidth);
  if (dom.canvasPriceLineWidth) {
    dom.canvasPriceLineWidth.value = String(state.priceLineWidth);
    dom.canvasPriceLineWidth.addEventListener("change", function () {
      state.priceLineWidth = Number(dom.canvasPriceLineWidth.value);
      applyPriceLine();
      persist();
    });
  }

  // Text font-size dropdown, built once here rather than hardcoded in
  // index.html so the option list stays in one place.
  var TEXT_SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20];
  TEXT_SIZES.forEach(function (size) {
    var opt = document.createElement("option");
    opt.value = String(size);
    opt.textContent = String(size);
    dom.canvasTextSize.appendChild(opt);
  });
  dom.canvasTextSize.value = String(state.textSize);
  dom.canvasTextSize.addEventListener("change", function () {
    state.textSize = Number(dom.canvasTextSize.value);
    applyText();
    persist();
  });

  // "Enable Dark Theme" — checked by default. Unchecking it switches the
  // whole app to Light Theme (see applyDarkTheme()); re-checking it
  // switches back to Dark. Applied immediately (not just on `change`, to
  // match every other Canvas control's live-preview behavior) and
  // persisted like every other field.
  dom.canvasDarkThemeCheckbox.checked = !!state.darkTheme;
  applyDarkTheme();
  dom.canvasDarkThemeCheckbox.addEventListener("change", function () {
    state.darkTheme = dom.canvasDarkThemeCheckbox.checked;
    applyDarkTheme();
    persist();
  });

  // v50.1 Update 1: grid-line enable checkboxes — toggling one hides/shows
  // its swatch and immediately hides/shows that grid line on the chart.
  function wireGridCheckbox(checkboxEl, swatchEl, stateKey) {
    if (!checkboxEl) return;
    checkboxEl.checked = !!state[stateKey];
    if (swatchEl) swatchEl.classList.toggle("hidden", !checkboxEl.checked);
    checkboxEl.addEventListener("change", function () {
      state[stateKey] = checkboxEl.checked;
      if (swatchEl) swatchEl.classList.toggle("hidden", !checkboxEl.checked);
      applyGrid();
      persist();
    });
  }
  wireGridCheckbox(dom.canvasGridHorzCheckbox, dom.canvasGridHorzSwatch, "gridHorzEnabled");
  wireGridCheckbox(dom.canvasGridVertCheckbox, dom.canvasGridVertSwatch, "gridVertEnabled");

  // Re-paints every control from the current `state`/`presetsCache` — used
  // both right after load() resolves (disk settings may differ from the
  // DEFAULTS the controls were first wired up with) and after a preset is
  // applied.
  function refreshUI() {
    // Each swatch's `.value` setter (see color-picker.js's attach()) both
    // updates its internal state and repaints the swatch fill, so a plain
    // assignment is enough to reflect a freshly loaded/applied state.
    if (dom.canvasBgSwatch) dom.canvasBgSwatch.value = state.background;
    if (dom.canvasCrosshairSwatch) dom.canvasCrosshairSwatch.value = state.crosshairColor;
    if (dom.canvasTextSwatch) dom.canvasTextSwatch.value = state.textColor;
    if (dom.canvasBodyUpSwatch) dom.canvasBodyUpSwatch.value = state.bodyUp;
    if (dom.canvasBodyDownSwatch) dom.canvasBodyDownSwatch.value = state.bodyDown;
    if (dom.canvasBorderUpSwatch) dom.canvasBorderUpSwatch.value = state.borderUp;
    if (dom.canvasBorderDownSwatch) dom.canvasBorderDownSwatch.value = state.borderDown;
    if (dom.canvasWickUpSwatch) dom.canvasWickUpSwatch.value = state.wickUp;
    if (dom.canvasWickDownSwatch) dom.canvasWickDownSwatch.value = state.wickDown;
    if (dom.canvasGridHorzSwatch) dom.canvasGridHorzSwatch.value = state.gridHorzColor;
    if (dom.canvasGridVertSwatch) dom.canvasGridVertSwatch.value = state.gridVertColor;
    if (dom.canvasCrosshairStyle) dom.canvasCrosshairStyle.value = state.crosshairStyle;
    if (dom.canvasTextSize) dom.canvasTextSize.value = String(state.textSize);
    if (dom.canvasPriceLineSwatch) dom.canvasPriceLineSwatch.value = state.priceLineColor;
    if (dom.canvasPriceLineStyle) dom.canvasPriceLineStyle.value = state.priceLineStyle;
    if (dom.canvasCrosshairWidth) dom.canvasCrosshairWidth.value = String(state.crosshairWidth);
    if (dom.canvasPriceLineWidth) dom.canvasPriceLineWidth.value = String(state.priceLineWidth);
    if (dom.canvasSelectorSwatch) dom.canvasSelectorSwatch.value = state.selectorColor;
    if (dom.canvasAskSwatch) dom.canvasAskSwatch.value = state.askColor;
    if (dom.canvasAskStyle) dom.canvasAskStyle.value = state.askStyle;
    if (dom.canvasAskWidth) dom.canvasAskWidth.value = String(state.askWidth);
    if (dom.canvasAskCheckbox) dom.canvasAskCheckbox.checked = !!state.askEnabled;
    if (dom.canvasDailyBreakSwatch) dom.canvasDailyBreakSwatch.value = state.dailyBreakColor;
    if (dom.canvasDailyBreakWidth) dom.canvasDailyBreakWidth.value = String(state.dailyBreakWidth);
    if (dom.canvasDailyBreakCheckbox) dom.canvasDailyBreakCheckbox.checked = !!state.dailyBreakEnabled;
    if (dom.canvasDarkThemeCheckbox) dom.canvasDarkThemeCheckbox.checked = !!state.darkTheme;
    if (dom.canvasGridHorzCheckbox) {
      dom.canvasGridHorzCheckbox.checked = !!state.gridHorzEnabled;
      if (dom.canvasGridHorzSwatch) dom.canvasGridHorzSwatch.classList.toggle("hidden", !state.gridHorzEnabled);
    }
    if (dom.canvasGridVertCheckbox) {
      dom.canvasGridVertCheckbox.checked = !!state.gridVertEnabled;
      if (dom.canvasGridVertSwatch) dom.canvasGridVertSwatch.classList.toggle("hidden", !state.gridVertEnabled);
    }
    applyAll();
    refreshPresetOptions();
  }

  // ---- v50.1 Update 3: named Canvas presets --------------------------------
  var PRESET_DEFAULT_ID = "__default__";

  function closePresetDropdown() {
    if (dom.canvasPresetDropdownWrap) dom.canvasPresetDropdownWrap.classList.remove("open");
  }
  function togglePresetDropdown(evt) {
    if (evt) evt.stopPropagation();
    if (!dom.canvasPresetDropdownWrap) return;
    closePresetSaveBox();
    dom.canvasPresetDropdownWrap.classList.toggle("open");
  }
  function setPresetDropdownLabel(text) {
    if (dom.canvasPresetDropdownLabel) dom.canvasPresetDropdownLabel.textContent = text;
  }

  function nextPresetId() {
    var max = 0;
    presetsCache.forEach(function (p) {
      var id = Number(p && p.id);
      if (Number.isFinite(id) && id > max) max = id;
    });
    return max + 1;
  }

  // Rebuilds the preset dropdown list. "Default" is always the first,
  // undeletable entry — clicking it resets every Canvas field to the
  // factory theme (DEFAULTS).
  function refreshPresetOptions() {
    var list = dom.canvasPresetDropdownList;
    if (!list) return;
    list.innerHTML = "";

    var defaultRow = document.createElement("div");
    defaultRow.className = "canvas-preset-dropdown-item";
    var defaultBtn = document.createElement("button");
    defaultBtn.type = "button";
    defaultBtn.className = "canvas-preset-dropdown-item-name";
    defaultBtn.textContent = "Default";
    defaultBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      applyPreset(PRESET_DEFAULT_ID);
      closePresetDropdown();
    });
    defaultRow.appendChild(defaultBtn);
    list.appendChild(defaultRow);

    presetsCache.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "canvas-preset-dropdown-item";

      var nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "canvas-preset-dropdown-item-name";
      nameBtn.textContent = p.name;
      nameBtn.addEventListener("click", function (evt) {
        evt.stopPropagation();
        applyPreset(p.id);
        closePresetDropdown();
      });

      var trashBtn = document.createElement("button");
      trashBtn.type = "button";
      trashBtn.className = "canvas-preset-dropdown-item-trash";
      trashBtn.title = "Delete preset";
      trashBtn.innerHTML = App.Icons.trash();
      trashBtn.addEventListener("click", function (evt) {
        evt.stopPropagation();
        deletePreset(p.id);
      });

      row.appendChild(nameBtn);
      row.appendChild(trashBtn);
      list.appendChild(row);
    });
  }

  // Applying a preset (or "Default") replaces every Canvas field at once
  // and re-applies/persists immediately, same as touching each control by
  // hand would.
  function applyPreset(id) {
    var settings;
    var label;
    if (id === PRESET_DEFAULT_ID) {
      settings = cloneDefaults();
      label = "Default";
    } else {
      var found = presetsCache.filter(function (p) { return p.id === id; })[0];
      if (!found) return;
      settings = sanitizeSettings(found.settings);
      label = found.name;
    }
    state = settings;
    setPresetDropdownLabel(label);
    refreshUI();
    persist();
  }

  function deletePreset(id) {
    presetsCache = presetsCache.filter(function (p) { return p.id !== id; });
    refreshPresetOptions();
    persist();
  }

  function openPresetSaveBox() {
    if (!dom.canvasPresetSaveBox) return;
    closePresetDropdown();
    dom.canvasPresetSaveBox.classList.add("open");
    if (dom.canvasPresetSaveInput) {
      dom.canvasPresetSaveInput.value = "";
      dom.canvasPresetSaveInput.focus();
    }
  }
  function closePresetSaveBox() {
    if (dom.canvasPresetSaveBox) dom.canvasPresetSaveBox.classList.remove("open");
  }
  function commitPresetSave() {
    if (!dom.canvasPresetSaveInput) return;
    var name = dom.canvasPresetSaveInput.value.trim();
    if (!name) { closePresetSaveBox(); return; }
    var id = nextPresetId();
    presetsCache.push({ id: id, name: name, settings: deepCopy(state) });
    closePresetSaveBox();
    refreshPresetOptions();
    setPresetDropdownLabel(name);
    persist();
  }

  if (dom.canvasPresetDropdownBtn) dom.canvasPresetDropdownBtn.addEventListener("click", togglePresetDropdown);
  document.addEventListener("click", closePresetDropdown);
  if (dom.canvasPresetSave) dom.canvasPresetSave.addEventListener("click", function (evt) {
    evt.stopPropagation();
    openPresetSaveBox();
  });
  if (dom.canvasPresetSaveConfirm) dom.canvasPresetSaveConfirm.addEventListener("click", function (evt) {
    evt.stopPropagation();
    commitPresetSave();
  });
  if (dom.canvasPresetSaveCancel) dom.canvasPresetSaveCancel.addEventListener("click", function (evt) {
    evt.stopPropagation();
    closePresetSaveBox();
  });
  if (dom.canvasPresetSaveInput) {
    dom.canvasPresetSaveInput.addEventListener("click", function (evt) { evt.stopPropagation(); });
    dom.canvasPresetSaveInput.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") { evt.preventDefault(); commitPresetSave(); }
      else if (evt.key === "Escape") { evt.preventDefault(); closePresetSaveBox(); }
    });
  }
  if (dom.canvasPresetDropdownWrap) {
    dom.canvasPresetDropdownWrap.addEventListener("click", function (evt) { evt.stopPropagation(); });
  }

  refreshPresetOptions();

  // No per-tab lifecycle work needed (nothing polls/streams here) — the
  // Canvas tab's controls stay live-bound to `state` regardless of whether
  // this tab is the one currently visible.
  function activate() {}
  function deactivate() {}

  App.CanvasSettings = {
    activate: activate,
    deactivate: deactivate,
    applyAll: applyAll,
    load: load,
    // v50.3 Update 1: lets multi-panel.js sync a freshly-created companion
    // panel to whatever Canvas settings are already active this session.
    applyToPanel: applyToPanel,
  };
})();
