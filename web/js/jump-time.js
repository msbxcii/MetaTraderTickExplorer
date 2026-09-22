// =============================================================================
// jump-time.js — SPACE opens the centered Jump Time dialog and performs a
// bounded, arbitrary-time sliding-window jump.
// Loaded after state.js and before main.js so DOM refs and key listeners are
// established before the application boots.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function formatDatePart(ts) {
    var d = new Date(Number(ts) * 1000);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }

  function formatTimePart(ts) {
    var d = new Date(Number(ts) * 1000);
    return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds());
  }

  function parseParts(dateStr, timeStr) {
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateStr || "").trim());
    if (!dm) return null;
    var tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((timeStr || "").trim());
    if (!tm) return null;

    var year = Number(dm[1]), month = Number(dm[2]), day = Number(dm[3]);
    var hh = Number(tm[1]), mm = Number(tm[2]), ss = Number(tm[3] || 0);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 59) return null;

    var ms = Date.UTC(year, month - 1, day, hh, mm, ss);
    var d = new Date(ms);
    if (isNaN(ms) || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return Math.round(ms / 1000);
  }

  function floorToTimeframe(ts, tf) {
    return Math.floor(Number(ts) / tf) * tf;
  }

  // ---- v47.2 Update 2: Select-Date-style calendar (same UI/behavior as
  // Bar Replay's own modal — see replay-bar.js's renderCalendar()/
  // shiftMonth()/selectDay(), duplicated here in the same shape rather
  // than shared, since the two modals have independent open/close and
  // bounds-fetch lifecycles). Clicking a day keeps whatever time-of-day is
  // already in the time field, exactly like Select Date.
  var calYear = null, calMonth = null;
  var WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

  function isoWeekday(d) { return (d.getUTCDay() + 6) % 7; }

  function dayBoundsOk(ts) {
    var bounds = App.jumpTimeBounds;
    if (!bounds || bounds.first_time === null || bounds.last_time === null) return true;
    return ts >= Number(bounds.first_time) && ts <= Number(bounds.last_time);
  }

  function renderCalendar() {
    if (!dom.jumpTimeCalTitle || calYear === null) return;
    dom.jumpTimeCalTitle.textContent = new Date(Date.UTC(calYear, calMonth, 1))
      .toLocaleString("en-US", { month: "long", timeZone: "UTC" }) + " " + calYear;

    var grid = dom.jumpTimeCalGrid;
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

    var curParsed = parseParts(dom.jumpTimeDate.value, "00:00:00");
    var selectedDayTs = curParsed === null ? null : Math.floor(curParsed / 86400) * 86400;

    for (var day = 1; day <= daysInMonth; day++) {
      var dayTs = Math.floor(Date.UTC(calYear, calMonth, day) / 1000);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rbd-cal-day";
      btn.textContent = String(day);
      if (!dayBoundsOk(dayTs)) btn.classList.add("rbd-cal-day-disabled");
      if (selectedDayTs !== null && dayTs === selectedDayTs) btn.classList.add("rbd-cal-day-selected");
      (function (ts) {
        btn.addEventListener("click", function () { selectDay(ts); });
      })(dayTs);
      grid.appendChild(btn);
    }
  }

  function selectDay(dayTs) {
    // Keep whatever time-of-day is currently in the time field.
    var timeParts = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((dom.jumpTimeTime.value || "").trim());
    var hh = timeParts ? Number(timeParts[1]) : 0;
    var mm = timeParts ? Number(timeParts[2]) : 0;
    var ss = timeParts ? Number(timeParts[3] || 0) : 0;
    dom.jumpTimeDate.value = formatDatePart(dayTs);
    dom.jumpTimeTime.value = pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss);
    renderCalendar();
    validate();
  }

  function shiftMonth(delta) {
    calMonth += delta;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
  }

  function setInvalid(invalid) {
    dom.jumpTimeDate.classList.toggle("rbd-invalid", !!invalid);
    dom.jumpTimeTime.classList.toggle("rbd-invalid", !!invalid);
  }

  function setStatus(text) {
    dom.jumpTimeStatus.textContent = text || "";
    dom.jumpTimeStatus.style.display = text ? "block" : "none";
  }

  function setGoEnabled(enabled) {
    dom.jumpTimeGo.disabled = !enabled;
    dom.jumpTimeGo.classList.toggle("disabled", !enabled);
  }

  function close() {
    dom.jumpTimePanel.classList.remove("open");
    App.jumpTimeOpen = false;
    setStatus("");
    setInvalid(false);
  }

  function open() {
    if (App.currentTf === null || !App.chart || !window.pywebview) return;

    App.DrawingContextMenu.close();
    dom.jumpTimePanel.classList.add("open");
    App.jumpTimeOpen = true;
    setGoEnabled(false);
    setStatus("Checking available data…");

    var ts = null;
    var current = App.candlesByTf[App.currentTf] || [];
    if (current.length) ts = current[current.length - 1].time;
    if (ts === null) ts = Math.floor(Date.now() / 1000);
    dom.jumpTimeDate.value = formatDatePart(ts);
    dom.jumpTimeTime.value = formatTimePart(ts);
    dom.jumpTimeDate.focus();
    dom.jumpTimeDate.select();

    var seedDate = new Date(ts * 1000);
    calYear = seedDate.getUTCFullYear();
    calMonth = seedDate.getUTCMonth();
    renderCalendar();

    var generation = ++App.jumpTimeBoundsGeneration;
    window.pywebview.api.get_history_bounds(App.currentTf).then(function (bounds) {
      if (!App.jumpTimeOpen || generation !== App.jumpTimeBoundsGeneration) return;
      App.jumpTimeBounds = bounds || null;
      renderCalendar();
      validate();
    }).catch(function (err) {
      if (!App.jumpTimeOpen || generation !== App.jumpTimeBoundsGeneration) return;
      App.jumpTimeBounds = null;
      setGoEnabled(false);
      setStatus("Unable to read data range");
      console.error("Jump Time bounds failed:", err);
    });
  }

  function validate() {
    var ts = parseParts(dom.jumpTimeDate.value, dom.jumpTimeTime.value);
    if (ts === null) {
      setInvalid(true);
      setGoEnabled(false);
      setStatus("Use YYYY-MM-DD and HH:MM:SS");
      return null;
    }

    var bounds = App.jumpTimeBounds;
    if (!bounds || bounds.first_time === null || bounds.last_time === null) {
      setInvalid(false);
      setGoEnabled(false);
      setStatus("No chart data available");
      return null;
    }

    if (ts < Number(bounds.first_time) || ts > Number(bounds.last_time)) {
      setInvalid(true);
      setGoEnabled(false);
      setStatus("Time is outside the available data range");
      return null;
    }

    setInvalid(false);
    setGoEnabled(true);
    setStatus("");
    return ts;
  }


  function combinePartsForJump(tf) {
    var w = App.windowByTf[tf];
    if (!w) return [];
    return (w.older || []).concat(w.newer || []);
  }

  // v33: the actual "fetch a bounded window around `target` and apply it
  // to the chart" mechanics, extracted out of performJump() so the Object
  // Tree panel's per-object jump (see object-panel.js) can reuse exactly
  // the same, already-battle-tested sliding-window logic instead of
  // duplicating it. Returns a Promise<boolean> (true = jump applied).
  // `bounds` is the {first_time, last_time} object for `tf` — the caller
  // is responsible for having it (either from the open dialog, or freshly
  // fetched — see jumpToTimestamp() below).
  // v33.4: optional 4th arg `autoFit` (bool) — when true, turns Auto Fit
  // (price autoScale) back on after the jump lands. Only jumpToTimestamp()
  // passes it; performJump() (the Jump Time dialog) leaves it off, so its
  // vertical price range is left exactly as the user had it. v33.5: the
  // horizontal framing below (now centered, not right-edge) is shared and
  // identical for both callers regardless of this flag.
  function executeJump(tf, target, bounds, autoFit) {
    var requestGeneration = ++App.historyGeneration;
    var jumpGeneration = ++App.jumpTimeRequestGeneration;
    // v57 Update 17: the in-flight history lock is token-owned now (see
    // chart-core.js) so a superseded jump can release it without ever
    // clearing a lock a newer read has since taken.
    var jumpToken = (App.ChartCore && App.ChartCore.acquireLoadingLock)
      ? App.ChartCore.acquireLoadingLock(tf, "jump")
      : (App.loadingDirectionByTf[tf] = "jump", null);

    function releaseJumpLock() {
      if (jumpToken !== null && App.ChartCore && App.ChartCore.releaseLoadingLock) {
        App.ChartCore.releaseLoadingLock(tf, jumpToken);
      } else {
        App.loadingDirectionByTf[tf] = null;
      }
    }

    return window.pywebview.api.get_history_window(tf, target, App.LAZY_LOAD_CHUNK).then(function (payload) {
      if (requestGeneration !== App.historyGeneration || jumpGeneration !== App.jumpTimeRequestGeneration || App.currentTf !== tf) {
        releaseJumpLock();
        return false;
      }

      var before = payload && Array.isArray(payload.before) ? payload.before : [];
      var after = payload && Array.isArray(payload.after) ? payload.after : [];
      var resolvedTarget = payload ? Number(payload.target_time) : NaN;
      releaseJumpLock();

      if (!before.length || !Number.isFinite(resolvedTarget)) return false;

      // The target candle is the final candle of the left/older partition.
      // The right/newer partition contains only strictly later candles. This
      // makes the target itself the exact right boundary of the visible jump.
      var w = App.SlidingWindow.fromJump(before, after, {
        firstTime: Number(bounds.first_time),
        lastTime: Number(bounds.last_time),
      });
      App.windowByTf[tf] = w;
      App.candlesByTf[tf] = combinePartsForJump(tf);
      App.edgeLoadArmed.older = true;
      App.edgeLoadArmed.newer = true;

      // v35.1 Fix 3: lock the Sliding Window edge loader BEFORE any chart
      // mutation. setData() and setVisibleLogicalRange() can synchronously
      // emit viewport callbacks; those callbacks must belong to this jump
      // transaction and must not start a competing history-page request.
      if (autoFit) App.jumpTransactionActive = true;

      // v35.1 Fix 1: object-tree jumps can arrive here while the price axis is
      // still in manual scale mode. Enable Auto Fit BEFORE setData() so
      // the chart itself never paints the new candles with the stale/manual
      // vertical range.
      if (autoFit && App.ChartCore && App.ChartCore.setAutoFit) App.ChartCore.setAutoFit(true);

      // v35.1 Fix 2: the drawing overlay is painted by its own RAF loop and
      // can otherwise leave the OLD object pixels visible for one frame while
      // the chart has already switched to the NEW time/price mapping. Hide
      // it for the atomic data+viewport transition; reveal only after two
      // animation frames, once both renderers have settled.
      var suppressOverlay = !!(autoFit && App.DrawingEngine && App.DrawingEngine.setJumpRenderSuppressed);
      if (suppressOverlay) App.DrawingEngine.setJumpRenderSuppressed(true);

      App.series.setData(App.candlesByTf[tf]);

      // v33.5: the jump target is now centered in the view, instead of
      // pinned to the right edge (v33 through v33.4). This is a core
      // change to the shared jump mechanism — it affects the Jump Time
      // dialog exactly the same as the Objects panel, on purpose (see the
      // v33.5 README entry for why: centering is a better UX for the
      // dialog too, and it's what lets the Objects panel's jump rely on
      // nothing but autoFit — a centered target is inside the frame at
      // any zoom level with no offset math needed at all).
      var targetIndex = before.length - 1;
      var visible = App.chart.timeScale().getVisibleLogicalRange();
      var barsOnScreen = visible ? (visible.to - visible.from) : Math.min(before.length - 1, 100);
      if (!(barsOnScreen > 0)) barsOnScreen = Math.min(before.length - 1, 100);
      var half = barsOnScreen / 2;
      var from = targetIndex - half;
      var to = targetIndex + half;
      // Keep the same width, just slide the whole window right instead of
      // clamping only `from` (which would narrow the view near the start
      // of the loaded data).
      if (from < 0) { to -= from; from = 0; }
      App.chart.timeScale().setVisibleLogicalRange({ from: from, to: to });

      if (suppressOverlay && App.DrawingEngine.revealAfterJumpSettles) {
        App.DrawingEngine.revealAfterJumpSettles(function () {
          App.jumpTransactionActive = false;
        });
      } else if (autoFit) {
        App.jumpTransactionActive = false;
      }

      return true;
    }).catch(function (err) {
      releaseJumpLock();
      App.jumpTransactionActive = false;
      if (App.DrawingEngine && App.DrawingEngine.setJumpRenderSuppressed) {
        App.DrawingEngine.setJumpRenderSuppressed(false);
      }
      console.error("Jump failed:", err);
      return false;
    });
  }

  function performJump() {
    var requested = validate();
    if (requested === null || App.currentTf === null) return;

    var tf = App.currentTf;
    var target = floorToTimeframe(requested, tf);

    setGoEnabled(false);
    setStatus("Jumping…");

    // v58.1 Update 1: Jump Time now turns Auto Fit (price autoScale) back
    // on too, same as the Objects panel's jumpToTimestamp() already did —
    // pass autoFit=true instead of leaving it off.
    executeJump(tf, target, App.jumpTimeBounds, true).then(function (ok) {
      if (ok) {
        close();
        // v39: propagate the same real-time target to every visible
        // companion multi-chart panel, so Jump Time (SPACE) moves the whole
        // multi-chart in sync instead of just the primary panel. `requested`
        // (not `target`) is passed on purpose — it's timeframe-independent,
        // and each companion floors it to its own timeframe (see
        // multi-panel.js's jumpPanelToTimestamp()).
        if (App.MultiPanel && App.MultiPanel.jumpAllToTimestamp) App.MultiPanel.jumpAllToTimestamp(requested);
        return;
      }
      setGoEnabled(true);
      setStatus("No candle could be resolved for that time");
    });
  }

  // v33.4: previously 1350 (v33.1 Fix 5) — an Object Tree jump landed not
  // on the object's own anchor time but 1350 candles further forward, so
  // there'd be some future context visible past it. That interacted badly
  // with the old right-edge framing: at any zoom narrower than 1350 bars,
  // the *actual* object (1350 candles behind the framed edge) fell
  // outside the visible range entirely — the opposite of the intended
  // "make sure I can see this" behavior. Set to 0: the object's own
  // anchor time is now the jump target directly. v33.5: with the target
  // now CENTERED in the view (see executeJump() above) rather than
  // pinned to the right edge, this 0 offset is what makes a plain
  // autoFit sufficient for the Objects panel — a centered point is always
  // inside the frame at any zoom, in from the tightest zoom-in to the
  // widest zoom-out, with no dependency on how wide the current view
  // happens to be. Left as a named constant (rather than removing the
  // offset mechanism) in case a small look-ahead is ever wanted again.
  var JUMP_OFFSET_CANDLES = 0;

  // v33: jump straight to an arbitrary timestamp with no dialog involved —
  // used by the Object Tree panel to jump to a drawn object's anchor time
  // (see drawing-engine.js getAnchorTime()); v33.4: JUMP_OFFSET_CANDLES is
  // 0 now, so that anchor time IS the jump target, unmodified (see the
  // constant's note above). Always re-fetches bounds rather than trusting
  // a stale App.jumpTimeBounds (the dialog may never have been opened
  // this session). Returns a Promise<boolean>.
  function jumpToTimestamp(ts) {
    if (App.currentTf === null || !App.chart || !window.pywebview || !window.pywebview.api) {
      return Promise.resolve(false);
    }
    var tf = App.currentTf;
    return window.pywebview.api.get_history_bounds(tf).then(function (bounds) {
      if (!bounds || bounds.first_time === null || bounds.last_time === null) return false;
      // The offset is applied here, once bounds for the CURRENT timeframe
      // are known, so it's always computed in the timeframe actually on
      // screen at jump time — not whatever timeframe the object's anchor
      // time was originally drawn on (objects store real, timeframe-
      // independent time; see drawing-engine.js's v14/v21 notes).
      var offsetTs = ts + JUMP_OFFSET_CANDLES * tf;
      // If the offset target overshoots the newest available data, clamp
      // to the last available time instead of silently failing the whole
      // jump — still lands as close to the intended spot as the data
      // allows, matching how every other bounded jump in this file
      // degrades (see performJump()'s own range check).
      if (offsetTs > Number(bounds.last_time)) offsetTs = Number(bounds.last_time);
      if (offsetTs < Number(bounds.first_time)) return false;
      App.jumpTimeBounds = bounds;
      var target = floorToTimeframe(offsetTs, tf);
      // v33.4/v33.5: pass autoFit=true so Auto Fit re-enables once this
      // lands — combined with the target being the object's own anchor
      // time (JUMP_OFFSET_CANDLES=0) and executeJump() now centering the
      // target in the view, the object is guaranteed both horizontally on
      // screen (dead center, any zoom) and vertically on screen (autoScale
      // fits to it). The Jump Time dialog's own performJump() above
      // passes no 4th arg but now shares the same centered framing.
      return executeJump(tf, target, bounds, true);
    }).catch(function (err) {
      console.error("jumpToTimestamp failed:", err);
      return false;
    });
  }

  [dom.jumpTimeDate, dom.jumpTimeTime].forEach(function (el) {
    el.addEventListener("input", validate);
    el.addEventListener("change", validate);
    el.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") {
        evt.preventDefault();
        performJump();
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        close();
      }
    });
  });

  dom.jumpTimeGo.addEventListener("click", performJump);
  dom.jumpTimeCancel.addEventListener("click", close);
  dom.jumpTimeClose.addEventListener("click", close);
  if (dom.jumpTimeCalPrev) {
    dom.jumpTimeCalPrev.innerHTML = App.Icons.chevron();
    dom.jumpTimeCalPrev.addEventListener("click", function () { shiftMonth(-1); });
  }
  if (dom.jumpTimeCalNext) {
    dom.jumpTimeCalNext.innerHTML = App.Icons.chevron();
    dom.jumpTimeCalNext.addEventListener("click", function () { shiftMonth(1); });
  }

  document.addEventListener("mousedown", function (evt) {
    if (App.jumpTimeOpen && !dom.jumpTimePanel.contains(evt.target)) close();
  });

  document.addEventListener("keydown", function (evt) {
    if (evt.key === "Escape" && App.jumpTimeOpen) {
      close();
      return;
    }
    if (evt.key === " " && !App.jumpTimeOpen) {
      if (evt.repeat) return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      evt.preventDefault();
      open();
    }
  });

  App.jumpTimeOpen = false;
  App.jumpTimeBounds = null;
  App.jumpTimeBoundsGeneration = 0;
  App.jumpTimeRequestGeneration = 0;
  App.JumpTime = { open: open, close: close, perform: performJump, jumpToTimestamp: jumpToTimestamp };
})();
