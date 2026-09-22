// =============================================================================
// app-version.js — v67.2: fetches the app's display name/version from the
// single source of truth on the Python side (src/version.py, exposed as
// ChartBridge.get_app_info()) and applies it wherever the frontend needs
// it — the custom title bar's #titlebar-title and document.title here,
// the About tab's Version card in about-panel.js. Neither this file nor
// about-panel.js hardcodes the version string itself; both just read
// App.AppVersion.getInfo() (waiting on load() first if it hasn't resolved
// yet), so bumping VERSION in src/version.py is the only edit a release
// needs.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;

  var info = null;     // {name, version, title} once loaded, else null
  var promise = null;

  function applyTitlebar() {
    if (!info) return;
    var titleEl = document.getElementById("titlebar-title");
    if (titleEl) titleEl.textContent = info.title;
    document.title = info.title;
  }

  function hasBridge() {
    return !!(window.pywebview && window.pywebview.api && window.pywebview.api.get_app_info);
  }

  function load() {
    if (info) return Promise.resolve(info);      // already have it — nothing to do
    if (promise) return promise;                  // a real bridge call is already in flight
    if (!hasBridge()) {
      // Bridge not ready yet (e.g. called before "pywebviewready" fires) —
      // resolve with null WITHOUT caching, so the next call (once the
      // bridge is actually ready) tries again instead of being stuck
      // replaying this same failed attempt forever.
      return Promise.resolve(null);
    }
    promise = window.pywebview.api.get_app_info().then(function (data) {
      info = data;
      applyTitlebar();
      return info;
    }).catch(function (err) {
      console.warn("get_app_info failed:", err);
      return null;
    }).then(function (result) {
      promise = null;
      return result;
    });
    return promise;
  }

  App.AppVersion = {
    load: load,
    getInfo: function () { return info; },
  };
})();
