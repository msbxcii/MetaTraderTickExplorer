// =============================================================================
// replay-bar.js — v41: Bar Replay + Sliding Window parity.
//
// Lets the user pick a point in the past, hides every candle after it, and
// then plays the chart forward from that point exactly like a live feed.
 // v41 also gives Replay the same bounded two-partition Sliding Window used
 // by normal navigation, including timestamp-based older/newer edge loading —
// at a chosen speed multiplier (1x/5x/10x/30x/60x) — using nothing but data
// already exposed by the existing pywebview API (get_history_bounds,
// get_history_window and get_history_page_after — no backend changes).
//
// Design, in one paragraph: the engine always streams the FINEST cached
// granularity (1-second candles, timeframe key "1") forward from the chosen
// point, one small paged fetch at a time, and aggregates those 1-second
// candles into whatever timeframe is currently on screen — exactly the way
// chart-core.js's own live-tick merge already builds the active timeframe's
// last candle out of incoming ticks (see mergeAuthoritativeTail). Driving
// everything off the 1-second stream, rather than re-fetching the active
// timeframe repeatedly, is what makes "10x on a 1m chart" and "60x on a 1m
// chart" (see the spec's two worked examples) fall out of the SAME simple
// rule (`speed` 1-second candles delivered per real second) instead of
// needing a special case per timeframe.
//
// A single setInterval — reset only when the speed or the play/pause state
// changes — drives playback. That, plus a small look-ahead buffer of
// already-fetched 1-second candles, is the entire runtime cost: one timer,
// one array, no per-frame work, regardless of how fast replay is running.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  // ---- module state ---------------------------------------------------
  App.replayActive = false;      // Replay mode on (bar visible, header icon gold)
  App.replayPlaying = false;     // currently advancing candles
  App.replaySpeed = 1;           // 1 | 5 | 10 | 30 | 60
  App.replayTf = null;           // the timeframe Replay was started for (locked)

  var queue = [];                // buffered 1s candles not yet consumed
  var cursorTime = null;         // last 1s time already fetched up through
  var fetching = false;          // a get_history_page_after(1, ...) is in flight
  var reachedLive = false;       // the 1s stream has caught up to now
  var building = null;           // in-progress aggregate candle for App.replayTf
  var timer = null;              // setInterval id while playing
  var hasSelection = false;      // a Select Date target has been applied
  var lastFedTime = null;        // v40 Update 4: 1s-time of the last candle
                                  // actually consumed into `building` — the
                                  // replay "playhead". Used both to reseed
                                  // App.replayTf on a dynamic timeframe
                                  // change and to size the Update 5 object
                                  // visibility cutoff.
  var forceHiddenIds = [];       // v40 Update 5: ids of objects THIS module
                                  // hid because they sit after the replay
                                  // cutoff — never objects the user already
                                  // had hidden themselves (those are left
                                  // alone on entry and exit alike).

  var PREFETCH_CHUNK = 600;      // ~10 minutes of 1s candles per page
  var PREFETCH_LOW_WATER = 80;   // fetch more once the buffer drops below this
  // v40.1 perf fix: feedOneCandle() used to arr.push() forever with no
  // eviction — a 30-60x replay session run for a while builds tens of
  // thousands of resident candles on the active timeframe (worse still
  // across every open multi-chart panel at once, see multi-panel.js),
  // which is exactly the RAM growth + progressive slowdown reported after
  // long multi-chart sessions. Cap resident candles the same way ordinary
  // Sliding-Window history already does, and only trim in batches (not on
  // every single tick) so the occasional series.setData() this requires
  // stays rare.

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function fmtDate(ts) {
    var d = new Date(Number(ts) * 1000);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }
  function fmtTime(ts) {
    var d = new Date(Number(ts) * 1000);
    return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds());
  }

  // =====================================================================
  // Header toggle — enter/exit Replay mode.
  // =====================================================================
  function setToggleActive(active) {
    dom.replayBarToggle.classList.toggle("active", active);
    dom.replayBar.classList.toggle("open", active);
  }

  function enterReplayMode() {
    if (App.replayActive) return;
    App.replayActive = true;
    App.replayTf = App.currentTf;
    hasSelection = false;
    setToggleActive(true);
    dom.replayBar.classList.add("rb-waiting");
    // v40 Update 4: the reference timeframe dropdown stays fully usable
    // while Replay is active/playing — see App.ReplayBar.changeTimeframe()
    // and buildTfDropdown()'s click handler in chart-core.js.
    setPlayIcon(false);
    // v40 Update 6: jump straight into Select Date so the user isn't left
    // looking at an empty "waiting" bar with no obvious next step.
    openSelectDate();
  }

  function exitReplayMode() {
    if (!App.replayActive) return;
    stopPlayback();
    App.replayActive = false;
    hasSelection = false;
    building = null;
    queue = [];
    cursorTime = null;
    lastFedTime = null;
    reachedLive = false;
    fetching = false;
    App.replayTf = null;
    App.replayCutoffByTf = {};
    setToggleActive(false);
    dom.replayBar.classList.add("rb-waiting");
    // v40 Update 5: give back every object Replay hid on our own account,
    // and drop every object the user drew WHILE Replay was active — both
    // are scoped to the replay session that's now ending.
    restoreObjectVisibility();
    purgeReplayTempObjects();
    restoreLiveData();
    document.dispatchEvent(new CustomEvent("App:replayExited"));
  }

  // Reload the active timeframe fresh from the backend and jump back to the
  // live edge — undoes the temporary "future candles hidden" truncation
  // Select Date applied, and resumes normal live-tick merging (guarded off
  // in chart-core.js by App.replayActive, which is now false again).
  function restoreLiveData() {
    var tf = App.currentTf;
    if (tf === null || !window.pywebview || !window.pywebview.api) return;
    var w = App.windowByTf[tf];
    // Forces ChartCore.jumpToLatest() to take its full-refetch branch
    // instead of the "already live, just scroll" shortcut — the resident
    // window here may still be a truncated Replay snapshot.
    if (w) w.rightIsLive = false;
    if (App.ChartCore && App.ChartCore.jumpToLatest) App.ChartCore.jumpToLatest();
  }

  dom.replayBarToggle.addEventListener("click", function () {
    if (App.replayActive) exitReplayMode();
    else enterReplayMode();
  });

  dom.replayCloseBtn.addEventListener("click", exitReplayMode);

  // =====================================================================
  // Select Date modal.
  // =====================================================================
  var calYear = null, calMonth = null;   // month currently shown (0-indexed)
  var calSelectedTs = null;              // seconds, floored to the day
  var bounds = null;                     // {first_time, last_time} for tf=1

  var WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

  function isoWeekday(d) { // 0=Mon..6=Sun
    return (d.getUTCDay() + 6) % 7;
  }

  function dayBoundsOk(ts) {
    if (!bounds || bounds.first_time === null || bounds.last_time === null) return true;
    return ts >= Number(bounds.first_time) && ts <= Number(bounds.last_time);
  }

  function renderCalendar() {
    dom.rbdCalTitle.textContent = new Date(Date.UTC(calYear, calMonth, 1))
      .toLocaleString("en-US", { month: "long", timeZone: "UTC" }) + " " + calYear;

    var grid = dom.rbdCalGrid;
    grid.innerHTML = "";
    WEEKDAY_LABELS.forEach(function (lbl) {
      var el = document.createElement("div");
      el.className = "rbd-cal-dow";
      el.textContent = lbl;
      grid.appendChild(el);
    });

    var firstOfMonth = new Date(Date.UTC(calYear, calMonth, 1));
    var leading = isoWeekday(firstOfMonth);
    var daysInMonth = new Date(Date.UTC(calYear, calMonth + 1, 0)).getUTCDate();

    for (var i = 0; i < leading; i++) {
      var blank = document.createElement("div");
      blank.className = "rbd-cal-day rbd-cal-day-out";
      grid.appendChild(blank);
    }

    var selectedDayTs = calSelectedTs === null ? null : Math.floor(calSelectedTs / 86400) * 86400;

    for (var day = 1; day <= daysInMonth; day++) {
      var dayTs = Math.floor(Date.UTC(calYear, calMonth, day) / 1000);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rbd-cal-day";
      btn.textContent = String(day);
      if (!dayBoundsOk(dayTs)) btn.classList.add("rbd-cal-day-disabled");
      if (selectedDayTs !== null && dayTs === selectedDayTs) btn.classList.add("rbd-cal-day-selected");
      (function (ts) {
        btn.addEventListener("click", function () {
          selectDay(ts);
        });
      })(dayTs);
      grid.appendChild(btn);
    }
  }

  function selectDay(dayTs) {
    // Keep whatever time-of-day is currently in the time field.
    var timeParts = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((dom.rbdTimeInput.value || "").trim());
    var hh = timeParts ? Number(timeParts[1]) : 0;
    var mm = timeParts ? Number(timeParts[2]) : 0;
    var ss = timeParts ? Number(timeParts[3] || 0) : 0;
    calSelectedTs = dayTs + hh * 3600 + mm * 60 + ss;
    dom.rbdDateInput.value = fmtDate(dayTs);
    renderCalendar();
    validateFields();
  }

  function shiftMonth(delta) {
    calMonth += delta;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
  }

  function parseFields() {
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dom.rbdDateInput.value || "").trim());
    var tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((dom.rbdTimeInput.value || "").trim());
    if (!dm || !tm) return null;
    var year = Number(dm[1]), month = Number(dm[2]), day = Number(dm[3]);
    var hh = Number(tm[1]), mm = Number(tm[2]), ss = Number(tm[3] || 0);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 59) return null;
    var ms = Date.UTC(year, month - 1, day, hh, mm, ss);
    var d = new Date(ms);
    if (isNaN(ms) || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return Math.round(ms / 1000);
  }

  function validateFields() {
    var ts = parseFields();
    var ok = ts !== null && dayBoundsOk(ts);
    dom.rbdDateInput.classList.toggle("rbd-invalid", ts === null);
    dom.rbdTimeInput.classList.toggle("rbd-invalid", ts === null);
    dom.rbdSelectBtn.disabled = !ok;
    dom.rbdSelectBtn.style.opacity = ok ? "" : "0.4";
    if (ts !== null) calSelectedTs = ts;
    return ok ? ts : null;
  }

  function openSelectDate() {
    if (!App.replayActive || App.currentTf === null || !window.pywebview) return;
    App.DrawingContextMenu && App.DrawingContextMenu.close && App.DrawingContextMenu.close();

    var current = App.candlesByTf[App.currentTf] || [];
    var seedTs = current.length ? current[current.length - 1].time : Math.floor(Date.now() / 1000);
    dom.rbdDateInput.value = fmtDate(seedTs);
    dom.rbdTimeInput.value = fmtTime(seedTs);
    calSelectedTs = seedTs;
    var d = new Date(seedTs * 1000);
    calYear = d.getUTCFullYear();
    calMonth = d.getUTCMonth();

    dom.rbdBackdrop.classList.add("open");
    renderCalendar();

    window.pywebview.api.get_history_bounds(1).then(function (b) {
      bounds = b || null;
      renderCalendar();
      validateFields();
    }).catch(function () {
      bounds = null;
    });
  }

  function closeSelectDate() {
    dom.rbdBackdrop.classList.remove("open");
  }

  dom.replaySelectDateBtn.addEventListener("click", openSelectDate);
  dom.rbdClose.addEventListener("click", closeSelectDate);
  dom.rbdCancelBtn.addEventListener("click", closeSelectDate);
  dom.rbdCalPrev.addEventListener("click", function () { shiftMonth(-1); });
  dom.rbdCalNext.addEventListener("click", function () { shiftMonth(1); });
  [dom.rbdDateInput, dom.rbdTimeInput].forEach(function (el) {
    el.addEventListener("input", validateFields);
    el.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") { evt.preventDefault(); dom.rbdSelectBtn.click(); }
      else if (evt.key === "Escape") { evt.preventDefault(); closeSelectDate(); }
    });
  });
  dom.rbdBackdrop.addEventListener("mousedown", function (evt) {
    if (evt.target === dom.rbdBackdrop) closeSelectDate();
  });

  dom.rbdSelectBtn.addEventListener("click", function () {
    var ts = validateFields();
    if (ts === null) return;
    closeSelectDate();
    beginReplayAt(ts);
  });

  // =====================================================================
  // v40 Update 5: temporary future-object hiding.
  // Objects anchored after the chosen replay point are hidden for the
  // duration of the replay session — using the SAME `hidden` flag the
  // Object Tree's own eye icon uses, so no rendering/hit-test code
  // anywhere else needs to know Replay exists — but only ever objects
  // that weren't already hidden by the user, and only ever undone by this
  // module's own restoreObjectVisibility(). getAnchorTime() already
  // returns null for hlines (no time component), so those are correctly
  // left alone/always visible, exactly like every other timeframe-
  // independent view of these objects.
  // =====================================================================
  function applyObjectVisibility(cutoffTime) {
    restoreObjectVisibility();
    if (!App.DrawingEngine || !App.DrawingEngine.getAnchorTime) return;
    App.drawObjects.forEach(function (obj) {
      if (obj.hidden) return; // already hidden by the user - leave it alone
      var t = App.DrawingEngine.getAnchorTime(obj);
      if (t === null || t === undefined) return;
      if (t > cutoffTime) {
        obj.hidden = true;
        forceHiddenIds.push(obj.id);
      }
    });
    if (App.ObjectsPanel && App.ObjectsPanel.refresh) App.ObjectsPanel.refresh();
  }

  function restoreObjectVisibility() {
    if (!forceHiddenIds.length) return;
    forceHiddenIds.forEach(function (id) {
      for (var i = 0; i < App.drawObjects.length; i++) {
        if (App.drawObjects[i].id === id) { App.drawObjects[i].hidden = false; break; }
      }
    });
    forceHiddenIds = [];
    if (App.ObjectsPanel && App.ObjectsPanel.refresh) App.ObjectsPanel.refresh();
  }

  function purgeReplayTempObjects() {
    if (!App.DrawingEngine || !App.DrawingEngine.removeObject) return;
    App.drawObjects.slice().forEach(function (obj) {
      if (obj._replayTemp) App.DrawingEngine.removeObject(obj);
    });
  }

  // v41: convert the bounded Jump-Time result into the same two-slot
  // representation used by normal live startup. The rightmost slot is the
  // current Replay playhead; older history is loaded lazily by the existing
  // Sliding Window edge loader. No third resident partition is introduced.
  function rebaseReplayWindow(tf, candles, jumpWindow, pageIsOldest) {
    var clean = (candles || []).slice();
    var w = App.SlidingWindow.create();
    // Jump Time already gave us one bounded historical partition ending at
    // the selected point. Keep that complete partition as Replay's right
    // slot. Do NOT manufacture a second partition by slicing it again: the
    // normal Sliding Window starts with one resident slot and creates the
    // second only when the user approaches an edge.
    w.older = null;
    w.newer = clean;
    w.rightIsLive = false;      // Replay never claims the real-Live slot.
    w.rightIsReplay = true;     // the right slot is the Replay playhead.
    // Preserve the exact oldest-boundary decision already made by the shared
    // Jump-Time transaction. This is the critical difference from the old
    // V41 implementation: a one-partition Replay window is NOT automatically
    // considered exhausted just because its `older` slot is null.
    w.exhaustedOlder = jumpWindow ? !!jumpWindow.exhaustedOlder : !!pageIsOldest;
    App.windowByTf[tf] = w;
    App.candlesByTf[tf] = App.SlidingWindow.combine(w);
    App.edgeLoadArmed.older = true;
    App.edgeLoadArmed.newer = true;
    if (!App.replayCutoffByTf) App.replayCutoffByTf = {};
    App.replayCutoffByTf[tf] = w.newer.length ? w.newer[w.newer.length - 1].time : null;
  }

  // =====================================================================
  // Applying the chosen point: hide every future candle on the active
  // timeframe and jump the view to it, reusing the existing Jump Time
  // sliding-window mechanics (jumpToTimestamp) rather than duplicating
  // them — Select Date's "hide the future, land on this moment" is just
  // that same jump, plus one truncation of the freshly-loaded array.
  // =====================================================================
  function beginReplayAt(ts) {
    var tf = App.currentTf;
    if (tf === null || !App.JumpTime) return;
    stopPlayback();

    App.JumpTime.jumpToTimestamp(ts).then(function (ok) {
      if (!ok || App.currentTf !== tf) return;

      var target = Math.floor(ts / tf) * tf;
      var arr = (App.candlesByTf[tf] || []).filter(function (c) { return c.time <= target; });

      // v41: Replay is now rebased into the exact same two resident slots as
      // normal history. The selected point is the temporary "live edge";
      // walking left invokes the battle-tested SlidingWindow edge loader,
      // and walking right can only return through pages bounded by the
      // current Replay playhead.
      rebaseReplayWindow(tf, arr, App.windowByTf[tf], false);
      arr = App.candlesByTf[tf];
      if (App.series) App.series.setData(arr);
      // v40 Update 1: seed the dashed live-price line from the replayed
      // point itself, not whatever the real market happened to be doing
      // the moment Replay was opened.
      if (arr.length && App.ChartCore && App.ChartCore.setLivePrice) {
        App.ChartCore.setLivePrice(arr[arr.length - 1].close);
      }

      App.replayTf = tf;
      if (!App.replayCutoffByTf) App.replayCutoffByTf = {};
      App.replayCutoffByTf[tf] = target;
      building = arr.length ? arr[arr.length - 1] : null;
      queue = [];
      reachedLive = false;
      fetching = false;
      // The next 1-second candle to stream in is the first one AFTER this
      // timeframe's already-complete bucket, i.e. after (target + tf - 1).
      cursorTime = target + tf - 1;
      lastFedTime = cursorTime;
      hasSelection = true;
      dom.replayBar.classList.remove("rb-waiting");
      // v40 Update 5: hide every object anchored after this point for the
      // rest of the replay session.
      applyObjectVisibility(target);
      // v40 Update 2: let multi-panel.js reload every companion panel at
      // this same point, on each companion's own timeframe.
      document.dispatchEvent(new CustomEvent("App:replayStarted", { detail: { ts: target, tf: tf } }));
      prefetch();
    });
  }

  // =====================================================================
  // Playback engine.
  // =====================================================================
  function prefetch() {
    if (fetching || reachedLive || cursorTime === null) return;
    if (!window.pywebview || !window.pywebview.api) return;
    fetching = true;
    window.pywebview.api.get_history_page_after(1, cursorTime, PREFETCH_CHUNK).then(function (payload) {
      fetching = false;
      var candles = Array.isArray(payload) ? payload : ((payload && payload.candles) || []);
      var isLatest = !!(payload && !Array.isArray(payload) && payload.is_latest);
      if (candles.length) {
        cursorTime = candles[candles.length - 1].time;
        for (var i = 0; i < candles.length; i++) queue.push(candles[i]);
      }
      if (isLatest && !candles.length) reachedLive = true;
    }).catch(function (err) {
      fetching = false;
      console.error("Bar Replay: prefetch failed:", err);
    });
  }

  function feedOneCandle(c) {
    lastFedTime = c.time;
    var tf = App.replayTf;
    if (tf !== null) {
      if (!App.replayCutoffByTf) App.replayCutoffByTf = {};
      App.replayCutoffByTf[tf] = Math.floor(c.time / tf) * tf;
    }

    // v41 perf: the overlay's render loop repaints every frame while
    // App.replayActive && App.replayPlaying (see drawing-engine.js's
    // surfaceNeedsPaint), so this isn't strictly needed while playing
    // - but it's cheap and covers the single frame right after playback
    // pauses on this exact candle, so the paused frame isn't stale by up
    // to one heartbeat interval.
    if (App.DrawingEngine && App.DrawingEngine.requestRender) App.DrawingEngine.requestRender();

    // Keep the Replay aggregate advancing even while the user is looking at
    // older partitions. The visible Sliding Window is updated only when its
    // right slot is currently the Replay edge, exactly like Live stops
    // mutating a user-panned historical window. When the user returns right,
    // syncPrimaryWindow() catches the resident window up to this playhead.
    var bucket = tf === null ? null : Math.floor(c.time / tf) * tf;
    if (tf !== null) {
      if (!building || building.time !== bucket) {
        building = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close };
      } else {
        if (c.high > building.high) building.high = c.high;
        if (c.low < building.low) building.low = c.low;
        building.close = c.close;
      }
    }

    // v40/v41: companion panels receive the exact same 1-second stream.
    document.dispatchEvent(new CustomEvent("App:replayCandle", { detail: c }));

    if (tf === null || !App.series || !building) return;
    var w = App.windowByTf[tf];
    if (!w || !w.rightIsReplay) {
      // User is panned into older history; playback continues in the
      // background, but the visible historical window remains untouched.
      return;
    }

    // Update 1 (V67): `building` is one mutable object reused for every
    // tick inside the current bucket (see above - it's only replaced when
    // the bucket itself rolls over). mergeReplayTail() stores whatever
    // object it's given directly into the Sliding Window (no copy), so
    // after the bucket's first tick, w.newer's last candle *is* `building`
    // - the exact same reference. From the second tick onward,
    // tailChangesWindow() was then comparing that stored reference against
    // `building` itself (i.e. an object against itself), which is always
    // value-equal, so every tick after the first looked like "no change"
    // and both the window and App.series.update() were skipped for the
    // rest of the bucket. The forming candle was left frozen at its very
    // first tick's O/H/L/C (visually a flat dot) until the bucket rolled
    // over and setData() repainted everything from scratch - indistinguish-
    // able from a normal reload. At 1x this is a one-second glitch on the
    // currently-forming bar and easy to miss; at high Replay speeds (e.g.
    // 60x) a whole higher-timeframe bar (60 seconds) is built and shown in
    // ~1 real second, so the frozen/dotted look is what's on screen for
    // most of that bar's visible lifetime. Passing a fresh snapshot object
    // on every tick (instead of the shared mutable one) gives the sliding
    // window a genuinely new value to diff each time, so every tick's
    // O/H/L/C reaches the chart again, at every Replay speed.
    var buildingSnapshot = {
      time: building.time,
      open: building.open,
      high: building.high,
      low: building.low,
      close: building.close
    };

    var visibleLogical = App.chart ? App.chart.timeScale().getVisibleLogicalRange() : null;
    var transition = App.SlidingWindow.mergeReplayTail(w, [buildingSnapshot], App.LAZY_LOAD_CHUNK);
    if (!transition.changed) return;
    App.windowByTf[tf] = transition.window;
    App.candlesByTf[tf] = App.SlidingWindow.combine(transition.window);

    if (transition.rolled.length) {
      App.series.setData(App.candlesByTf[tf]);
      if (visibleLogical) {
        var shift = transition.window.older ? 0 : -transition.rolled.length;
        App.chart.timeScale().setVisibleLogicalRange({
          from: visibleLogical.from + shift,
          to: visibleLogical.to + shift
        });
      }
    } else {
      App.series.update(buildingSnapshot);
    }

    if (App.ChartCore && App.ChartCore.setLivePrice) {
      App.ChartCore.setLivePrice(buildingSnapshot.close);
    }
  }

  // Called by ChartCore after a Replay partition transition. It reseats the
  // aggregate candle pointer to the resident right slot and, when the backend
  // has not persisted the current in-progress Replay bucket yet, injects that
  // in-memory bucket through the same bounded Replay tail transition.
  function syncPrimaryWindow(tf) {
    if (!App.replayActive || tf !== App.replayTf) return;
    var w = App.windowByTf[tf];
    if (!w || !w.newer || !w.newer.length) return;
    if (w.newer[w.newer.length - 1] && building && w.newer[w.newer.length - 1].time === building.time) {
      building = w.newer[w.newer.length - 1];
    }
    if (building && w.newer[w.newer.length - 1].time < building.time) {
      // Same reasoning as feedOneCandle() above: hand the merge a snapshot,
      // never the shared mutable `building` object itself.
      var buildingSnapshot2 = {
        time: building.time,
        open: building.open,
        high: building.high,
        low: building.low,
        close: building.close
      };
      var result = App.SlidingWindow.mergeReplayTail(w, [buildingSnapshot2], App.LAZY_LOAD_CHUNK);
      if (result.changed) {
        App.windowByTf[tf] = result.window;
        App.candlesByTf[tf] = App.SlidingWindow.combine(result.window);
        if (App.series) App.series.setData(App.candlesByTf[tf]);
      }
    }
  }

  // Keep the newest candle in view only if the user was already watching
  // the live edge — never yanks the viewport out from under someone who
  // has scrolled back to inspect something mid-replay.
  function followEdge(prevLen) {
    if (!App.chart) return;
    var range = App.chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    if (range.to >= prevLen - 2) {
      App.chart.timeScale().setVisibleLogicalRange({ from: range.from + 1, to: range.to + 1 });
    }
  }

  function tick() {
    if (!queue.length) {
      prefetch();
      if (reachedLive && !queue.length) pausePlayback();
      return;
    }
    feedOneCandle(queue.shift());
    if (queue.length < PREFETCH_LOW_WATER) prefetch();
  }

  function intervalMs() {
    return 1000 / App.replaySpeed;
  }

  function startPlayback() {
    if (!hasSelection || App.replayPlaying) return;
    App.replayPlaying = true;
    setPlayIcon(true);
    if (timer) clearInterval(timer);
    timer = setInterval(tick, intervalMs());
  }

  function pausePlayback() {
    App.replayPlaying = false;
    setPlayIcon(false);
    if (timer) { clearInterval(timer); timer = null; }
  }

  function stopPlayback() {
    pausePlayback();
  }

  function restartTimerIfPlaying() {
    if (!App.replayPlaying) return;
    if (timer) clearInterval(timer);
    timer = setInterval(tick, intervalMs());
  }

  // =====================================================================
  // v40 Update 4: change the reference (primary-panel) timeframe while
  // Replay is active — including mid-Play — without ever touching the
  // real live backend. Every candle already recorded up to the replay
  // playhead is genuinely historical, so the new timeframe's candles up
  // to that same point can simply be re-aggregated from the cache via the
  // ordinary get_history_page() call (the same aggregation the rest of
  // the app already trusts for real history), then playback resumes from
  // exactly where it left off, still fed by the same 1-second stream.
  // =====================================================================
  function changeTimeframe(newTf) {
    if (!App.replayActive || !newTf) return;
    if (newTf === App.replayTf) return;

    var wasPlaying = App.replayPlaying;
    if (wasPlaying) pausePlayback();

    // v40.1 perf fix: showTimeframe()'s normal (non-Replay) path always
    // deletes the outgoing timeframe's resident array on switch; this
    // Replay-only path skipped that, so repeatedly changing the reference
    // timeframe mid-Replay silently accumulated one full unbounded array
    // per timeframe ever visited, for the rest of the session.
    var oldTf = App.replayTf;
    if (oldTf !== null && oldTf !== newTf) {
      // Invalidate any in-flight ordinary/replay Sliding Window request for
      // the outgoing timeframe before releasing its resident state.
      App.historyGeneration++;
      delete App.windowByTf[oldTf];
      delete App.candlesByTf[oldTf];
      delete App.loadingDirectionByTf[oldTf];
      if (App.replayCutoffByTf) delete App.replayCutoffByTf[oldTf];
    }

    App.replayTf = newTf;
    App.currentTf = newTf;
    if (App.ChartCore && App.ChartCore.syncTfUI) App.ChartCore.syncTfUI();
    document.dispatchEvent(new CustomEvent("App:timeframeChanged", { detail: { tf: newTf } }));

    if (!hasSelection || lastFedTime === null || !window.pywebview || !window.pywebview.api) {
      if (wasPlaying) startPlayback();
      return;
    }

    var cutoff = lastFedTime;
    window.pywebview.api.get_history_page(newTf, cutoff + 1, App.LAZY_LOAD_CHUNK).then(function (payload) {
      if (App.replayTf !== newTf) return; // superseded by another change meanwhile
      var candles = Array.isArray(payload) ? payload : ((payload && payload.candles) || []);
      rebaseReplayWindow(newTf, candles, null, !!(payload && !Array.isArray(payload) && payload.is_oldest));
      if (App.replayCutoffByTf) App.replayCutoffByTf[newTf] = cutoff;
      candles = App.candlesByTf[newTf];
      if (App.series) App.series.setData(candles);
      var bucketStart = Math.floor(cutoff / newTf) * newTf;
      building = (candles.length && candles[candles.length - 1].time === bucketStart)
        ? candles[candles.length - 1] : null;
      if (candles.length) {
        if (App.chart) App.chart.timeScale().scrollToRealTime();
        if (App.ChartCore && App.ChartCore.setLivePrice) {
          App.ChartCore.setLivePrice(candles[candles.length - 1].close);
        }
      }
      if (wasPlaying) startPlayback();
    }).catch(function (err) {
      console.error("Bar Replay: timeframe change failed:", err);
      if (wasPlaying) startPlayback();
    });
  }

  function setPlayIcon(playing) {
    dom.replayPlayPauseBtn.innerHTML = playing ? App.Icons.pause() : App.Icons.play();
    dom.replayPlayPauseBtn.title = playing ? "Pause" : "Play";
    dom.replayPlayPauseBtn.classList.toggle("active", playing);
  }

  dom.replayPlayPauseBtn.addEventListener("click", function () {
    if (App.replayPlaying) pausePlayback();
    else startPlayback();
  });

  // ---- Replay Speed dropdown ------------------------------------------
  function closeSpeedMenu() { dom.replaySpeedWrap.classList.remove("open"); }
  function openSpeedMenu() { dom.replaySpeedWrap.classList.add("open"); }

  dom.replaySpeedBtn.addEventListener("click", function (evt) {
    evt.stopPropagation();
    if (dom.replaySpeedWrap.classList.contains("open")) closeSpeedMenu();
    else openSpeedMenu();
  });

  Array.prototype.forEach.call(dom.replaySpeedList.querySelectorAll("button"), function (btn) {
    btn.addEventListener("click", function () {
      App.replaySpeed = Number(btn.getAttribute("data-speed")) || 1;
      dom.replaySpeedLabel.textContent = App.replaySpeed + "x";
      Array.prototype.forEach.call(dom.replaySpeedList.querySelectorAll("button"), function (b) {
        b.classList.toggle("active", b === btn);
      });
      closeSpeedMenu();
      restartTimerIfPlaying();
    });
  });

  document.addEventListener("mousedown", function (evt) {
    if (!dom.replaySpeedWrap.contains(evt.target)) closeSpeedMenu();
  });

  // ---- Icons ------------------------------------------------------------
  dom.replayBarToggle.innerHTML = App.Icons.replay();
  dom.replaySelectDateBtn.innerHTML = App.Icons.calendarSmall();
  dom.replaySpeedBtn.insertAdjacentHTML("afterbegin", App.Icons.speedGauge());
  dom.rbdCalPrev.innerHTML = App.Icons.chevron();
  dom.rbdCalNext.innerHTML = App.Icons.chevron();
  setPlayIcon(false);

  App.ReplayBar = {
    isActive: function () { return App.replayActive; },
    // v40 Update 4: called by chart-core.js's tf-dropdown click handler
    // whenever Replay is active, instead of a real backend tf switch.
    changeTimeframe: changeTimeframe,
    syncPrimaryWindow: syncPrimaryWindow,
    // v40 Update 2: lets multi-panel.js seed a companion panel opened (or
    // switched to a new timeframe) mid-replay at the correct point.
    getReplayPointTime: function () { return lastFedTime !== null ? lastFedTime : cursorTime; },
  };
})();
