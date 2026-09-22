// =============================================================================
// style-defaults.js — v36 Fix 1/2: per-object-type "current default style"
// (whatever the user last set in the style editor becomes the style newly
// drawn objects of that type start with) and user-saved named presets that
// can be re-applied to any existing object of that type from the style
// editor.
// v37: now persisted to <project root>/output/style_settings/style_settings.json
// (via ChartBridge.get_style_settings/save_style_settings — see
// src/style_store.py), the same way drawn objects are (drawing-persistence.js),
// instead of only living in the browser's localStorage — so a chosen default
// style or saved preset survives across runs of the app, not just across
// symbols within one run. localStorage is kept only as a dev-mode fallback
// for whenever this file is opened outside pywebview (no window.pywebview.api
// available), so the style editor still works (just without on-disk
// persistence) in that case.
//
// Every public function below (getDefaultStyle/setDefaultStyle/listPresets/
// getPreset/savePreset/deletePreset) stays perfectly synchronous — callers
// throughout drawing-engine.js/drawing-context-menu.js are unchanged — by
// reading/writing an in-memory cache that App.StyleDefaults.load() (called
// once at boot, from main.js) populates from disk, and every mutation
// schedules a debounced write back to disk, mirroring
// drawing-persistence.js's load()/scheduleSave() pattern exactly.
//
// Kept intentionally independent of drawing-engine.js's object shape: this
// module only ever hands out/accepts plain {borderColor, borderWidth,
// borderStyle, fillColor, fillOpacity, middleLine} style objects, always as
// fresh deep copies, so nothing here can end up aliased with a live
// App.drawObjects entry's `.style`.

(function () {
  "use strict";

  var App = window.App;

  var LOCAL_DEFAULTS_KEY = "mt5te.styleDefaults.v1";
  var LOCAL_PRESETS_KEY = "mt5te.stylePresets.v1";
  var VALID_TYPES = ["hline", "vline", "trend", "rect", "fib", "fibext"];
  var VALID_BORDER_STYLES = ["solid", "dashed", "dotted"];
  var VALID_LINE_STYLES = ["solid", "dashed", "dotted"];

  // v47: Fib Retracement default level rows — level 0/1 are the two
  // anchor points the user actually clicks (see drawing-engine.js) and are
  // never removable; 0.5/2/3 are the update's spec'd extra default levels,
  // each positioned proportionally to the 0->1 span (see fibLevelPrice()
  // in drawing-engine.js).
  function factoryFibLevels() {
    return [
      { id: 1, level: 0, description: "Stoploss" },
      { id: 2, level: 1, description: "Entry" },
      { id: 3, level: 0.5, description: "Middle" },
      { id: 4, level: 2, description: "TP1" },
      { id: 5, level: 3, description: "TP2" },
    ];
  }

  // v53: Fib Expansion default level rows — level 0 ("E2", the object's
  // own 3rd click) and level 1 ("C2", the point extended from it by the
  // 1st->2nd click span) are the only two rows shipped by default; both
  // are the anchor rows and are never removable (see isProtectedFibRow in
  // drawing-context-menu.js) — same protection rule as Fib Retracement's
  // own level 0/1, just with different default descriptions.
  function factoryFibExtLevels() {
    return [
      { id: 1, level: 0, description: "E2" },
      { id: 2, level: 1, description: "C2" },
    ];
  }
  var SAVE_DEBOUNCE_MS = 400;

  // In-memory cache, populated by load() (see main.js's boot()) from the
  // on-disk store. Every getter below reads from these — never straight
  // from disk — so the public API can stay synchronous even though loading
  // and saving are both async pywebview calls.
  var defaultsCache = {};       // { type: rawStyle }
  var presetsCache = null;      // { hline: [...], vline: [...], trend: [...], rect: [...] }

  var saveTimer = null;
  var saveInFlight = false;
  var saveAgainAfterInFlight = false;

  // The style every type starts with before the user has ever changed
  // anything (first run, or nothing loaded yet).
  function factoryDefault(type) {
    var base = {
      borderColor: "#c9a227",
      borderWidth: 2,
      borderStyle: "solid",
      // v38 Fix 1: border now carries its own opacity too (applied via
      // hexToRgba the same way fillOpacity already was), so the themed
      // color+opacity picker has something to control for every color it
      // opens on, not just Fill.
      borderOpacity: 100,
      fillColor: "#c9a227",
      fillOpacity: type === "rect" ? 18 : 0,
    };
    // v36 Fix 4: Middle Line only means anything for a rectangle, but it's
    // still part of "rect"'s style object (not bolted on separately) so it
    // rides along through clone/save/preset/default handling for free.
    if (type === "rect") {
      base.middleLine = { enabled: false, style: "dashed", color: "#c9a227", width: 1, opacity: 100 };
    }
    if (type === "fib") {
      base.fillOpacity = 0;
      base.levels = factoryFibLevels();
      base.showDescription = false;
    }
    if (type === "fibext") {
      base.fillOpacity = 0;
      base.levels = factoryFibExtLevels();
      base.showDescription = false;
    }
    return base;
  }

  // v47: sanitizes a raw levels array for the fib tool — always keeps the
  // 0 and 1 anchor rows (id 1/2, level fixed) even if a corrupt/older save
  // dropped them, drops anything without a finite level number, and hands
  // out fresh ids for rows that came in without one.
  // v53: `type` picks which fallback descriptions are re-inserted for a
  // missing/corrupt anchor row — Fib Retracement's "Stoploss"/"Entry" vs
  // Fib Expansion's "E2"/"C2" — everything else about the sanitize logic
  // (drop non-finite levels, hand out fresh ids) is shared between them.
  function sanitizeFibLevels(raw, type) {
    var list = Array.isArray(raw) ? raw : [];
    var maxId = 0;
    var out = list.map(function (r) {
      var level = Number(r && r.level);
      if (!Number.isFinite(level)) return null;
      var id = Number(r && r.id);
      if (!Number.isFinite(id) || id <= 0) id = 0;
      if (id > maxId) maxId = id;
      return { id: id, level: level, description: (r && typeof r.description === "string") ? r.description : "" };
    }).filter(Boolean);
    out.forEach(function (r) { if (r.id === 0) r.id = ++maxId; });
    var has0 = out.some(function (r) { return r.level === 0; });
    var has1 = out.some(function (r) { return r.level === 1; });
    var desc0 = type === "fibext" ? "E2" : "Stoploss";
    var desc1 = type === "fibext" ? "C2" : "Entry";
    if (!has1) out.unshift({ id: ++maxId, level: 1, description: desc1 });
    if (!has0) out.unshift({ id: ++maxId, level: 0, description: desc0 });
    return out;
  }

  function sanitizeMiddleLine(raw) {
    var ml = raw && typeof raw === "object" ? raw : {};
    return {
      enabled: !!ml.enabled,
      style: VALID_LINE_STYLES.indexOf(ml.style) !== -1 ? ml.style : "dashed",
      color: typeof ml.color === "string" && ml.color ? ml.color : "#c9a227",
      width: Number.isFinite(Number(ml.width)) && Number(ml.width) >= 0 ? Number(ml.width) : 1,
      // v38 Fix 1: defaults to fully opaque so a file saved before this
      // field existed renders exactly as it did before.
      opacity: Number.isFinite(Number(ml.opacity)) ? Number(ml.opacity) : 100,
    };
  }

  // Merges a possibly-partial/older-shaped raw style object onto this
  // type's factory default, so a style saved before a field existed (e.g.
  // borderStyle/middleLine, added in v36) still comes back complete rather
  // than undefined.
  function sanitizeStyle(type, raw) {
    var d = factoryDefault(type);
    var s = raw && typeof raw === "object" ? raw : {};
    var out = {
      borderColor: typeof s.borderColor === "string" && s.borderColor ? s.borderColor : d.borderColor,
      borderWidth: Number.isFinite(Number(s.borderWidth)) && Number(s.borderWidth) >= 0 ? Number(s.borderWidth) : d.borderWidth,
      borderStyle: VALID_BORDER_STYLES.indexOf(s.borderStyle) !== -1 ? s.borderStyle : d.borderStyle,
      borderOpacity: Number.isFinite(Number(s.borderOpacity)) ? Number(s.borderOpacity) : d.borderOpacity,
      fillColor: typeof s.fillColor === "string" && s.fillColor ? s.fillColor : d.fillColor,
      fillOpacity: Number.isFinite(Number(s.fillOpacity)) ? Number(s.fillOpacity) : d.fillOpacity,
    };
    if (type === "rect") out.middleLine = sanitizeMiddleLine(s.middleLine || d.middleLine);
    if (type === "fib" || type === "fibext") {
      out.levels = sanitizeFibLevels(s.levels && s.levels.length ? s.levels : d.levels, type);
      out.showDescription = !!s.showDescription;
    }
    return out;
  }

  function deepCopyStyle(style) { return JSON.parse(JSON.stringify(style)); }

  function emptyPresetsAll() {
    var all = {};
    VALID_TYPES.forEach(function (t) { all[t] = []; });
    return all;
  }

  function normalizePresetsCache() {
    if (!presetsCache || typeof presetsCache !== "object") presetsCache = {};
    VALID_TYPES.forEach(function (t) {
      if (!Array.isArray(presetsCache[t])) presetsCache[t] = [];
    });
  }

  // ---- dev-mode fallback (no window.pywebview.api available) ------------
  function readLocalJson(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function writeLocalJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // best-effort only
    }
  }

  // ---- v37: load from / save to <project root>/output/style_settings/ ---
  // Mirrors drawing-persistence.js's load()/scheduleSave() exactly.
  function load() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.get_style_settings) {
      // Dev fallback: no Python bridge available (e.g. opened directly in
      // a browser) — fall back to localStorage so the editor still works.
      defaultsCache = readLocalJson(LOCAL_DEFAULTS_KEY) || {};
      presetsCache = readLocalJson(LOCAL_PRESETS_KEY) || emptyPresetsAll();
      normalizePresetsCache();
      return Promise.resolve();
    }
    return window.pywebview.api.get_style_settings().then(function (data) {
      defaultsCache = (data && typeof data.defaults === "object" && data.defaults) || {};
      presetsCache = (data && typeof data.presets === "object" && data.presets) || emptyPresetsAll();
      normalizePresetsCache();
    }).catch(function (err) {
      console.error("Loading saved style settings failed:", err);
      defaultsCache = {};
      presetsCache = emptyPresetsAll();
    });
  }

  function doSave() {
    normalizePresetsCache();
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.save_style_settings) {
      writeLocalJson(LOCAL_DEFAULTS_KEY, defaultsCache);
      writeLocalJson(LOCAL_PRESETS_KEY, presetsCache);
      return;
    }
    saveInFlight = true;
    window.pywebview.api.save_style_settings({ defaults: defaultsCache, presets: presetsCache })
      .catch(function (err) {
        console.error("Saving style settings failed:", err);
      }).then(function () {
        saveInFlight = false;
        // A change that arrived while the previous save was still in
        // flight isn't lost — remember to run once more right after.
        if (saveAgainAfterInFlight) {
          saveAgainAfterInFlight = false;
          scheduleSave();
        }
      });
  }

  function scheduleSave() {
    if (saveInFlight) { saveAgainAfterInFlight = true; return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
  }

  // Best-effort only, same caveat as drawing-persistence.js's flushNow().
  function flushNow() {
    clearTimeout(saveTimer);
    doSave();
  }
  window.addEventListener("beforeunload", flushNow);

  // ---- Per-type default style ------------------------------------------
  // v36 Fix 1: getDefaultStyle(type) is what defaultStyle() in
  // drawing-engine.js calls instead of a hard-coded literal, so every
  // freshly drawn object of a type picks up whatever was last set.
  function getDefaultStyle(type) {
    return sanitizeStyle(type, defaultsCache ? defaultsCache[type] : undefined);
  }

  // Called whenever the user edits ANY style field of an existing object in
  // the style editor — from then on, newly drawn objects of that same type
  // start out with this exact style, until the user changes it again.
  function setDefaultStyle(type, style) {
    if (VALID_TYPES.indexOf(type) === -1) return;
    if (!defaultsCache) defaultsCache = {};
    defaultsCache[type] = sanitizeStyle(type, style);
    scheduleSave();
  }

  // ---- Named presets ------------------------------------------------------
  // v36 Fix 2: { hline: [{id,name,style}], vline: [...], trend: [...],
  // rect: [...] }. A preset never carries a live reference to any object's
  // style — savePreset() always stores a deep copy, and getPreset()/
  // listPresets() always hand back deep copies too.
  function nextPresetIdFor(all) {
    var max = 0;
    VALID_TYPES.forEach(function (t) {
      (all[t] || []).forEach(function (p) {
        var id = Number(p && p.id);
        if (Number.isFinite(id) && id > max) max = id;
      });
    });
    return max + 1;
  }

  function listPresets(type) {
    if (VALID_TYPES.indexOf(type) === -1 || !presetsCache) return [];
    return (presetsCache[type] || []).map(function (p) {
      return { id: p.id, name: p.name, style: sanitizeStyle(type, p.style) };
    });
  }

  function getPreset(type, id) {
    var found = listPresets(type).filter(function (p) { return p.id === id; })[0];
    return found ? deepCopyStyle(found.style) : null;
  }

  function savePreset(type, name, style) {
    if (VALID_TYPES.indexOf(type) === -1) return null;
    var cleanName = (name || "").trim();
    if (!cleanName) return null;
    normalizePresetsCache();
    var id = nextPresetIdFor(presetsCache);
    presetsCache[type].push({ id: id, name: cleanName, style: sanitizeStyle(type, style) });
    scheduleSave();
    return id;
  }

  function deletePreset(type, id) {
    if (VALID_TYPES.indexOf(type) === -1 || !presetsCache) return;
    presetsCache[type] = (presetsCache[type] || []).filter(function (p) { return p.id !== id; });
    scheduleSave();
  }

  App.StyleDefaults = {
    load: load,
    flushNow: flushNow,
    factoryDefault: factoryDefault,
    sanitizeStyle: sanitizeStyle,
    getDefaultStyle: getDefaultStyle,
    setDefaultStyle: setDefaultStyle,
    listPresets: listPresets,
    getPreset: getPreset,
    savePreset: savePreset,
    deletePreset: deletePreset,
  };
})();
