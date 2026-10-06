// sessions.js — v93: Setting > Sessions & Timezone tab.
// State: { localTz, sessions:[{name,start,end,tz,color,opacity,on}] } + named
// presets, persisted via ChartBridge.get/save_sessions_settings. Painting is
// done by drawing-engine.js (under the candles) from App.sessions.
(function () {
  "use strict";
  var App = window.App;
  var $ = function (id) { return document.getElementById(id); };

  // v117: built-in preset. Times are the exchange's OWN wall clock (tz column), so the
  // session stays right all year: DST of New York / London is handled by tz.js per day,
  // and no separate "DST" / "Standard" presets are needed.
  function mk(name, start, end, tz) { return { name: name, start: start, end: end, tz: tz || "", color: "#848484", opacity: 10, on: false }; }
  var EXCHANGE_SESSIONS = [
    mk("NewYork Forex", "08:00", "17:00", "America/New_York"),
    mk("LSE - London Stock Exchange", "08:00", "16:30", "Europe/London"),
    mk("NYSE - NewYork Stock Exchange", "09:30", "16:00", "America/New_York"),
  ];
  var BUILTIN = [
    { id: "__sess_exch__", name: "Default", sessions: EXCHANGE_SESSIONS },
  ];
  var DEFAULT_SESSIONS = EXCHANGE_SESSIONS;
  var TZ_CHOICES = [   // [IANA zone, label]; "" = display time (old behaviour)
    ["", "Display time"], ["America/New_York", "New York"], ["America/Chicago", "Chicago"], ["Europe/London", "London"],
    ["Europe/Berlin", "Frankfurt / Paris"], ["Europe/Moscow", "Moscow"], ["Asia/Dubai", "Dubai"], ["Asia/Kolkata", "Mumbai"],
    ["Asia/Hong_Kong", "Hong Kong"], ["Asia/Shanghai", "Shanghai"], ["Asia/Tokyo", "Tokyo"], ["Australia/Sydney", "Sydney"],
    ["Pacific/Auckland", "Wellington"], ["UTC", "UTC"],
  ];
  var LOCAL_KEY = "mtte.sessions.v93";
  var state = { localTz: false, tzv: 117, sessions: clone(DEFAULT_SESSIONS) };   // v117: Local Timezone off by default
  var presets = [];        // [{id, name, sessions}]
  var currentPresetLabel = BUILTIN[0].name;
  var editingPresetId = null;
  var saveTimer = null;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function api() { return window.pywebview && window.pywebview.api; }

  // "HH:MM" -> minutes, or null.
  function toMin(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    var h = Number(m[1]), mm = Number(m[2]);
    return h > 23 || mm > 59 ? null : h * 60 + mm;
  }

  // Compiled, render-ready list (only valid + enabled rows).
  function publish() {
    App.sessions = state.sessions.map(function (s) {
      var a = toMin(s.start), b = toMin(s.end);
      if (!s.on || a === null || b === null || a === b) return null;
      var z = s.tz || "";
      if (z && App.Tz && App.Tz.validZone && !App.Tz.validZone(z)) return null;   // v117: unknown zone name
      return { name: s.name || "", s: a, e: b, z: z, color: s.color, opacity: Number(s.opacity) || 0 };
    }).filter(Boolean);
    paintLocalTz();
    if (App.DrawingEngine && App.DrawingEngine.refreshSessions) App.DrawingEngine.refreshSessions();
  }

  function persist() {
    clearTimeout(saveTimer);  // debounce typing
    saveTimer = setTimeout(function () {
      var data = { settings: state, presets: presets };
      var a = api();
      if (a && a.save_sessions_settings) a.save_sessions_settings(data).catch(function () {});
      else try { localStorage.setItem(LOCAL_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
    }, 300);
  }

  // v117: Enable Local Timezone is only usable once a broker clock rule is known; without one the
  // chart always shows broker time. The saved choice is kept and comes back when a rule exists.
  function paintLocalTz() {
    var cb = $("sess-local-tz"), hint = $("sess-local-tz-hint");
    if (!cb) return;
    var has = !!(App.Tz && App.Tz.hasRule && App.Tz.hasRule());
    cb.disabled = !has;
    cb.checked = has && state.localTz;
    if (hint) hint.textContent = has ? "" : "Showing broker time. Detect or set the broker clock below to enable.";
    var th = $("sess-tz-hint");
    if (th) {
      var needs = !has && (App.sessions || []).some(function (x) { return x.z; });
      th.textContent = needs ? "Sessions with a timezone are drawn once the broker clock is known (Detect, or pick a rule above)." : "";
      th.classList.toggle("bad", needs);
    }
  }

  // v117: preset identity = rows + hours + zone only. Ticks, colours, opacity and names don't count,
  // so toggling a session never leaves its preset, and editing a time back restores the label.
  function sig(list) {
    return JSON.stringify((list || []).map(function (s) { return [toMin(s.start) === null ? String(s.start) : toMin(s.start), toMin(s.end) === null ? String(s.end) : toMin(s.end), s.tz || ""]; }));
  }
  function matchLabel() {
    var cur = sig(state.sessions), all = BUILTIN.concat(presets), i;
    for (i = 0; i < all.length; i++) if (all[i].name === currentPresetLabel && sig(all[i].sessions) === cur) return currentPresetLabel;
    for (i = 0; i < all.length; i++) if (sig(all[i].sessions) === cur) return all[i].name;
    return "-";
  }
  function changed() { currentPresetLabel = matchLabel(); paintPresetLabel(); publish(); persist(); }

  // ---- rows -------------------------------------------------------------
  function renderRows() {
    var box = $("sess-rows");
    box.innerHTML = "";
    if (!state.sessions.length) {
      var e = document.createElement("div");
      e.className = "sess-empty";
      e.textContent = "No sessions. Click \u201c+ Add Session\u201d.";
      box.appendChild(e);
      return;
    }
    state.sessions.forEach(function (s, i) {
      var row = document.createElement("div");
      row.className = "tr sess sess-row";

      var on = document.createElement("input");
      on.type = "checkbox"; on.checked = s.on !== false; on.title = "Show on chart";
      on.addEventListener("change", function () { s.on = on.checked; changed(); });

      var name = textInput(s.name, "Name", function (v) { s.name = v; return true; });
      var start = textInput(s.start, "HH:MM", function (v) { s.start = v; return toMin(v) !== null; });
      var end = textInput(s.end, "HH:MM", function (v) { s.end = v; return toMin(v) !== null; });

      var tzs = document.createElement("select");
      tzs.title = "Timezone the Start/End times are written in";
      var known = TZ_CHOICES.some(function (c) { return c[0] === (s.tz || ""); });
      (known ? TZ_CHOICES : TZ_CHOICES.concat([[s.tz, s.tz]])).forEach(function (c) {
        var o = document.createElement("option"); o.value = c[0]; o.textContent = c[1]; tzs.appendChild(o);
      });
      tzs.value = s.tz || "";
      tzs.addEventListener("keydown", function (e) { e.stopPropagation(); });
      tzs.addEventListener("change", function () { s.tz = tzs.value; changed(); });

      var sw = document.createElement("button");
      App.ColorField.attach(sw, { value: s.color, initialOpacity: s.opacity });
      sw.addEventListener("input", function () { s.color = sw.value; s.opacity = sw.opacity; publish(); });
      sw.addEventListener("change", function () { s.color = sw.value; s.opacity = sw.opacity; changed(); });

      var del = document.createElement("button");
      del.type = "button"; del.className = "canvas-preset-dropdown-item-trash"; del.title = "Delete session";
      del.innerHTML = App.Icons.trash();
      del.addEventListener("click", function () { state.sessions.splice(i, 1); renderRows(); changed(); });

      [on, name, start, end, tzs, sw, del].forEach(function (el) { row.appendChild(el); });
      box.appendChild(row);
    });
  }

  function textInput(value, ph, onValue) {
    var el = document.createElement("input");
    el.type = "text"; el.value = value || ""; el.placeholder = ph; el.autocomplete = "off";
    el.addEventListener("input", function () {
      var ok = onValue(el.value.trim());
      el.classList.toggle("sess-invalid", !ok);
      changed();
    });
    el.addEventListener("keydown", function (e) { e.stopPropagation(); }); // keep chart shortcuts out
    return el;
  }

  // ---- presets ------------------------------------------------------------
  function paintPresetLabel() { $("sess-preset-dropdown-label").textContent = currentPresetLabel; }
  function closeDropdown() { $("sess-preset-dropdown").classList.remove("open"); }

  function renderPresetList() {
    var list = $("sess-preset-dropdown-list");
    list.innerHTML = "";
    function item(label, onPick, p) {
      var row = document.createElement("div");
      row.className = "canvas-preset-dropdown-item";
      var b = document.createElement("button");
      b.type = "button"; b.className = "canvas-preset-dropdown-item-name"; b.textContent = label;
      b.addEventListener("click", function (e) { e.stopPropagation(); onPick(); closeDropdown(); });
      row.appendChild(b);
      if (p) {
        var m = document.createElement("button");
        m.type = "button"; m.className = "canvas-preset-dropdown-item-modify"; m.title = "Modify preset";
        m.innerHTML = App.Icons.modify();
        m.addEventListener("click", function (e) { e.stopPropagation(); openSaveBox(p.name, p.id); });
        var t = document.createElement("button");
        t.type = "button"; t.className = "canvas-preset-dropdown-item-trash"; t.title = "Delete preset";
        t.innerHTML = App.Icons.trash();
        t.addEventListener("click", function (e) {
          e.stopPropagation();
          presets = presets.filter(function (x) { return x.id !== p.id; });
          renderPresetList(); persist();
        });
        row.appendChild(m); row.appendChild(t);
      }
      list.appendChild(row);
    }
    BUILTIN.forEach(function (b) { item(b.name, function () { loadSessions(b.sessions, b.name); }); });
    presets.forEach(function (p) { item(p.name, function () { loadSessions(p.sessions, p.name); }, p); });
  }

  function loadSessions(list, label) {
    state.sessions = clone(list || []);
    renderRows(); publish(); persist();
    currentPresetLabel = label; paintPresetLabel();
  }

  function openSaveBox(prefill, id) {
    editingPresetId = id || null;
    $("sess-preset-save-box").classList.add("open");
    var inp = $("sess-preset-save-input");
    inp.value = prefill || ""; inp.focus(); inp.select();
  }
  function closeSaveBox() { $("sess-preset-save-box").classList.remove("open"); editingPresetId = null; }
  function confirmSave() {
    var name = $("sess-preset-save-input").value.trim();
    if (!name) return;
    if (BUILTIN.some(function (b) { return b.name === name; })) { $("sess-preset-save-input").focus(); return; }  // v94: reserved
    // v101: preset names are unique - same name updates that preset (as in the Canvas tab).
    var byName = presets.filter(function (x) { return x.name === name; })[0];
    var byId = editingPresetId ? presets.filter(function (x) { return x.id === editingPresetId; })[0] : null;
    if (byName) {
      byName.sessions = clone(state.sessions);
      if (byId && byId !== byName) presets = presets.filter(function (x) { return x !== byId; });
    } else if (byId) { byId.name = name; byId.sessions = clone(state.sessions); }
    else presets.push({ id: "s" + Date.now().toString(36), name: name, sessions: clone(state.sessions) });
    currentPresetLabel = name; paintPresetLabel();
    closeSaveBox(); renderPresetList(); persist();
  }

  // ---- load / wire ------------------------------------------------------
  function applyLoaded(data) {
    var s = data && data.settings;
    if (s && typeof s === "object" && Array.isArray(s.sessions)) {
      state.localTz = s.tzv === 117 && s.localTz === true;   // v117: files from before the marker start with it OFF
      state.tzv = 117;
      state.sessions = s.sessions;
    }
    presets = (data && Array.isArray(data.presets)) ? data.presets : [];
    // v101: collapse same-name presets saved by earlier versions (newest wins).
    var seen = {};
    presets.forEach(function (x, i) { seen[x.name] = i; });
    presets = presets.filter(function (x, i) { return seen[x.name] === i; });
    currentPresetLabel = matchLabel();   // v117: recognise Default / a saved preset by its content
    paintPresetLabel();
    if (App.Tz) App.Tz.setEnabled(state.localTz);
    renderRows(); renderPresetList(); publish();
  }

  function load() {
    var a = api();
    if (a && a.get_sessions_settings) {
      a.get_sessions_settings().then(applyLoaded).catch(function () { applyLoaded(null); });
    } else {
      var d = null;
      try { d = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch (e) { /* ignore */ }
      applyLoaded(d);
    }
  }

  if (!$("settings-pane-sessions")) return;

  $("sess-local-tz").addEventListener("change", function (e) {
    if (!(App.Tz && App.Tz.hasRule && App.Tz.hasRule())) { paintLocalTz(); return; }
    state.localTz = e.target.checked;
    if (App.Tz) App.Tz.setEnabled(state.localTz);  // instant
    persist();
  });
  $("sess-add").addEventListener("click", function () {
    state.sessions.push({ name: "Session " + (state.sessions.length + 1), start: "00:00", end: "08:00", tz: "", color: "#3fb68b", opacity: 10, on: true });
    renderRows(); changed();
    var box = $("sess-rows"); box.scrollTop = box.scrollHeight;
  });
  $("sess-preset-dropdown-btn").addEventListener("click", function (e) {
    e.stopPropagation(); $("sess-preset-dropdown").classList.toggle("open");
  });
  document.addEventListener("click", closeDropdown);
  $("sess-preset-save").addEventListener("click", function () { openSaveBox("", null); });
  $("sess-preset-save-confirm").addEventListener("click", confirmSave);
  $("sess-preset-save-cancel").addEventListener("click", closeSaveBox);
  $("sess-preset-save-input").addEventListener("keydown", function (e) {
    e.stopPropagation();
    if (e.key === "Enter") confirmSave(); else if (e.key === "Escape") closeSaveBox();
  });

  // ---- v116: Broker clock (Auto / US / Europe / Fixed UTC / Custom) ---------
  // The rule itself lives in python (time_offset_store.py, per broker server);
  // App.Tz turns it into per-candle display offsets. Auto asks the sync
  // process to measure the broker's weekly open/close on one forex symbol.
  var tzSt = null, tzBusy = false, tzSaveTimer = null, tzBusyTimer = null, tzRep = null;   // v123: tzRep = last Detect report, RAM only
  var FX_RE = /^(USD|EUR|GBP|JPY|CHF|AUD|NZD|CAD)(USD|EUR|GBP|JPY|CHF|AUD|NZD|CAD)/i;
  function hrs(min) { var h = min / 60; return (h >= 0 ? "+" : "") + (Math.round(h * 100) / 100); }
  function num(el) { var v = parseFloat(String(el.value).replace(",", ".")); return isFinite(v) ? v : null; }

  function tzStatus(text, bad) {
    var el = $("tzb-status");
    el.textContent = text || ""; el.classList.toggle("bad", !!bad);
  }

  function renderReport(det) {
    var box = $("tzb-report");
    if (!det || !det.weeks || !det.weeks.length) { box.innerHTML = ""; return; }
    var rows = [];
    det.weeks.forEach(function (w) {
      (w.items || []).forEach(function (it) { rows.push({ day: it.day, w: w.label, it: it }); });
    });
    rows.sort(function (a, b) { return a.day < b.day ? 1 : a.day > b.day ? -1 : (a.it.kind < b.it.kind ? 1 : -1); });
    var h = "<table><thead><tr><th>Date</th><th>Event</th><th>Broker</th><th>Rule</th><th></th></tr></thead><tbody>";
    rows.forEach(function (r) {
      var it = r.it, m, c;
      if (!it.valid) { m = "ignored"; c = "na"; }
      else if (it.ok === undefined) { m = "\u2013"; c = "na"; }
      else { m = it.ok ? "\u2713" : "\u2717"; c = it.ok ? "ok" : "no"; }
      h += "<tr><td>" + r.day + "</td><td>" + (it.kind === "close" ? "Fri close" : "Sun open") + " \u00b7 " + r.w + "</td><td>UTC" +
        hrs(it.obs_min) + "</td><td>" + (it.pred_min !== undefined ? "UTC" + hrs(it.pred_min) : "") + '</td><td class="' + c + '">' + m + "</td></tr>";
    });
    box.innerHTML = h + "</tbody></table>";
  }

  function paintTz() {
    var st = tzSt || (App.Tz && App.Tz.state && App.Tz.state());
    if (!st) return;
    tzSt = st;
    var mode = st.mode || "auto", man = st.manual || {};
    var modeEl = $("tzb-mode");
    if (modeEl.value !== mode) modeEl.value = mode;
    $("tzb-fixed-row").style.display = mode === "fixed" ? "" : "none";
    $("tzb-custom-row").style.display = mode === "custom" ? "" : "none";
    $("tzb-auto-row").style.display = mode === "auto" ? "" : "none";
    if (document.activeElement !== $("tzb-fixed")) $("tzb-fixed").value = man.fixed_hours !== undefined ? man.fixed_hours : 3;
    if (document.activeElement !== $("tzb-shift")) $("tzb-shift").value = man.shift_hours !== undefined ? man.shift_hours : 7;
    $("tzb-ref").value = man.ref || "ny";
    var det = st.detected || null;
    // current rule + what it means right now
    var now = "";
    if (st.rule && App.Tz && App.Tz.brokerOffsetAtUtc) {
      now = (st.label || "") + " \u00b7 now UTC" + hrs(App.Tz.brokerOffsetAtUtc(Date.now() / 1000) / 60);
    } else if (mode === "auto") now = "not detected yet";
    $("tzb-now").textContent = now;
    // status line
    if (!tzBusy) {
      if (mode !== "auto") tzStatus("");
      else if (st.stale) tzStatus("The broker clock no longer matches the saved rule. Press Detect to measure it again.", true);
      else if (det && det.message) tzStatus(det.message, !det.decided && !st.rule);
      else tzStatus("Not detected yet. Until then the chart shows broker time. Pick a forex symbol and press Detect, or choose a rule.");
    }
    renderReport(mode === "auto" ? tzRep : null);   // v123: table only for this session's run
    $("tzb-detect").disabled = tzBusy;
  }

  // v123: themed dropdown; only forex pairs against USD (EURUSD first), no gold/oil/indices.
  function setSym(v) { $("tzb-sym").value = v || ""; $("tzb-sym-label").textContent = v || "-"; }
  function closeSymDd() { $("tzb-symdd").classList.remove("open"); }
  function renderSymList(list) {
    var box = $("tzb-sym-list"); box.innerHTML = "";
    list.forEach(function (n) {
      var row = document.createElement("div"); row.className = "canvas-preset-dropdown-item";
      var b = document.createElement("button"); b.type = "button"; b.className = "canvas-preset-dropdown-item-name"; b.textContent = n;
      b.addEventListener("click", function (e) { e.stopPropagation(); setSym(n); closeSymDd(); });
      row.appendChild(b); box.appendChild(row);
    });
  }
  function fillSymbols() {
    var a = api();
    if (!a || !a.get_symbols) return;
    a.get_symbols().then(function (r) {
      var all = ((r && r.symbols) || []).map(function (x) { return x && x.symbol; }).filter(Boolean);
      var list = all.filter(function (n) { return FX_RE.test(n) && /USD/i.test(n.slice(0, 6)); });
      list.sort(function (x, y) {
        var ex = /^EURUSD/i.test(x) ? 0 : 1, ey = /^EURUSD/i.test(y) ? 0 : 1;
        return ex - ey || (x < y ? -1 : x > y ? 1 : 0);
      });
      renderSymList(list);
      if (list.length && list.indexOf($("tzb-sym").value) < 0) setSym(list[0]);
    }).catch(function () { /* list stays empty */ });
  }

  function sendMode() {
    var a = api();
    if (!a || !a.set_tz_mode) return;
    var fx = num($("tzb-fixed")), sh = num($("tzb-shift"));
    var params = { ref: $("tzb-ref").value };
    if (fx !== null) params.fixed_hours = fx;
    if (sh !== null) params.shift_hours = sh;
    a.set_tz_mode($("tzb-mode").value, params).then(function (st) { App.Tz.applyState(st); }).catch(function () {});
  }
  function sendModeSoon() { clearTimeout(tzSaveTimer); tzSaveTimer = setTimeout(sendMode, 300); }

  function busyGuard() {   // v123: never leave Detect locked if no result arrives
    clearTimeout(tzBusyTimer);
    tzBusyTimer = setTimeout(function () { tzBusy = false; $("tzb-detect").disabled = false; tzStatus("Detection did not finish. Press Detect to try again.", true); }, 120000);
  }
  function startDetect() {
    var a = api(), sym = $("tzb-sym").value.trim();
    if (!a || !a.start_tz_detect) { tzStatus("Detection needs the desktop app.", true); return; }
    if (!sym) { tzStatus("Pick a forex symbol from your broker's list first.", true); return; }
    tzBusy = true; tzRep = null; $("tzb-detect").disabled = true; $("tzb-report").innerHTML = "";
    busyGuard();
    tzStatus("Starting...");
    a.start_tz_detect(sym, false).then(function (r) {
      if (r && r.ok === false) { tzBusy = false; clearTimeout(tzBusyTimer); tzStatus(r.error || "Could not start detection.", true); $("tzb-detect").disabled = false; }
    }).catch(function () { tzBusy = false; tzStatus("Could not start detection.", true); $("tzb-detect").disabled = false; });
  }

  function wireTz() {
    if (!$("tzb-mode")) return;
    $("tzb-mode").addEventListener("change", function () { sendMode(); });
    $("tzb-ref").addEventListener("change", sendMode);
    ["tzb-fixed", "tzb-shift"].forEach(function (id) {
      var el = $(id);
      el.addEventListener("keydown", function (e) { e.stopPropagation(); });
      el.addEventListener("input", function () {
        var v = num(el), lim = id === "tzb-fixed" ? [-12, 14] : [-24, 24];
        var ok = v !== null && v >= lim[0] && v <= lim[1];
        el.classList.toggle("sess-invalid", !ok);
        if (ok) sendModeSoon();
      });
    });
    $("tzb-sym-btn").addEventListener("click", function (e) { e.stopPropagation(); $("tzb-symdd").classList.toggle("open"); });
    document.addEventListener("click", closeSymDd);
    $("tzb-detect").addEventListener("click", startDetect);
    document.addEventListener("App:tzState", function (e) { tzSt = e.detail || tzSt; paintTz(); paintLocalTz(); });
    document.addEventListener("App:tzDetectStatus", function (e) {
      var d = e.detail || {};
      tzBusy = true; $("tzb-detect").disabled = true; busyGuard();
      tzStatus("Detecting broker clock" + (d.total ? " (" + Math.min(d.done + 1, d.total) + "/" + d.total + ")" : "") + (d.text ? " - " + d.text : ""));
    });
    document.addEventListener("App:tzDetectResult", function (e) {
      var r = e.detail || {};
      tzBusy = false; clearTimeout(tzBusyTimer); $("tzb-detect").disabled = false;
      tzRep = r;
      paintTz();
      tzStatus((r.message || (r.decided ? "Detected." : "No result.")) +
        (!r.decided && tzSt && tzSt.rule ? " The saved rule is unchanged." : ""), !r.decided);
    });
    fillSymbols();
    paintTz();
  }

  // Defaults visible right away; saved state replaces them once loaded.
  wireTz();
  renderRows(); renderPresetList(); publish(); paintLocalTz();
  if (window.pywebview && window.pywebview.api) load();
  else window.addEventListener("pywebviewready", load);

  App.SessionsSettings = { activate: function () { fillSymbols(); paintTz(); }, deactivate: function () { closeDropdown(); closeSymDd(); closeSaveBox(); } };
})();
