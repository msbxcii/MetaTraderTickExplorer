// =============================================================================
// state.js — shared namespace, DOM references, and cross-module state.
// =============================================================================
// v22: the chart logic and the drawing-tools logic used to live together in
// one 1758-line <script> block in index.html. As the project grows (trading
// panel, risk sizing, etc. are being considered next), that made it easy for
// a change in one area to accidentally touch the other. This file — plus the
// sibling files loaded after it — splits that single block into focused
// modules, one concern per file:
//
//   state.js              this file: the shared App namespace + DOM refs
//   coords.js              logical/time/pixel coordinate conversion helpers
//   chart-core.js           chart creation, timeframes, history, live updates
//   drawing-engine.js        draw objects, toolbar, hit-test, move/resize/clone
//   drawing-context-menu.js   right-click style/time editor panel
//   keyboard-shortcuts.js     undo/delete/escape key handling
//   icons.js                  inline SVG icon strings for the toolbar
//   main.js                    boots everything, in the right order
//
// These are loaded as ordinary <script> tags (not ES modules): the app is
// opened from a local file:// path via pywebview, and `type="module"` scripts
// are blocked by CORS under file://. Every module attaches its pieces onto
// the single shared `window.App` object below instead of using top-level
// `var`/`function`, so there's exactly one global and no risk of one file's
// helper silently colliding with another's.
//
// v30: chart history state is intentionally bounded; the active timeframe
// owns at most two resident partitions and all other timeframe arrays are
// released on switch.

window.App = {
  // ---- Chart state (owned by chart-core.js) --------------------------------
  TIMEFRAMES: [],         // filled from ChartBridge.get_config()
  candlesByTf: {},        // active timeframe render series: logical window plus transient oldest render buffer during an oldest-partial patch
  currentTf: null,
  chart: null,
  series: null,
  livePriceLine: null,
  livePrice: null,        // latest known live price, independent of visible history
  liveAskLine: null,      // V64: standalone PriceLine for the live ASK (no axis label)
  liveAsk: null,          // V64: latest known live ASK, display-only (never stored)
  lastBid: null,

  // (v25.3) Last connection status reported by the sync process itself
  // ("online" | "offline" | "syncing") - see window.onStatus in
  // chart-core.js. Starts "offline" since that's true by definition until
  // the sync process (a separate OS process that always starts
  // disconnected) confirms otherwise - this replaces the old behavior of
  // always forcing the dot green at startup regardless of real state.
  backendStatus: "offline",

  // (v31) Sliding-window history is deliberately timestamp/slot based.
  // Only two chronological resident slots exist per timeframe:
  //   older = the earlier partition (or null)
  //   newer = the later partition (or null)
  // No navigation partition IDs are stored in the browser. The backend is
  // queried from the actual timestamp boundary of the resident data.
  // `rightIsLive` is the only authority for real MT5 live patches. Replay has
  // a separate `rightIsReplay` flag so its moving Playhead can use the same
  // two-slot machinery without ever masquerading as the real Live edge.
  LAZY_LOAD_CHUNK: 4339,
  LAZY_LOAD_EDGE_BARS: 50,
  windowByTf: {},          // { tf: { older, newer, rightIsLive, rightIsReplay, exhaustedOlder } }
  loadingDirectionByTf: {},// { tf: "older" | "newer" } while one page is in flight

  // v41: Replay's moving right boundary, in timeframe seconds. The ordinary
  // Sliding Window loader uses this only while Replay is active; it prevents
  // a "newer" navigation request from ever exposing the hidden future.
  replayCutoffByTf: {},

  // Prevent duplicate edge loads while the pointer remains down during a
  // click+drag. The request starts as soon as the visible range enters the
  // configured edge zone, and this armed flag ensures one request per entry.
  isPointerDownOnChart: false,
  historyGeneration: 0,  // incremented to invalidate stale async history responses

  // ---- Drawing-engine state (owned by drawing-engine.js) -------------------
  drawObjects: [],   // { id, type, points:[...], style:{...}, name, folderId }
                      // hline points: {logical, price} (logical unused for rendering)
                      // vline points (v21): {time, price}
                      // trend/rect points (v14): {time, price}
                      // v33.1: `name` (Fix 3) is a user-editable display
                      // label, independent of `type` — defaults to the
                      // type's label until renamed. `folderId` (Fix 4) is
                      // either null (object sits at the panel's top level)
                      // or an id referencing an entry in App.objectFolders.
  nextObjectId: 1,

  // v33.1 Fix 4: Object Tree folders — purely a panel-side grouping
  // concept, never touching how an object is drawn/rendered on the chart
  // itself. { id, name, collapsed }. Membership is stored on the object
  // (folderId), not here, so moving an object in/out of a folder never
  // needs to walk this array. v33.2 fix 6: `collapsed` (default true —
  // set when the folder is created/receives its first drop) hides a
  // folder's members from the panel entirely until the folder row is
  // clicked open again; members are never removed from App.drawObjects,
  // only from the panel's visible row list (see orderedVisibleList() in
  // object-panel.js).
  objectFolders: [],
  nextFolderId: 1,
  currentTool: "cursor",   // cursor | hline | vline | trend | rect
  pendingObject: null,     // in-progress drag (trend/rect) preview
  dragStart: null,         // {time, price} for trend/rect while mouse is down (v14)

  // Selection / move / resize / clone state (v13)
  selectedObject: null,    // the SINGLE object showing chart selection
                            // handles / being dragged-resized right now.
                            // Left click on the chart or on a panel row
                            // (with no Ctrl/Shift) always narrows down to
                            // exactly this one object.
  // v33.1 Fix 2: multi-select set for the Object Tree panel — Ctrl+click
  // toggles a row in/out, Shift+click range-selects between the last
  // clicked row and the new one, and the trash/hide/lock action buttons on
  // ANY selected row act on every object in this set. A plain click (no
  // modifier) collapses this back down to a single entry, which is also
  // the moment App.selectedObject is set to that same object (so a
  // single-selected row IS the chart's selected object; a panel-only
  // multi-selection has no chart counterpart — see object-panel.js).
  // v33.2 fix 4: every object in this set is genuinely selected, so it
  // gets the SAME yellow highlight as App.selectedObject, both in the
  // panel and drawn on the chart (see renderFrame() in
  // drawing-engine.js) — a multi-selection now looks and behaves as
  // "all of these are selected", not just the single most-recent one.
  panelSelectedObjects: [],  // array of objects currently multi-selected
                              // in the Object Tree panel
  panelLastClickedObject: null, // anchor for Shift+click range-select
  interaction: null,       // { kind:'move'|'resize', obj, ... } while a
                            // cursor-tool drag is in progress

  // v40: Ctrl+click on the chart toggles an object in/out of
  // panelSelectedObjects (same array the Object Tree panel's own
  // Ctrl/Shift multi-select uses), so a chart-driven multi-selection and
  // a panel-driven one are always the same thing. Ctrl+click+drag on an
  // empty point of the chart (not on an object) starts a rubber-band
  // selection box instead — see drawing-engine.js's handleCursorMouseDown/
  // Move/Up. { startX, startY, curX, curY } in canvas-pixel space while
  // the gesture is in progress, else null.
  selectionBox: null,
  // v40: the exact array of objects a chart right-click group menu
  // (Hide/Lock/Delete) is currently acting on — see
  // drawing-context-menu.js's openGroupContextMenu/closeGroupContextMenu.
  groupMenuObjects: null,
  HIT_TOLERANCE: 6,        // px tolerance for hitting a line/border
  HANDLE_HIT: 8,           // px tolerance for grabbing a handle
  HANDLE_R: 5,             // px radius of a trend-line endpoint handle
  HANDLE_S: 8,             // px size of a rectangle corner handle

  dpr: window.devicePixelRatio || 1,

  // (v28) Auto Fit — mirrors the right price scale's own `autoScale`
  // option (Lightweight Charts keeps the price axis auto-fit to visible
  // data by default). True = on/white button; false = off/black button.
  // Always starts ON when the chart loads. Turned off either by clicking
  // the "A" button or by the user click+dragging the price axis
  // (Lightweight Charts already disables autoScale internally on that
  // drag — see syncAutoFitButton() in chart-core.js, which just keeps
  // our button in sync with it).
  autoFitEnabled: true,

  // v35.1 Fix 2: while an Object Tree jump swaps history data and the
  // horizontal viewport, the drawing overlay must not expose the previous
  // frame's object coordinates. The overlay is hidden for the short render
  // transaction and revealed only after the chart has had time to settle.
  jumpRenderSuppressed: false,

  // v35.1 Fix 3: prevent the Sliding Window edge loader from reacting to
  // viewport events emitted internally by an Object Tree Jump. During a jump,
  // setData()/setVisibleLogicalRange() can synchronously emit a range change;
  // allowing that event to start a partition request races the jump and can
  // move the chart back to an intermediate range for a few frames.
  jumpTransactionActive: false,

  // Right-click style/time editor (drawing-context-menu.js)
  activeMenuObject: null,

  // ---- Object Tree panel state (v33, owned by object-panel.js) ------------
  objectsPanelOpen: false,
  // v35 fix 2: "creation" (default, existing newest-id-first behavior) or
  // "time" (by Jump Time anchor, closest-to-live first). Applies only to
  // ordinary object rows; folders are always pinned to the top regardless
  // of this setting, and each folder's own members are sorted by it
  // independently of the top-level list — see orderedVisibleList() in
  // object-panel.js.
  objectTreeSort: "creation",

  // ---- DOM references (shared across modules) -------------------------------
  dom: {
    // v33.1 Fix 1: chartContainer now points at #chart-surface — the
    // flex-growing wrapper that actually holds the chart/canvas/toolbar
    // buttons (see index.html's #chart-surface CSS comment) — rather than
    // #chart-container itself, which now also contains the Object Tree
    // panel as a flex sibling. Every existing caller of dom.chartContainer
    // (chart-core.js's ResizeObserver, drawing-engine.js's canvas sizing
    // and mouse/contextmenu listeners) wants exactly the chart's own box,
    // so redirecting this one reference is sufficient — no call sites
    // needed to change.
    chartContainer: document.getElementById("chart-surface"),
    statusBanner: document.getElementById("status-banner"),
    liveDotEl: document.getElementById("live-dot"),
    hintToastEl: document.getElementById("hint-toast"),

    symbolDropdownEl: document.getElementById("symbol-dropdown"),
    symbolDropdownBtn: document.getElementById("symbol-dropdown-btn"),
    symbolDropdownLabel: document.getElementById("symbol-dropdown-label"),
    symbolDropdownList: document.getElementById("symbol-dropdown-list"),

    tfDropdownEl: document.getElementById("tf-dropdown"),
    tfDropdownBtn: document.getElementById("tf-dropdown-btn"),
    tfDropdownLabel: document.getElementById("tf-dropdown-label"),
    tfDropdownList: document.getElementById("tf-dropdown-list"),

    drawCanvas: document.getElementById("draw-canvas"),
    toolbarEl: document.getElementById("draw-toolbar"),
    autofitBtn: document.getElementById("autofit-btn"),

    contextMenuEl: document.getElementById("draw-context-menu"),
    dcmTitle: document.getElementById("dcm-title-text"),
    // v37 Fix 1: header action icons (lock/hide/delete) that now live next
    // to the ✕ close icon, mirroring the Object Tree panel's row buttons.
    dcmHeaderLock: document.getElementById("dcm-header-lock"),
    dcmHeaderHide: document.getElementById("dcm-header-hide"),
    dcmHeaderDelete: document.getElementById("dcm-header-delete"),
    dcmName: document.getElementById("dcm-name"),
    // v70.7 Update 1/2: Timeframes panel (see drawing-context-menu.js).
    dcmTfSection: document.getElementById("dcm-tf-section"),
    dcmTfHeader: document.getElementById("dcm-tf-header"),
    dcmTfClockIcon: document.getElementById("dcm-tf-clock-icon"),
    dcmTfBody: document.getElementById("dcm-tf-body"),
    // v71 Update 1: Auto toggle pill, inline in the Timeframes header.
    dcmTfAutoBtn: document.getElementById("dcm-tf-auto-btn"),
    dcmBorderColor: document.getElementById("dcm-border-color"),
    dcmBorderWidth: document.getElementById("dcm-border-width"),
    dcmBorderStyle: document.getElementById("dcm-border-style"),
    // v38 Fix 1: Fill's color+opacity now live together in the themed
    // color picker opened from this swatch — no separate opacity slider
    // or wrapping row of its own any more (see dcmFillColor.opacity).
    dcmFillColor: document.getElementById("dcm-fill-color"),
    // v36 Fix 4: rectangle-only "Middle Line" section.
    dcmMiddleLineRow: document.getElementById("dcm-middle-line-row"),
    dcmMiddleLineEnabled: document.getElementById("dcm-middle-line-enabled"),
    // v37 Fix 3: color/width/type now share one compact row.
    dcmMiddleLineFieldsRow: document.getElementById("dcm-middle-line-fields-row"),
    dcmMiddleLineColor: document.getElementById("dcm-middle-line-color"),
    dcmMiddleLineWidth: document.getElementById("dcm-middle-line-width"),
    dcmMiddleLineStyle: document.getElementById("dcm-middle-line-style"),
    // v47: Fib Retracement Level & Description table.
    dcmFibLevelsSection: document.getElementById("dcm-fib-levels-section"),
    dcmFibTableBody: document.getElementById("dcm-fib-table-body"),
    dcmFibAddLevel: document.getElementById("dcm-fib-add-level"),
    dcmFibDescToggleRow: document.getElementById("dcm-fib-desc-toggle-row"),
    dcmFibEnableDescription: document.getElementById("dcm-fib-enable-description"),
    // v37 Fix 2: style presets — now a themed dropdown (with a per-row
    // trash icon) instead of a native <select>, plus an inline "save as"
    // box instead of a native window.prompt().
    dcmPresetRow: document.getElementById("dcm-preset-row"),
    dcmPresetDropdownWrap: document.getElementById("dcm-preset-dropdown"),
    dcmPresetDropdownBtn: document.getElementById("dcm-preset-dropdown-btn"),
    dcmPresetDropdownLabel: document.getElementById("dcm-preset-dropdown-label"),
    dcmPresetDropdownList: document.getElementById("dcm-preset-dropdown-list"),
    dcmPresetSave: document.getElementById("dcm-preset-save"),
    dcmPresetSaveBox: document.getElementById("dcm-preset-save-box"),
    dcmPresetSaveInput: document.getElementById("dcm-preset-save-input"),
    dcmPresetSaveConfirm: document.getElementById("dcm-preset-save-confirm"),
    dcmPresetSaveCancel: document.getElementById("dcm-preset-save-cancel"),
    dcmTimeFromRow: document.getElementById("dcm-time-from-row"),
    dcmTimeToRow: document.getElementById("dcm-time-to-row"),
    dcmVlineTimeRow: document.getElementById("dcm-vline-time-row"),
    dcmVlineTimeDate: document.getElementById("dcm-vline-time-date"),
    dcmVlineTimeTime: document.getElementById("dcm-vline-time-time"),
    // v70.3 Update 2: hline price editor.
    dcmHlinePriceRow: document.getElementById("dcm-hline-price-row"),
    dcmHlinePrice: document.getElementById("dcm-hline-price"),
    dcmTimeFromDate: document.getElementById("dcm-time-from-date"),
    dcmTimeFromTime: document.getElementById("dcm-time-from-time"),
    dcmTimeToDate: document.getElementById("dcm-time-to-date"),
    dcmTimeToTime: document.getElementById("dcm-time-to-time"),
    dcmUnlock: document.getElementById("dcm-unlock"),
    dcmClose: document.getElementById("dcm-close"),

    // v40: minimal Hide/Lock/Delete menu for a right-click on an object
    // that's part of a multi-selection (>1 selected) — a single selected
    // object's right-click still opens the full editor above.
    groupContextMenuEl: document.getElementById("draw-group-context-menu"),
    dcmgHide: document.getElementById("dcmg-hide"),
    dcmgLock: document.getElementById("dcmg-lock"),
    dcmgDelete: document.getElementById("dcmg-delete"),

    // Object Tree panel (v33; v33.1 adds folders/multi-select/rename)
    objectsPanelToggle: document.getElementById("objects-panel-toggle"),
    objectsPanelEl: document.getElementById("objects-panel"),
    objectsPanelList: document.getElementById("objects-panel-list"),
    objectsPanelClose: document.getElementById("objects-panel-close"),
    objectsPanelNewFolder: document.getElementById("objects-panel-new-folder"),
    objectsPanelSortWrap: document.getElementById("objects-panel-sort-wrap"),
    objectsPanelSortBtn: document.getElementById("objects-panel-sort-btn"),
    objectsPanelSortList: document.getElementById("objects-panel-sort-list"),
    objectsPanelSortCreationBtn: document.getElementById("objects-panel-sort-creation"),
    objectsPanelSortTimeBtn: document.getElementById("objects-panel-sort-time"),

    // Jump Time dialog (v30.2) — intentionally initialized here so the
    // listener module can load before main.js boots ChartCore.
    jumpTimePanel: document.getElementById("jump-time-panel"),
    jumpTimeDate: document.getElementById("jump-time-date"),
    jumpTimeTime: document.getElementById("jump-time-time"),
    jumpTimeStatus: document.getElementById("jump-time-status"),
    jumpTimeGo: document.getElementById("jump-time-go"),
    jumpTimeCancel: document.getElementById("jump-time-cancel"),
    jumpTimeClose: document.getElementById("jump-time-close"),
    // v47.2: Select-Date-style calendar grid, shared visual language with
    // Bar Replay's own modal (see rbd* refs below).
    jumpTimeCalPrev: document.getElementById("jump-time-cal-prev"),
    jumpTimeCalNext: document.getElementById("jump-time-cal-next"),
    jumpTimeCalTitle: document.getElementById("jump-time-cal-title"),
    jumpTimeCalGrid: document.getElementById("jump-time-cal-grid"),

    // Bar Replay (v40)
    replayBarToggle: document.getElementById("replay-bar-toggle"),
    replayBar: document.getElementById("replay-bar"),
    replaySelectDateBtn: document.getElementById("replay-select-date-btn"),
    replayPlayPauseBtn: document.getElementById("replay-playpause-btn"),
    replaySpeedWrap: document.getElementById("replay-speed-wrap"),
    replaySpeedBtn: document.getElementById("replay-speed-btn"),
    replaySpeedLabel: document.getElementById("replay-speed-label"),
    replaySpeedList: document.getElementById("replay-speed-list"),
    replayCloseBtn: document.getElementById("replay-close-btn"),
    rbdBackdrop: document.getElementById("rbd-backdrop"),
    rbdClose: document.getElementById("rbd-close"),
    rbdDateInput: document.getElementById("rbd-date-input"),
    rbdTimeInput: document.getElementById("rbd-time-input"),
    rbdCalPrev: document.getElementById("rbd-cal-prev"),
    rbdCalNext: document.getElementById("rbd-cal-next"),
    rbdCalTitle: document.getElementById("rbd-cal-title"),
    rbdCalGrid: document.getElementById("rbd-cal-grid"),
    rbdCancelBtn: document.getElementById("rbd-cancel-btn"),
    rbdSelectBtn: document.getElementById("rbd-select-btn"),

    // Market Data Overview pane (v38.1; re-homed into the Setting panel in v50)
    mdoOldestDays: document.getElementById("mdo-oldest-days"),
    mdoOldestData: document.getElementById("mdo-oldest-data"),
    mdoYearSelect: document.getElementById("mdo-year-select"),
    mdoMonthSelect: document.getElementById("mdo-month-select"),
    mdoToleranceSelect: document.getElementById("mdo-tolerance-select"),
    mdoChartBox: document.getElementById("mdo-chart-box"),
    mdoCheckboxRow: document.getElementById("mdo-checkbox-row"),
    mdoHoverInfo: document.getElementById("mdo-hover-info"),
    mdoBackfillBtn: document.getElementById("mdo-backfill-btn"),
    mdoBackfillStatus: document.getElementById("mdo-backfill-status"),
    mdoRefreshBtn: document.getElementById("mdo-refresh-btn"),
    mdoSelectAllBtn: document.getElementById("mdo-select-all-btn"),
    // v46: Extend controls (date-range history extension, next to BackFill)
    mdoExtendBtn: document.getElementById("mdo-extend-btn"),
    mdoExtendDateBox: document.getElementById("mdo-extend-date-box"),
    mdoExtendDateInput: document.getElementById("mdo-extend-date-input"),
    mdoExtendCancel: document.getElementById("mdo-extend-cancel"),
    mdoExtendConfirm: document.getElementById("mdo-extend-confirm"),
    // v63: Chart / Log view switch above the histogram box.
    mdoViewChartBtn: document.getElementById("mdo-view-chart-btn"),
    mdoViewLogBtn: document.getElementById("mdo-view-log-btn"),
    mdoLogBox: document.getElementById("mdo-log-box"),
    mdoCheckboxRowWrap: document.getElementById("mdo-checkbox-row-wrap"),
    mdoPane: document.getElementById("settings-pane-market-data-overview"),

    // v50: Setting panel — replaces the old direct Market-Data-Overview
    // modal. One toggle button opens a tabbed panel; Market Data Overview
    // is now just one of its tabs (see settings-panel.js).
    settingsToggle: document.getElementById("settings-toggle"),
    settingsBackdrop: document.getElementById("settings-backdrop"),
    settingsClose: document.getElementById("settings-close"),
    settingsContentTitle: document.getElementById("settings-content-title"),
    settingsTabs: document.getElementById("settings-tabs"),

    // v59: Log panel — see web/js/log-panel.js.
    logToggle: document.getElementById("log-toggle"),
    logPanel: document.getElementById("log-panel"),
    logPanelHandle: document.getElementById("log-panel-handle"),
    logPanelClose: document.getElementById("log-panel-close"),
    logPanelBody: document.getElementById("log-panel-body"),
    logPanelFilters: document.getElementById("log-panel-filters"),

    // v50: Canvas tab — chart theme controls.
    canvasBgSwatch: document.getElementById("canvas-bg-swatch"),
    canvasCrosshairSwatch: document.getElementById("canvas-crosshair-swatch"),
    canvasCrosshairStyle: document.getElementById("canvas-crosshair-style"),
    canvasTextSwatch: document.getElementById("canvas-text-swatch"),
    canvasTextSize: document.getElementById("canvas-text-size"),
    canvasBodyUpSwatch: document.getElementById("canvas-body-up-swatch"),
    canvasBodyDownSwatch: document.getElementById("canvas-body-down-swatch"),
    canvasBorderUpSwatch: document.getElementById("canvas-border-up-swatch"),
    canvasBorderDownSwatch: document.getElementById("canvas-border-down-swatch"),
    canvasWickUpSwatch: document.getElementById("canvas-wick-up-swatch"),
    canvasWickDownSwatch: document.getElementById("canvas-wick-down-swatch"),
    // v50.3 Update 2: Price Line controls + Crosshair/Price Line thickness.
    canvasPriceLineSwatch: document.getElementById("canvas-price-line-swatch"),
    canvasPriceLineStyle: document.getElementById("canvas-price-line-style"),
    canvasCrosshairWidth: document.getElementById("canvas-crosshair-width"),
    canvasPriceLineWidth: document.getElementById("canvas-price-line-width"),
    // v50.3 Update 4: Selector (app-wide accent) swatch.
    canvasSelectorSwatch: document.getElementById("canvas-selector-swatch"),
    // v50.1 Update 1: grid-line enable checkboxes + their color swatches.
    canvasGridHorzCheckbox: document.getElementById("canvas-grid-horz-checkbox"),
    canvasGridHorzSwatch: document.getElementById("canvas-grid-horz-swatch"),
    canvasGridVertCheckbox: document.getElementById("canvas-grid-vert-checkbox"),
    canvasGridVertSwatch: document.getElementById("canvas-grid-vert-swatch"),
    // V64.1 Update 2: Enable Ask Price + its color / line type / width.
    canvasAskCheckbox: document.getElementById("canvas-ask-checkbox"),
    canvasAskSwatch: document.getElementById("canvas-ask-swatch"),
    canvasAskStyle: document.getElementById("canvas-ask-style"),
    canvasAskWidth: document.getElementById("canvas-ask-width"),
    canvasDailyBreakCheckbox: document.getElementById("canvas-daily-break-checkbox"),
    canvasDailyBreakSwatch: document.getElementById("canvas-daily-break-swatch"),
    canvasDailyBreakWidth: document.getElementById("canvas-daily-break-width"),
    // v50.1 Update 3: Canvas Preset picker.
    canvasPresetDropdownWrap: document.getElementById("canvas-preset-dropdown"),
    canvasPresetDropdownBtn: document.getElementById("canvas-preset-dropdown-btn"),
    canvasPresetDropdownLabel: document.getElementById("canvas-preset-dropdown-label"),
    canvasPresetDropdownList: document.getElementById("canvas-preset-dropdown-list"),
    canvasPresetSave: document.getElementById("canvas-preset-save"),
    canvasPresetSaveBox: document.getElementById("canvas-preset-save-box"),
    canvasPresetSaveInput: document.getElementById("canvas-preset-save-input"),
    canvasPresetSaveConfirm: document.getElementById("canvas-preset-save-confirm"),
    canvasPresetSaveCancel: document.getElementById("canvas-preset-save-cancel"),

    // v51: Keyboard Shortcuts tab.
    kbdShortcutsTbody: document.getElementById("kbd-shortcuts-tbody"),
    kbdResetAllBtn: document.getElementById("kbd-reset-all-btn"),
  },
};

// drawCtx is derived from drawCanvas, kept alongside the other drawing refs.
window.App.dom.drawCtx = window.App.dom.drawCanvas.getContext("2d");
