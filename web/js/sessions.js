// sessions.js — v93: Setting > Sessions & Timezone tab.
// State: { localTz, sessions:[{name,start,end,color,opacity,on}] } + named
// presets, persisted via ChartBridge.get/save_sessions_settings. Painting is
// done by drawing-engine.js (under the candles) from App.sessions.
(function () {
  "use strict";
  var App = window.App;
  var $ = function (id) { return document.getElementById(id); };

  // v94: built-in presets (shown first in the dropdown, never deletable/renamable).
  function mk(name, start, end) { return { name: name, start: start, end: end, color: "#848484", opacity: 10, on: false }; }
  var DST_SESSIONS = [
    mk("NewYork Forex (DST)", "15:30", "23:30"),
    mk("LSE - London Stock Exchange (DST)", "10:30", "19:00"),
    mk("NYSE - NewYork Stock Exchange (DST)", "17:00", "23:30"),
  ];
  var STD_SESSIONS = [
    mk("NewYork Forex", "16:30", "00:30"),
    mk("LSE - London Stock Exchange", "11:30", "20:00"),
    mk("NYSE - NewYork Stock Exchange", "18:00", "00:30"),
  ];
  var BUILTIN = [
    { id: "__sess_dst__", name: "Default Daylight Saving Time", sessions: DST_SESSIONS },
    { id: "__sess_std__", name: "Default Standard Time", sessions: STD_SESSIONS },
  ];
  var DEFAULT_SESSIONS = DST_SESSIONS;
  var LOCAL_KEY = "mtte.sessions.v93";
  var state = { localTz: true, sessions: clone(DEFAULT_SESSIONS) };
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
      return { name: s.name || "", s: a, e: b, color: s.color, opacity: Number(s.opacity) || 0 };
    }).filter(Boolean);
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

  function changed() { currentPresetLabel = "-"; paintPresetLabel(); publish(); persist(); }

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

      var sw = document.createElement("button");
      App.ColorField.attach(sw, { value: s.color, initialOpacity: s.opacity });
      sw.addEventListener("input", function () { s.color = sw.value; s.opacity = sw.opacity; publish(); });
      sw.addEventListener("change", function () { s.color = sw.value; s.opacity = sw.opacity; changed(); });

      var del = document.createElement("button");
      del.type = "button"; del.className = "canvas-preset-dropdown-item-trash"; del.title = "Delete session";
      del.innerHTML = App.Icons.trash();
      del.addEventListener("click", function () { state.sessions.splice(i, 1); renderRows(); changed(); });

      [on, name, start, end, sw, del].forEach(function (el) { row.appendChild(el); });
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
    var p = editingPresetId && presets.filter(function (x) { return x.id === editingPresetId; })[0];
    if (p) { p.name = name; p.sessions = clone(state.sessions); }
    else presets.push({ id: "s" + Date.now().toString(36), name: name, sessions: clone(state.sessions) });
    currentPresetLabel = name; paintPresetLabel();
    closeSaveBox(); renderPresetList(); persist();
  }

  // ---- load / wire ------------------------------------------------------
  function applyLoaded(data) {
    var s = data && data.settings;
    if (s && typeof s === "object" && Array.isArray(s.sessions)) {
      state.localTz = s.localTz !== false;
      state.sessions = s.sessions;
      currentPresetLabel = "-";  // user's saved list (may differ from a built-in)
    }
    presets = (data && Array.isArray(data.presets)) ? data.presets : [];
    paintPresetLabel();
    $("sess-local-tz").checked = state.localTz;
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
    state.localTz = e.target.checked;
    if (App.Tz) App.Tz.setEnabled(state.localTz);  // instant
    persist();
  });
  $("sess-add").addEventListener("click", function () {
    state.sessions.push({ name: "Session " + (state.sessions.length + 1), start: "00:00", end: "08:00", color: "#3fb68b", opacity: 10, on: true });
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

  // Defaults visible right away; saved state replaces them once loaded.
  renderRows(); renderPresetList(); publish();
  if (window.pywebview && window.pywebview.api) load();
  else window.addEventListener("pywebviewready", load);

  App.SessionsSettings = { activate: function () {}, deactivate: function () { closeDropdown(); closeSaveBox(); } };
})();
