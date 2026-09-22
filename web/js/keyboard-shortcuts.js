// =============================================================================
// keyboard-shortcuts.js — global key-binding engine + the Setting panel's
// "Keyboard Shortcuts" tab.
//
// v51: previously this file just hardcoded five key handlers directly.
// It now owns a data-driven binding table (ACTIONS) so every shortcut can
// be re-mapped by the user, shows a themed table of all of them in the
// Keyboard Shortcuts tab, and persists any changes to disk (see
// src/keyboard_shortcuts_store.py) exactly like Canvas settings already
// do, so a re-bound shortcut survives closing and reopening the app.
//
// All bindings are matched on KeyboardEvent.code (the physical key
// position) rather than .key (the character the layout produces), so a
// shortcut fires the same whether the OS keyboard layout is set to
// English or Persian, per spec — "Global" here means layout-independent,
// not that it works outside the app window.
//
// Backspace = undo last, Delete = clear all, Escape = cancel/deselect
// (Escape is NOT user-remappable — it's a fixed UI convention, not listed
// in ACTIONS), Space = Jump Time, Home/End jump to the true oldest/latest
// history partition, matching default MetaTrader behavior. v51 adds
// Ctrl+H / Ctrl+V for the Horizontal/Vertical Line tools, plus three more
// actions (Rectangle / Trend Line / Fib Retracement) that ship with no
// default key — assignable only, per spec.
//
// v51 Update 2: Ctrl+H / Ctrl+V place their line immediately at the
// mouse's current position, with no follow-up click needed — exclusive
// to these two shortcuts (every other tool, whether toolbar- or
// shortcut-armed, keeps the normal "arm the tool, then click to place"
// flow). See drawing-engine.js's placeAtLastMouse().
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  // ---- Action table -------------------------------------------------------
  // `run` is called when the bound combo fires (and no typing target is
  // focused). `code` in DEFAULT is a KeyboardEvent.code value, or null for
  // "ships unassigned, per spec" actions the user can still bind later.
  var ACTIONS = [
    {
      id: "jumpTime", label: "Jump Time",
      default: { ctrl: false, shift: false, alt: false, code: "Space" },
    },
    {
      id: "jumpLatest", label: "Jump To Latest",
      default: { ctrl: false, shift: false, alt: false, code: "End" },
      run: function () {
        // v58.1 Update 2: disabled entirely while Replay mode is active.
        // END jumping to the real live data mid-Replay broke the whole
        // Replay mechanism (it silently pulled the chart off the replay
        // cutoff and onto real-time data). No-op here; the shortcut
        // starts working again automatically once Replay mode exits,
        // since this only checks the current App.replayActive flag.
        if (App.replayActive) return;
        App.ChartCore.jumpToLatest();
        if (App.MultiPanel && App.MultiPanel.jumpAllToLatest) App.MultiPanel.jumpAllToLatest();
      },
    },
    {
      id: "jumpOldest", label: "Jump To Oldest",
      default: { ctrl: false, shift: false, alt: false, code: "Home" },
      run: function () {
        App.ChartCore.jumpToOldest();
        if (App.MultiPanel && App.MultiPanel.jumpAllToOldest) App.MultiPanel.jumpAllToOldest();
      },
    },
    {
      id: "undoLast", label: "Undo Last Object",
      default: { ctrl: false, shift: false, alt: false, code: "Backspace" },
      run: function () {
        // v57 Update 15: this doubles as the undo for Delete All Objects
        // (see below) while that deletion is still the most recent thing
        // that happened to the object list.
        if (lastBulkDelete && !App.drawObjects.length && lastBulkDeleteAtId === App.nextObjectId) {
          App.drawObjects = lastBulkDelete;
          lastBulkDelete = null;
          if (App.DrawingEngine) {
            App.DrawingEngine.persistChange();
            App.DrawingEngine.showHint("Objects restored");
          }
          return;
        }
        lastBulkDelete = null;
        if (!App.drawObjects.length) return;
        var removed = App.drawObjects.pop();
        if (App.activeMenuObject === removed) App.DrawingContextMenu.close();
        if (App.selectedObject === removed) { App.selectedObject = null; App.interaction = null; }
        // v57 Update 15 (bug fix): popping the object here bypassed
        // DrawingEngine.removeObject(), which is the only place that keeps
        // the Object Tree's multi-selection free of dangling references -
        // so the panel could keep a deleted object highlighted (and act on
        // it from a row button) after it was gone from the chart.
        forgetObject(removed);
        if (App.DrawingEngine) App.DrawingEngine.persistChange();
      },
    },
    {
      id: "deleteAll", label: "Delete All Objects",
      default: { ctrl: false, shift: false, alt: false, code: "Delete" },
      run: function () {
        if (!App.drawObjects.length) return;
        // v57 Update 15: a single keystroke used to destroy every drawn
        // object on the chart - permanently, since it also went straight to
        // disk through persistChange() and "Undo Last Object" only ever
        // popped one object. Nothing warned about it and nothing could take
        // it back. The deleted set is now kept in memory for exactly one
        // undo, and the toast says so, so the shortcut stays as fast as it
        // was for the case where it was meant (clearing the chart) without
        // being unrecoverable when it wasn't.
        var count = App.drawObjects.length;
        lastBulkDelete = App.drawObjects.slice();
        lastBulkDeleteAtId = App.nextObjectId;
        App.drawObjects = [];
        App.selectedObject = null;
        App.interaction = null;
        App.panelSelectedObjects = [];
        App.panelLastClickedObject = null;
        App.DrawingContextMenu.close();
        if (App.DrawingEngine) {
          App.DrawingEngine.persistChange();
          var undoKey = formatBinding(bindings.undoLast);
          App.DrawingEngine.showHint(
            count + (count === 1 ? " object deleted" : " objects deleted") +
            (undoKey ? " \u2014 press " + undoKey + " to undo" : "")
          );
        }
      },
    },
    {
      id: "objHLine", label: "Object: Horizontal Line",
      default: { ctrl: true, shift: false, alt: false, code: "KeyH" },
      // v51 Update 2: placed immediately at the current mouse position —
      // no follow-up click needed. Falls back to just arming the tool
      // (old behavior) if the mouse isn't currently over any chart panel.
      run: function () {
        if (!App.DrawingEngine) return;
        if (!App.DrawingEngine.placeAtLastMouse || !App.DrawingEngine.placeAtLastMouse("hline")) {
          App.DrawingEngine.setTool("hline");
        }
      },
    },
    {
      id: "objVLine", label: "Object: Vertical Line",
      default: { ctrl: true, shift: false, alt: false, code: "KeyV" },
      // v51 Update 2: same instant-placement behavior as Horizontal Line
      // above — exclusive to these two shortcuts, per spec.
      run: function () {
        if (!App.DrawingEngine) return;
        if (!App.DrawingEngine.placeAtLastMouse || !App.DrawingEngine.placeAtLastMouse("vline")) {
          App.DrawingEngine.setTool("vline");
        }
      },
    },
    // Per spec: shipped with no key assigned. The user can add one from
    // the table below; whatever they pick is persisted the same way.
    {
      id: "objRect", label: "Object: Rectangle",
      default: null,
      run: function () { if (App.DrawingEngine) App.DrawingEngine.setTool("rect"); },
    },
    {
      id: "objTrend", label: "Object: Trend Line",
      default: null,
      run: function () { if (App.DrawingEngine) App.DrawingEngine.setTool("trend"); },
    },
    {
      id: "objFib", label: "Object: Fib Retracement",
      default: null,
      run: function () { if (App.DrawingEngine) App.DrawingEngine.setTool("fib"); },
    },
    // v53: shipped with no key assigned, same as every other drawing tool
    // above besides Horizontal/Vertical Line.
    {
      id: "objFibExt", label: "Object: Fib Expansion",
      default: null,
      run: function () { if (App.DrawingEngine) App.DrawingEngine.setTool("fibext"); },
    },
  ];

  // v57 Update 15: the object list as it was immediately before the last
  // "Delete All Objects", held in memory for exactly one undo. Cleared as
  // soon as anything else changes the list, so it can never resurrect a
  // stale set over newer work.
  var lastBulkDelete = null;
  // App.nextObjectId at the moment of that deletion. If it has moved since,
  // the user has drawn something new and the snapshot is no longer "the last
  // thing that happened" - restoring it then would resurrect an old set on
  // top of newer work, so it is simply dropped.
  var lastBulkDeleteAtId = 0;

  // Keep the Object Tree panel's selection state free of an object that no
  // longer exists. DrawingEngine.removeObject() does this for every other
  // deletion path; the shortcut handlers above are the exceptions.
  function forgetObject(obj) {
    if (!obj) return;
    var idx = App.panelSelectedObjects ? App.panelSelectedObjects.indexOf(obj) : -1;
    if (idx !== -1) App.panelSelectedObjects.splice(idx, 1);
    if (App.panelLastClickedObject === obj) App.panelLastClickedObject = null;
  }

  var ACTION_BY_ID = {};
  ACTIONS.forEach(function (a) { ACTION_BY_ID[a.id] = a; });

  // Readable names for codes that aren't already obvious letters/digits.
  var CODE_LABELS = {
    Space: "Space", End: "End", Home: "Home", Backspace: "Backspace",
    Delete: "Delete", Escape: "Esc", Tab: "Tab", Enter: "Enter",
    ArrowUp: "\u2191", ArrowDown: "\u2193", ArrowLeft: "\u2190", ArrowRight: "\u2192",
    PageUp: "PageUp", PageDown: "PageDown",
  };

  function codeLabel(code) {
    if (!code) return "";
    if (CODE_LABELS[code]) return CODE_LABELS[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F[0-9]{1,2}$/.test(code)) return code;
    return code;
  }

  function formatBinding(b) {
    if (!b || !b.code) return null;
    var parts = [];
    if (b.ctrl) parts.push("Ctrl");
    if (b.shift) parts.push("Shift");
    if (b.alt) parts.push("Alt");
    parts.push(codeLabel(b.code));
    return parts.join(" + ");
  }

  function bindingsEqual(a, b) {
    if (!a || !b) return false;
    return !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift && !!a.alt === !!b.alt && a.code === b.code;
  }

  // ---- Persistence ---------------------------------------------------------
  // Mirrors canvas-settings.js's load()/save() pattern exactly: disk via
  // ChartBridge.get_keyboard_shortcuts/save_keyboard_shortcuts (see
  // src/keyboard_shortcuts_store.py) when running inside pywebview, plain
  // localStorage as a dev-mode fallback otherwise.
  var LOCAL_KEY = "v51-keyboard-shortcuts";
  var SAVE_DEBOUNCE_MS = 300;

  // actionId -> binding (or null = unassigned). Starts as the defaults;
  // load() overlays any saved customizations the moment it resolves.
  var bindings = {};
  ACTIONS.forEach(function (a) { bindings[a.id] = a.default ? shallowCopy(a.default) : null; });

  function shallowCopy(b) { return { ctrl: !!b.ctrl, shift: !!b.shift, alt: !!b.alt, code: b.code }; }

  function sanitizeBindings(raw) {
    var out = {};
    ACTIONS.forEach(function (a) {
      var v = raw && raw[a.id];
      if (v && typeof v === "object" && typeof v.code === "string" && v.code) {
        out[a.id] = { ctrl: !!v.ctrl, shift: !!v.shift, alt: !!v.alt, code: v.code };
      } else if (v === null) {
        out[a.id] = null;
      } else {
        out[a.id] = a.default ? shallowCopy(a.default) : null;
      }
    });
    return out;
  }

  function readLocalJson(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeLocalJson(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* best-effort */ }
  }

  var saveTimer = null;
  function doSave() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.save_keyboard_shortcuts) {
      writeLocalJson(LOCAL_KEY, bindings);
      return;
    }
    window.pywebview.api.save_keyboard_shortcuts({ bindings: bindings }).catch(function (err) {
      console.error("Saving Keyboard Shortcuts failed:", err);
    });
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; doSave(); }, SAVE_DEBOUNCE_MS);
  }

  function load() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.get_keyboard_shortcuts) {
      bindings = sanitizeBindings(readLocalJson(LOCAL_KEY));
      renderTable();
      return Promise.resolve();
    }
    return window.pywebview.api.get_keyboard_shortcuts().then(function (data) {
      bindings = sanitizeBindings(data && data.bindings);
      renderTable();
    }).catch(function (err) {
      console.error("Loading saved Keyboard Shortcuts failed:", err);
    });
  }

  // ---- Global key handling --------------------------------------------------
  // While a table row is capturing the user's next keystroke (see
  // beginCapture below), the normal action dispatch is suppressed so, e.g.,
  // pressing "H" to *set* Ctrl+H doesn't also fire whatever "H" currently
  // does.
  var capturing = null; // {actionId} or null

  function matches(evt, b) {
    if (!b || !b.code) return false;
    return evt.code === b.code && !!evt.ctrlKey === !!b.ctrl && !!evt.shiftKey === !!b.shift && !!evt.altKey === !!b.alt;
  }

  document.addEventListener("keydown", function (evt) {
    if (capturing) return; // handled by the capture listener below instead
    if (isTypingTarget(document.activeElement)) return;

    if (evt.key === "Escape") {
      // v39: ESC also restores a maximized multi-chart panel (see
      // multi-panel.js's double-click-to-maximize) — checked first and
      // unconditionally, alongside (not instead of) the existing drawing-
      // tool-cancel / context-menu-close behavior below. Not user-
      // remappable — a fixed UI convention, not one of the ACTIONS above.
      if (App.MultiPanel && App.MultiPanel.isMaximized && App.MultiPanel.isMaximized()) {
        App.MultiPanel.restoreFromMaximize();
      }
      if (App.dragStart) { App.DrawingEngine.cancelPendingObject(); App.DrawingEngine.returnToCursor(); }
      else if (App.currentTool !== "cursor") { App.DrawingEngine.returnToCursor(); }
      App.DrawingContextMenu.close();
      return;
    }

    for (var i = 0; i < ACTIONS.length; i++) {
      var action = ACTIONS[i];
      if (matches(evt, bindings[action.id])) {
        if (action.run) action.run();
        evt.preventDefault();
        return;
      }
    }
  });

  // ---- Keyboard Shortcuts tab ------------------------------------------------
  if (!dom.kbdShortcutsTbody) return;

  var rowRefs = {}; // actionId -> {tr, badge, editBtn, clearBtn}

  function stopCaptureListeners() {
    document.removeEventListener("keydown", onCaptureKeydown, true);
  }

  function onCaptureKeydown(evt) {
    if (!capturing) return;
    evt.preventDefault();
    evt.stopPropagation();
    // Ignore bare modifier presses — wait for the actual key.
    if (evt.code === "ControlLeft" || evt.code === "ControlRight" ||
        evt.code === "ShiftLeft" || evt.code === "ShiftRight" ||
        evt.code === "AltLeft" || evt.code === "AltRight" ||
        evt.code === "MetaLeft" || evt.code === "MetaRight") {
      return;
    }
    if (evt.code === "Escape") { cancelCapture(); return; }
    capturing.pending = { ctrl: evt.ctrlKey, shift: evt.shiftKey, alt: evt.altKey, code: evt.code };
    renderRow(capturing.actionId);
  }

  function beginCapture(actionId) {
    if (capturing) cancelCapture();
    capturing = { actionId: actionId, pending: null };
    document.addEventListener("keydown", onCaptureKeydown, true);
    renderRow(actionId);
  }

  function cancelCapture() {
    if (!capturing) return;
    var id = capturing.actionId;
    capturing = null;
    stopCaptureListeners();
    renderRow(id);
  }

  function confirmCapture() {
    if (!capturing || !capturing.pending) { cancelCapture(); return; }
    var actionId = capturing.actionId;
    var newBinding = capturing.pending;
    // If some other action already owns this exact combo, free it first —
    // two actions can't share one shortcut.
    ACTIONS.forEach(function (a) {
      if (a.id !== actionId && bindingsEqual(bindings[a.id], newBinding)) {
        bindings[a.id] = null;
        renderRow(a.id);
      }
    });
    bindings[actionId] = newBinding;
    capturing = null;
    stopCaptureListeners();
    renderRow(actionId);
    scheduleSave();
  }

  function clearBinding(actionId) {
    if (capturing && capturing.actionId === actionId) cancelCapture();
    bindings[actionId] = null;
    renderRow(actionId);
    scheduleSave();
  }

  function resetAllToDefault() {
    if (capturing) cancelCapture();
    ACTIONS.forEach(function (a) { bindings[a.id] = a.default ? shallowCopy(a.default) : null; });
    renderTable();
    scheduleSave();
  }

  function renderRow(actionId) {
    var refs = rowRefs[actionId];
    if (!refs) return;
    var isCapturing = capturing && capturing.actionId === actionId;
    var current = bindings[actionId];

    refs.badge.classList.remove("kbd-unassigned", "kbd-listening");
    if (isCapturing) {
      refs.badge.classList.add("kbd-listening");
      refs.badge.textContent = capturing.pending ? formatBinding(capturing.pending) : "Press a key\u2026";
    } else if (current) {
      refs.badge.textContent = formatBinding(current);
    } else {
      refs.badge.classList.add("kbd-unassigned");
      refs.badge.textContent = "Not Assigned";
    }

    refs.editBtn.innerHTML = isCapturing ? "\u2713" : "\u270E";
    refs.editBtn.title = isCapturing ? "Confirm" : (current ? "Change" : "Assign");
    refs.editBtn.classList.toggle("kbd-confirm-btn", isCapturing);
    refs.editBtn.disabled = isCapturing && !capturing.pending;

    refs.clearBtn.innerHTML = "\u2715";
    if (isCapturing) {
      refs.clearBtn.title = "Cancel";
      refs.clearBtn.classList.add("kbd-cancel-btn");
      refs.clearBtn.classList.remove("kbd-clear-btn");
      refs.clearBtn.disabled = false;
    } else {
      refs.clearBtn.title = "Remove";
      refs.clearBtn.classList.remove("kbd-cancel-btn");
      refs.clearBtn.classList.add("kbd-clear-btn");
      refs.clearBtn.disabled = !current;
    }
  }

  function renderTable() {
    dom.kbdShortcutsTbody.innerHTML = "";
    rowRefs = {};
    ACTIONS.forEach(function (action) {
      var tr = document.createElement("tr");

      var tdLabel = document.createElement("td");
      tdLabel.className = "kbd-action-label";
      tdLabel.textContent = action.label;

      var tdShortcut = document.createElement("td");
      var badge = document.createElement("span");
      badge.className = "kbd-shortcut-badge";
      tdShortcut.appendChild(badge);

      var tdControls = document.createElement("td");
      var controls = document.createElement("div");
      controls.className = "kbd-row-controls";

      var editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "kbd-icon-btn";
      editBtn.addEventListener("click", function () {
        if (capturing && capturing.actionId === action.id) {
          confirmCapture();
        } else {
          beginCapture(action.id);
        }
      });

      var clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "kbd-icon-btn kbd-clear-btn";
      clearBtn.addEventListener("click", function () {
        if (capturing && capturing.actionId === action.id) {
          cancelCapture();
        } else {
          clearBinding(action.id);
        }
      });

      controls.appendChild(editBtn);
      controls.appendChild(clearBtn);
      tdControls.appendChild(controls);

      tr.appendChild(tdLabel);
      tr.appendChild(tdShortcut);
      tr.appendChild(tdControls);
      dom.kbdShortcutsTbody.appendChild(tr);

      rowRefs[action.id] = { tr: tr, badge: badge, editBtn: editBtn, clearBtn: clearBtn };
      renderRow(action.id);
    });
  }

  if (dom.kbdResetAllBtn) dom.kbdResetAllBtn.addEventListener("click", resetAllToDefault);

  renderTable();

  // Leaving the tab mid-capture (or closing the Setting panel) should not
  // leave a dangling capture-mode keydown listener armed underneath the
  // rest of the app.
  function deactivate() { if (capturing) cancelCapture(); }
  function activate() {}

  App.KeyboardShortcuts = {
    activate: activate,
    deactivate: deactivate,
    load: load,
  };
})();
