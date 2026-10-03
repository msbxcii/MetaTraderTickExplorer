// =============================================================================
// ui-scale.js — v104: interface scale.
//
// Python zooms the whole WebView natively (ChartBridge.ui_scale_apply), so
// panels, icons, fonts and chart text scale together. v104: fixed percent only
// (50/75/100/125/150, default 100) - no auto-fit, so no monitor re-checks.
// This file only applies the saved scale at startup (main.js waits for it)
// and drives the "Interface Scale" row at the top of the Canvas table.
// =============================================================================
(function () {
  "use strict";

  var App = window.App || (window.App = {});
  var root = document.documentElement;
  var elPct = document.getElementById("ui-scale-percent");
  var seq = 0;
  var zoom = 1;

  function api() { return window.pywebview && window.pywebview.api; }
  function reveal() { root.classList.remove("ui-scale-pending"); }

  function render(info) {
    if (!elPct || !info) return;
    var ok = !!info.supported;
    if (info.lazyChunk) App.LAZY_LOAD_CHUNK = info.lazyChunk;  // v106: window size follows the scale
    zoom = ok ? info.zoom : 1;
    root.style.setProperty("--ui-zoom", String(zoom));  // used by the window resize grips
    elPct.disabled = !ok;
    elPct.title = ok ? "Make the whole interface (panels, icons, fonts) bigger or smaller"
                     : "Not available on this system";
    elPct.value = String(info.percent);
  }

  // One Python call; a newer call makes an older, slower answer irrelevant.
  function request(prefs) {
    var a = api();
    if (!a || !a.ui_scale_apply) return Promise.resolve(null);
    var mine = ++seq;
    return a.ui_scale_apply(prefs || null).then(function (info) {
      if (mine === seq) render(info);
      return info;
    }).catch(function (err) {
      console.error("Interface scale failed:", err);
      return null;
    });
  }

  // Startup: apply before the chart is built, then show the page.
  function init() {
    return request(null).then(reveal, reveal);
  }

  // v104: wheel zoom parity. In pixel mode Chromium reports deltaY in CSS px
  // (/zoom) and the chart then divides by devicePixelRatio (which includes the
  // zoom) again, so a notch zooms the chart ~1/zoom^2 as much (150% -> 0.44x).
  // Scale such wheel events by zoom^2 (only above 100%: below it the chart's
  // own cap of one step per event already gives the same result).
  var redispatching = false;
  document.addEventListener("wheel", function (e) {
    if (redispatching || zoom <= 1.001 || e.deltaMode !== 0 || !e.cancelable) return;
    var t = e.target;
    if (!t || !t.closest || !t.closest(".tv-lightweight-charts")) return;
    var k = zoom * zoom;
    e.preventDefault();
    e.stopImmediatePropagation();
    redispatching = true;
    try {
      t.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
        deltaX: e.deltaX * k, deltaY: e.deltaY * k, deltaMode: 0,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey
      }));
    } finally { redispatching = false; }
  }, { capture: true, passive: false });

  if (elPct) {
    elPct.value = "100";
    elPct.addEventListener("change", function () { request({ percent: Number(elPct.value) }); });
  }

  App.UiScale = { init: init };
})();
