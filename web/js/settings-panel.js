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

  function open(initialTab) {
    dom.settingsBackdrop.classList.add("open");
    isOpen = true;
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

  App.SettingsPanel = { open: open, close: close, showTab: showTab };
})();
