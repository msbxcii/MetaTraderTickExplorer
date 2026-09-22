// =============================================================================
// object-panel.js — v33: the "Object Tree" side panel — a collapsible list
// (right edge of the chart, toggled via the layers button) of every drawn
// object, modeled after TradingView's own Object Tree panel.
// =============================================================================
// v33.1 additions:
//   Fix 2 — Ctrl+click toggles a row into/out of a multi-selection;
//     Shift+click range-selects between the last-clicked row and the new
//     one; a plain click collapses back to a single selection (and jumps
//     the chart there, as before); the trash/hide/lock buttons on ANY
//     selected row act on the whole multi-selection. Clicking empty panel
//     space, or empty chart space (see drawing-engine.js), unselects
//     everywhere. Only App.selectedObject (the chart's own single
//     selection) gets the yellow "active" highlight here — see the note
//     on App.panelSelectedObjects in state.js.
//   Fix 3 — double-click a row's label to rename that object inline.
//   Fix 4 — a "new folder" button in the header creates a folder row;
//     double-click renames it the same way objects rename; drag-and-drop
//     one or more selected rows onto a folder row moves them into it;
//     hovering a folder row reveals lock/hide/delete buttons that apply
//     to every object currently inside that folder.
//   Fix 6 — a row whose object sits outside the currently-loaded
//     timeframe's available history (per get_history_bounds) renders in
//     the muted/grey color instead of the normal text color.
// v33.2 additions (a separate, later round of six fixes to this same
// panel):
//   Fix 1 — double-clicking an object row's label now reliably renames it.
//     The v33.1 approach (a native "dblclick" listener on the label)
//     silently broke for objects specifically because a plain click
//     already calls selectAndJump() -> refresh(), which tears down and
//     rebuilds every row's DOM node — so by the time the browser would
//     dispatch "dblclick", the label it was going to fire on had already
//     been removed from the document (this never affected folder rows,
//     since a plain click on a folder row only calls stopPropagation(),
//     no refresh()). Renaming now uses its own click-timestamp-based
//     double-click detection (see lastRowClick below) instead of relying
//     on the browser's native dblclick surviving a DOM rebuild.
//   Fix 2 — moved to drawing-context-menu.js: the right-click style/time
//     editor now also has a Name field, so an object can be renamed
//     without opening the panel at all.
//   Fix 3 — a row rendered grey (isOutOfRange()) can still be selected
//     (single click, Ctrl/Shift multi-select, lock/hide/delete) but never
//     jumped to — selectAndJump() now checks isOutOfRange() before ever
//     calling JumpTime.jumpToTimestamp().
//   Fix 4 — a Ctrl/Shift multi-selection now renders EVERY selected row
//     with the exact same yellow highlight as a single active selection
//     (previously a dimmer, separate color), and drawing-engine.js's
//     renderFrame() draws chart-side selection handles for every object
//     in App.panelSelectedObjects, not just the single App.selectedObject.
//   Fix 5 — row order now sorts explicitly by obj.id (creation order)
//     descending — newest first — instead of relying on array position,
//     so it can never be thrown off by anything else that reorders
//     App.drawObjects. Folders always sort above every top-level object
//     regardless of creation time ("pinned to top"), and a folder's own
//     members sort newest-first the same way.
//   Fix 6 — folders can now be collapsed: a folder row's `collapsed` flag
//     (default false — open) hides its members from the panel entirely
//     while set. Clicking a folder row toggles it; dropping a
//     multi-selection onto a folder both moves the objects in
//     (o.folderId = folder.id, exactly as before) AND opens the folder so
//     the move is immediately visible, indented under it.
// v33.3 additions:
//   Fix 1 — an out-of-range object row (see isOutOfRange()/Fix 6 above,
//     v33.1) is now ALSO rendered with a strikethrough on its label, on
//     top of the existing grey color, so it reads unambiguously as "not
//     reachable" rather than just dimmed.
//   Fix 2 — a folder row's lock/hide buttons now reflect and TOGGLE the
//     folder's actual contents state instead of always forcing
//     lock=true/hidden=true. folderIsLocked()/folderIsHidden() below
//     treat a folder as "locked"/"hidden" only when EVERY object inside
//     it currently is; clicking flips every member to the opposite of
//     that state (so a second click now correctly unlocks/unhides
//     everything), and — matching the per-object lock/eye buttons — the
//     button gets the same "active" (gold) styling and icon swap
//     (lock/unlock, eye/eyeOff) once the whole folder is in that state,
//     where previously these two buttons never changed appearance at
//     all. Also now calls persistChange(), which the old handlers never
//     did.
//   Fix 3 — two aesthetic fixes to nested (in-folder) rows: the
//     indentation that marks an object as living inside an open folder
//     is more pronounced (was barely distinguishable from a top-level
//     row), and the folder open/closed chevron — previously a tiny
//     9px text glyph that was practically unreadable — is now a proper
//     SVG icon that rotates 90deg open/closed with a short transition.
// v33.4 addition:
//   Object-row jump now always lands with the object on screen: see
//   jump-time.js's executeJump()/jumpToTimestamp() "fit" frame mode —
//   selectAndJump() below is unchanged, it's what jumpToTimestamp() does
//   internally that changed.
// v33.5 addition:
//   jump-time.js's shared jump framing now centers the target in the
//   view instead of pinning it to the right edge (affects the Jump Time
//   dialog too, not just this panel) — selectAndJump()/jumpToTimestamp()
//   here are unchanged, only executeJump()'s internal framing moved.
// v35 additions:
//   Fix 1 — the panel's own scrollbar is now themed (see .objects-panel-
//     list rules in index.html); no JS changes here.
//   Fix 2 — a small "Sort by" button (App.dom.objectsPanelSortBtn) next to
//     the existing "new folder" button opens a minimal dropdown with
//     "Sort By Creation" (the pre-existing newest-id-first order, still
//     the default) and "Sort By Date", which orders by each object's Jump
//     Time anchor (getAnchorTime()) with the one closest to live data
//     (i.e. the LARGEST/most-recent anchor) first. The active mode is
//     kept in App.objectTreeSort ("creation" | "time"). Regardless of
//     mode, folders are always pinned above every top-level object exactly
//     as before — only which comparator orders the *objects within* each
//     level (top-level list and, independently, each folder's own
//     members) changes. Objects with no anchor time (hline) sort last
//     within "time" mode rather than crashing the comparator. Moving
//     objects into/out of a folder (drag-drop) already calls refresh()
//     today, so the list is naturally re-sorted under the active mode the
//     moment membership changes — no extra invalidation needed.
//   Fix 3 — REVERTED (see v36 below): rows no longer show a Jump Time
//     timestamp at all.
// v36 additions (this round of two fixes):
//   Fix 1 — removed the v35-fix-3 per-row date/time stamp entirely: it
//     reserved a fixed chunk of the row's width even while not hovered,
//     which forced the object's name to truncate (ellipsis) well before
//     it actually ran out of room. The label now gets the row's full
//     width and only gets an end ellipsis ("...", cropping the LAST
//     characters) once its own text genuinely can't fit.
//   Fix 2 — the reverse of Fix 4's drag-into-a-folder: a multi-selection
//     (or single row) can now be dragged out of a folder and dropped
//     anywhere else in the panel — empty background or any row that
//     isn't itself a folder — to move it back to the top-level list.
//     See resolveDragMoveSet() and the panel-list-level drop handler
//     near the bottom of this file.

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  var TYPE_LABELS = {
    hline: "Horizontal Line",
    vline: "Vertical Line",
    trend: "Trend Line",
    rect: "Rectangle",
    fib: "Fib Retracement",
    fibext: "Fib Expansion",
  };

  // ---- Fix 6: out-of-range bounds cache -----------------------------------
  // Re-fetched whenever the panel opens/refreshes for a new timeframe.
  // Deliberately tolerant of being stale/absent — worst case a row is
  // shown in the normal (in-range) color for one refresh until the next
  // bounds fetch resolves, never a hard failure.
  var boundsByTf = {};          // { tf: {first_time, last_time} | null }
  var boundsFetchInFlight = {}; // { tf: true } while a fetch is in flight

  function ensureBoundsForCurrentTf() {
    var tf = App.currentTf;
    if (tf === null || boundsByTf[tf] !== undefined || boundsFetchInFlight[tf]) return;
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.get_history_bounds) return;
    boundsFetchInFlight[tf] = true;
    window.pywebview.api.get_history_bounds(tf).then(function (bounds) {
      boundsFetchInFlight[tf] = false;
      boundsByTf[tf] = (bounds && bounds.first_time !== null && bounds.last_time !== null) ? bounds : null;
      if (App.objectsPanelOpen) refresh();
    }).catch(function () {
      boundsFetchInFlight[tf] = false;
      boundsByTf[tf] = null;
    });
  }

  // A timeframe switch invalidates any cached bounds for OTHER timeframes
  // too little to matter (they're cheap to refetch and rarely wrong for
  // long), but the currently-displayed one is what every visible row's
  // grey/normal color depends on, so drop its cache entry on every switch
  // and let ensureBoundsForCurrentTf() above refetch it fresh.
  function invalidateBoundsCache() {
    boundsByTf = {};
    boundsFetchInFlight = {};
  }

  // Fix 6: "the object's time" means its anchor time WITHOUT the Fix 5
  // jump offset — getAnchorTime() already returns exactly that (the raw
  // {time, price} position drawn/stored on the object), so this reuses it
  // rather than duplicating the per-type logic.
  function isOutOfRange(obj) {
    var tf = App.currentTf;
    var bounds = tf !== null ? boundsByTf[tf] : null;
    if (!bounds) return false; // unknown bounds -> don't grey out speculatively
    var anchor = App.DrawingEngine.getAnchorTime(obj);
    if (anchor === null) return false; // hline: no time position, never greyed
    return anchor < Number(bounds.first_time);
  }

  // ---- Multi-select helpers (Fix 2) ---------------------------------------
  function isPanelSelected(obj) {
    return App.panelSelectedObjects.indexOf(obj) !== -1;
  }

  function clearSelection() {
    App.panelSelectedObjects = [];
    App.panelLastClickedObject = null;
    if (App.selectedObject) { App.selectedObject = null; App.interaction = null; }
  }

  // v33.2 fix 5: sort by obj.id (a monotonic App.nextObjectId counter —
  // see state.js/drawing-engine.js) descending, so "newest first" is an
  // explicit, unambiguous rule rather than depending on App.drawObjects
  // happening to still be in creation-push order.
  function byNewestFirst(a, b) { return b.id - a.id; }

  // v35 fix 2: "Sort By Date" — orders by each object's Jump Time anchor
  // (App.DrawingEngine.getAnchorTime(), the same timestamp the row itself
  // jumps to), largest/most-recent first so the object closest to live
  // data sits at the top. hlines have no anchor time (getAnchorTime()
  // returns null for them) — those sort after every timed object, and
  // fall back to byNewestFirst() to break ties (including hline-vs-hline)
  // so the order is still fully deterministic rather than depending on
  // whatever order the sort happened to leave them in.
  function byJumpTimeNewestFirst(a, b) {
    var ta = App.DrawingEngine.getAnchorTime(a);
    var tb = App.DrawingEngine.getAnchorTime(b);
    if (ta === null && tb === null) return byNewestFirst(a, b);
    if (ta === null) return 1;
    if (tb === null) return -1;
    if (tb !== ta) return tb - ta;
    return byNewestFirst(a, b);
  }

  function objectComparator() {
    return App.objectTreeSort === "time" ? byJumpTimeNewestFirst : byNewestFirst;
  }

  function orderedVisibleList() {
    // Flat, on-screen row order (folders inline with their members) — used
    // both to render and to resolve a Shift+click range, so "between the
    // first and last clicked row" means what the user actually sees.
    var rows = [];
    var topLevel = App.drawObjects.filter(function (o) { return !o.folderId; });
    var byFolder = {};
    App.drawObjects.forEach(function (o) {
      if (o.folderId) {
        if (!byFolder[o.folderId]) byFolder[o.folderId] = [];
        byFolder[o.folderId].push(o);
      }
    });
    // Folders are always pinned above every top-level object (fix 5),
    // newest folder first among folders themselves — this pin/order is
    // unaffected by App.objectTreeSort (v35 fix 2): only the objects
    // *within* each level (top-level, and independently each folder's own
    // members) follow the active Sort By mode.
    var cmp = objectComparator();
    App.objectFolders.slice().sort(byNewestFirst).forEach(function (folder) {
      rows.push({ kind: "folder", folder: folder });
      // v33.2 fix 6: a collapsed folder hides its members from the panel
      // list entirely (they're still in App.drawObjects and still drawn
      // on the chart — only this list of visible rows omits them).
      if (!folder.collapsed) {
        (byFolder[folder.id] || []).slice().sort(cmp).forEach(function (o) {
          rows.push({ kind: "object", obj: o, folder: folder });
        });
      }
    });
    topLevel.slice().sort(cmp).forEach(function (o) {
      rows.push({ kind: "object", obj: o, folder: null });
    });
    return rows;
  }

  function selectRange(fromObj, toObj) {
    var rows = orderedVisibleList().filter(function (r) { return r.kind === "object"; });
    var objs = rows.map(function (r) { return r.obj; });
    var i0 = objs.indexOf(fromObj), i1 = objs.indexOf(toObj);
    if (i0 === -1 || i1 === -1) return [toObj];
    var lo = Math.min(i0, i1), hi = Math.max(i0, i1);
    return objs.slice(lo, hi + 1);
  }

  // v33.2 fix 1: manual double-click detection by click timestamp, used
  // INSTEAD OF a native "dblclick" listener on the label — see the fix-1
  // note atop this file for why the native event was unreliable here.
  var DOUBLE_CLICK_MS = 400;
  var lastRowClick = { obj: null, time: 0 };

  // A left click on a row, respecting Ctrl (toggle) / Shift (range) / plain
  // (collapse-to-one, and — per Fix 2 — this IS the chart's selection too).
  function handleRowClick(obj, evt) {
    if (evt.shiftKey && App.panelLastClickedObject) {
      lastRowClick = { obj: null, time: 0 };
      App.panelSelectedObjects = selectRange(App.panelLastClickedObject, obj);
      refresh();
      return;
    }
    if (evt.ctrlKey || evt.metaKey) {
      lastRowClick = { obj: null, time: 0 };
      var idx = App.panelSelectedObjects.indexOf(obj);
      if (idx === -1) App.panelSelectedObjects.push(obj);
      else App.panelSelectedObjects.splice(idx, 1);
      App.panelLastClickedObject = obj;
      refresh();
      return;
    }

    var now = Date.now();
    var isDoubleClick = lastRowClick.obj === obj && (now - lastRowClick.time) < DOUBLE_CLICK_MS;
    lastRowClick = { obj: null, time: 0 };

    if (isDoubleClick) {
      // Select (no jump) and start the inline rename on the row that's
      // about to be (re)rendered for this object.
      App.panelSelectedObjects = [obj];
      App.panelLastClickedObject = obj;
      App.selectedObject = obj;
      App.interaction = null;
      refresh();
      beginRenameFor(obj);
      return;
    }
    lastRowClick = { obj: obj, time: now };

    // Plain (single) click: collapse to just this row, and this becomes
    // the chart's own single selection + jump target — the same behavior
    // the v33 panel always had for an unmodified click.
    App.panelSelectedObjects = [obj];
    App.panelLastClickedObject = obj;
    selectAndJump(obj);
  }

  // Finds the freshly-rendered row for `obj` (built by the refresh() call
  // just before this runs) and starts the inline rename on its label.
  function beginRenameFor(obj) {
    var row = dom.objectsPanelList.querySelector('.obj-row[data-obj-id="' + obj.id + '"]');
    var label = row && row.querySelector(".obj-row-label");
    if (!label) return;
    startRenameLabel(label, obj.name || TYPE_LABELS[obj.type] || obj.type, function (newName) {
      obj.name = newName;
      App.DrawingEngine.persistChange();
    });
  }

  // A row's action buttons act on the whole multi-selection ONLY when the
  // clicked row is itself part of one; otherwise they act on just that row
  // — so clicking lock/hide/delete on an unrelated, non-selected row never
  // surprises the user by also touching whatever else happens to be
  // multi-selected elsewhere in the panel.
  function bulkApplyOrSingle(obj, fn) {
    if (isPanelSelected(obj) && App.panelSelectedObjects.length > 1) {
      App.panelSelectedObjects.slice().forEach(fn);
    } else {
      fn(obj);
    }
  }

  // ---- Row builders --------------------------------------------------------
  function buildObjectRow(obj, inFolder) {
    var row = document.createElement("div");
    row.className = "obj-row";
    row.dataset.objId = String(obj.id);
    if (App.selectedObject === obj) row.className += " active";
    else if (isPanelSelected(obj)) row.className += " panel-selected";
    if (obj.hidden) row.className += " obj-hidden";
    if (isOutOfRange(obj)) row.className += " obj-out-of-range";
    if (inFolder) row.className += " obj-in-folder";
    row.draggable = true;

    var icon = document.createElement("span");
    icon.className = "obj-row-icon";
    icon.innerHTML = App.Icons[obj.type] ? App.Icons[obj.type]() : "";
    row.appendChild(icon);

    var label = document.createElement("span");
    label.className = "obj-row-label";
    label.textContent = obj.name || TYPE_LABELS[obj.type] || obj.type;
    row.appendChild(label);

    // v33.2 fix 1: renaming is driven entirely by handleRowClick's manual
    // double-click detection now (see the fix-1 note atop this file) — no
    // native "dblclick" listener here anymore, since refresh() rebuilding
    // the row on every plain click made that listener unreliable.

    var actions = document.createElement("span");
    actions.className = "obj-row-actions";

    var lockBtn = document.createElement("button");
    lockBtn.type = "button";
    lockBtn.className = "obj-row-btn" + (obj.locked ? " active" : "");
    lockBtn.title = obj.locked ? "Unlock" : "Lock";
    lockBtn.innerHTML = obj.locked ? App.Icons.lock() : App.Icons.unlock();
    lockBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      var next = !obj.locked;
      bulkApplyOrSingle(obj, function (o) { App.DrawingEngine.setLocked(o, next); });
    });

    var eyeBtn = document.createElement("button");
    eyeBtn.type = "button";
    eyeBtn.className = "obj-row-btn" + (obj.hidden ? " active" : "");
    eyeBtn.title = obj.hidden ? "Show" : "Hide";
    eyeBtn.innerHTML = obj.hidden ? App.Icons.eyeOff() : App.Icons.eye();
    eyeBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      var next = !obj.hidden;
      bulkApplyOrSingle(obj, function (o) { App.DrawingEngine.setHidden(o, next); });
    });

    var trashBtn = document.createElement("button");
    trashBtn.type = "button";
    trashBtn.className = "obj-row-btn obj-row-btn-danger";
    trashBtn.title = "Delete";
    trashBtn.innerHTML = App.Icons.trash();
    trashBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      bulkApplyOrSingle(obj, function (o) { App.DrawingEngine.removeObject(o); });
      refresh();
    });

    actions.appendChild(lockBtn);
    actions.appendChild(eyeBtn);
    actions.appendChild(trashBtn);
    row.appendChild(actions);

    row.addEventListener("click", function (evt) { handleRowClick(obj, evt); });

    // Fix 4: drag this row (and, if it's part of a multi-selection, every
    // other selected row) onto a folder row to move them all into it.
    row.addEventListener("dragstart", function (evt) {
      if (!isPanelSelected(obj)) {
        App.panelSelectedObjects = [obj];
        App.panelLastClickedObject = obj;
        refresh();
      }
      evt.dataTransfer.effectAllowed = "move";
      evt.dataTransfer.setData("text/plain", String(obj.id));
    });

    return row;
  }

  // Shared by both drop targets (a folder row, and the panel list itself
  // for the reverse move) — the multi-selection if the dragged row is
  // part of one, otherwise just the single dragged object recovered from
  // the drag event's payload.
  function resolveDragMoveSet(evt) {
    var moving = App.panelSelectedObjects.length ? App.panelSelectedObjects.slice() : [];
    if (!moving.length) {
      var draggedId = Number(evt.dataTransfer.getData("text/plain"));
      var draggedObj = App.drawObjects.filter(function (o) { return o.id === draggedId; })[0];
      if (draggedObj) moving = [draggedObj];
    }
    return moving;
  }

  function folderMembers(folder) {
    return App.drawObjects.filter(function (o) { return o.folderId === folder.id; });
  }

  // v33.3 fix 2: a folder is treated as "locked"/"hidden" only when it has
  // at least one object AND every one of them currently is — this is what
  // the lock/hide buttons toggle against (so a second click reliably
  // reverses the first), and what decides their pressed/active look.
  function folderIsLocked(folder) {
    var members = folderMembers(folder);
    return members.length > 0 && members.every(function (o) { return !!o.locked; });
  }
  function folderIsHidden(folder) {
    var members = folderMembers(folder);
    return members.length > 0 && members.every(function (o) { return !!o.hidden; });
  }

  function buildFolderRow(folder) {
    var row = document.createElement("div");
    row.className = "obj-row obj-folder-row";

    // v33.2 fix 6: a small chevron shows/toggles the folder's open/closed
    // state — clicking anywhere on the row (except the label mid-rename)
    // toggles it, same as clicking the chevron itself.
    // v33.3 fix 3: SVG chevron (drawn pointing right/"closed") instead of
    // the old 9px text glyph; CSS rotates it 90deg when open, so the same
    // icon serves both states with a smooth transition rather than a hard
    // glyph swap.
    var chevron = document.createElement("span");
    chevron.className = "obj-folder-chevron" + (folder.collapsed ? "" : " obj-folder-chevron-open");
    chevron.innerHTML = App.Icons.chevron ? App.Icons.chevron() : (folder.collapsed ? "\u25B8" : "\u25BE");
    row.appendChild(chevron);

    var icon = document.createElement("span");
    icon.className = "obj-row-icon";
    icon.innerHTML = App.Icons.folder ? App.Icons.folder() : "";
    row.appendChild(icon);

    var label = document.createElement("span");
    label.className = "obj-row-label";
    label.textContent = folder.name;
    row.appendChild(label);

    // v33.2 fix 6: clicks on the label itself never bubble to the row's
    // open/close toggle (added just below) — otherwise a click on the
    // label meant to start a rename (or either half of a double-click)
    // would also flip the folder open/closed underneath it.
    label.addEventListener("click", function (evt) { evt.stopPropagation(); });
    label.addEventListener("dblclick", function (evt) {
      evt.stopPropagation();
      startRenameLabel(label, folder.name, function (newName) {
        folder.name = newName;
        App.DrawingEngine.persistChange();
      });
    });

    var actions = document.createElement("span");
    actions.className = "obj-row-actions";

    // v33.3 fix 2: mirrors the per-object lock/eye buttons — icon, title,
    // and "active" styling now reflect whether the folder's contents are
    // ALL currently locked/hidden, and a click toggles to the opposite of
    // that state (previously these always forced true, so a second click
    // did nothing and the buttons never visually changed).
    var folderLocked = folderIsLocked(folder);
    var lockBtn = document.createElement("button");
    lockBtn.type = "button";
    lockBtn.className = "obj-row-btn" + (folderLocked ? " active" : "");
    lockBtn.title = folderLocked ? "Unlock folder contents" : "Lock folder contents";
    lockBtn.innerHTML = folderLocked ? App.Icons.lock() : App.Icons.unlock();
    lockBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      var next = !folderIsLocked(folder);
      folderMembers(folder).forEach(function (o) { App.DrawingEngine.setLocked(o, next); });
    });

    var folderHidden = folderIsHidden(folder);
    var eyeBtn = document.createElement("button");
    eyeBtn.type = "button";
    eyeBtn.className = "obj-row-btn" + (folderHidden ? " active" : "");
    eyeBtn.title = folderHidden ? "Show folder contents" : "Hide folder contents";
    eyeBtn.innerHTML = folderHidden ? App.Icons.eyeOff() : App.Icons.eye();
    eyeBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      var next = !folderIsHidden(folder);
      folderMembers(folder).forEach(function (o) { App.DrawingEngine.setHidden(o, next); });
    });

    var trashBtn = document.createElement("button");
    trashBtn.type = "button";
    trashBtn.className = "obj-row-btn obj-row-btn-danger";
    trashBtn.title = "Delete folder and its contents";
    trashBtn.innerHTML = App.Icons.trash();
    trashBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      folderMembers(folder).forEach(function (o) { App.DrawingEngine.removeObject(o); });
      var fIdx = App.objectFolders.indexOf(folder);
      if (fIdx !== -1) App.objectFolders.splice(fIdx, 1);
      App.DrawingEngine.persistChange();
      refresh();
    });

    actions.appendChild(lockBtn);
    actions.appendChild(eyeBtn);
    actions.appendChild(trashBtn);
    row.appendChild(actions);

    // v33.2 fix 6: click on the folder row toggles it open/closed (its
    // members show/hide in the panel accordingly — see
    // orderedVisibleList()); this also stops the click from bubbling to
    // the panel-empty-space handler, same as before — folders aren't
    // chart objects and have no anchor time to jump to or select.
    row.addEventListener("click", function (evt) {
      evt.stopPropagation();
      folder.collapsed = !folder.collapsed;
      refresh();
    });

    row.addEventListener("dragover", function (evt) {
      evt.preventDefault();
      evt.dataTransfer.dropEffect = "move";
      row.classList.add("obj-folder-dragover");
    });
    row.addEventListener("dragleave", function () {
      row.classList.remove("obj-folder-dragover");
    });
    row.addEventListener("drop", function (evt) {
      evt.preventDefault();
      // Fix 2 (reverse move): stop this from also bubbling up to the
      // panel-list-level drop handler below, which would otherwise
      // immediately pull the very same objects back OUT of the folder
      // right after this handler just moved them in.
      evt.stopPropagation();
      row.classList.remove("obj-folder-dragover");
      var moving = resolveDragMoveSet(evt);
      moving.forEach(function (o) { o.folderId = folder.id; });
      // v33.2 fix 6: open the folder on drop so the moved-in objects are
      // immediately visible, indented under it — confirming the move
      // instead of just silently vanishing from the flat list.
      if (moving.length) {
        folder.collapsed = false;
        App.DrawingEngine.persistChange();
      }
      refresh();
    });

    return row;
  }

  // Shared inline-rename UI for both object rows and folder rows: swaps
  // the label span for a text input, pre-filled with the current name,
  // committed on Enter/blur and cancelled on Escape.
  function startRenameLabel(labelEl, currentName, onCommit) {
    var input = document.createElement("input");
    input.type = "text";
    input.className = "obj-row-rename-input";
    input.value = currentName;
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    var done = false;
    function commit() {
      if (done) return;
      done = true;
      var val = input.value.trim();
      if (val) onCommit(val);
      refresh();
    }
    function cancel() {
      if (done) return;
      done = true;
      refresh();
    }
    input.addEventListener("keydown", function (evt) {
      evt.stopPropagation();
      if (evt.key === "Enter") { evt.preventDefault(); commit(); }
      else if (evt.key === "Escape") { evt.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
    input.addEventListener("click", function (evt) { evt.stopPropagation(); });
  }

  function selectAndJump(obj) {
    App.selectedObject = obj;
    App.interaction = null;
    refresh();

    // v33.2 fix 3: a grey/out-of-range row can be selected (and its
    // lock/hide/delete buttons used) exactly like any other row, but it
    // is never a Jump target — no attempt is made at all, not even one
    // that would just fail with "outside the available data range".
    if (isOutOfRange(obj)) {
      App.DrawingEngine.showHint("Jump disabled — this object is outside the loaded historical data");
      return;
    }

    var anchor = App.DrawingEngine.getAnchorTime(obj);
    if (anchor === null) {
      if (obj.type === "hline") App.DrawingEngine.showHint("Horizontal lines have no Jump position");
      return;
    }
    App.JumpTime.jumpToTimestamp(anchor).then(function (ok) {
      if (!ok) App.DrawingEngine.showHint("Can't jump — outside the available data range");
    });
    // v39: also jump every visible companion multi-chart panel to this
    // object's anchor time, same as Home/End/Jump Time (SPACE) — see
    // multi-panel.js's jumpAllToTimestamp(). Fired unconditionally alongside
    // the primary jump above, independent of whether it succeeds, exactly
    // like the Home/End handlers in keyboard-shortcuts.js do.
    if (App.MultiPanel && App.MultiPanel.jumpAllToTimestamp) App.MultiPanel.jumpAllToTimestamp(anchor);
  }

  function refresh() {
    // v41 perf: every selection change in this panel (row click, Ctrl/Shift
    // multi-select, rename, folder collapse) calls refresh() whether or not
    // it also calls App.DrawingEngine.persistChange() - and a selection
    // change alone (e.g. clicking a row to highlight an object on the
    // chart) needs the overlay to repaint even with no create/lock/hide/
    // delete involved. Hooking it here, rather than at every call site
    // above, covers all of them in one place.
    if (App.DrawingEngine && App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();
    // v57 Update 12 (perf): refresh() is called from DrawingEngine's
    // persistChange() on EVERY create/move/resize/style/lock/hide/delete, and
    // from every selection change - whether or not the Object Tree panel is
    // even open. Rebuilding the panel's entire DOM (one row element, three
    // icon buttons and four listeners per object) for a panel that is closed
    // is pure waste; a drag-heavy session with a few dozen objects was paying
    // it on every single mouse-up. Mark it stale instead and rebuild once, in
    // open(), when it actually becomes visible.
    // open() sets App.objectsPanelOpen before calling refresh(), so opening
    // the panel always rebuilds it from the current state.
    if (!App.objectsPanelOpen) return;
    ensureBoundsForCurrentTf();
    dom.objectsPanelList.innerHTML = "";
    var rows = orderedVisibleList();
    if (!rows.length) {
      var empty = document.createElement("div");
      empty.className = "obj-panel-empty";
      empty.textContent = "No objects on this chart";
      dom.objectsPanelList.appendChild(empty);
      return;
    }
    rows.forEach(function (r) {
      if (r.kind === "folder") dom.objectsPanelList.appendChild(buildFolderRow(r.folder));
      else dom.objectsPanelList.appendChild(buildObjectRow(r.obj, !!r.folder));
    });
  }

  function createFolder() {
    var folder = { id: App.nextFolderId++, name: "New Folder", collapsed: false };
    App.objectFolders.push(folder);
    App.DrawingEngine.persistChange();
    refresh();
  }

  function open() {
    dom.objectsPanelEl.classList.add("open");
    App.objectsPanelOpen = true;
    dom.objectsPanelToggle.classList.add("active");
    // App.objectsPanelOpen is set BEFORE this call on purpose - refresh()
    // reads it to decide whether to build rows (see v57 Update 12 above).
    refresh();
  }

  function close() {
    dom.objectsPanelEl.classList.remove("open");
    App.objectsPanelOpen = false;
    dom.objectsPanelToggle.classList.remove("active");
  }

  function toggle() {
    if (App.objectsPanelOpen) close(); else open();
  }

  dom.objectsPanelToggle.innerHTML = App.Icons.layers();
  dom.objectsPanelToggle.addEventListener("click", toggle);
  dom.objectsPanelClose.addEventListener("click", close);
  if (dom.objectsPanelNewFolder) {
    dom.objectsPanelNewFolder.innerHTML = App.Icons.folderPlus ? App.Icons.folderPlus() : "+";
    dom.objectsPanelNewFolder.addEventListener("click", createFolder);
  }

  // v35 fix 2: "Sort by" dropdown — same open/close/outside-click pattern
  // as the header's own tf-dropdown (see chart-core.js), scoped to its own
  // .obj-panel-sort-wrap wrapper so it doesn't interfere with that other
  // dropdown. Picking an option updates App.objectTreeSort and re-renders
  // (orderedVisibleList() above already reads it on every refresh()).
  function closeSortMenu() {
    if (dom.objectsPanelSortWrap) dom.objectsPanelSortWrap.classList.remove("open");
  }
  function toggleSortMenu(evt) {
    evt.stopPropagation();
    if (!dom.objectsPanelSortWrap) return;
    dom.objectsPanelSortWrap.classList.toggle("open");
  }
  function setSortMode(mode) {
    App.objectTreeSort = mode;
    closeSortMenu();
    if (dom.objectsPanelSortCreationBtn) dom.objectsPanelSortCreationBtn.classList.toggle("active", mode === "creation");
    if (dom.objectsPanelSortTimeBtn) dom.objectsPanelSortTimeBtn.classList.toggle("active", mode === "time");
    refresh();
  }
  if (dom.objectsPanelSortBtn) {
    dom.objectsPanelSortBtn.innerHTML = App.Icons.sort ? App.Icons.sort() : "";
    dom.objectsPanelSortBtn.addEventListener("click", toggleSortMenu);
  }
  if (dom.objectsPanelSortCreationBtn) {
    dom.objectsPanelSortCreationBtn.classList.add("active"); // "creation" is the default
    dom.objectsPanelSortCreationBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      setSortMode("creation");
    });
  }
  if (dom.objectsPanelSortTimeBtn) {
    dom.objectsPanelSortTimeBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      setSortMode("time");
    });
  }
  document.addEventListener("click", closeSortMenu);

  // v33.1 Fix 2: a click anywhere in the panel that ISN'T on a row (empty
  // list background, header) also unselects everything — matching the
  // "click outside the object rows" unselect rule.
  dom.objectsPanelList.addEventListener("click", function (evt) {
    if (evt.target === dom.objectsPanelList) {
      clearSelection();
      refresh();
    }
  });

  // Fix 2 — the reverse of Fix 4's "drag onto a folder row to move in":
  // dropping the same drag-selection anywhere in the panel that ISN'T a
  // folder row (empty background, or any top-level/in-folder object row —
  // neither of which has its own drop handler, so the event bubbles up to
  // here) clears folderId on every moved object, i.e. pulls them back out
  // to the top-level list. A folder row's own drop handler above always
  // stops this event from reaching here, so dropping directly on a folder
  // still moves objects IN, never immediately back out.
  dom.objectsPanelList.addEventListener("dragover", function (evt) {
    evt.preventDefault();
    evt.dataTransfer.dropEffect = "move";
  });
  dom.objectsPanelList.addEventListener("drop", function (evt) {
    evt.preventDefault();
    var moving = resolveDragMoveSet(evt).filter(function (o) { return !!o.folderId; });
    if (moving.length) {
      moving.forEach(function (o) { o.folderId = null; });
      App.DrawingEngine.persistChange();
      refresh();
    }
  });

  // v33.1 Fix 6: the grey/normal split depends on the CURRENT timeframe's
  // bounds, so a timeframe switch invalidates the cache and (if the panel
  // is open) triggers a refetch + re-render — otherwise switching from,
  // say, 1s to 1h would keep showing 1s-relative grey states.
  document.addEventListener("App:timeframeChanged", function () {
    invalidateBoundsCache();
    if (App.objectsPanelOpen) refresh();
  });

  App.ObjectsPanel = { open: open, close: close, toggle: toggle, refresh: refresh };
})();
