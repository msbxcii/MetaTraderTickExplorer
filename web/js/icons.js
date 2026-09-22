// =============================================================================
// icons.js — inline SVG icon strings for the drawing toolbar.
// =============================================================================
// currentColor so each icon follows its toolbar button's text color /
// active state automatically. No dependencies on any other module.

(function () {
  "use strict";

  function iconCursor() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M3 2l9.5 5.5-4 1-1.5 4.2L3 2z" fill="currentColor" stroke="none"/></svg>';
  }
  function iconTrend() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 12.5L13 3"/><circle cx="2.5" cy="12.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="13" cy="3" r="1.3" fill="currentColor" stroke="none"/></svg>';
  }
  function iconHLine() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 8h12"/><circle cx="4.5" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="11.5" cy="8" r="1.2" fill="currentColor" stroke="none"/></svg>';
  }
  function iconVLine() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 2v12"/><circle cx="8" cy="4.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="11.5" r="1.2" fill="currentColor" stroke="none"/></svg>';
  }
  function iconRect() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4" width="11" height="8" rx="1"/></svg>';
  }
  // v47: Fibonacci Retracement toolbar icon — three horizontal "level"
  // strokes of decreasing length (matching the user-supplied Icon.png
  // reference), drawn with the same currentColor/stroke-width/line-cap
  // convention as every other toolbar glyph in this file so it follows
  // the button's own hover/active state automatically.
  function iconFib() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 3.6h12"/><path d="M2 8h9"/><path d="M2 12.4h5.5"/></svg>';
  }
  // v53: Fibonacci Expansion toolbar icon — traced verbatim from the
  // user-supplied FE.svg reference (three level strokes + the diagonal
  // "leg" markers), recolored to currentColor/fill so it follows the
  // button's own hover/active state exactly like every other glyph here.
  function iconFibExpansion() {
    return '<svg viewBox="0 0 28 28" fill="currentColor" stroke="none"><g fill-rule="nonzero"><path d="M4 25h22v-1h-22z"/><path d="M4 21h22v-1h-22z"/><path d="M6.5 17h19.5v-1h-19.5z"/><path d="M5 14.5v-3h-1v3zM6.617 9.275l10.158-3.628-.336-.942-10.158 3.628z"/><path d="M18.5 6c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM4.5 11c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM4.5 18c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></g></svg>';
  }

  // ---- v33: Object Tree panel icons ---------------------------------------
  // ---- v38: color picker eyedropper icon ---------------------------------
  function iconEyedropper() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5-2 2-2.5-2.5 2-2z"/><path d="M9.5 5.5L4 11l-1.5 2.5L5 12l5.5-5.5"/></svg>';
  }

  function iconLayers() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M8 2.2l6 3.1-6 3.1-6-3.1 6-3.1z"/><path d="M2 8.3l6 3.1 6-3.1"/><path d="M2 11.1l6 3.1 6-3.1"/></svg>';
  }
  function iconTrash() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10"/><path d="M6.2 4.5V3.2c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.3"/><path d="M4.3 4.5l.6 8.3c.05.6.5 1 1.1 1h4c.6 0 1.05-.4 1.1-1l.6-8.3"/><path d="M6.6 7v4.2"/><path d="M9.4 7v4.2"/></svg>';
  }
  function iconEye() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-4.6 7-4.6S15 8 15 8s-2.5 4.6-7 4.6S1 8 1 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  }
  function iconEyeOff() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 2.2l11.6 11.6"/><path d="M6.6 4.1C7 4 7.5 3.9 8 3.9c4.5 0 7 4.1 7 4.1s-.8 1.4-2.3 2.7"/><path d="M4.4 5.5C2.4 6.8 1 8 1 8s2.5 4.1 7 4.1c1 0 1.9-.2 2.7-.6"/><path d="M6.3 8a1.7 1.7 0 0 0 2.4 2.4"/></svg>';
  }
  function iconLock() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="7.2" width="9.6" height="6.4" rx="1"/><path d="M5 7.2V5a3 3 0 0 1 6 0v2.2"/></svg>';
  }
  function iconUnlock() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="7.2" width="9.6" height="6.4" rx="1"/><path d="M5 7.2V5a3 3 0 0 1 5.6-1.4"/></svg>';
  }
  // ---- v33.1 Fix 4: Object Tree folder icons ------------------------------
  function iconFolder() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4.2c0-.6.4-1 1-1h3.1l1.1 1.4h6.8c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1V4.2z"/></svg>';
  }
  function iconFolderPlus() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4.2c0-.6.4-1 1-1h3.1l1.1 1.4h6.8c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1V4.2z"/><path d="M8 6.6v3.6"/><path d="M6.2 8.4h3.6"/></svg>';
  }
  // v33.3 fix 3: a clearer, larger open/closed indicator for folder rows
  // than the old text-glyph triangle (which rendered almost invisibly
  // small in the panel's font). Drawn "closed" (pointing right); the
  // panel rotates it 90deg via CSS when the folder is open, rather than
  // swapping to a second path — a single icon plus a CSS transform gives
  // a smooth, minimal expand/collapse animation instead of a hard swap.
  function iconChevron() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3l5 5-5 5"/></svg>';
  }
  // v35 fix 2: small "sort" glyph (three descending bars with a down
  // arrow) for the Sort By dropdown button in the Object Tree header.
  function iconSort() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h8"/><path d="M2.5 8h5.5"/><path d="M2.5 11.5h3"/><path d="M11 6.2v6.3"/><path d="M9 10.8l2 2 2-2"/></svg>';
  }

  // v38.1: SQLite database icon (Market Data Overview modal trigger).
  // Traced from the user-supplied sql.svg — its dark rounded-rect body
  // (fill #0a0e17) matches --bg exactly, so it's kept as a literal fixed
  // fill here (it's the "hole" the lighter glyph sits on, not something
  // that should tint on hover). Its lighter "SQL" glyph (originally fill
  // #6b7686, i.e. exactly --muted) is switched to currentColor instead of
  // a fixed hex, so it follows the button's color like every other icon
  // in this file: --muted at rest, --text on hover, via the same
  // #objects-panel-toggle-style :hover rule the button uses.
  //
  // Note: the dark body fill is a literal #0a0e17 hex, NOT var(--bg) —
  // var(...) inside an SVG presentation attribute (as opposed to inside a
  // <style> block or a style="" property) is unreliable across
  // WebView/renderer versions, so a plain hex is used here instead, kept
  // in sync with --bg by hand (both currently #0a0e17).
  function iconSql() {
    return '<svg viewBox="0 0 377.33 214.67" fill="none"><path fill="#0a0e17" d="M372.82,167.54c-1.87,23.57-21.06,42.4-44.5,44.5H49.24c-23.03-2.12-41.28-19.75-44.34-42.66,2.42-39.22-3.66-83.2-.1-121.86C6.81,25.55,24.92,7.24,46.56,4.28l281.76-.32c23.37,2.15,41.76,20.25,44.44,43.56-2.29,38.96,3.11,81.48.06,120.02Z"/><path fill="#0a0e17" d="M192.78,148h-15.5c-4.83,0-11.45-7.93-12.26-12.74-1.43-8.52-1.43-46,0-54.52,2.44-14.51,20.05-13.62,31.3-12.78,7.78.58,14.82,4.48,16.22,12.78,1.59,9.46,1.38,42.79.24,52.76-.34,2.94-1.05,5.64-3.5,7.48-1.45,0-17.2-18.84-20.51-20.54-.96-.5-1.02-.49-1.98,0-1.17.6-10.1,9.99-9.94,10.92l15.93,16.64h0Z"/><path fill="currentColor" d="M175.54,52.26c23.2-3.13,50.86,1.02,53.28,29.21.97,11.36,1.32,54.82-2.53,63.54-.95,2.15-4.51,5.94-4.51,7.51,0,2.9,11.36,10.44,10.94,12.85l-10.56,10.56-14.08-12.74c-24.32,3.17-56.63,2.74-59.32-28.65-.98-11.48-1.4-50.92,1.53-60.54,3.28-10.74,14.06-20.23,25.26-21.74h-.01ZM192.78,148l-15.93-16.64c-.16-.93,8.77-10.32,9.94-10.92.96-.49,1.02-.5,1.98,0,3.31,1.7,19.06,20.53,20.51,20.54,2.45-1.85,3.16-4.54,3.5-7.48,1.14-9.97,1.35-43.3-.24-52.76-1.4-8.3-8.44-12.2-16.22-12.78-11.25-.84-28.86-1.73-31.3,12.78-1.43,8.52-1.43,46,0,54.52.81,4.81,7.43,12.74,12.26,12.74h15.5Z"/><path fill="currentColor" d="M132.78,84h-16c-1.55-17.67-18.66-17.34-32.54-16.04-20.15,1.89-20.66,29.26-.87,31.95,13.94,1.89,25.2-3.47,37.89,7.11,21.38,17.83,11.31,53.68-16.08,56.87-25.18,2.93-51.06-1.9-52.39-31.89h16c.24,0,.09,3.33.68,4.81,5.22,13.16,19.55,12.39,31.86,11.23,20.15-1.89,20.66-29.26.87-31.95-15.09-2.05-26.23,3.87-39.44-8.56-19.43-18.29-8.91-52.33,17.63-55.42s50.92,1.98,52.39,31.89Z"/><polygon fill="currentColor" points="260.78 52 260.78 148 324.78 148 324.78 164 244.78 164 244.78 52 260.78 52"/></svg>';
  }

  // ---- v40: Bar Replay icons -----------------------------------------
  // Header toggle: a "rewind to a point, then play forward" glyph — two
  // back-facing triangles plus a small marker line, distinct from the
  // plain double-chevron "skip back" glyph so it doesn't get confused
  // with an ordinary rewind/previous control.
  function iconReplay() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M8.2 3.2L3.6 8l4.6 4.8" fill="currentColor" stroke="none"/><path d="M13 3.2L8.4 8l4.6 4.8" fill="currentColor" stroke="none"/><path d="M2.2 2.3v11.4"/></svg>';
  }
  function iconCalendarSmall() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.2" y="3.2" width="11.6" height="10.6" rx="1.2"/><path d="M2.2 6.4h11.6"/><path d="M5.2 1.8v2.4"/><path d="M10.8 1.8v2.4"/></svg>';
  }
  function iconPlay() {
    return '<svg viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M4.5 2.8v10.4a.8.8 0 0 0 1.22.68l8.2-5.2a.8.8 0 0 0 0-1.36l-8.2-5.2A.8.8 0 0 0 4.5 2.8z"/></svg>';
  }
  function iconPause() {
    return '<svg viewBox="0 0 16 16" fill="currentColor" stroke="none"><rect x="3.6" y="2.6" width="3" height="10.8" rx="0.8"/><rect x="9.4" y="2.6" width="3" height="10.8" rx="0.8"/></svg>';
  }
  function iconSpeedGauge() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11.5a6 6 0 0 1 12 0"/><path d="M8 11.5L11 7.2"/><circle cx="8" cy="11.5" r="1" fill="currentColor" stroke="none"/></svg>';
  }

  // v44.1: minimal "refresh" glyph (two arced arrows) for the Market Data
  // Overview panel's manual candle-count re-count button, next to the
  // Tolerance dropdown. Same currentColor/stroke convention as every
  // other icon here so it follows its button's hover state automatically.
  function iconRefresh() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.6v3.2h-3.2"/></svg>';
  }

  // ---- v50: Setting panel ------------------------------------------------
  // Header toggle (replaces the old direct-to-Market-Data-Overview icon):
  // traced from the user-supplied Setting.svg gear glyph, switched to
  // currentColor so it follows #settings-toggle's hover/active state
  // exactly like every other icon-button glyph in this file.
  function iconGear() {
    return '<svg viewBox="0 0 122.88 122.878" fill="currentColor" stroke="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M101.589,14.7l8.818,8.819c2.321,2.321,2.321,6.118,0,8.439l-7.101,7.101 c1.959,3.658,3.454,7.601,4.405,11.752h9.199c3.283,0,5.969,2.686,5.969,5.968V69.25c0,3.283-2.686,5.969-5.969,5.969h-10.039 c-1.231,4.063-2.992,7.896-5.204,11.418l6.512,6.51c2.321,2.323,2.321,6.12,0,8.44l-8.818,8.819c-2.321,2.32-6.119,2.32-8.439,0 l-7.102-7.102c-3.657,1.96-7.601,3.456-11.753,4.406v9.199c0,3.282-2.685,5.968-5.968,5.968H53.629 c-3.283,0-5.969-2.686-5.969-5.968v-10.039c-4.063-1.232-7.896-2.993-11.417-5.205l-6.511,6.512c-2.323,2.321-6.12,2.321-8.441,0 l-8.818-8.818c-2.321-2.321-2.321-6.118,0-8.439l7.102-7.102c-1.96-3.657-3.456-7.6-4.405-11.751H5.968 C2.686,72.067,0,69.382,0,66.099V53.628c0-3.283,2.686-5.968,5.968-5.968h10.039c1.232-4.063,2.993-7.896,5.204-11.418l-6.511-6.51 c-2.321-2.322-2.321-6.12,0-8.44l8.819-8.819c2.321-2.321,6.118-2.321,8.439,0l7.101,7.101c3.658-1.96,7.601-3.456,11.753-4.406 V5.969C50.812,2.686,53.498,0,56.78,0h12.471c3.282,0,5.968,2.686,5.968,5.969v10.036c4.064,1.231,7.898,2.992,11.422,5.204 l6.507-6.509C95.471,12.379,99.268,12.379,101.589,14.7L101.589,14.7z M61.44,36.92c13.54,0,24.519,10.98,24.519,24.519 c0,13.538-10.979,24.519-24.519,24.519c-13.539,0-24.519-10.98-24.519-24.519C36.921,47.9,47.901,36.92,61.44,36.92L61.44,36.92z"/></svg>';
  }

  // Setting-panel sidebar tab glyphs — one static (non-interactive, per
  // spec: only the label text next to each is clickable) minimal icon per
  // tab, traced from the user-supplied icons.zip set and switched to
  // currentColor so they dim/brighten along with their tab label's own
  // muted-to-text color swap on select (see settings-panel.js), instead of
  // needing a second hover/active rule of their own.
  function iconTabMarketData() {
    return '<svg viewBox="0 0 122.88 120.54" fill="currentColor" stroke="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M95.7,65.5c15.01,0,27.18,12.17,27.18,27.18c0,15.01-12.17,27.18-27.18,27.18 c-15.01,0-27.18-12.17-27.18-27.18C68.52,77.67,80.69,65.5,95.7,65.5L95.7,65.5z M111.57,92.9h-9.98V77.16H90.33V92.9l-10.27,0 l15.75,15.32L111.57,92.9L111.57,92.9z M17.69,26.67c8.1,2.71,19.38,4.38,31.91,4.38c12.53,0,23.81-1.67,31.91-4.38 c7.11-2.37,11.51-5.25,11.51-8.06c0-2.81-4.4-5.69-11.51-8.06c-8.1-2.7-19.38-4.38-31.91-4.38c-12.53,0-23.81,1.67-31.91,4.38 C2.6,15.59,2.18,21.5,17.69,26.67L17.69,26.67z M6.24,47.86c0.56,2.62,4.83,5.26,11.45,7.47c8.1,2.71,19.38,4.38,31.91,4.38 s23.81-1.67,31.91-4.38c7.11-2.37,11.51-5.25,11.51-8.06h0.03v-19.3c-2.53,1.73-5.78,3.26-9.59,4.53 c-8.73,2.91-20.71,4.72-33.86,4.72c-13.16,0-25.13-1.8-33.86-4.72c-3.77-1.26-6.98-2.76-9.49-4.47V47.86L6.24,47.86z M63.3,92.54 c-4.35,0.44-8.95,0.67-13.7,0.67c-13.16,0-25.13-1.8-33.86-4.72c-3.77-1.26-6.98-2.76-9.49-4.47v18.49 c0.56,2.62,4.83,5.26,11.45,7.47c8.1,2.7,19.38,4.38,31.91,4.38c7.52,0,14.58-0.6,20.78-1.67c1.56,1.94,3.33,3.7,5.29,5.24 c-7.53,1.65-16.49,2.6-26.07,2.6c-13.16,0-25.13-1.8-33.86-4.72c-4.6-1.54-15.67-6.58-15.67-12.62c0-0.71,0-1.3,0-1.98 C0.06,73.69,0,46.15,0,18.61c0-5.76,6.01-10.65,15.73-13.9C24.46,1.8,36.44,0,49.6,0c13.16,0,25.13,1.8,33.86,4.72 c8.85,2.95,14.62,7.27,15.59,12.37c0.12,0.32,0.18,0.67,0.18,1.04v42.37c-1.2-0.14-2.42-0.21-3.66-0.21c-0.85,0-1.68,0.03-2.51,0.1 v-3.74c-2.53,1.73-5.78,3.26-9.59,4.53c-8.73,2.91-20.71,4.72-33.86,4.72c-13.16,0-25.13-1.8-33.86-4.72 c-3.77-1.26-6.98-2.76-9.49-4.47v18.49c0.56,2.62,4.83,5.26,11.45,7.47c8.1,2.7,19.38,4.38,31.91,4.38c5.01,0,9.82-0.27,14.31-0.76 C63.51,88.3,63.3,90.4,63.3,92.54L63.3,92.54z"/></svg>';
  }
  function iconTabCanvas() {
    return '<svg viewBox="0 0 108.2 122.88" fill="currentColor" stroke="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M93.01,73.51c3.8,16.46,15.19,24.68,15.19,32.91c0,8.23-3.8,16.46-15.19,16.46 c-11.39,0-15.19-8.23-15.19-16.46C77.82,98.19,89.22,89.97,93.01,73.51L93.01,73.51z M11.63,5.91l5.32-5.32c0.8-0.8,2.1-0.8,2.9,0 l16.19,16.19l8.33-8.33c2.25-2.25,5.94-2.25,8.19,0l42.68,42.68c2.25,2.25,2.25,5.94,0,8.19l-42.68,42.68 c-2.25,2.25-5.94,2.25-8.19,0L1.69,59.33c-2.25-2.25-2.25-5.94,0-8.19l26.13-26.14L11.63,8.81C10.83,8.02,10.83,6.71,11.63,5.91 L11.63,5.91z M51.38,22.02l30.31,30.31c0.89,0.89,1.28,2.09,1.19,3.26H14.06c-0.1-1.17,0.3-2.37,1.18-3.26l30.31-30.31 C47.16,20.42,49.78,20.42,51.38,22.02L51.38,22.02z"/></svg>';
  }
  function iconTabKeyboard() {
    return '<svg viewBox="0 0 122.88 59.48" fill="currentColor" stroke="none"><path d="M113.82,0c2.49,0,4.76,1.02,6.4,2.66c1.64,1.64,2.66,3.91,2.66,6.4v41.35c0,2.49-1.02,4.76-2.66,6.4 c-1.64,1.64-3.91,2.66-6.4,2.66H9.06c-2.49,0-4.76-1.02-6.4-2.66C1.02,55.18,0,52.91,0,50.42V9.06c0-2.49,1.02-4.76,2.66-6.4 C4.3,1.02,6.57,0,9.06,0C69.6,0,96.63,0,113.82,0L113.82,0z M92.24,3.84H9.06c-1.44,0-2.74,0.59-3.69,1.54 C4.42,6.32,3.84,7.63,3.84,9.06v41.35c0,1.44,0.59,2.74,1.54,3.69c0.95,0.95,2.25,1.54,3.69,1.54h104.75 c1.44,0,2.74-0.59,3.69-1.54c0.95-0.95,1.54-2.25,1.54-3.69V9.06c0-1.44-0.59-2.74-1.54-3.69c-0.95-0.95-2.25-1.54-3.69-1.54 h-13.24C98.26,3.84,94.56,3.84,92.24,3.84L92.24,3.84z M12.26,9.73h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54 c0,1.06-0.86,1.92-1.92,1.92h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54C10.34,10.59,11.2,9.73,12.26,9.73L12.26,9.73z M27.61,9.73 h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54 C25.69,10.59,26.55,9.73,27.61,9.73L27.61,9.73z M42.97,9.73h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92 h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54C41.05,10.59,41.91,9.73,42.97,9.73L42.97,9.73z M58.32,9.73h7.75 c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54 C56.41,10.59,57.26,9.73,58.32,9.73L58.32,9.73z M73.68,9.73h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92 h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54C71.76,10.59,72.62,9.73,73.68,9.73L73.68,9.73z M89.04,9.73h7.75 c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54 C87.12,10.59,87.98,9.73,89.04,9.73L89.04,9.73z M104.39,9.73h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92 h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54C102.47,10.59,103.33,9.73,104.39,9.73L104.39,9.73z M104.39,23.85h7.75 c1.06,0,1.92,0.87,1.92,1.94v20.68c0,1.07-0.86,1.94-1.92,1.94h-7.75c-1.06,0-1.92-0.87-1.92-1.94V25.79 C102.47,24.72,103.33,23.85,104.39,23.85L104.39,23.85z M12.26,24.02h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54 c0,1.06-0.86,1.92-1.92,1.92h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54C10.34,24.88,11.2,24.02,12.26,24.02L12.26,24.02z M27.61,24.02h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54 C25.69,24.88,26.55,24.02,27.61,24.02L27.61,24.02z M42.97,24.02h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92 h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54C41.05,24.88,41.91,24.02,42.97,24.02L42.97,24.02z M58.32,24.02h7.75 c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54 C56.41,24.88,57.26,24.02,58.32,24.02L58.32,24.02z M73.68,24.02h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92 h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54C71.76,24.88,72.62,24.02,73.68,24.02L73.68,24.02z M89.04,24.02h7.75 c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54 C87.12,24.88,87.98,24.02,89.04,24.02L89.04,24.02z M12.26,38.16h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92 h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54C10.34,39.02,11.2,38.16,12.26,38.16L12.26,38.16z M27.61,38.16h38.47 c1.05,0,1.9,0.86,1.9,1.92v6.54c0,1.06-0.85,1.92-1.9,1.92H27.61c-1.05,0-1.9-0.86-1.9-1.92v-6.54 C25.71,39.02,26.56,38.16,27.61,38.16L27.61,38.16z M73.68,38.16h7.75c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92 h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54C71.76,39.02,72.62,38.16,73.68,38.16L73.68,38.16z M89.04,38.16h7.75 c1.06,0,1.92,0.86,1.92,1.92v6.54c0,1.06-0.86,1.92-1.92,1.92h-7.75c-1.06,0-1.92-0.86-1.92-1.92v-6.54 C87.12,39.02,87.98,38.16,89.04,38.16L89.04,38.16z"/></svg>';
  }
  // No source icon shipped for the Configuration tab (icons.zip only had
  // About/Canvas/KeyboardShortcuts/Market Data Overview/Setting) — drawn
  // fresh here as a minimal "sliders" glyph, matching the flat single-tone
  // currentColor style of the rest of this tab-icon set.
  function iconTabConfiguration() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 4.5h7.2"/><path d="M11.4 4.5H14"/><circle cx="10.3" cy="4.5" r="1.1" fill="currentColor" stroke="none"/><path d="M2 8h3.4"/><path d="M7.6 8H14"/><circle cx="6.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><path d="M2 11.5h5.4"/><path d="M9.6 11.5H14"/><circle cx="8.5" cy="11.5" r="1.1" fill="currentColor" stroke="none"/></svg>';
  }
  function iconTabAbout() {
    return '<svg viewBox="0 0 512 512" fill="currentColor" stroke="none"><path fill-rule="nonzero" d="M256 0c70.69 0 134.7 28.66 181.02 74.98C483.34 121.31 512 185.31 512 256c0 70.69-28.66 134.7-74.98 181.02C390.7 483.34 326.69 512 256 512c-70.69 0-134.7-28.66-181.02-74.98C28.66 390.7 0 326.69 0 256c0-70.69 28.66-134.69 74.98-181.02C121.3 28.66 185.31 0 256 0zm17.75 342.25h29.15v29.32h-93.79v-29.32h28.76v-92.34h-28.76v-29.32h64.64v121.66zm-27.94-150.37c-7.08-.05-13.12-2.53-18.2-7.56-5.08-5.01-7.56-11.11-7.56-18.25 0-7.01 2.48-13.06 7.56-18.08 5.08-5.02 11.12-7.55 18.2-7.55 6.95 0 12.99 2.53 18.08 7.55 5.13 5.02 7.67 11.07 7.67 18.08 0 4.72-1.2 9.07-3.56 12.94-2.36 3.93-5.45 7.07-9.31 9.37-3.87 2.3-8.17 3.45-12.88 3.5zm171.9-97.59C376.33 52.92 319.15 27.32 256 27.32c-63.15 0-120.33 25.6-161.71 66.97C52.92 135.68 27.32 192.85 27.32 256c0 63.15 25.6 120.33 66.97 161.71 41.38 41.37 98.56 66.97 161.71 66.97 63.15 0 120.33-25.6 161.71-66.97 41.37-41.38 66.97-98.56 66.97-161.71 0-63.15-25.6-120.32-66.97-161.71z"/></svg>';
  }

  // v59: Log panel header toggle — a minimal "text document" glyph (folded
  // corner + a few text-line strokes), same currentColor/stroke-width/
  // line-cap convention as every other icon in this file so it follows
  // #log-toggle's hover/active state automatically, matching #settings-
  // toggle's gear right next to it.
  function iconLog() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 1.8h5.7l2.9 2.9v9.5a.9.9 0 0 1-.9.9H3.6a.9.9 0 0 1-.9-.9V2.7a.9.9 0 0 1 .9-.9z"/><path d="M9.3 1.8v2.6c0 .5.4.9.9.9h2.9"/><path d="M4.9 8h6"/><path d="M4.9 10.2h6"/><path d="M4.9 12.4h3.6"/></svg>';
  }

  // v63: "Chart" view button of the Market Data Overview tab's Chart/Log
  // switch — traced from the user-supplied chart.svg (three-bar-plus-one
  // column glyph), switched to currentColor + a plain evenodd fill so it
  // follows .mdo-view-btn's hover/selected color like every other icon here.
  function iconChart() {
    return '<svg viewBox="0 0 122.88 101.67" fill="currentColor" stroke="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M67.14,55.68h21.15c1.13,0,2.05,0.92,2.05,2.05v41.9c0,1.12-0.92,2.05-2.05,2.05l-21.15,0 c-1.12,0-2.05-0.92-2.05-2.05v-41.9C65.09,56.6,66.01,55.68,67.14,55.68L67.14,55.68z M2.05,0H23.2c1.13,0,2.05,0.93,2.05,2.05 v97.58c0,1.12-0.93,2.05-2.05,2.05H2.05c-1.12,0-2.05-0.92-2.05-2.05V2.05C0,0.92,0.92,0,2.05,0L2.05,0z M99.68,76.33h21.15 c1.13,0,2.05,0.93,2.05,2.05v21.25c0,1.12-0.92,2.05-2.05,2.05H99.68c-1.12,0-2.05-0.92-2.05-2.05V78.38 C97.64,77.25,98.56,76.33,99.68,76.33L99.68,76.33L99.68,76.33z M34.59,31.5h21.15c1.13,0,2.05,0.93,2.05,2.05v66.07 c0,1.12-0.93,2.05-2.05,2.05H34.59c-1.12,0-2.05-0.92-2.05-2.05V33.55C32.54,32.42,33.47,31.5,34.59,31.5L34.59,31.5z"/></svg>';
  }

  window.App.Icons = {
    cursor: iconCursor,
    trend: iconTrend,
    hline: iconHLine,
    vline: iconVLine,
    rect: iconRect,
    fib: iconFib,
    fibExpansion: iconFibExpansion,
    layers: iconLayers,
    eyedropper: iconEyedropper,
    trash: iconTrash,
    eye: iconEye,
    eyeOff: iconEyeOff,
    lock: iconLock,
    unlock: iconUnlock,
    folder: iconFolder,
    folderPlus: iconFolderPlus,
    chevron: iconChevron,
    sort: iconSort,
    sql: iconSql,
    replay: iconReplay,
    calendarSmall: iconCalendarSmall,
    play: iconPlay,
    pause: iconPause,
    speedGauge: iconSpeedGauge,
    refresh: iconRefresh,
    gear: iconGear,
    log: iconLog,
    chart: iconChart,
    tabMarketData: iconTabMarketData,
    tabCanvas: iconTabCanvas,
    tabKeyboard: iconTabKeyboard,
    tabConfiguration: iconTabConfiguration,
    tabAbout: iconTabAbout,
  };
})();
