// v92: display clock = system time. Everything internal stays in broker
// time; only labels shown to the user and times typed by the user are
// shifted by App.Tz (system - broker, seconds).
// v116: the shift is no longer one constant. When a broker clock rule is
// known (Auto-detected or chosen in Sessions & Timezone) it is computed per
// instant, so candles from before a DST change show the right local time
// too:   broker_offset(utc) = refOffset(ref, utc) + shift_min * 60
//        ref "ny" = New York US DST, "eu" = Europe DST (UTC+0/+1), "utc".
// Mirrors src/broker_tz.py.
// v117: the old constant "legacy" offset is gone. With no rule the app shows
// pure broker time (shift 0) no matter what Enable Local Timezone says.
(function () {
  "use strict";
  var App = window.App;
  var H = 3600;
  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var rule = null;              // {ref, shift_min} or null
  var enabled = false;          // v93: Enable Local Timezone (v117: off by default; inert while no rule)
  var charts = [];
  var state = null;             // last state object from python (mode, detected, ...)
  var memo = {}, memoN = 0;     // shiftAt cache, 15-minute buckets
  var bounds = {};              // "ref|year" -> [startUtc, endUtc]
  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  // ---- DST arithmetic (same as broker_tz.py) -------------------------------
  function nthSunday(y, m, n) {   // m 1..12; n>=1 or -1 (last); returns UTC seconds of 00:00
    var day;
    if (n > 0) {
      var dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      day = 1 + (7 - dow) % 7 + 7 * (n - 1);
    } else {
      var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      day = last - new Date(Date.UTC(y, m - 1, last)).getUTCDay();
    }
    return Date.UTC(y, m - 1, day) / 1000;
  }
  function bnd(ref, y) {
    var k = ref + "|" + y, b = bounds[k];
    if (!b) {
      b = ref === "ny" ? [nthSunday(y, 3, 2) + 7 * H, nthSunday(y, 11, 1) + 6 * H]
                       : [nthSunday(y, 3, -1) + H, nthSunday(y, 10, -1) + H];
      bounds[k] = b;
    }
    return b;
  }
  function refOff(ref, u) {
    if (ref === "utc") return 0;
    var b = bnd(ref, new Date(u * 1000).getUTCFullYear());
    var dst = u >= b[0] && u < b[1];
    return ref === "ny" ? (dst ? -4 * H : -5 * H) : (dst ? H : 0);
  }
  function brokerOffAtUtc(u) { return refOff(rule.ref, u) + rule.shift_min * 60; }
  function brokerOffAtBroker(ts) {   // time on the broker clock itself (what candles carry)
    var sh = rule.shift_min * 60;
    if (rule.ref === "utc") return sh;
    var std = rule.ref === "ny" ? -5 * H : 0, dst = std + H;
    var c = std + sh;
    if (brokerOffAtUtc(ts - c) === c) return c;
    c = dst + sh;
    if (brokerOffAtUtc(ts - c) === c) return c;
    return std + sh;
  }
  function sysOffAtUtc(u) { return -new Date(u * 1000).getTimezoneOffset() * 60; }

  // ---- shifts ----------------------------------------------------------------
  // system clock minus broker clock at broker time ts (0 while Local Timezone is off or no rule is known)
  function shiftAt(ts) {
    if (!enabled || !rule) return 0;
    if (typeof ts !== "number" || !isFinite(ts)) ts = nowBroker();
    var k = Math.floor(ts / 900), v = memo[k];
    if (v === undefined) {
      var b = brokerOffAtBroker(ts);
      v = sysOffAtUtc(ts - b) - b;
      if (memoN > 4000) { memo = {}; memoN = 0; }
      memo[k] = v; memoN++;
    }
    return v;
  }
  function nowBroker() {
    var u = Date.now() / 1000;
    return rule ? u + brokerOffAtUtc(u) : u;
  }
  function rawNow() {   // system - broker right now, even when Local Timezone is off (0: unknown)
    if (!rule) return 0;
    var u = Date.now() / 1000;
    return sysOffAtUtc(u) - brokerOffAtUtc(u);
  }
  function tfShift(time) { return (App.currentTf || 0) >= 86400 ? 0 : shiftAt(time); }
  function active() { return enabled && !!rule; }

  function tickMark(time, type) {
    if (!active() || typeof time !== "number") return null;  // default formatter
    var d = new Date((time + tfShift(time)) * 1000);
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
    var d = new Date((time + tfShift(time)) * 1000);
    var s = d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " '" + pad(d.getUTCFullYear() % 100);
    if ((App.currentTf || 0) < 86400) s += "  " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds());
    return s;
  }
  var OPTS = { localization: { timeFormatter: crosshairTime }, timeScale: { tickMarkFormatter: tickMark } };

  function refresh() {
    memo = {}; memoN = 0;
    charts = charts.filter(function (c) {
      try { c.applyOptions(OPTS); return true; } catch (e) { return false; }  // removed chart
    });
    try { document.dispatchEvent(new CustomEvent("App:timeOffsetChanged", { detail: rawNow() })); } catch (e) { /* old engine */ }
  }

  function toUser(t) { t = Number(t); return t + shiftAt(t); }
  function toBroker(t) {       // inverse of toUser (two fixed-point passes cover DST edges)
    t = Number(t);
    var b = t - shiftAt(t);
    return t - shiftAt(b);
  }

  // ---- v117: wall clocks of named zones (for sessions) ------------------------
  // A session is typed in its own exchange's clock (e.g. London 08:00-16:30);
  // DST of that zone is handled here, so one preset is right all year. Uses the
  // browser's tz database (Intl), so past DST dates are right too.
  var zfmt = {}, zmemo = {}, zmemoN = 0;   // v118: zmemoN = entry count (no Object.keys scan)
  function zoneFmt(z) {
    if (zfmt[z] !== undefined) return zfmt[z];
    var f = null;
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: z, hourCycle: "h23", year: "numeric", month: "numeric",
        day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    } catch (e) { f = null; }
    return (zfmt[z] = f);
  }
  function zoneOffAtUtc(z, u) {     // seconds the zone is ahead of UTC at instant u; null for an unknown zone
    var f = zoneFmt(z);
    if (!f) return null;
    var k = z + "|" + Math.floor(u / 900), v = zmemo[k];
    if (v === undefined) {
      var p = {}, parts = f.formatToParts(new Date(Math.floor(u / 900) * 900 * 1000));
      for (var i = 0; i < parts.length; i++) p[parts[i].type] = parseInt(parts[i].value, 10);
      v = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - Math.floor(u / 900) * 900) / 900) * 900;
      if (zmemoN > 6000) { zmemo = {}; zmemoN = 0; }
      zmemo[k] = v; zmemoN++;
    }
    return v;
  }
  function zoneWallToUtc(z, wall) {  // wall clock of zone z (as UTC-style seconds) -> real UTC instant
    var o1 = zoneOffAtUtc(z, wall);
    if (o1 === null) return null;
    var u = wall - o1, o2 = zoneOffAtUtc(z, u);
    return o2 === o1 ? u : wall - o2;
  }

  App.Tz = {
    // v117: wall-clock instant of zone ``zone`` -> chart (broker) time; null while the
    // broker clock rule is unknown or the zone name is invalid.
    zoneWallToBroker: function (zone, wall) {
      if (!rule) return null;
      var u = zoneWallToUtc(zone, wall);
      return u === null ? null : u + brokerOffAtUtc(u);
    },
    zoneOffsetAtUtc: zoneOffAtUtc,
    validZone: function (z) { return !!zoneFmt(z); },
    // Display shift: at broker time ts, or "now" when ts is omitted.
    offset: function (ts) { return shiftAt(ts); },
    // system - broker now, regardless of Local Timezone (news.js)
    raw: function () { return rawNow(); },
    toUser: toUser,
    toBroker: toBroker,
    // v116 helpers for news.js (events are stamped in UTC)
    brokerOffsetAtUtc: function (u) { return rule ? brokerOffAtUtc(u) : 0; },   // 0 = unknown (check hasRule)
    sysOffsetAtUtc: sysOffAtUtc,
    hasRule: function () { return !!rule; },
    state: function () { return state; },
    attach: function (chart) {
      if (!chart) return;
      charts.push(chart);
      try { chart.applyOptions(OPTS); } catch (e) { /* ignore */ }
    },
    setEnabled: function (on) {
      on = !!on;
      if (on === enabled) return;
      enabled = on;
      refresh();
    },
    isEnabled: function () { return enabled; },
    // Full state from python (get_tz_state / onTzState).
    applyState: function (st) {
      state = st || null;
      var r = st && st.rule && /^(ny|eu|utc)$/.test(st.rule.ref) && isFinite(st.rule.shift_min) ? { ref: st.rule.ref, shift_min: Number(st.rule.shift_min) } : null;
      var changed = (!!r !== !!rule) || (r && rule && (r.ref !== rule.ref || r.shift_min !== rule.shift_min));
      rule = r;
      if (changed) refresh();
      try { document.dispatchEvent(new CustomEvent("App:tzState", { detail: state })); } catch (e) { /* ignore */ }
    },
  };

  // Python pushes: the rule state, detection progress/result.
  window.onTzState = function (st) { App.Tz.applyState(st); };
  window.onTzDetectStatus = function (d) {
    try { document.dispatchEvent(new CustomEvent("App:tzDetectStatus", { detail: d })); } catch (e) { /* ignore */ }
  };
  window.onTzDetectResult = function (r) {
    try { document.dispatchEvent(new CustomEvent("App:tzDetectResult", { detail: r })); } catch (e) { /* ignore */ }
  };
  // Saved state from disk (works offline too).
  function loadSaved() {
    var api = window.pywebview && window.pywebview.api;
    if (!api) return;
    if (api.get_tz_state) {
      api.get_tz_state().then(function (st) { App.Tz.applyState(st); }).catch(function () { /* keep broker time */ });
    }
  }
  if (window.pywebview && window.pywebview.api) loadSaved();
  else window.addEventListener("pywebviewready", loadSaved);
})();
