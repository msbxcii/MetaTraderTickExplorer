// =============================================================================
// main.js — boots the app once pywebview's API bridge is ready. Loaded last,
// after every other module has attached its pieces onto window.App.
// =============================================================================

(function () {
  "use strict";

  function boot() {
    // v67.2: fetch the app name/version (single source: src/version.py)
    // as early as possible so the title bar shows the right text/version
    // from the first frame rather than flashing the static HTML fallback.
    if (App.AppVersion && App.AppVersion.load) App.AppVersion.load();
    // v37: style defaults/presets now live on disk (see style-defaults.js /
    // src/style_store.py) — load them alongside everything else so the
    // very first newly-drawn object already picks up the saved default.
    if (App.StyleDefaults && App.StyleDefaults.load) {
      App.StyleDefaults.load();
    }
    App.ChartCore.init();
    // v50: apply the Canvas theme (background/crosshair/text/candle/grid
    // colors) now that App.chart/App.series exist — canvas-settings.js
    // wires its own UI controls long before this point (using DEFAULTS,
    // for an instant first paint), but can't touch the chart itself until
    // here.
    if (App.CanvasSettings && App.CanvasSettings.applyAll) App.CanvasSettings.applyAll();
    // v50.1: Canvas settings/presets now live on disk (see
    // canvas-settings.js / src/canvas_settings_store.py) — load() fetches
    // the saved values and, once resolved, repaints every Canvas control
    // and re-applies them to the chart, replacing the DEFAULTS the panel
    // opened with a moment ago.
    if (App.CanvasSettings && App.CanvasSettings.load) App.CanvasSettings.load();
    // v51: Keyboard Shortcuts tab bindings now live on disk (see
    // keyboard-shortcuts.js / src/keyboard_shortcuts_store.py) — load()
    // fetches any saved custom bindings before the global keydown
    // listener needs to consult them.
    if (App.KeyboardShortcuts && App.KeyboardShortcuts.load) App.KeyboardShortcuts.load();
    // v37: multi-chart panel layout (2/3-up, synced crosshair + time range).
    // Safe to init right after ChartCore.init() returns: createChart() runs
    // synchronously at the top of that call, so App.chart/App.series already
    // exist here even though the config/history fetch it kicked off is
    // still resolving in the background.
    if (App.MultiPanel) App.MultiPanel.init();
    // V64: pick up the newest live ASK the app already knows (if any), so the
    // ASK line does not wait for the next quote change on a quiet market.
    if (App.ChartCore.loadInitialLiveAsk) App.ChartCore.loadInitialLiveAsk();
    // v33: loading saved drawings is independent of chart/history init —
    // drawing-engine.js's render loop is already running and simply reads
    // whatever App.drawObjects currently is on every frame, so replacing
    // it once this resolves "just works", the same way a live timeframe
    // switch already does.
    if (App.DrawingPersistence) {
      App.DrawingPersistence.load().then(function () {
        if (App.ObjectsPanel) App.ObjectsPanel.refresh();
      });
    }
  }

  if (window.pywebview) {
    boot();
  } else {
    window.addEventListener("pywebviewready", function () {
      boot();
    });
  }
})();
