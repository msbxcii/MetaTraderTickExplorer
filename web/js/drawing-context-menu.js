// =============================================================================
// drawing-context-menu.js — right-click style/time editor panel for a
// selected drawn object.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  var TOOL_LABELS = { hline: "Horizontal Line", vline: "Vertical Line", trend: "Trend Line", rect: "Rectangle", fib: "Fib Retracement", fibext: "Fib Expansion" };

  // v38 Fix 1: Border/Fill/Middle Line color fields are now themed
  // dark swatch buttons (with an opacity slider built into the popover
  // they open) instead of native <input type="color">, which the page
  // can't restyle or add opacity to. Each keeps reading/writing `.value`
  // (hex) and `.opacity` (0-100) and firing "input"/"change" exactly like
  // a native color input used to, so the rest of this file barely changes.
  if (App.ColorField) {
    App.ColorField.attach(dom.dcmBorderColor, { opacity: true, value: "#c9a227" });
    App.ColorField.attach(dom.dcmFillColor, { opacity: true, value: "#c9a227" });
    App.ColorField.attach(dom.dcmMiddleLineColor, { opacity: true, value: "#c9a227" });
  }

  // ---- v15: rectangle box start/end time editor ---------------------------
  // Times are shown/edited in UTC to match how Lightweight Charts itself
  // labels the time axis and crosshair (it formats numeric `time` values,
  // which are Unix seconds, using UTC date parts — no local-timezone
  // shift). This uses two plain text fields (date, time) instead of the
  // native <input type="datetime-local">, which on some browsers/OS
  // locales renders an AM/PM native picker with no reliable CSS-only way
  // to force strict 24h display. Formatting/parsing stays manual with
  // UTC getters/Date.UTC(), same as before.
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function formatDatePart(ts) {
    var d = new Date(ts * 1000);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }

  function formatTimePart(ts) {
    var d = new Date(ts * 1000);
    return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds());
  }

  // Accepts "HH:MM" or "HH:MM:SS", strictly 24h (00-23), no AM/PM token.
  function parseParts(dateStr, timeStr) {
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateStr || "").trim());
    if (!dm) return null;
    var tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((timeStr || "").trim());
    if (!tm) return null;
    var year = Number(dm[1]), month = Number(dm[2]), day = Number(dm[3]);
    var hh = Number(tm[1]), mm = Number(tm[2]), ss = Number(tm[3] || 0);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hh > 23 || mm > 59 || ss > 59) return null;
    var ms = Date.UTC(year, month - 1, day, hh, mm, ss);
    if (isNaN(ms)) return null;
    return Math.round(ms / 1000);
  }

  // A rectangle's two stored points aren't labeled "start"/"end" — this
  // finds which one is earlier in time (box start) and which is later
  // (box end) right now, as live references into obj.points so editing
  // .time on what's returned mutates the object directly.
  function rectTimeEndpoints(obj) {
    var p0 = obj.points[0], p1 = obj.points[1];
    return p0.time <= p1.time ? { startPoint: p0, endPoint: p1 } : { startPoint: p1, endPoint: p0 };
  }

  function openContextMenu(obj, clientX, clientY) {
    App.activeMenuObject = obj;
    var locked = !!obj.locked;
    dom.dcmTitle.textContent = (TOOL_LABELS[obj.type] || "Object") + (locked ? " — Locked" : "");
    // v33: a locked object can only be reached here (right-click, not
    // left-click — see drawing-engine.js hitTest()). It shows a minimal
    // menu with just an Unlock action instead of the full style/time
    // editor: editing style/time or deleting a locked object would be a
    // silent way around "locked", which should mean "hands off" until
    // it's explicitly unlocked again.
    dom.contextMenuEl.classList.toggle("locked-mode", locked);
    // v37 Fix 1: header lock/hide/delete icons — reflect the object's
    // current state every time the menu (re)opens for it.
    updateHeaderButtons(obj);
    closePresetDropdown();
    closePresetSaveBox();
    // v33.2 fix 2: the same rename the Object Tree panel row offers
    // (double-click) is now also available here, since this menu is the
    // only rename entry point reachable straight from the chart itself.
    if (dom.dcmName) dom.dcmName.value = obj.name || TOOL_LABELS[obj.type] || obj.type;
    if (locked) {
      dom.contextMenuEl.classList.add("open");
      var lockedMenuW = dom.contextMenuEl.offsetWidth || 280;
      var lockedMenuH = dom.contextMenuEl.offsetHeight || 80;
      var lockedLeft = Math.min(clientX, window.innerWidth - lockedMenuW - 8);
      var lockedTop = Math.min(clientY, window.innerHeight - lockedMenuH - 8);
      dom.contextMenuEl.style.left = Math.max(8, lockedLeft) + "px";
      dom.contextMenuEl.style.top = Math.max(8, lockedTop) + "px";
      return;
    }
    dom.dcmBorderColor.value = obj.style.borderColor;
    dom.dcmBorderColor.opacity = obj.style.borderOpacity == null ? 100 : obj.style.borderOpacity;
    dom.dcmBorderWidth.value = String(obj.style.borderWidth);
    dom.dcmBorderStyle.value = obj.style.borderStyle || "solid";
    var isRect = obj.type === "rect";
    var isVline = obj.type === "vline";
    var isHline = obj.type === "hline";
    var isFib = obj.type === "fib";
    // v53: Fib Expansion shares the exact same Level & Description table
    // as Fib Retracement (per spec) — everywhere that section applies,
    // check isFibFamily instead of isFib alone. Fib Expansion has 3
    // stored points though, so it's deliberately left OUT of the
    // rect/fib "time from/to" editor below (that editor assumes exactly
    // 2 points via rectTimeEndpoints()) — its anchors are only editable
    // by dragging their handles on the chart itself.
    var isFibExt = obj.type === "fibext";
    var isFibFamily = isFib || isFibExt;
    // v38 Fix 1: Fill now shares Border's row — only its own swatch
    // toggles per type, there's no separate wrapping row any more.
    dom.dcmFillColor.style.display = isRect ? "" : "none";
    dom.dcmTimeFromRow.style.display = (isRect || isFib) ? "flex" : "none";
    dom.dcmTimeToRow.style.display = (isRect || isFib) ? "flex" : "none";
    dom.dcmVlineTimeRow.style.display = isVline ? "flex" : "none";
    // v70.3 Update 2.
    if (dom.dcmHlinePriceRow) dom.dcmHlinePriceRow.style.display = isHline ? "flex" : "none";
    // v36 Fix 4: Middle Line row only applies to rectangles; its color/
    // width/type fields only make sense once it's actually enabled.
    dom.dcmMiddleLineRow.style.display = isRect ? "flex" : "none";
    // v47/v53: Level & Description table applies to the whole Fib family.
    if (dom.dcmFibLevelsSection) dom.dcmFibLevelsSection.style.display = isFibFamily ? "block" : "none";
    if (isRect) {
      var ml = obj.style.middleLine || { enabled: false, style: "dashed", color: obj.style.borderColor, width: 1, opacity: 100 };
      dom.dcmMiddleLineEnabled.checked = !!ml.enabled;
      dom.dcmMiddleLineColor.value = ml.color;
      dom.dcmMiddleLineColor.opacity = ml.opacity == null ? 100 : ml.opacity;
      dom.dcmMiddleLineWidth.value = String(ml.width);
      dom.dcmMiddleLineStyle.value = ml.style;
      updateMiddleLineSubRows(true, ml.enabled);
    } else {
      updateMiddleLineSubRows(false, false);
    }
    if (isFibFamily) {
      if (dom.dcmFibEnableDescription) dom.dcmFibEnableDescription.checked = !!obj.style.showDescription;
      renderFibLevelTable(obj);
    }
    refreshPresetOptions(obj.type);
    if (isRect) {
      dom.dcmFillColor.value = obj.style.fillColor;
      dom.dcmFillColor.opacity = obj.style.fillOpacity;
    }
    if (isRect || isFib) {
      var ends = rectTimeEndpoints(obj);
      dom.dcmTimeFromDate.value = formatDatePart(ends.startPoint.time);
      dom.dcmTimeFromTime.value = formatTimePart(ends.startPoint.time);
      dom.dcmTimeToDate.value = formatDatePart(ends.endPoint.time);
      dom.dcmTimeToTime.value = formatTimePart(ends.endPoint.time);
      dom.dcmTimeFromDate.classList.remove("dcm-dt-invalid");
      dom.dcmTimeFromTime.classList.remove("dcm-dt-invalid");
      dom.dcmTimeToDate.classList.remove("dcm-dt-invalid");
      dom.dcmTimeToTime.classList.remove("dcm-dt-invalid");
    }
    if (isVline) {
      dom.dcmVlineTimeDate.value = formatDatePart(obj.points[0].time);
      dom.dcmVlineTimeTime.value = formatTimePart(obj.points[0].time);
      dom.dcmVlineTimeDate.classList.remove("dcm-dt-invalid");
      dom.dcmVlineTimeTime.classList.remove("dcm-dt-invalid");
    }
    // v70.3 Update 2.
    if (isHline && dom.dcmHlinePrice) {
      dom.dcmHlinePrice.value = String(obj.points[0].price);
      dom.dcmHlinePrice.classList.remove("dcm-dt-invalid");
    }
    // v70.7 Update 1/2: Timeframes panel — refresh pill/checkbox state for
    // whichever object this menu now shows. Reads obj.timeframes without
    // materializing it (renderTimeframesPanel() itself treats a missing
    // map as "everything on"), so simply opening the menu never turns a
    // freshly-drawn object's untouched (all-visible) state into a stored
    // per-object override.
    renderTimeframesPanel(obj);

    dom.contextMenuEl.classList.add("open");
    // Position after it's visible so we can read its real size and keep
    // it inside the viewport.
    var menuW = dom.contextMenuEl.offsetWidth || 280;
    var menuH = dom.contextMenuEl.offsetHeight || 200;
    var left = Math.min(clientX, window.innerWidth - menuW - 8);
    var top = Math.min(clientY, window.innerHeight - menuH - 8);
    dom.contextMenuEl.style.left = Math.max(8, left) + "px";
    dom.contextMenuEl.style.top = Math.max(8, top) + "px";
  }

  function closeContextMenu() {
    dom.contextMenuEl.classList.remove("open");
    dom.contextMenuEl.classList.remove("locked-mode");
    App.activeMenuObject = null;
  }

  // ---- v70.7 Update 1/2: Timeframes panel ----------------------------------
  // Groups mirror Panel.png exactly: Seconds (1s/5s/15s), Minutes (1m/5m/
  // 15m), Hours (1h/4h/1D). A group's own checkbox is pure UI reflecting
  // (and, on click, setting) all three of its member pills — there is no
  // separate "group enabled" flag stored on the object; the source of
  // truth is always the per-timeframe map itself (see drawing-engine.js's
  // isObjectVisibleAtTf()/ensureTimeframesMap()).
  var TF_GROUPS = {
    seconds: [1, 5, 15],
    minutes: [60, 300, 900],
    hours: [3600, 14400, 86400],
  };
  var tfCollapsed = false; // open by default for every object, per spec

  function tfPillEls() {
    return dom.contextMenuEl ? dom.contextMenuEl.querySelectorAll(".dcm-tf-pill") : [];
  }
  function tfGroupCheckboxEls() {
    return dom.contextMenuEl ? dom.contextMenuEl.querySelectorAll(".dcm-tf-group-checkbox") : [];
  }

  // Reads obj.timeframes (or the implicit all-on default when it hasn't
  // been touched yet) and paints every pill/checkbox to match — called
  // whenever the menu opens for a (possibly different) object.
  function renderTimeframesPanel(obj) {
    if (!dom.dcmTfSection) return;
    dom.dcmTfSection.classList.toggle("collapsed", tfCollapsed);
    var isTimeBased = obj.type === "rect" || obj.type === "trend" || obj.type === "vline" ||
      obj.type === "fib" || obj.type === "fibext" || obj.type === "hline";
    // Every drawable type can be timeframe-filtered — nothing to gate on
    // type here, unlike Border/Fill/Middle Line which only apply to some.
    void isTimeBased;
    tfPillEls().forEach(function (pill) {
      var tf = Number(pill.getAttribute("data-tf"));
      var on = App.DrawingEngine ? App.DrawingEngine.isObjectVisibleAtTf(obj, tf) : true;
      pill.classList.toggle("active", on);
    });
    tfGroupCheckboxEls().forEach(function (cb) {
      var group = cb.getAttribute("data-group");
      var tfs = TF_GROUPS[group] || [];
      var allOn = tfs.every(function (tf) {
        return App.DrawingEngine ? App.DrawingEngine.isObjectVisibleAtTf(obj, tf) : true;
      });
      cb.checked = allOn;
    });
    // v71 Update 1: Auto pill — hline/vline have no time span, so Auto is
    // never available for them (always hidden, never clickable); every
    // other drawable type reflects/toggles obj.autoTf.
    if (dom.dcmTfAutoBtn) {
      var autoApplies = obj.type !== "hline" && obj.type !== "vline";
      dom.dcmTfAutoBtn.classList.toggle("dcm-tf-auto-hidden", !autoApplies);
      dom.dcmTfAutoBtn.classList.toggle("active", autoApplies && !!obj.autoTf);
    }
  }

  function setTfVisible(obj, tf, on) {
    if (!App.DrawingEngine) return;
    var map = App.DrawingEngine.ensureTimeframesMap(obj);
    map[tf] = on;
  }

  // Pill click — toggles that one timeframe, then re-syncs its group's
  // checkbox (which only reflects "all three on", never sets anything
  // itself here).
  (function bindTimeframesPanel() {
    if (!dom.dcmTfSection) return;
    dom.dcmTfSection.addEventListener("click", function (evt) {
      // v71 Update 1: the Auto pill lives inside the header, so it must be
      // checked BEFORE the header's own collapse-toggle handling below —
      // clicking it must only flip Auto, never expand/collapse the panel.
      var autoBtn = evt.target.closest && evt.target.closest(".dcm-tf-auto-btn");
      if (autoBtn) {
        evt.stopPropagation();
        var obj = App.activeMenuObject;
        if (!obj || obj.type === "hline" || obj.type === "vline") return;
        var nextAuto = !obj.autoTf;
        obj.autoTf = nextAuto;
        if (App.StyleDefaults) App.StyleDefaults.setAutoDefault(obj.type, nextAuto);
        // Turning Auto on immediately (re)computes the timeframe map from
        // the object's current, already-final time span — per spec this
        // is a one-shot calculation on toggle, not an ongoing mechanism.
        if (nextAuto && App.DrawingEngine && App.DrawingEngine.applyAutoTimeframes) {
          App.DrawingEngine.applyAutoTimeframes(obj);
        }
        renderTimeframesPanel(obj);
        persistChange();
        return;
      }
      var pill = evt.target.closest && evt.target.closest(".dcm-tf-pill");
      if (pill) {
        if (!App.activeMenuObject) return;
        var tf = Number(pill.getAttribute("data-tf"));
        var next = !pill.classList.contains("active");
        setTfVisible(App.activeMenuObject, tf, next);
        // v71 Update 1: any manual pill edit turns Auto off for this
        // object (per spec's "نکته اول") — Auto and hand-editing are
        // mutually exclusive states, never silently overridden.
        if (App.activeMenuObject.autoTf) App.activeMenuObject.autoTf = false;
        renderTimeframesPanel(App.activeMenuObject);
        persistChange();
        return;
      }
      var groupCb = evt.target.closest && evt.target.closest(".dcm-tf-group-checkbox");
      if (groupCb) {
        if (!App.activeMenuObject) return;
        var group = groupCb.getAttribute("data-group");
        var tfs = TF_GROUPS[group] || [];
        // Read the checkbox's own post-click state (the browser has
        // already flipped it by the time "click" fires) and apply that
        // to every timeframe in the row, per spec's two-way binding.
        var next2 = groupCb.checked;
        tfs.forEach(function (tf) { setTfVisible(App.activeMenuObject, tf, next2); });
        if (App.activeMenuObject.autoTf) App.activeMenuObject.autoTf = false;
        renderTimeframesPanel(App.activeMenuObject);
        persistChange();
        return;
      }
      var header = evt.target.closest && evt.target.closest("#dcm-tf-header");
      if (header) {
        tfCollapsed = !tfCollapsed;
        dom.dcmTfSection.classList.toggle("collapsed", tfCollapsed);
      }
    });
    if (dom.dcmTfClockIcon && App.Icons && App.Icons.clock) dom.dcmTfClockIcon.innerHTML = App.Icons.clock();
  })();

  // v40: minimal Hide/Lock/Delete menu for a right-click that landed on an
  // object which is part of a multi-selection (see drawing-engine.js's
  // contextmenu handler for the >1-selected check that routes here instead
  // of openContextMenu()). Every action below applies to the WHOLE array
  // passed in, not just the object that happened to be right-clicked.
  function openGroupContextMenu(objects, clientX, clientY) {
    closeContextMenu();
    App.groupMenuObjects = objects;
    dom.groupContextMenuEl.classList.add("open");
    var menuW = dom.groupContextMenuEl.offsetWidth || 160;
    var menuH = dom.groupContextMenuEl.offsetHeight || 110;
    var left = Math.min(clientX, window.innerWidth - menuW - 8);
    var top = Math.min(clientY, window.innerHeight - menuH - 8);
    dom.groupContextMenuEl.style.left = Math.max(8, left) + "px";
    dom.groupContextMenuEl.style.top = Math.max(8, top) + "px";
  }

  function closeGroupContextMenu() {
    if (dom.groupContextMenuEl) dom.groupContextMenuEl.classList.remove("open");
    App.groupMenuObjects = null;
  }

  if (dom.dcmgHide) dom.dcmgHide.addEventListener("click", function () {
    (App.groupMenuObjects || []).forEach(function (o) {
      if (App.DrawingEngine) App.DrawingEngine.setHidden(o, true);
    });
    if (App.ObjectsPanel) App.ObjectsPanel.refresh();
    closeGroupContextMenu();
  });
  if (dom.dcmgLock) dom.dcmgLock.addEventListener("click", function () {
    (App.groupMenuObjects || []).forEach(function (o) {
      if (App.DrawingEngine) App.DrawingEngine.setLocked(o, true);
    });
    if (App.ObjectsPanel) App.ObjectsPanel.refresh();
    closeGroupContextMenu();
  });
  if (dom.dcmgDelete) dom.dcmgDelete.addEventListener("click", function () {
    (App.groupMenuObjects || []).slice().forEach(function (o) {
      if (App.DrawingEngine) App.DrawingEngine.removeObject(o);
    });
    closeGroupContextMenu();
  });

  // v33: every style/time edit below is a real change to a persisted
  // object, so each one schedules a save (and refreshes the Object Tree
  // panel, in case it's showing this object). App.DrawingEngine.persistChange
  // is a no-op-safe call (see its own comment in drawing-engine.js).
  function persistChange() {
    if (App.DrawingEngine) App.DrawingEngine.persistChange();
  }

  // v36 Fix 1: any actual STYLE edit (border/fill/middle-line — never the
  // name or the time fields) also becomes that object type's new default,
  // so the next object drawn with that tool starts out looking the same.
  function persistStyleChange() {
    persistChange();
    if (App.activeMenuObject && App.StyleDefaults) {
      App.StyleDefaults.setDefaultStyle(App.activeMenuObject.type, App.activeMenuObject.style);
    }
    // V70.1 Update 2: any direct edit to color/appearance no longer
    // matches whichever preset (if any) was last applied/shown, so the
    // dropdown's label goes back to "-". applyPresetToActiveObject()
    // deliberately calls persistChange() (not this function), so picking
    // a preset itself never re-triggers this.
    setPresetDropdownLabel("-");
  }

  // v36 Fix 4: shows/hides the Middle Line's color/width/type fields —
  // only relevant for a rectangle, and only once the checkbox is on.
  function updateMiddleLineSubRows(isRect, enabled) {
    dom.dcmMiddleLineFieldsRow.style.display = (isRect && enabled) ? "flex" : "none";
  }

  // ---- v47: Fib Retracement — Level & Description table (Update 3) ------
  // obj.style.levels is [{id, level, description}], kept in the same
  // order the user sees/edits them in (NOT re-sorted here — only the
  // canvas renderer in drawing-engine.js sorts by level for drawing). The
  // id=1 (level 0) and id=2 (level 1) rows are the two points the user
  // actually clicked to place the object — their Level number can't be
  // changed and they can't be deleted, per spec; only their Description
  // is editable.
  function isProtectedFibRow(row) {
    return row.level === 0 || row.level === 1;
  }

  function renderFibLevelTable(obj) {
    var body = dom.dcmFibTableBody;
    if (!body) return;
    body.innerHTML = "";
    (obj.style.levels || []).forEach(function (row) {
      var protectedRow = isProtectedFibRow(row);
      var rowEl = document.createElement("div");
      rowEl.className = "dcm-fib-row";

      var levelInput = document.createElement("input");
      levelInput.type = "number";
      levelInput.step = "any";
      levelInput.className = "dcm-fib-level-input";
      levelInput.value = String(row.level);
      levelInput.disabled = protectedRow;
      levelInput.addEventListener("change", function () {
        var v = parseFloat(levelInput.value);
        if (!isFinite(v)) { levelInput.value = String(row.level); return; }
        row.level = v;
        persistStyleChange();
      });

      var descInput = document.createElement("input");
      descInput.type = "text";
      descInput.className = "dcm-fib-desc-input";
      descInput.value = row.description || "";
      descInput.autocomplete = "off";
      descInput.addEventListener("change", function () {
        row.description = descInput.value;
        persistStyleChange();
      });

      var trashBtn = document.createElement("button");
      trashBtn.type = "button";
      trashBtn.className = "dcm-fib-row-trash";
      trashBtn.title = protectedRow ? "Level 0 and Level 1 can't be removed" : "Remove level";
      trashBtn.disabled = protectedRow;
      // v47.1 Update 3: the trash-can glyph read as too small/indistinct at
      // this size — a plain "X" (same glyph the panel's own close buttons
      // already use) is clearer at a glance.
      trashBtn.textContent = "\u2715";
      trashBtn.addEventListener("click", function () {
        if (protectedRow || !App.activeMenuObject) return;
        var levels = App.activeMenuObject.style.levels;
        var idx = levels.indexOf(row);
        if (idx !== -1) levels.splice(idx, 1);
        renderFibLevelTable(App.activeMenuObject);
        persistStyleChange();
      });

      rowEl.appendChild(levelInput);
      rowEl.appendChild(descInput);
      rowEl.appendChild(trashBtn);
      body.appendChild(rowEl);
    });
  }

  // Update 3: a new row's Level defaults to one more than the largest
  // whole-number ("natural") level already in the table. Its Description
  // defaults follow whichever tool this is:
  //  - Fib Retracement: "TP" followed by that same whole number minus one
  //    (e.g. largest natural level being 3 makes the new row Level 4 /
  //    "TP3").
  //  - v53 Fib Expansion: "C" followed by that same whole number plus one
  //    (e.g. largest natural level being 1 — the default C2 row — makes
  //    the new row Level 2 / "C3", then Level 3 / "C4", and so on), per
  //    spec — this keeps the numbering consistent with the default E2
  //    (level 0) / C2 (level 1) naming.
  function addFibLevelRow(obj) {
    var maxNatural = 0;
    (obj.style.levels || []).forEach(function (r) {
      if (Number.isInteger(r.level) && r.level > maxNatural) maxNatural = r.level;
    });
    var newLevel = maxNatural + 1;
    var maxId = 0;
    (obj.style.levels || []).forEach(function (r) { if (r.id > maxId) maxId = r.id; });
    var desc = obj.type === "fibext" ? ("C" + (newLevel + 1)) : ("TP" + (newLevel - 1));
    obj.style.levels.push({ id: maxId + 1, level: newLevel, description: desc });
    renderFibLevelTable(obj);
    persistStyleChange();
  }

  function isFibFamilyType(type) { return type === "fib" || type === "fibext"; }

  if (dom.dcmFibAddLevel) dom.dcmFibAddLevel.addEventListener("click", function () {
    if (App.activeMenuObject && isFibFamilyType(App.activeMenuObject.type)) addFibLevelRow(App.activeMenuObject);
  });
  if (dom.dcmFibEnableDescription) dom.dcmFibEnableDescription.addEventListener("change", function () {
    if (App.activeMenuObject && isFibFamilyType(App.activeMenuObject.type)) {
      App.activeMenuObject.style.showDescription = dom.dcmFibEnableDescription.checked;
      persistStyleChange();
    }
  });

  // ---- v37 Fix 2: preset dropdown (replaces the native <select>) --------
  function closePresetDropdown() {
    if (dom.dcmPresetDropdownWrap) dom.dcmPresetDropdownWrap.classList.remove("open");
  }
  function togglePresetDropdown(evt) {
    evt.stopPropagation();
    if (!dom.dcmPresetDropdownWrap) return;
    closePresetSaveBox();
    dom.dcmPresetDropdownWrap.classList.toggle("open");
  }
  function setPresetDropdownLabel(text) {
    if (dom.dcmPresetDropdownLabel) dom.dcmPresetDropdownLabel.textContent = text;
  }

  // Rebuilds the preset dropdown list for the given object type. Each row
  // shows the preset name (click applies it to the active object) plus its
  // own trash icon (click deletes that preset outright — no need to select
  // it first).
  function refreshPresetOptions(type) {
    // V70.1 Update 1: the dropdown's placeholder text is "-" instead of
    // "Default" (there's no built-in "Default" entry in this list —
    // "Default" is just the tool's own factory look, already reachable by
    // not picking any preset at all, so labeling the placeholder "Default"
    // was misleading).
    setPresetDropdownLabel("-");
    var list = dom.dcmPresetDropdownList;
    if (!list) return;
    list.innerHTML = "";
    var presets = App.StyleDefaults ? App.StyleDefaults.listPresets(type) : [];
    if (!presets.length) {
      var empty = document.createElement("div");
      empty.className = "dcm-preset-dropdown-empty";
      empty.textContent = "No saved presets";
      list.appendChild(empty);
      return;
    }
    presets.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "dcm-preset-dropdown-item";

      var nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "dcm-preset-dropdown-item-name";
      nameBtn.textContent = p.name;
      nameBtn.addEventListener("click", function (evt) {
        evt.stopPropagation();
        applyPresetToActiveObject(p.id);
        setPresetDropdownLabel(p.name);
        closePresetDropdown();
      });

      // V70.1 Update 3: Modify — sits left of the trash icon. Opens the
      // same inline "save preset" box the + button does, pre-filled with
      // this row's own name, in "editing" mode (see openPresetSaveBox()/
      // commitPresetSave()) so confirming updates this exact preset
      // (name and style) instead of creating a new one. Unlike the name
      // button above, this never applies the preset to the active object.
      var modifyBtn = document.createElement("button");
      modifyBtn.type = "button";
      modifyBtn.className = "dcm-preset-dropdown-item-modify";
      modifyBtn.title = "Modify preset";
      modifyBtn.innerHTML = App.Icons.modify();
      modifyBtn.addEventListener("click", function (evt) {
        evt.stopPropagation();
        openPresetSaveBox(p.name, p.id);
      });

      var trashBtn = document.createElement("button");
      trashBtn.type = "button";
      trashBtn.className = "dcm-preset-dropdown-item-trash";
      trashBtn.title = "Delete preset";
      trashBtn.innerHTML = App.Icons.trash();
      trashBtn.addEventListener("click", function (evt) {
        evt.stopPropagation();
        App.StyleDefaults.deletePreset(type, p.id);
        refreshPresetOptions(type);
      });

      row.appendChild(nameBtn);
      row.appendChild(modifyBtn);
      row.appendChild(trashBtn);
      list.appendChild(row);
    });
  }

  // v36 Fix 2: applying a preset changes only the currently selected
  // object's style, immediately — it does NOT change that type's default
  // for future new objects (that only happens via Fix 1, by directly
  // editing a field).
  function applyPresetToActiveObject(presetId) {
    if (!App.activeMenuObject || !App.StyleDefaults) return;
    var style = App.StyleDefaults.getPreset(App.activeMenuObject.type, presetId);
    if (!style) return;
    App.activeMenuObject.style = style;
    // Re-populate every style field from the newly applied style so the
    // panel reflects it right away.
    openContextMenuStyleFieldsOnly(App.activeMenuObject);
    persistChange();
  }

  // V70.1 Update 3: which preset (by id) the inline save box is currently
  // editing — null means the box is in plain "save a new preset" mode
  // (the + button). Set by the row's Modify icon, cleared whenever the
  // box closes.
  var editingPresetId = null;

  // ---- v37 Fix 2: inline "save preset" box (replaces window.prompt) -----
  // V70.1 Update 3: optionally opens in "editing" mode for an existing
  // preset — prefillName/targetId come from a row's Modify icon. Opening
  // it this way never touches the active object's own style (no preset
  // is applied) — it only pre-fills the name so the Check mark can commit
  // an update to that same preset instead of creating a new one.
  function openPresetSaveBox(prefillName, targetId) {
    if (!dom.dcmPresetSaveBox) return;
    closePresetDropdown();
    editingPresetId = targetId != null ? targetId : null;
    dom.dcmPresetSaveBox.classList.add("open");
    if (dom.dcmPresetSaveInput) {
      dom.dcmPresetSaveInput.value = prefillName || "";
      dom.dcmPresetSaveInput.focus();
      dom.dcmPresetSaveInput.select();
    }
  }
  function closePresetSaveBox() {
    if (dom.dcmPresetSaveBox) dom.dcmPresetSaveBox.classList.remove("open");
    editingPresetId = null;
  }
  function commitPresetSave() {
    if (!App.activeMenuObject || !App.StyleDefaults || !dom.dcmPresetSaveInput) return;
    var name = dom.dcmPresetSaveInput.value.trim();
    if (!name) { closePresetSaveBox(); return; }
    var id = App.StyleDefaults.savePreset(App.activeMenuObject.type, name, App.activeMenuObject.style, editingPresetId);
    closePresetSaveBox();
    if (id === null) return;
    refreshPresetOptions(App.activeMenuObject.type);
    setPresetDropdownLabel(name);
  }

  // ---- v37 Fix 1: header Lock / Hide / Delete icons ----------------------
  // Mirrors the Object Tree panel's own row buttons (same icons, same
  // active/danger styling) so an object can be locked/hidden/deleted
  // straight from the style editor without needing the tree panel open.
  function updateHeaderButtons(obj) {
    if (dom.dcmHeaderLock) {
      dom.dcmHeaderLock.classList.toggle("active", !!obj.locked);
      dom.dcmHeaderLock.title = obj.locked ? "Unlock" : "Lock";
      dom.dcmHeaderLock.innerHTML = obj.locked ? App.Icons.lock() : App.Icons.unlock();
    }
    if (dom.dcmHeaderHide) {
      dom.dcmHeaderHide.classList.toggle("active", !!obj.hidden);
      dom.dcmHeaderHide.title = obj.hidden ? "Show" : "Hide";
      dom.dcmHeaderHide.innerHTML = obj.hidden ? App.Icons.eyeOff() : App.Icons.eye();
    }
    if (dom.dcmHeaderDelete) {
      dom.dcmHeaderDelete.title = "Delete";
      dom.dcmHeaderDelete.innerHTML = App.Icons.trash();
    }
  }

  // Re-reads style fields into the open panel without touching position/
  // size/menu placement — used right after a preset is applied.
  function openContextMenuStyleFieldsOnly(obj) {
    dom.dcmBorderColor.value = obj.style.borderColor;
    dom.dcmBorderColor.opacity = obj.style.borderOpacity == null ? 100 : obj.style.borderOpacity;
    dom.dcmBorderWidth.value = String(obj.style.borderWidth);
    dom.dcmBorderStyle.value = obj.style.borderStyle || "solid";
    if (obj.type === "rect") {
      dom.dcmFillColor.value = obj.style.fillColor;
      dom.dcmFillColor.opacity = obj.style.fillOpacity;
      var ml = obj.style.middleLine || { enabled: false, style: "dashed", color: obj.style.borderColor, width: 1, opacity: 100 };
      dom.dcmMiddleLineEnabled.checked = !!ml.enabled;
      dom.dcmMiddleLineColor.value = ml.color;
      dom.dcmMiddleLineColor.opacity = ml.opacity == null ? 100 : ml.opacity;
      dom.dcmMiddleLineWidth.value = String(ml.width);
      dom.dcmMiddleLineStyle.value = ml.style;
      updateMiddleLineSubRows(true, ml.enabled);
    } else if (obj.type === "fib" || obj.type === "fibext") {
      if (dom.dcmFibEnableDescription) dom.dcmFibEnableDescription.checked = !!obj.style.showDescription;
      renderFibLevelTable(obj);
    }
  }

  // v33.2 fix 2: commit on Enter/blur, same as the panel's inline rename —
  // an empty value is ignored (keeps whatever name/default it already had)
  // rather than letting the object end up with a blank label.
  function commitNameField() {
    if (!App.activeMenuObject) return;
    var val = dom.dcmName.value.trim();
    if (val) {
      App.activeMenuObject.name = val;
      persistChange();
    } else {
      dom.dcmName.value = App.activeMenuObject.name || TOOL_LABELS[App.activeMenuObject.type] || App.activeMenuObject.type;
    }
  }
  dom.dcmName.addEventListener("change", commitNameField);
  dom.dcmName.addEventListener("keydown", function (evt) {
    if (evt.key === "Enter") { evt.preventDefault(); dom.dcmName.blur(); }
  });

  dom.dcmBorderColor.addEventListener("input", function () {
    if (App.activeMenuObject) {
      App.activeMenuObject.style.borderColor = dom.dcmBorderColor.value;
      App.activeMenuObject.style.borderOpacity = dom.dcmBorderColor.opacity;
      persistStyleChange();
    }
  });
  dom.dcmBorderWidth.addEventListener("change", function () {
    if (App.activeMenuObject) { App.activeMenuObject.style.borderWidth = Number(dom.dcmBorderWidth.value); persistStyleChange(); }
  });
  // v36 Fix 3: border line type (solid/dashed/dotted).
  dom.dcmBorderStyle.addEventListener("change", function () {
    if (App.activeMenuObject) { App.activeMenuObject.style.borderStyle = dom.dcmBorderStyle.value; persistStyleChange(); }
  });
  // v38 Fix 1: Fill's color and opacity are both set from the one themed
  // swatch/popover now — no separate opacity slider element any more.
  dom.dcmFillColor.addEventListener("input", function () {
    if (App.activeMenuObject) {
      App.activeMenuObject.style.fillColor = dom.dcmFillColor.value;
      App.activeMenuObject.style.fillOpacity = dom.dcmFillColor.opacity;
      persistStyleChange();
    }
  });

  // v36 Fix 4: Middle Line (rectangles only) — enable checkbox plus its
  // color/width/type sub-fields, all folded into obj.style.middleLine.
  function ensureMiddleLine(obj) {
    if (!obj.style.middleLine) {
      obj.style.middleLine = { enabled: false, style: "dashed", color: obj.style.borderColor, width: 1, opacity: 100 };
    }
    return obj.style.middleLine;
  }
  dom.dcmMiddleLineEnabled.addEventListener("change", function () {
    if (!App.activeMenuObject || App.activeMenuObject.type !== "rect") return;
    var ml = ensureMiddleLine(App.activeMenuObject);
    ml.enabled = dom.dcmMiddleLineEnabled.checked;
    updateMiddleLineSubRows(true, ml.enabled);
    persistStyleChange();
  });
  dom.dcmMiddleLineColor.addEventListener("input", function () {
    if (!App.activeMenuObject || App.activeMenuObject.type !== "rect") return;
    var ml = ensureMiddleLine(App.activeMenuObject);
    ml.color = dom.dcmMiddleLineColor.value;
    ml.opacity = dom.dcmMiddleLineColor.opacity;
    persistStyleChange();
  });
  dom.dcmMiddleLineWidth.addEventListener("change", function () {
    if (!App.activeMenuObject || App.activeMenuObject.type !== "rect") return;
    ensureMiddleLine(App.activeMenuObject).width = Number(dom.dcmMiddleLineWidth.value);
    persistStyleChange();
  });
  dom.dcmMiddleLineStyle.addEventListener("change", function () {
    if (!App.activeMenuObject || App.activeMenuObject.type !== "rect") return;
    ensureMiddleLine(App.activeMenuObject).style = dom.dcmMiddleLineStyle.value;
    persistStyleChange();
  });

  // v37 Fix 2: preset dropdown open/close + inline "save as" box (see the
  // functions above) — replaces the old native <select> + prompt() flow.
  if (dom.dcmPresetDropdownBtn) dom.dcmPresetDropdownBtn.addEventListener("click", togglePresetDropdown);
  document.addEventListener("click", closePresetDropdown);
  dom.dcmPresetSave.addEventListener("click", function (evt) {
    evt.stopPropagation();
    openPresetSaveBox();
  });
  if (dom.dcmPresetSaveConfirm) dom.dcmPresetSaveConfirm.addEventListener("click", function (evt) {
    evt.stopPropagation();
    commitPresetSave();
  });
  if (dom.dcmPresetSaveCancel) dom.dcmPresetSaveCancel.addEventListener("click", function (evt) {
    evt.stopPropagation();
    closePresetSaveBox();
  });
  if (dom.dcmPresetSaveInput) {
    dom.dcmPresetSaveInput.addEventListener("click", function (evt) { evt.stopPropagation(); });
    dom.dcmPresetSaveInput.addEventListener("keydown", function (evt) {
      evt.stopPropagation();
      if (evt.key === "Enter") { evt.preventDefault(); commitPresetSave(); }
      else if (evt.key === "Escape") { evt.preventDefault(); closePresetSaveBox(); }
    });
  }
  function handleTimeFromChange() {
    if (!App.activeMenuObject || (App.activeMenuObject.type !== "rect" && App.activeMenuObject.type !== "fib")) return;
    var t = parseParts(dom.dcmTimeFromDate.value, dom.dcmTimeFromTime.value);
    var valid = t !== null;
    dom.dcmTimeFromDate.classList.toggle("dcm-dt-invalid", !valid);
    dom.dcmTimeFromTime.classList.toggle("dcm-dt-invalid", !valid);
    if (!valid) return;
    rectTimeEndpoints(App.activeMenuObject).startPoint.time = t;
    // v71 Update 2: the Start/End Time fields fire "change" only once the
    // user commits a full value (field loses focus / Enter), not per
    // keystroke — same one-shot moment as a handle drag ending, so it's
    // safe to recompute Auto here without giving up the "no per-digit
    // recalculation" requirement.
    if (App.DrawingEngine && App.DrawingEngine.applyAutoTimeframes) {
      App.DrawingEngine.applyAutoTimeframes(App.activeMenuObject);
      renderTimeframesPanel(App.activeMenuObject);
    }
    persistChange();
  }
  function handleTimeToChange() {
    if (!App.activeMenuObject || (App.activeMenuObject.type !== "rect" && App.activeMenuObject.type !== "fib")) return;
    var t = parseParts(dom.dcmTimeToDate.value, dom.dcmTimeToTime.value);
    var valid = t !== null;
    dom.dcmTimeToDate.classList.toggle("dcm-dt-invalid", !valid);
    dom.dcmTimeToTime.classList.toggle("dcm-dt-invalid", !valid);
    if (!valid) return;
    rectTimeEndpoints(App.activeMenuObject).endPoint.time = t;
    // v71 Update 2: see the matching note in handleTimeFromChange() above.
    if (App.DrawingEngine && App.DrawingEngine.applyAutoTimeframes) {
      App.DrawingEngine.applyAutoTimeframes(App.activeMenuObject);
      renderTimeframesPanel(App.activeMenuObject);
    }
    persistChange();
  }
  dom.dcmTimeFromDate.addEventListener("change", handleTimeFromChange);
  dom.dcmTimeFromTime.addEventListener("change", handleTimeFromChange);
  dom.dcmTimeToDate.addEventListener("change", handleTimeToChange);
  dom.dcmTimeToTime.addEventListener("change", handleTimeToChange);
  function handleVlineTimeChange() {
    if (!App.activeMenuObject || App.activeMenuObject.type !== "vline") return;
    var t = parseParts(dom.dcmVlineTimeDate.value, dom.dcmVlineTimeTime.value);
    var valid = t !== null;
    dom.dcmVlineTimeDate.classList.toggle("dcm-dt-invalid", !valid);
    dom.dcmVlineTimeTime.classList.toggle("dcm-dt-invalid", !valid);
    if (!valid) return;
    App.activeMenuObject.points[0].time = t;
    persistChange();
  }
  dom.dcmVlineTimeDate.addEventListener("change", handleVlineTimeChange);
  dom.dcmVlineTimeTime.addEventListener("change", handleVlineTimeChange);
  // v70.3 Update 2: hline price editor, same shape as handleVlineTimeChange.
  function handleHlinePriceChange() {
    if (!dom.dcmHlinePrice || !App.activeMenuObject || App.activeMenuObject.type !== "hline") return;
    var p = parseFloat(dom.dcmHlinePrice.value);
    var valid = isFinite(p);
    dom.dcmHlinePrice.classList.toggle("dcm-dt-invalid", !valid);
    if (!valid) return;
    App.activeMenuObject.points[0].price = p;
    persistChange();
  }
  if (dom.dcmHlinePrice) dom.dcmHlinePrice.addEventListener("change", handleHlinePriceChange);

  // v37 Fix 1: header Lock/Hide/Delete — same actions the Object Tree
  // panel's row buttons perform, now reachable from the style editor too.
  if (dom.dcmHeaderDelete) dom.dcmHeaderDelete.addEventListener("click", function (evt) {
    evt.stopPropagation();
    if (App.activeMenuObject && App.DrawingEngine) {
      App.DrawingEngine.removeObject(App.activeMenuObject);
    }
    closeContextMenu();
  });
  if (dom.dcmHeaderLock) dom.dcmHeaderLock.addEventListener("click", function (evt) {
    evt.stopPropagation();
    if (!App.activeMenuObject || !App.DrawingEngine) return;
    var next = !App.activeMenuObject.locked;
    App.DrawingEngine.setLocked(App.activeMenuObject, next);
    if (App.ObjectsPanel) App.ObjectsPanel.refresh();
    if (next) {
      // Matches the existing rule that a locked object only shows the
      // minimal Unlock menu — switch straight to that view rather than
      // leaving stale style/time fields visible for an object that's now
      // locked.
      dom.dcmTitle.textContent = (TOOL_LABELS[App.activeMenuObject.type] || "Object") + " — Locked";
      dom.contextMenuEl.classList.add("locked-mode");
    } else {
      dom.contextMenuEl.classList.remove("locked-mode");
      dom.dcmTitle.textContent = TOOL_LABELS[App.activeMenuObject.type] || "Object";
    }
    updateHeaderButtons(App.activeMenuObject);
  });
  if (dom.dcmHeaderHide) dom.dcmHeaderHide.addEventListener("click", function (evt) {
    evt.stopPropagation();
    if (!App.activeMenuObject || !App.DrawingEngine) return;
    App.DrawingEngine.setHidden(App.activeMenuObject, !App.activeMenuObject.hidden);
    if (App.ObjectsPanel) App.ObjectsPanel.refresh();
    updateHeaderButtons(App.activeMenuObject);
  });

  // v33: the locked-mode menu's only action — hands the object back to
  // ordinary left-click select/move/resize.
  dom.dcmUnlock.addEventListener("click", function () {
    if (App.activeMenuObject && App.DrawingEngine) {
      App.DrawingEngine.setLocked(App.activeMenuObject, false);
    }
    closeContextMenu();
  });

  dom.dcmClose.addEventListener("click", closeContextMenu);

  document.addEventListener("mousedown", function (evt) {
    if (dom.contextMenuEl.classList.contains("open") && !dom.contextMenuEl.contains(evt.target)) {
      closeContextMenu();
    }
    if (dom.groupContextMenuEl && dom.groupContextMenuEl.classList.contains("open") &&
        !dom.groupContextMenuEl.contains(evt.target)) {
      closeGroupContextMenu();
    }
  });

  App.DrawingContextMenu = {
    open: openContextMenu,
    close: closeContextMenu,
    openGroup: openGroupContextMenu,
    closeGroup: closeGroupContextMenu,
  };
})();
