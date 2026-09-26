// =============================================================================
// drawing-persistence.js — v33: makes drawn chart objects (App.drawObjects)
// survive closing and reopening the app. v33.1: also persists Object Tree
// folders (App.objectFolders) and each object's name/folderId.
// =============================================================================
// Before this file existed, App.drawObjects lived purely in a JS variable
// (see the design note at the top of drawing-engine.js) — intentionally, at
// the time, since nothing needed it to outlive the window. This module adds
// the other half: on boot it asks the Python side (ChartBridge.get_drawings,
// backed by src/drawing_store.py) for whatever was last saved and
// repopulates App.drawObjects (and, v33.1, App.objectFolders) from it; after
// that, every mutation (create, move, resize, style/time edit, lock, hide,
// delete, rename, folder create/move/delete — see the `persistChange()`
// calls sprinkled through drawing-engine.js, drawing-context-menu.js,
// object-panel.js and keyboard-shortcuts.js) calls scheduleSave() here,
// which debounces a full re-save of both lists to disk.
//
// Deliberately dumb on the wire: this file doesn't know anything about
// object *semantics* beyond the shape drawing-engine.js already uses
// (type/points/style/locked/hidden/name/folderId) — it just strips
// transient/runtime-only fields (like the in-progress-drag `_preview` flag,
// which never applies to anything already in App.drawObjects anyway) before
// handing the arrays to Python, and reconstructs plain objects on load.

(function () {
  "use strict";

  var App = window.App;

  var SAVE_DEBOUNCE_MS = 400;
  var VALID_TYPES = ["hline", "vline", "trend", "rect", "fib", "fibext"];
  // v70.7 Update 1/2: the app's 9 fixed timeframe checkboxes, in seconds —
  // kept in lockstep with drawing-engine.js's own TF_SECONDS list.
  var TF_SECONDS_LIST = [1, 5, 15, 60, 300, 900, 3600, 14400, 86400];

  function sanitizeTimeframesMap(raw) {
    if (!raw || typeof raw !== "object") return undefined;
    var map = {};
    var any = false;
    TF_SECONDS_LIST.forEach(function (tf) {
      if (raw[tf] !== undefined) { map[tf] = !!raw[tf]; any = true; }
    });
    return any ? map : undefined;
  }

  var saveTimer = null;
  var saveInFlight = false;
  var saveAgainAfterInFlight = false;

  function serializeObjects() {
    // v57 Update 13: objects drawn WHILE Bar Replay is active are explicitly
    // scratch - drawing-engine.js tags them `_replayTemp` and replay-bar.js
    // deletes them the moment Replay mode closes. They were still being
    // written to <symbol>.json on every debounced save in the meantime, so
    // closing the app (or a crash) mid-Replay left them behind permanently,
    // with no Replay session running any more to clean them up.
    return App.drawObjects.filter(function (obj) {
      return !obj._replayTemp;
    }).map(function (obj) {
      return {
        id: obj.id,
        type: obj.type,
        // hline points only ever carry `price` meaningfully (their
        // `logical` field is a leftover render-time placeholder, never
        // used — see drawing-engine.js objectPixels()); every other type
        // stores real {time, price}, per the v14/v21 fixes documented in
        // drawing-engine.js.
        points: obj.points.map(function (p) {
          return obj.type === "hline"
            ? { price: p.price }
            : { time: p.time, price: p.price };
        }),
        style: {
          borderColor: obj.style.borderColor,
          borderWidth: obj.style.borderWidth,
          // v36 Fix 3: border line type (solid/dashed/dotted).
          borderStyle: obj.style.borderStyle || "solid",
          // v38 Fix 1: border opacity, set from the themed color picker.
          borderOpacity: Number.isFinite(Number(obj.style.borderOpacity)) ? Number(obj.style.borderOpacity) : 100,
          fillColor: obj.style.fillColor,
          fillOpacity: obj.style.fillOpacity,
          // v36 Fix 4: rectangle-only Middle Line settings. Omitted for
          // non-rect types the same way it's absent on their style objects.
          middleLine: obj.style.middleLine ? {
            enabled: !!obj.style.middleLine.enabled,
            style: obj.style.middleLine.style,
            color: obj.style.middleLine.color,
            width: obj.style.middleLine.width,
            // v38 Fix 1: middle line opacity.
            opacity: Number.isFinite(Number(obj.style.middleLine.opacity)) ? Number(obj.style.middleLine.opacity) : 100,
          } : undefined,
          // v47: Fib Retracement-only level table + description toggle.
          levels: obj.style.levels ? obj.style.levels.map(function (l) {
            return { id: l.id, level: l.level, description: l.description };
          }) : undefined,
          showDescription: obj.style.levels ? !!obj.style.showDescription : undefined,
        },
        locked: !!obj.locked,
        hidden: !!obj.hidden,
        // v33.1 Fix 3/4
        name: typeof obj.name === "string" ? obj.name : "",
        folderId: (obj.folderId === null || obj.folderId === undefined) ? null : Number(obj.folderId),
        // v70.7 Update 1/2: Timeframe Based Hidden/Show. Omitted entirely
        // when never touched (see ensureTimeframesMap()'s lazy creation in
        // drawing-engine.js) so an untouched object round-trips with no
        // extra bytes and still reads back as "visible everywhere".
        timeframes: obj.timeframes ? obj.timeframes : undefined,
        // v71 Update 1: Auto toggle state. Omitted when off (the common
        // case) for the same "no extra bytes for the default" reason as
        // timeframes above.
        autoTf: obj.autoTf ? true : undefined,
      };
    });
  }

  function serializeFolders() {
    return App.objectFolders.map(function (f) {
      return { id: f.id, name: typeof f.name === "string" ? f.name : "Folder" };
    });
  }

  var TYPE_LABELS = { hline: "Horizontal Line", vline: "Vertical Line", trend: "Trend Line", rect: "Rectangle", fib: "Fib Retracement", fibext: "Fib Expansion" };

  function deserializeFolders(list) {
    var maxId = 0;
    var folders = (Array.isArray(list) ? list : []).map(function (raw) {
      var id = Number(raw && raw.id);
      if (!Number.isFinite(id) || id <= 0) return null;
      if (id > maxId) maxId = id;
      return { id: id, name: (raw && typeof raw.name === "string" && raw.name) || "Folder" };
    }).filter(Boolean);
    return { folders: folders, maxId: maxId };
  }

  function deserializeObjects(list, validFolderIds) {
    var maxId = 0;
    var objects = (Array.isArray(list) ? list : []).map(function (raw) {
      var type = raw && raw.type;
      if (VALID_TYPES.indexOf(type) === -1) return null;
      var rawPoints = Array.isArray(raw.points) ? raw.points : [];
      var points = rawPoints.map(function (p) {
        return type === "hline"
          ? { logical: 0, price: Number(p && p.price) }
          : { time: Number(p && p.time), price: Number(p && p.price) };
      });
      // A malformed/truncated entry (missing points, non-finite numbers)
      // would only ever paint as invisible garbage — safer to drop it than
      // let a corrupt line into App.drawObjects (and then re-save it back
      // out, baking the corruption in permanently).
      // v53: Fib Expansion stores 3 points (its 3 clicks), not 2.
      var expectedPoints = (type === "hline" || type === "vline") ? 1 : (type === "fibext" ? 3 : 2);
      if (points.length < expectedPoints) return null;
      for (var i = 0; i < points.length; i++) {
        if (!Number.isFinite(points[i].price)) return null;
        if (type !== "hline" && !Number.isFinite(points[i].time)) return null;
      }
      var id = Number(raw.id);
      if (!Number.isFinite(id) || id <= 0) id = 0;
      if (id > maxId) maxId = id;
      var style = raw.style || {};
      // v33.1: a folderId that no longer matches any saved folder (e.g. the
      // folder itself was deleted in an older, buggier session) falls back
      // to top-level rather than pointing at nothing.
      var rawFolderId = raw && raw.folderId;
      var folderId = (rawFolderId !== null && rawFolderId !== undefined && validFolderIds.indexOf(Number(rawFolderId)) !== -1)
        ? Number(rawFolderId) : null;
      // v36: delegate to style-defaults.js's own sanitizer so a file saved
      // by an older version (missing borderStyle/middleLine entirely) and
      // a freshly-created style both come back in the exact same complete
      // shape.
      var sanitizedStyle = App.StyleDefaults
        ? App.StyleDefaults.sanitizeStyle(type, style)
        : {
            borderColor: typeof style.borderColor === "string" ? style.borderColor : "#c9a227",
            borderWidth: Number.isFinite(Number(style.borderWidth)) ? Number(style.borderWidth) : 2,
            borderStyle: "solid",
            borderOpacity: Number.isFinite(Number(style.borderOpacity)) ? Number(style.borderOpacity) : 100,
            fillColor: typeof style.fillColor === "string" ? style.fillColor : "#c9a227",
            fillOpacity: Number.isFinite(Number(style.fillOpacity)) ? Number(style.fillOpacity) : (type === "rect" ? 18 : 0),
          };
      return {
        id: id,
        type: type,
        points: points,
        style: sanitizedStyle,
        locked: !!(raw && raw.locked),
        hidden: !!(raw && raw.hidden),
        name: (raw && typeof raw.name === "string" && raw.name) || TYPE_LABELS[type] || type,
        folderId: folderId,
        // v70.7 Update 1/2: sanitize into a plain {tf:bool} map, or leave
        // undefined (== "visible everywhere") if the saved value is
        // missing/malformed rather than guessing at a partial one.
        timeframes: sanitizeTimeframesMap(raw && raw.timeframes),
        // v71 Update 1: Auto toggle state — missing/malformed reads back
        // as off, same "fail to the pre-feature behavior" policy as
        // timeframes above.
        autoTf: !!(raw && raw.autoTf),
      };
    }).filter(Boolean);

    // Any loaded object with id 0 (missing/invalid in the file) still
    // needs a unique id before it can live in App.drawObjects — hand out
    // fresh ones above whatever the file's highest valid id was.
    objects.forEach(function (obj) {
      if (obj.id === 0) obj.id = ++maxId;
    });

    return { objects: objects, maxId: maxId };
  }

  function load() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.get_drawings) {
      return Promise.resolve();
    }
    return window.pywebview.api.get_drawings().then(function (data) {
      // Back end always returns {objects, folders} (see chart_bridge.py),
      // but tolerate a bare list too, in case an older cached bridge
      // build is ever loaded against this frontend.
      var rawObjects = Array.isArray(data) ? data : (data && data.objects);
      var rawFolders = Array.isArray(data) ? [] : (data && data.folders);
      var parsedFolders = deserializeFolders(rawFolders);
      var parsedObjects = deserializeObjects(rawObjects, parsedFolders.folders.map(function (f) { return f.id; }));
      App.drawObjects = parsedObjects.objects;
      App.nextObjectId = parsedObjects.maxId + 1;
      App.objectFolders = parsedFolders.folders;
      App.nextFolderId = parsedFolders.maxId + 1;
      // v41 perf: this resolves asynchronously, well after the drawing
      // overlay's render loop has typically already settled onto its idle
      // heartbeat (see drawing-engine.js's dirty-render note) - a whole-
      // array replace of App.drawObjects needs its own explicit
      // requestRender() here rather than relying on main.js's follow-up
      // App.ObjectsPanel.refresh() call to indirectly cover it.
      if (App.DrawingEngine && App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
    }).catch(function (err) {
      console.error("Loading saved drawings failed:", err);
    });
  }

  function doSave() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.save_drawings) return;
    saveInFlight = true;
    window.pywebview.api.save_drawings(serializeObjects(), serializeFolders()).catch(function (err) {
      console.error("Saving drawings failed:", err);
    }).then(function () {
      saveInFlight = false;
      // A change that arrived while the previous save was still in
      // flight isn't lost — scheduleSave() below just remembers to run
      // once more right after this save finishes.
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

  // Best-effort only: pywebview's js_api calls are async, and there's no
  // reliable way to block window close on one finishing. In practice this
  // still gets the request off to the Python side before teardown for a
  // normal window-close; the debounced timer-driven save covers everything
  // else (it's rarely more than SAVE_DEBOUNCE_MS behind the last change).
  function flushNow() {
    clearTimeout(saveTimer);
    doSave();
  }
  window.addEventListener("beforeunload", flushNow);

  App.DrawingPersistence = {
    load: load,
    scheduleSave: scheduleSave,
    flushNow: flushNow,
  };
})();

