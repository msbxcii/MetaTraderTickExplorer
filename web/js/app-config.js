// =============================================================================
// app-config.js — v67.3: the Setting panel's Configuration tab. Only
// user-facing settings are exposed here; advanced runtime parameters remain
// internal in src/config.py. Each exposed field is grouped into a small
// logical section and has an inline hover description.
// icon (what the variable does + what raising/lowering it changes) and a
// "Restore to Default" button that puts every field back to config.py's
// original hardcoded values.
//
// FIELDS below is this tab's only source of truth for which variables
// exist, their type/unit, and their title/description — src/config.py and
// src/config_store.py stay completely agnostic of what any of these keys
// mean (same "kept dumb" convention style-defaults.js/canvas-settings.js/
// keyboard-shortcuts.js already follow for their own tabs).
//
// v52 Update 2: each field's description used to live behind a small "i"
// icon + floating popover next to its title — too easy for the popover
// to run past the panel edge / overlap other text (see bug report), and
// a whole extra icon per row wasn't minimal. Replaced with a single
// FIXED description box docked to the right of the field list; hovering
// (or focusing) anywhere across a row — title, input, or unit, the row's
// full width — swaps that box's text. The box never moves, so nothing it
// shows can ever overlap another row. The width this took was recovered
// by narrowing the input fields, which didn't need to be as wide as they
// were.
//
// Persistence mirrors the Canvas/Keyboard-Shortcuts tabs exactly: saved
// (debounced) via ChartBridge.get_app_config/save_app_config to
// <project root>/output/app_config/app_config.json when running inside
// pywebview, plain localStorage as a dev-mode fallback otherwise.
//
// IMPORTANT (also stated in the tab's own intro line): a saved change
// takes effect starting with the app's NEXT launch, not this already-
// running instance — config.py applies saved overrides once, at import
// time, before anything else in the app has read the old hardcoded
// values.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  var body = document.getElementById("appcfg-body");
  if (!body) return;

  var LOCAL_KEY = "v52-app-config-overrides";
  var SAVE_DEBOUNCE_MS = 500;

  // v56.6 Update 2: minimal folder/browse icon for the MT5 Terminal Path
  // row — no fixed fill color baked in (that's stripped from the source
  // asset), so it inherits `currentColor` and follows the app's own
  // theme/hover colors exactly like every other icon button in the app
  // (see .appcfg-browse-btn below).
  var BROWSE_ICON_SVG =
    '<svg viewBox="0 0 122.88 98.15" xmlns="http://www.w3.org/2000/svg">' +
    '<path fill="currentColor" d="M6.02,0h33.66L50.8,12.3h66.46c3.1,0,5.63,2.55,5.63,5.63V92.5c0,3.1-2.53,5.64-5.63,5.64l-110.59,0' +
    'C3.56,98.15,0,95.6,0,92.5V6.02C0,2.72,2.72,0,6.02,0L6.02,0z M111.83,27.42c0-2.98-2.46-5.42-5.43-5.42H17.46' +
    'c-2.96,0-6.41,2.44-6.41,5.42v53.8c0,3,3.45,5.43,6.41,5.43h88.95c2.97,0,5.43-2.44,5.43-5.43V27.42L111.83,27.42z"/>' +
    '</svg>';

  // ---- Field metadata -------------------------------------------------------
  // type: "text" | "int" | "float" | "intlist" | "bool" (comma-separated integers for intlist,
  // used only by CHART_TIMEFRAMES_SECONDS). `step` only applies to
  // int/float inputs.
  var SECTIONS = [
    {
      title: "Data",
      fields: [
        {
          key: "HISTORY_BACKFILL_MAX_DAYS", type: "int", step: "1", unit: "days",
          title: "Max Prefill Days",
          description: "Maximum number of broker days downloaded automatically during initial setup. Increase for more history, decrease for a faster first launch."
        }
      ],
    },
    {
      title: "Logging",
      fields: [
        {
          key: "LOG_TO_DISK", type: "bool",
          title: "Save Logs to Disk",
          description: "When enabled, non-DATABASE logs are appended to the daily log file. DATABASE logs stay available in the CMD window and all in-app log views but are kept out of the disk file to avoid unnecessary log-file growth. This setting applies on the next launch."
        }
      ],
    },
  ];

  var FIELD_BY_KEY = {};
  SECTIONS.forEach(function (s) {
    s.fields.forEach(function (f) { FIELD_BY_KEY[f.key] = f; });
  });

  var defaults = {};   // configKey -> original hardcoded value (from config.py)
  var current = {};    // configKey -> value currently shown in the fields
  var saveTimer = null;
  var loaded = false;

  // ---- Local persistence fallback (dev mode, no pywebview) -----------------
  function readLocalJson(key) {
    try { return JSON.parse(window.localStorage.getItem(key) || "null"); } catch (e) { return null; }
  }
  function writeLocalJson(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* best-effort */ }
  }

  function hasBridge(fn) {
    return !!(window.pywebview && window.pywebview.api && window.pywebview.api[fn]);
  }

  function doSave() {
    if (hasBridge("save_app_config")) {
      window.pywebview.api.save_app_config(current).catch(function (err) {
        console.warn("save_app_config failed:", err);
      });
    } else {
      writeLocalJson(LOCAL_KEY, current);
    }
    showSavedNote();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; doSave(); }, SAVE_DEBOUNCE_MS);
  }

  function showSavedNote() {
    var note = document.getElementById("appcfg-saved-note");
    if (!note) return;
    note.textContent = "Saved — applies on next launch";
    note.classList.add("visible");
    clearTimeout(showSavedNote._t);
    showSavedNote._t = setTimeout(function () { note.classList.remove("visible"); }, 2200);
  }

  function load() {
    if (hasBridge("get_app_config")) {
      return window.pywebview.api.get_app_config().then(function (data) {
        applyLoaded(data);
      }).catch(function (err) {
        console.warn("get_app_config failed:", err);
        applyLoaded(null);
      });
    }
    var local = readLocalJson(LOCAL_KEY);
    applyLoaded({ defaults: buildFallbackDefaults(), current: local || buildFallbackDefaults() });
    return Promise.resolve();
  }

  // Only used outside pywebview (dev mode) where config.py's real
  // hardcoded values aren't reachable — best-effort placeholders so the
  // tab still renders something sensible.
  function buildFallbackDefaults() {
    var d = {};
    Object.keys(FIELD_BY_KEY).forEach(function (k) {
      var type = FIELD_BY_KEY[k].type;
      d[k] = type === "intlist" ? [] : (type === "bool" ? false : "");
    });
    return d;
  }

  function applyLoaded(data) {
    data = data || {};
    defaults = (data.defaults && typeof data.defaults === "object") ? data.defaults : {};
    current = (data.current && typeof data.current === "object") ? data.current : {};
    // Any field this tab knows about but the backend didn't send (e.g. an
    // older saved file) just falls back to its own default.
    Object.keys(FIELD_BY_KEY).forEach(function (k) {
      if (!(k in current)) current[k] = defaults[k];
    });
    loaded = true;
    renderAll();
  }

  // ---- Value <-> input string conversion ------------------------------------
  function valueToInputString(field, value) {
    if (field.type === "intlist") {
      return Array.isArray(value) ? value.join(", ") : "";
    }
    if (value === undefined || value === null) return "";
    return String(value);
  }

  function parseInputString(field, raw) {
    if (field.type === "int") {
      var n = parseInt(raw, 10);
      return isNaN(n) ? null : n;
    }
    if (field.type === "float") {
      var f = parseFloat(raw);
      return isNaN(f) ? null : f;
    }
    if (field.type === "intlist") {
      var parts = String(raw).split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
      var nums = [];
      for (var i = 0; i < parts.length; i++) {
        var v = parseInt(parts[i], 10);
        if (isNaN(v)) return null;
        nums.push(v);
      }
      return nums;
    }
    return raw; // text
  }

  // ---- Rendering -------------------------------------------------------------
  function renderAll() {
    body.innerHTML = "";
    SECTIONS.forEach(function (section) {
      var visibleFields = section.fields.filter(function (f) { return f.key in defaults || f.key in current; });
      if (!visibleFields.length) return;

      var sectionEl = document.createElement("div");
      sectionEl.className = "appcfg-section";

      var titleEl = document.createElement("div");
      titleEl.className = "appcfg-section-title";
      titleEl.textContent = section.title;
      sectionEl.appendChild(titleEl);

      visibleFields.forEach(function (field) {
        sectionEl.appendChild(renderRow(field));
      });

      body.appendChild(sectionEl);
    });
  }

  function renderRow(field) {
    var row = document.createElement("div");
    row.className = "appcfg-row";

    // Boolean settings intentionally use the exact checkbox pattern already
    // used by the Canvas tab. Keep the native checkbox so behavior, keyboard
    // input and accessibility remain unchanged, but reuse Canvas styling and
    // place the checkbox before the label text.
    var input = document.createElement("input");
    input.dataset.key = field.key;

    if (field.type === "bool") {
      var boolLabel = document.createElement("label");
      boolLabel.className = "canvas-grid-checkbox-label";

      input.type = "checkbox";
      input.checked = !!current[field.key];

      var boolText = document.createElement("span");
      boolText.textContent = field.title;

      boolLabel.appendChild(input);
      boolLabel.appendChild(boolText);
      row.appendChild(boolLabel);

      input.addEventListener("change", function () {
        current[field.key] = !!input.checked;
        scheduleSave();
      });
    } else {
      var labelWrap = document.createElement("div");
      labelWrap.className = "appcfg-label-wrap";

      var label = document.createElement("span");
      label.className = "appcfg-label";
      label.textContent = field.title;
      labelWrap.appendChild(label);
      row.appendChild(labelWrap);

      input.type = "text";
      input.className = "appcfg-input";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.value = valueToInputString(field, current[field.key]);

      input.addEventListener("input", function () {
        var parsed = parseInputString(field, input.value);
        if (parsed === null) {
          input.classList.add("appcfg-input-invalid");
          return; // don't persist an unparsable value
        }
        input.classList.remove("appcfg-input-invalid");
        current[field.key] = parsed;
        scheduleSave();
      });

      row.appendChild(input);
    }

    // v56.6 Update 2: minimal native-folder-dialog browse button, only for
    // fields that opt in (currently just MT5 Terminal Path). Sits right
    // after the input, matching how "browse for a path" controls are
    // placed in most desktop apps. The dialog itself is opened by pywebview
    // on the Python side (ChartBridge.browse_mt5_terminal_path()) — this
    // just wires the button to it and writes the chosen path back into the
    // same input/current[] value the user typing it by hand would produce,
    // so it goes through the exact same parse/validate/save path below.
    if (field.browse) {
      var browseBtn = document.createElement("button");
      browseBtn.type = "button";
      browseBtn.className = "appcfg-browse-btn";
      browseBtn.title = "Browse…";
      browseBtn.setAttribute("aria-label", "Browse for " + field.title);
      browseBtn.innerHTML = BROWSE_ICON_SVG;
      browseBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!hasBridge("browse_mt5_terminal_path")) return;
        window.pywebview.api.browse_mt5_terminal_path().then(function (path) {
          if (!path) return; // dialog cancelled
          input.value = path;
          var parsed = parseInputString(field, path);
          if (parsed === null) {
            input.classList.add("appcfg-input-invalid");
            return;
          }
          input.classList.remove("appcfg-input-invalid");
          current[field.key] = parsed;
          scheduleSave();
        });
      });
      row.appendChild(browseBtn);
    }

    if (field.unit) {
      var unit = document.createElement("span");
      unit.className = "appcfg-unit";
      unit.textContent = field.unit;
      row.appendChild(unit);
    }

    // v52 Update 2: the whole row (title, input, unit — its full width,
    // per spec) drives the fixed description panel on the right, instead
    // of a separate per-title "i" icon + floating popover.
    row.addEventListener("mouseenter", function () { showDescription(field); });
    row.addEventListener("mouseleave", function () { clearDescription(); });
    input.addEventListener("focus", function () { showDescription(field); });

    return row;
  }

  // ---- Fixed description panel ----------------------------------------------
  var descPanel = document.getElementById("appcfg-desc-panel");
  var descTitle = document.getElementById("appcfg-desc-title");
  var descText = document.getElementById("appcfg-desc-text");

  function showDescription(field) {
    if (!descPanel) return;
    descPanel.classList.add("has-selection");
    if (descTitle) descTitle.textContent = field.title;
    if (descText) descText.textContent = field.description || "";
  }

  function clearDescription() {
    if (!descPanel) return;
    descPanel.classList.remove("has-selection");
    if (descTitle) descTitle.textContent = "";
    if (descText) descText.textContent = "";
  }

  // ---- Restore to Default ----------------------------------------------------
  var resetBtn = document.getElementById("appcfg-reset-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      if (hasBridge("restore_app_config_defaults")) {
        window.pywebview.api.restore_app_config_defaults().then(function (defs) {
          defaults = (defs && typeof defs === "object") ? defs : defaults;
          current = {};
          Object.keys(FIELD_BY_KEY).forEach(function (k) { current[k] = defaults[k]; });
          renderAll();
          showSavedNote();
        }).catch(function (err) { console.warn("restore_app_config_defaults failed:", err); });
      } else {
        current = {};
        Object.keys(FIELD_BY_KEY).forEach(function (k) { current[k] = defaults[k]; });
        writeLocalJson(LOCAL_KEY, current);
        renderAll();
        showSavedNote();
      }
    });
  }

  function activate() {
    if (!loaded) load();
  }
  function deactivate() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; doSave(); }
  }

  App.AppConfig = { activate: activate, deactivate: deactivate };
})();
