// v92: display clock = system time. Everything internal stays in broker
// time; only labels shown to the user and times typed by the user are
// shifted by App.Tz offset (system - broker, seconds, multiple of 15 min).
(function () {
  "use strict";
  var App = window.App;
  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var off = 0;
  var raw = 0, enabled = true;  // v93: Enable Local Timezone
  var charts = [];
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function shiftFor(tf) { return (tf || App.currentTf || 0) >= 86400 ? 0 : off; }

  function tickMark(time, type) {
    if (!off || typeof time !== "number") return null;  // default formatter
    var d = new Date((time + shiftFor()) * 1000);
    switch (type) {
      case 0: return String(d.getUTCFullYear());
      case 1: return MONTHS[d.getUTCMonth()];
      case 2: return String(d.getUTCDate());
      case 3: return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
      default: return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds());
    }
  }
  function crosshairTime(time) {
    if (typeof time !== "number") return String(time);
    var d = new Date((time + shiftFor()) * 1000);
    var s = d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " '" + pad(d.getUTCFullYear() % 100);
    if ((App.currentTf || 0) < 86400) s += "  " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds());
    return s;
  }
  var OPTS = { localization: { timeFormatter: crosshairTime }, timeScale: { tickMarkFormatter: tickMark } };

  function refresh() {
    charts = charts.filter(function (c) {
      try { c.applyOptions(OPTS); return true; } catch (e) { return false; }  // removed chart
    });
    try { document.dispatchEvent(new CustomEvent("App:timeOffsetChanged", { detail: off })); } catch (e) { /* old engine */ }
  }

  function apply() {
    var next = enabled ? raw : 0;
    if (next === off) return;
    off = next;
    refresh();
  }

  App.Tz = {
    offset: function () { return off; },
    toUser: function (t) { return Number(t) + off; },
    toBroker: function (t) { return Number(t) - off; },
    attach: function (chart) {
      if (!chart) return;
      charts.push(chart);
      try { chart.applyOptions(OPTS); } catch (e) { /* ignore */ }
    },
    set: function (sec) {
      raw = Math.round(Number(sec) || 0);
      apply();
    },
    setEnabled: function (on) { enabled = !!on; apply(); },
    isEnabled: function () { return enabled; },
  };

  // Python pushes a new offset after the daily check (live tick).
  window.onTimeOffset = function (sec) { App.Tz.set(sec); };
  // Saved offset from disk (works offline too).
  function loadSaved() {
    var api = window.pywebview && window.pywebview.api;
    if (!api || !api.get_time_offset) return;
    api.get_time_offset().then(function (sec) { App.Tz.set(sec); }).catch(function () { /* keep broker time */ });
  }
  if (window.pywebview && window.pywebview.api) loadSaved();
  else window.addEventListener("pywebviewready", loadSaved);
})();
