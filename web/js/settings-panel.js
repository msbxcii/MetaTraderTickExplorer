// =============================================================================
// settings-panel.js — v50: the shared "Setting" panel opened from the
// header's gear icon (replaces the old v38.1 Market-Data-Overview-only
// modal). Owns the backdrop/toggle button and the sidebar tab switching;
// each tab's own content/behavior lives in its own module (market-data-
// overview.js for the Market Data Overview tab, canvas-settings.js for
// Canvas, keyboard-shortcuts.js for Keyboard Shortcuts (v51), app-config.js
// for Configuration (v52), about-panel.js for About (v66.4)).
//
// Tabs call an optional {activate, deactivate} pair on App.<Module> when
// the user switches to/away from them, so a tab only does work (starts
// polling, loads data) while it's actually the one visible — same idea the
// old MDO modal already had for open/close, just generalized to N tabs.
// v66.4: About is no longer an empty shell — it now has its own module,
// about-panel.js, which loads/renders web/About.md the first time the tab
// is opened.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  if (!dom.settingsToggle || !dom.settingsBackdrop) return;

  // Tab id -> {label, iconEl id already in DOM, module on App with
  // activate()/deactivate(), pane element id}. Order here drives nothing
  // (the DOM already fixes the sidebar order) — this is just a lookup.
  var TABS = {
    "market-data-overview": { title: "Market Data Overview", module: "MarketDataOverview" },
    "canvas": { title: "Canvas", module: "CanvasSettings" },
    "sessions": { title: "Sessions & Timezone", module: "SessionsSettings" },  // v93
    "keyboard-shortcuts": { title: "Keyboard Shortcuts", module: "KeyboardShortcuts" },
    "configuration": { title: "Configuration", module: "AppConfig" },
    "about": { title: "About", module: "AboutPanel" },
  };

  var isOpen = false;
  var activeTab = null;

  // v50: static, non-clickable tab icons (see index.html/CSS — only the
  // label button next to each is interactive). Painted once here from
  // App.Icons rather than inline in the HTML, same convention every other
  // icon in this app follows.
  function paintTabIcons() {
    var map = {
      "market-data-overview": App.Icons.tabMarketData,
      "canvas": App.Icons.tabCanvas,
      "sessions": App.Icons.tabSessions,
      "keyboard-shortcuts": App.Icons.tabKeyboard,
      "configuration": App.Icons.tabConfiguration,
      "about": App.Icons.tabAbout,
    };
    Object.keys(map).forEach(function (tab) {
      var el = document.getElementById("settings-tab-icon-" + tab);
      if (el && map[tab]) el.innerHTML = map[tab]();
    });
  }

  function showTab(tab) {
    if (!TABS[tab]) return;
    if (activeTab && activeTab !== tab) {
      var prev = TABS[activeTab];
      var prevModule = prev.module && App[prev.module];
      if (prevModule && prevModule.deactivate) prevModule.deactivate();
      var prevRow = dom.settingsTabs.querySelector('.settings-tab[data-tab="' + activeTab + '"]');
      if (prevRow) prevRow.classList.remove("active");
      var prevPane = document.getElementById("settings-pane-" + activeTab);
      if (prevPane) prevPane.classList.remove("active");
    }

    activeTab = tab;
    dom.settingsContentTitle.textContent = TABS[tab].title;
    var row = dom.settingsTabs.querySelector('.settings-tab[data-tab="' + tab + '"]');
    if (row) row.classList.add("active");
    var pane = document.getElementById("settings-pane-" + tab);
    if (pane) pane.classList.add("active");

    var module = TABS[tab].module && App[TABS[tab].module];
    if (module && module.activate) module.activate();
  }

  // v98: measure the pane scrollbar/gutter width so the right inset of every
  // tab equals its left inset (see "v98" in index.html).
  function syncScrollbarWidth() {
    var modal = document.querySelector(".settings-modal");
    var panes = modal && modal.querySelector(".settings-panes");
    if (!panes) return;
    var w = Math.max(0, panes.offsetWidth - panes.clientWidth);
    modal.style.setProperty("--sbw", w + "px");
  }
  window.addEventListener("resize", syncScrollbarWidth);

  function open(initialTab) {
    dom.settingsBackdrop.classList.add("open");
    isOpen = true;
    syncScrollbarWidth();
    dom.settingsToggle.classList.add("active");
    showTab(initialTab || activeTab || "market-data-overview");
  }

  function close() {
    dom.settingsBackdrop.classList.remove("open");
    isOpen = false;
    dom.settingsToggle.classList.remove("active");
    if (activeTab) {
      var mod = TABS[activeTab].module && App[TABS[activeTab].module];
      if (mod && mod.deactivate) mod.deactivate();
    }
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  dom.settingsToggle.innerHTML = App.Icons.gear ? App.Icons.gear() : "";
  paintTabIcons();
  dom.settingsToggle.addEventListener("click", function () { toggle(); });
  dom.settingsClose.addEventListener("click", close);
  dom.settingsBackdrop.addEventListener("click", function (evt) {
    if (evt.target === dom.settingsBackdrop) close(); // click on the dimmed backdrop itself
  });
  document.addEventListener("keydown", function (evt) {
    if (evt.key === "Escape" && isOpen) close();
  });

  // Only the label text is clickable per spec — the click listener lives
  // on .settings-tab-label buttons, not the row, so the static icon next
  // to each never responds to a click of its own.
  var labelBtns = dom.settingsTabs.querySelectorAll(".settings-tab-label");
  for (var i = 0; i < labelBtns.length; i++) {
    labelBtns[i].addEventListener("click", function (evt) {
      showTab(evt.currentTarget.getAttribute("data-tab"));
    });
  }

  // v96: floating preset dropdown lists. The list used to be position:absolute
  // inside .settings-panes (overflow-y:auto), so when it needed more room than
  // was left below the button, the WHOLE tab started scrolling. It is now
  // position:fixed (taken out of the pane's scroll flow), placed under the
  // button (never above it) and its max-height is
  // fitted to the free space inside the Setting modal, so only the list's own
  // items scroll. Applies to every .canvas-preset-dropdown in the panel
  // (Canvas, Sessions & Timezone, and any future one) with no per-tab code.
  (function () {
    var modal = document.querySelector(".settings-modal");
    if (!modal) return;
    var GAP = 5, EDGE = 14, MIN_H = 72, MAX_H = 400;

    function place(wrap) {
      var btn = wrap.querySelector(".canvas-preset-dropdown-btn");
      var list = wrap.querySelector(".canvas-preset-dropdown-list");
      if (!btn || !list) return;
      var b = btn.getBoundingClientRect();
      var m = modal.getBoundingClientRect();
      var bottom = Math.min(m.bottom, window.innerHeight) - EDGE;
      list.style.maxHeight = "none";
      var natural = Math.min(list.scrollHeight + 2, MAX_H);
      // Always opens DOWNWARD. If the free space below is smaller than the
      // list, the list is cut to that space and scrolls inside itself.
      var below = bottom - b.bottom - GAP;
      var room = Math.max(MIN_H, Math.min(natural, below));
      list.style.position = "fixed";
      list.style.left = b.left + "px";
      list.style.width = b.width + "px";
      list.style.right = "auto";
      list.style.bottom = "auto";
      list.style.top = (b.bottom + GAP) + "px";
      list.style.maxHeight = room + "px";
    }

    var wraps = modal.querySelectorAll(".canvas-preset-dropdown");
    Array.prototype.forEach.call(wraps, function (wrap) {
      new MutationObserver(function () {
        if (wrap.classList.contains("open")) place(wrap);
      }).observe(wrap, { attributes: true, attributeFilter: ["class"] });
      // list contents change (preset added/deleted) while open -> refit
      var list = wrap.querySelector(".canvas-preset-dropdown-list");
      if (list) new MutationObserver(function () {
        if (wrap.classList.contains("open")) place(wrap);
      }).observe(list, { childList: true });
    });
    function refit() {
      Array.prototype.forEach.call(wraps, function (w) { if (w.classList.contains("open")) place(w); });
    }
    window.addEventListener("resize", refit);
    var panes = modal.querySelector(".settings-panes");
    if (panes) panes.addEventListener("scroll", refit, { passive: true });
  })();

  // v125: themed popup for native <select>s in Setting (the OS popup paints a
  // grey hover/selected row that can't be themed). Closed look stays native.
  (function () {
    var modal = dom.settingsBackdrop.querySelector(".settings-modal");
    if (!modal) return;
    var pop = null, owner = null;
    function close() {
      if (pop) { pop.remove(); pop = null; }
      owner = null;
    }
    function open(sel) {
      close();
      owner = sel;
      pop = document.createElement("div");
      pop.className = "sel-pop";
      var b = sel.getBoundingClientRect();
      Array.prototype.forEach.call(sel.options, function (o, i) {
        var it = document.createElement("div");
        it.className = "sel-pop-item" + (i === sel.selectedIndex ? " on" : "");
        it.textContent = o.textContent;
        if (o.disabled) it.classList.add("dis");
        it.addEventListener("mousedown", function (e) { e.preventDefault(); e.stopPropagation(); });
        it.addEventListener("click", function () {
          if (o.disabled) return;
          var changed = sel.selectedIndex !== i;
          sel.selectedIndex = i;
          close();
          if (changed) {
            sel.dispatchEvent(new Event("input", { bubbles: true }));
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
        pop.appendChild(it);
      });
      pop.style.left = b.left + "px";
      pop.style.minWidth = b.width + "px";
      modal.appendChild(pop);
      var below = window.innerHeight - b.bottom - 8, above = b.top - 8;
      var h = Math.min(pop.scrollHeight, 260);
      if (h > below && above > below) { pop.style.bottom = (window.innerHeight - b.top + 2) + "px"; pop.style.maxHeight = Math.min(260, above) + "px"; }
      else { pop.style.top = (b.bottom + 2) + "px"; pop.style.maxHeight = Math.min(260, below) + "px"; }
      var on = pop.querySelector(".on");
      if (on) on.scrollIntoView({ block: "nearest" });
    }
    modal.addEventListener("mousedown", function (e) {
      var sel = e.target.closest && e.target.closest("select");
      if (sel && !sel.disabled && modal.contains(sel)) {
        e.preventDefault();
        sel.focus();
        if (owner === sel) close(); else open(sel);
        return;
      }
      if (pop && !pop.contains(e.target)) close();
    }, true);
    document.addEventListener("mousedown", function (e) { if (pop && !modal.contains(e.target)) close(); });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("keydown", function (e) { if (pop && e.key === "Escape") { e.stopPropagation(); close(); } }, true);
    var panes = modal.querySelector(".settings-panes");
    if (panes) panes.addEventListener("scroll", close, { passive: true });
  })();

  App.SettingsPanel = { open: open, close: close, showTab: showTab };
})();
