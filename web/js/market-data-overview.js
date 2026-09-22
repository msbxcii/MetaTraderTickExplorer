// =============================================================================
// market-data-overview.js — v65: Extend (and the manual Refresh button) now
// grow the Year/Month dropdowns live as the oldest-data bound crosses into a
// month/year that wasn't an option yet, instead of only at Extend's very end
// (or, before that, not until the whole Market Data Overview panel was
// closed and reopened) — see rebuildYearMonthLists()/refreshYearMonthOptions
// below and their call sites in onExtendStatus() and requestManualRefresh().
// v65.1: switching Year/Month/Tolerance now takes one backend round-trip
// instead of three (see get_month_histogram in chart_bridge.py), rapid
// dropdown changes are debounced into a single load, and a stale response
// can no longer repaint the box for a month the user has since moved past —
// see loadHistogram()/scheduleLoadHistogram() below.
// v38.1: the "Market Data Overview" tab of the
// Setting panel (before v50 this owned its own standalone modal; it's now
// mounted as one pane inside the shared panel — see settings-panel.js,
// which owns the backdrop/toggle and calls App.MarketDataOverview.
// activate()/deactivate() when the user switches to/away from this tab).
// Shows the oldest available 1-second candle (plus how many calendar days of
// history that is), and
// a per-day candle-count histogram (for a chosen Year/Month/tolerance-
// timeframe) with per-day checkboxes the user can toggle to mark a range
// for a Backfill/Extend action.
//
// v63: a Chart / Log switch above the histogram box - Chart (default) is the
// histogram, Log shows the Database-category lines of the header Log panel
// (see setViewMode below and App.LogFeed in log-panel.js).
//
// Everything here is read-only against the backend (ChartBridge.
// get_db_overview / get_daily_candle_counts / get_month_histogram) except
// Backfill/Extend, which kick off a backend sync run.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  if (!dom.mdoOldestData) return;

  var MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // Same friendly label family as chart-core.js's formatTfLabel (kept as
  // its own small copy here, same as multi-panel.js already does, rather
  // than reaching into chart-core.js's private closure), but spelled out
  // in full words per the modal's spec ("1 Second", "15 Minutes", ...)
  // instead of the toolbar's compact "1s"/"15m" — two different controls
  // with two different label conventions, both driven by the same
  // App.TIMEFRAMES list.
  function toleranceLabel(tf) {
    if (tf % 3600 === 0) {
      var h = tf / 3600;
      return h + (h === 1 ? " Hour" : " Hours");
    }
    if (tf % 60 === 0) {
      var m = tf / 60;
      return m + (m === 1 ? " Minute" : " Minutes");
    }
    return tf + (tf === 1 ? " Second" : " Seconds");
  }

  var isOpen = false;
  var oldestYear = null, oldestMonth = null, oldestDay = null;
  var checkedDays = {}; // "YYYY-MM" -> Set-like object of day numbers currently checked
  var currentDaysInMonth = 0;

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // v61.3: "today" for this tab is the BROKER's calendar day, never the PC
  // clock. Candle timestamps are on the broker's clock (UTC+3 for many
  // brokers) treated as plain epoch seconds, while `new Date()` is the real
  // UTC of the PC - up to a few hours behind. Between 00:00 and 03:00 broker
  // time the two disagree about the date, so the newest day (and, at a month
  // or year change, the newest month/year) was hidden from the day columns
  // until real UTC caught up. The broker's "now" is the newest candle
  // get_db_overview() reports (an indexed MAX lookup, no extra cost); the PC
  // clock is only a fallback while no candle exists at all.
  var brokerNowSec = null;

  function brokerNowDate() {
    return brokerNowSec !== null ? new Date(brokerNowSec * 1000) : new Date();
  }

  function rememberBrokerNow(overview) {
    var t = overview && overview.newest_time;
    if (t !== null && t !== undefined && isFinite(Number(t))) brokerNowSec = Number(t);
  }


  function daysInMonth(year, month) {
    // month is 1-12
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function monthKey(year, month) { return year + "-" + month; }

  function formatOldestLabel(unixSeconds) {
    var d = new Date(unixSeconds * 1000);
    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    var datePart = d.getUTCFullYear() + "." + pad2(d.getUTCMonth() + 1) + "." + pad2(d.getUTCDate());
    var timePart = pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds());
    return datePart + " | " + timePart;
  }

  // v61.2: number of UTC calendar days from the oldest stored candle up to
  // and including today - a plain day count, no database query involved
  // (it is derived from the oldest_time get_db_overview() already returns).
  function countHistoryDays(unixSeconds) {
    var o = new Date(unixSeconds * 1000);
    var n = brokerNowDate();
    var oldestUtc = Date.UTC(o.getUTCFullYear(), o.getUTCMonth(), o.getUTCDate());
    var nowUtc = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
    return Math.max(1, Math.round((nowUtc - oldestUtc) / 86400000) + 1);
  }

  function showOldest(unixSeconds) {
    dom.mdoOldestData.textContent = formatOldestLabel(unixSeconds);
    if (dom.mdoOldestDays) {
      var days = countHistoryDays(unixSeconds);
      dom.mdoOldestDays.textContent = "(" + days.toLocaleString() + (days === 1 ? " Day" : " Days") + ")";
    }
  }

  function clearOldest() {
    dom.mdoOldestData.textContent = "—";
    if (dom.mdoOldestDays) dom.mdoOldestDays.textContent = "";
  }

  // ---- Year/Month population, bounded to [oldest data, current date] ----
  // so the user can never pick a year/month with no possible data in it.
  //
  // v65: this used to be one function (populateYearMonth) that always
  // rebuilt both lists AND forced the selection back to "now" - fine for
  // the initial open, but wrong for the two places that need to grow
  // these lists while the tab stays open and the user may be looking at
  // some other year/month: a running Extend pushing oldestYear/oldestMonth
  // further back (see onExtendStatus's "progress"/"done" cases below) and
  // the manual Refresh button. Forcing the jump there is exactly the bug
  // reported: the new, older months/years an Extend just reached were
  // real DOM options the whole time, just not reachable without first
  // closing and reopening the panel (which re-runs activate() ->
  // populateYearMonth() from scratch). rebuildYearMonthLists() is now the
  // one place that actually rebuilds the <option> elements; the two
  // callers below just differ in what they pass as the preferred
  // year/month to keep selected once the lists are rebuilt.
  function rebuildYearMonthLists(preferredYear, preferredMonth) {
    var now = brokerNowDate();
    var nowYear = now.getUTCFullYear();
    var nowMonth = now.getUTCMonth() + 1;

    dom.mdoYearSelect.innerHTML = "";
    for (var y = nowYear; y >= oldestYear; y--) {
      var opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      dom.mdoYearSelect.appendChild(opt);
    }

    var targetYear = (preferredYear !== null && preferredYear !== undefined &&
      preferredYear >= oldestYear && preferredYear <= nowYear) ? preferredYear : nowYear;
    dom.mdoYearSelect.value = String(targetYear);

    populateMonthsForYear(targetYear, nowYear, nowMonth, preferredMonth);
  }

  // Initial open (activate()): jump straight to the real current
  // year/month, exactly as before.
  function populateYearMonth() {
    rebuildYearMonthLists(null, null);
  }

  // Live refresh (Extend progress/done, manual Refresh): grows the lists
  // to include any newly-reached history WITHOUT moving the user off
  // whatever year/month they're currently looking at — an Extend only
  // ever pushes the oldest bound further into the past, so a selection
  // that was valid before this call is still valid after it; this only
  // ever adds options, never removes the one currently selected.
  function refreshYearMonthOptions() {
    var prevYear = Number(dom.mdoYearSelect.value) || null;
    var prevMonth = Number(dom.mdoMonthSelect.value) || null;
    rebuildYearMonthLists(prevYear, prevMonth);
  }

  function populateMonthsForYear(selectedYear, nowYear, nowMonth, preferredMonth) {
    var firstMonth = selectedYear === oldestYear ? oldestMonth : 1;
    var lastMonth = selectedYear === nowYear ? nowMonth : 12;

    // v65: an explicit preference (passed by refreshYearMonthOptions, so
    // the caller's own previous selection) now wins over "jump to the
    // current real month" - only populateYearMonth's initial-open call
    // leaves this unset, which is the one place that jump is wanted.
    var hasPreferred = preferredMonth !== null && preferredMonth !== undefined && preferredMonth !== "";
    var prevValue = hasPreferred ? String(preferredMonth) : dom.mdoMonthSelect.value;
    dom.mdoMonthSelect.innerHTML = "";
    for (var m = firstMonth; m <= lastMonth; m++) {
      var opt = document.createElement("option");
      opt.value = String(m);
      opt.textContent = MONTH_NAMES[m - 1];
      dom.mdoMonthSelect.appendChild(opt);
    }
    if (prevValue && Number(prevValue) >= firstMonth && Number(prevValue) <= lastMonth) {
      dom.mdoMonthSelect.value = prevValue;
    } else if (selectedYear === nowYear && nowMonth >= firstMonth && nowMonth <= lastMonth) {
      // Default to the current real month if it's in range, else the
      // last available one — this also covers the "load on a mid-month
      // day" case from the spec (defaulting to the month the user is in).
      dom.mdoMonthSelect.value = String(nowMonth);
    } else {
      dom.mdoMonthSelect.value = String(lastMonth);
    }
  }

  // v39: the modal's own tolerance list, independent of App.TIMEFRAMES
  // (the main chart toolbar's full list). Deliberately narrowed to just
  // 1/5/15 minutes per spec - the sub-minute tolerances (1s/5s/15s) are
  // the ones whose per-day COUNT(*) loop gets expensive against a large
  // candles_1s/5s/15s table, so leaving them selectable here bought
  // little (rarely used for this modal) for a real cost. 1 Hour was
  // dropped too, simply because it wasn't asked for.
  var MDO_TOLERANCES = [60, 300, 900];
  var MDO_DEFAULT_TOLERANCE = "60"; // 1 Minute

  function populateTolerance() {
    dom.mdoToleranceSelect.innerHTML = "";
    MDO_TOLERANCES.forEach(function (tf) {
      var opt = document.createElement("option");
      opt.value = String(tf);
      opt.textContent = toleranceLabel(tf);
      dom.mdoToleranceSelect.appendChild(opt);
    });
    dom.mdoToleranceSelect.value = MDO_DEFAULT_TOLERANCE;
  }

  // ---- How many day-columns to show for the selected year/month --------
  // v46.3 fix: the oldest day is now INCLUSIVE. The previous rule ("today
  // is day 23, oldest data is day 10 -> 13 squares, i.e. days 11..23")
  // unconditionally hid the oldest calendar day's own square, on the
  // assumption a first/partial day never holds meaningful data. That
  // assumption was wrong — a day can easily hold tens of minutes of real
  // cached candles (e.g. oldest tick at 23:39:05 still leaves ~20min of
  // that day cached) and hiding it made genuine data invisible. The count
  // is now capped by (a) the real number of days in the month, (b) — for
  // the current real month only — the current day of month, and (c) —
  // for the oldest month only — everything from oldestDay through the
  // cap above, oldestDay included. When both (b)/(c) apply in the same
  // month, the smaller cap wins.
  function visibleDayCount(year, month) {
    var total = daysInMonth(year, month);
    var now = brokerNowDate();
    var nowYear = now.getUTCFullYear();
    var nowMonth = now.getUTCMonth() + 1;
    var nowDay = now.getUTCDate();

    var cap = total;
    if (year === nowYear && month === nowMonth) {
      cap = Math.min(cap, nowDay);
    }
    if (year === oldestYear && month === oldestMonth) {
      // Inclusive of oldestDay itself (v46.3): total - oldestDay + 1.
      cap = Math.min(cap, total - oldestDay + 1);
      if (year === nowYear && month === nowMonth) {
        cap = Math.min(cap, nowDay - oldestDay + 1);
      }
    }
    return Math.max(0, cap);
  }

  function startDayOffset(year, month) {
    // Day squares start from day 1, UNLESS this is the oldest-data month,
    // in which case the first visible square is oldestDay itself (v46.3:
    // no longer skipped — see visibleDayCount above).
    if (year === oldestYear && month === oldestMonth) return oldestDay;
    return 1;
  }

  // ---- Histogram rendering ----------------------------------------------
  // `counts1m` is the SAME month's per-day counts but always at the
  // 1-minute (tf=60) tolerance, fetched alongside `counts` (which is at
  // whatever tolerance the user picked) — used only to decide each day's
  // "filled" (reference-complete) state, drawn as a solid bar. This is
  // independent of the missing-candle hover report, which was removed
  // (v39) and stays removed.
  function renderChart(counts, year, month, tf, counts1m) {
    dom.mdoChartBox.innerHTML = "";
    dom.mdoCheckboxRow.innerHTML = "";
    dom.mdoHoverInfo.innerHTML = "&nbsp;";
    var startDay = startDayOffset(year, month);
    var visible = visibleDayCount(year, month);
    var key = monthKey(year, month);
    var checked = checkedDays[key] || {};

    // Cap for auto-scale purposes: the maximum a bar could ever reach for
    // this tolerance in a single day, so a mostly-empty month doesn't
    // stretch a handful of candles into a full-height bar (spec: 15m ->
    // max 96/day). Still autoscale-fits inside the fixed-height box, per
    // the box's own CSS (height never changes; bars are what scale).
    var maxPerDay = Math.max(1, Math.floor(86400 / tf));
    var maxSeen = 1;
    for (var i = 0; i < visible; i++) {
      var c = counts[startDay - 1 + i] || 0;
      if (c > maxSeen) maxSeen = c;
    }
    var scaleMax = Math.min(maxPerDay, Math.max(maxSeen, 1));

    // The 1-minute "reference max" for this month — the most 1-minute
    // candles seen on any single visible day. A day whose own 1-minute
    // count equals this becomes the "filled" reference day (solid bar),
    // regardless of which tolerance is currently selected. Deliberately
    // NOT capped like scaleMax above — this is a plain max-seen
    // comparison, not something feeding a bar height.
    var maxSeen1m = 0;
    for (var j = 0; j < visible; j++) {
      var c1 = (counts1m && counts1m[startDay - 1 + j]) || 0;
      if (c1 > maxSeen1m) maxSeen1m = c1;
    }

    // v38.1 fix: always reserve exactly 31 fixed-width column slots (set
    // as a CSS variable the .mdo-day-col width formula reads), so a month
    // with fewer visible/populated days never stretches its bars wider —
    // it just leaves the remaining slots empty instead. Only the first
    // `visible` slots get an actual bar/checkbox/tooltip; the rest are
    // rendered as empty, non-interactive placeholders that still take up
    // their column's width.
    dom.mdoChartBox.style.setProperty("--mdo-col-count", "31");
    dom.mdoCheckboxRow.style.setProperty("--mdo-col-count", "31");

    function toggleDay(day, barColEl, cbColEl) {
      var k = monthKey(Number(dom.mdoYearSelect.value), Number(dom.mdoMonthSelect.value));
      if (!checkedDays[k]) checkedDays[k] = {};
      if (checkedDays[k][day]) {
        delete checkedDays[k][day];
        barColEl.classList.remove("checked");
        cbColEl.classList.remove("checked");
      } else {
        checkedDays[k][day] = true;
        barColEl.classList.add("checked");
        cbColEl.classList.add("checked");
      }
      updateBackfillEnabled();
      updateSelectAllBtnState();
    }

    for (var d = 0; d < 31; d++) {
      var col = document.createElement("div");
      var cbCol = document.createElement("div"); // paired checkbox-row column

      if (d >= visible) {
        col.className = "mdo-day-col mdo-day-col-empty";
        dom.mdoChartBox.appendChild(col);

        cbCol.className = "mdo-checkbox-col mdo-checkbox-col-empty";
        dom.mdoCheckboxRow.appendChild(cbCol);
        continue;
      }

      var dayNum = startDay + d;
      var count = counts[startDay - 1 + d] || 0;
      var count1m = (counts1m && counts1m[startDay - 1 + d]) || 0;
      var pct = Math.max(2, Math.round((count / scaleMax) * 100));
      var isChecked = !!checked[dayNum];
      var isFilled = maxSeen1m > 0 && count1m === maxSeen1m;

      col.className = "mdo-day-col" + (isChecked ? " checked" : "") + (isFilled ? " filled" : "");
      col.dataset.day = String(dayNum);

      var bar = document.createElement("div");
      bar.className = "mdo-bar";
      bar.style.height = pct + "%";
      col.appendChild(bar);

      var dateStr = year + "-" + (month < 10 ? "0" : "") + month + "-" + (dayNum < 10 ? "0" : "") + dayNum;
      var infoText = dateStr + " — " + count.toLocaleString() + " candle" + (count === 1 ? "" : "s");

      // v38.4: no more per-column floating tooltip element — hovering
      // this column just writes into the single fixed .mdo-hover-info
      // line above the box, which never moves and can't be clipped or
      // pushed off-screen the way a floating tooltip could.
      // v39: the 1-minute "missing candles" hover detail (the gap
      // report and its dedicated get_missing_ranges backend call) is
      // gone entirely — hover just shows the date + candle count now.
      // The Filled-bar reference above is unrelated and still computed.
      (function (day, txt) {
        col.addEventListener("mouseenter", function () {
          dom.mdoHoverInfo.textContent = txt;
        });
        col.addEventListener("mouseleave", function () {
          dom.mdoHoverInfo.innerHTML = "&nbsp;";
        });
      })(dayNum, infoText);

      // v38.2: the checkbox itself now lives in its own row BELOW the
      // chart box (outside the plotting area) instead of stacked inside
      // the bar column, per spec. It stays paired to its bar column by
      // day number, and clicking either one toggles the same state and
      // keeps both in sync visually.
      cbCol.className = "mdo-checkbox-col" + (isChecked ? " checked" : "");
      cbCol.dataset.day = String(dayNum);

      var box = document.createElement("div");
      box.className = "mdo-checkbox";
      cbCol.appendChild(box);

      (function (day, barColEl, cbColEl) {
        cbColEl.addEventListener("click", function () {
          toggleDay(day, barColEl, cbColEl);
        });
        // Hovering the checkbox also highlights its paired bar, and
        // hovering the bar (existing :hover CSS) already highlights the
        // bar itself — this keeps the pairing visually obvious now that
        // they're no longer in the same column.
        cbColEl.addEventListener("mouseenter", function () {
          barColEl.classList.add("mdo-checkbox-hover");
        });
        cbColEl.addEventListener("mouseleave", function () {
          barColEl.classList.remove("mdo-checkbox-hover");
        });
      })(dayNum, col, cbCol);

      dom.mdoChartBox.appendChild(col);
      dom.mdoCheckboxRow.appendChild(cbCol);
    }

    updateSelectAllBtnState();
  }

  var backfillRunning = false;
  var pendingBackfillKey = null; // "YYYY-MM" this run's request was sent for, so the
                                  // right month's checkboxes get cleared on completion
                                  // even if the user switched months while it ran.

  // ---- v44.1: Select All / Deselect All -----------------------------------
  // Toggles every currently-visible day of the displayed month at once.
  // Mirrors toggleDay()'s approach of patching the already-rendered DOM
  // directly (no re-fetch from the backend) — cheap and instant.
  function updateSelectAllBtnState() {
    if (!dom.mdoSelectAllBtn) return;
    var key = monthKey(Number(dom.mdoYearSelect.value), Number(dom.mdoMonthSelect.value));
    var checked = checkedDays[key] || {};
    var barCols = dom.mdoChartBox.querySelectorAll(".mdo-day-col[data-day]");
    var allChecked = barCols.length > 0 && Array.prototype.every.call(barCols, function (el) {
      return !!checked[Number(el.dataset.day)];
    });
    dom.mdoSelectAllBtn.classList.toggle("all-checked", allChecked);
  }

  function toggleSelectAll() {
    var key = monthKey(Number(dom.mdoYearSelect.value), Number(dom.mdoMonthSelect.value));
    var barCols = dom.mdoChartBox.querySelectorAll(".mdo-day-col[data-day]");
    var cbCols = dom.mdoCheckboxRow.querySelectorAll(".mdo-checkbox-col[data-day]");
    if (!barCols.length) return;

    if (!checkedDays[key]) checkedDays[key] = {};
    var checked = checkedDays[key];
    var allChecked = Array.prototype.every.call(barCols, function (el) {
      return !!checked[Number(el.dataset.day)];
    });
    var makeChecked = !allChecked; // currently all on -> turn all off, else turn all on

    Array.prototype.forEach.call(barCols, function (el) {
      var day = Number(el.dataset.day);
      if (makeChecked) checked[day] = true; else delete checked[day];
      el.classList.toggle("checked", makeChecked);
    });
    Array.prototype.forEach.call(cbCols, function (el) {
      el.classList.toggle("checked", makeChecked);
    });

    updateSelectAllBtnState();
    updateBackfillEnabled();
  }

  // ---- v44.1: manual "re-count candles" refresh --------------------------
  // Simply re-runs the exact same fetch loadHistogram() already does on
  // open/Tolerance-change/after a Backfill — this button just gives the
  // user a way to trigger that on demand, e.g. if they suspect the
  // background candle cache has moved on since the panel was opened.
  function requestManualRefresh() {
    if (!dom.mdoRefreshBtn || dom.mdoRefreshBtn.classList.contains("spinning")) return;
    dom.mdoRefreshBtn.classList.add("spinning");
    var finish = function () {
      if (dom.mdoRefreshBtn) dom.mdoRefreshBtn.classList.remove("spinning");
    };
    // v65: this used to only re-run loadHistogram(), which re-counts the
    // currently displayed month's days but never touches the Year/Month
    // dropdowns themselves — so Refresh could not surface a new month/year
    // an Extend had reached, which was the whole point of clicking it.
    // Check the oldest bound first (one cheap indexed MIN lookup - v65.1:
    // loadHistogram no longer separately fetches this itself, it's folded
    // into get_month_histogram below, so this really is one extra call,
    // only on this explicit click) and only rebuild the dropdown lists if
    // that bound actually moved.
    var refreshBounds = (window.pywebview && window.pywebview.api && window.pywebview.api.get_db_overview)
      ? window.pywebview.api.get_db_overview().then(function (data) {
          rememberBrokerNow(data);
          var oldestTs = data && data.oldest_time;
          if (oldestTs === null || oldestTs === undefined) return;
          var d = new Date(oldestTs * 1000);
          var newOldestYear = d.getUTCFullYear();
          var newOldestMonth = d.getUTCMonth() + 1;
          var boundaryChanged = (newOldestYear !== oldestYear || newOldestMonth !== oldestMonth);
          oldestYear = newOldestYear;
          oldestMonth = newOldestMonth;
          oldestDay = d.getUTCDate();
          showOldest(oldestTs);
          if (boundaryChanged) refreshYearMonthOptions();
        }).catch(function () {})
      : Promise.resolve();
    refreshBounds.then(function () {
      return loadHistogram(true);
    }).then(finish, finish);
  }

  function updateBackfillEnabled() {
    if (backfillRunning) return; // stays disabled/labelled while a run is in flight
    var key = monthKey(Number(dom.mdoYearSelect.value), Number(dom.mdoMonthSelect.value));
    var checked = checkedDays[key] || {};
    var any = Object.keys(checked).some(function (k) { return checked[k]; });
    dom.mdoBackfillBtn.disabled = !any;
  }

  function setBackfillStatusText(text, isDone) {
    if (!dom.mdoBackfillStatus) return;
    dom.mdoBackfillStatus.textContent = text || "\u00a0";
    dom.mdoBackfillStatus.classList.toggle("mdo-backfill-status-done", !!isDone);
  }

  // ---- BackFill ----------------------------------------------------------
  // (v44) Only acts on the days checked in the CURRENTLY DISPLAYED
  // Year/Month, per spec — switching month elsewhere in the panel doesn't
  // carry a pending selection along with it. The actual gap-finding and
  // MT5 fetch happen entirely on the backend (sync_process.py); this side
  // only sends the day numbers and reacts to the two status points it
  // reports back (see window.onBackfillStatus below).
  function requestBackfill() {
    var year = Number(dom.mdoYearSelect.value);
    var month = Number(dom.mdoMonthSelect.value);
    var key = monthKey(year, month);
    var checked = checkedDays[key] || {};
    var days = Object.keys(checked)
      .filter(function (k) { return checked[k]; })
      .map(Number);
    if (!days.length) return;
    if (backfillRunning || extendRunning) return; // one panel-driven write job at a time
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.start_backfill) return;

    backfillRunning = true;
    pendingBackfillKey = key;
    dom.mdoBackfillBtn.disabled = true;
    setBackfillStatusText("Backfill Processing...", false);

    window.pywebview.api.start_backfill(year, month, days).then(function (result) {
      if (!result || !result.ok) {
        // Couldn't even queue the request (e.g. sync process not wired
        // up) — don't leave the user staring at "Processing..." forever.
        backfillRunning = false;
        setBackfillStatusText("Backfill Unavailable", false);
        updateBackfillEnabled();
      }
      // On success, the real outcome arrives later via
      // window.onBackfillStatus("done", recovered) — nothing more to do
      // here now.
    }).catch(function () {
      backfillRunning = false;
      setBackfillStatusText("Backfill Unavailable", false);
      updateBackfillEnabled();
    });
  }

  // (v44) Called from app.py's live-queue consumer via evaluate_js, once
  // when the backend starts working on the request and once with the
  // final outcome. Kept intentionally as just these two general messages
  // (no per-day/per-range detail) per spec.
  window.onBackfillStatus = function (state, recovered) {
    if (state === "processing") {
      backfillRunning = true;
      dom.mdoBackfillBtn.disabled = true;
      setBackfillStatusText("Backfill Processing...", false);
      return;
    }
    if (state === "done") {
      backfillRunning = false;

      // v44.1: whatever days were sent off for this run get unchecked now
      // that it's finished — a finished Backfill (successful or not) is a
      // closed action, not something left "selected" for the user to
      // accidentally re-submit.
      if (pendingBackfillKey) {
        delete checkedDays[pendingBackfillKey];
        pendingBackfillKey = null;
      }

      var n = Number(recovered) || 0;
      setBackfillStatusText(
        n > 0 ? ("Backfill Done, " + n.toLocaleString() + " Seconds Recovered") : "Backfill Done, No Data Recovered",
        true
      );
      // Reflect whatever was actually recovered in the histogram/counts
      // right away, without waiting for the user to touch a dropdown.
      // loadHistogram() also re-renders the checkboxes from
      // checkedDays (now cleared above), so they show as unchecked too.
      if (isOpen) loadHistogram();
      else updateBackfillEnabled();
    }
  };

  // ---- v46: Extend ---------------------------------------------------------
  // Independent of Backfill above: instead of filling small in-range gaps
  // in already-cached months, Extend pushes the oldest available history
  // further back in time, to a date the user types in. All the actual
  // fetching/storing/gap-boundary logic lives in sync_process.py's
  // _process_extend_request; this side just collects the target date,
  // sends it off, and reports the two status points that come back.
  var extendRunning = false;
  var extendBoxOpen = false;

  function oldestDateStr() {
    if (!oldestYear) return "";
    return oldestYear + "-" + pad2(oldestMonth) + "-" + pad2(oldestDay);
  }

  // Shares the single status line with Backfill (see setBackfillStatusText
  // below) — the two actions are mutually exclusive from the user's point
  // of view, so one status line under the footer is enough for either.
  function setExtendStatusText(text, isDone) {
    if (!dom.mdoBackfillStatus) return;
    dom.mdoBackfillStatus.textContent = text || "\u00a0";
    dom.mdoBackfillStatus.classList.toggle("mdo-backfill-status-done", !!isDone);
  }

  // Per spec: the checkmark only appears once the typed date is strictly
  // older than "Oldest Data Available" — anything else has nothing for
  // Extend to actually do.
  function updateExtendConfirmVisibility() {
    if (!dom.mdoExtendDateInput || !dom.mdoExtendConfirm) return;
    var val = dom.mdoExtendDateInput.value; // native <input type=date> gives "YYYY-MM-DD" or ""
    var oldest = oldestDateStr();
    var valid = !!val && !!oldest && val < oldest; // plain ISO-8601 strings compare chronologically
    dom.mdoExtendConfirm.classList.toggle("visible", valid);
  }

  function openExtendBox() {
    if (!dom.mdoExtendDateBox) return;
    if (dom.mdoExtendDateInput) {
      var oldest = oldestDateStr();
      dom.mdoExtendDateInput.value = oldest; // default: Oldest Data Available, per spec
      if (oldest) dom.mdoExtendDateInput.max = oldest; // can't Extend to a date that isn't older
    }
    dom.mdoExtendDateBox.classList.add("open");
    if (dom.mdoExtendBtn) dom.mdoExtendBtn.classList.add("active");
    extendBoxOpen = true;
    updateExtendConfirmVisibility();
  }

  function closeExtendBox() {
    if (!dom.mdoExtendDateBox) return;
    dom.mdoExtendDateBox.classList.remove("open");
    if (dom.mdoExtendBtn) dom.mdoExtendBtn.classList.remove("active");
    extendBoxOpen = false;
  }

  // Extend itself is ALWAYS clickable (per spec, unlike BackFill it never
  // gets a `disabled` attribute) — this just toggles the date box, and
  // only declines to reopen/close it while a run this box started is
  // still in flight, so the box can't be dismissed out from under an
  // active request.
  function toggleExtendBox() {
    if (extendRunning) return;
    if (extendBoxOpen) closeExtendBox(); else openExtendBox();
  }

  function requestExtend() {
    if (extendRunning || backfillRunning) return;
    if (!dom.mdoExtendDateInput) return;
    var targetDate = dom.mdoExtendDateInput.value;
    var oldest = oldestDateStr();
    if (!targetDate || !oldest || !(targetDate < oldest)) return; // guarded already by the confirm mark's own visibility
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.start_extend) return;

    extendRunning = true;
    if (dom.mdoExtendConfirm) dom.mdoExtendConfirm.classList.remove("visible");
    dom.mdoExtendDateInput.disabled = true;
    setExtendStatusText("Extend Processing...", false);

    window.pywebview.api.start_extend(targetDate).then(function (result) {
      if (!result || !result.ok) {
        extendRunning = false;
        dom.mdoExtendDateInput.disabled = false;
        setExtendStatusText("Extend Unavailable", false);
        updateExtendConfirmVisibility();
      }
      // On success, the real outcome arrives later via
      // window.onExtendStatus("done", ...) — nothing more to do here now.
    }).catch(function () {
      extendRunning = false;
      dom.mdoExtendDateInput.disabled = false;
      setExtendStatusText("Extend Unavailable", false);
      updateExtendConfirmVisibility();
    });
  }

  // (v46) Called from app.py's live-queue consumer, exactly like
  // window.onBackfillStatus above: once when the backend starts working on
  // the request, and once with the final { days_added, days_unreachable }
  // outcome.
  window.onExtendStatus = function (state, info) {
    if (state === "processing") {
      extendRunning = true;
      var total = info && Number(info.days_total);
      setExtendStatusText(total ? ("Extend Processing... (0/" + total.toLocaleString() + " days)") : "Extend Processing...", false);
      return;
    }
    if (state === "progress") {
      // (v46.1) A single MT5 history call for an older, not-yet-cached
      // date can itself take a while - this per-day progress event is
      // what keeps the status line moving instead of sitting on a static
      // "Processing..." for the whole request, so a long Extend doesn't
      // read as stuck.
      extendRunning = true;
      var processed = (info && Number(info.days_processed)) || 0;
      var totalDays = (info && Number(info.days_total)) || 0;
      var addedSoFar = (info && Number(info.days_added)) || 0;
      setExtendStatusText(
        "Extend Processing... (" + processed.toLocaleString() + "/" + totalDays.toLocaleString() +
        " days checked, " + addedSoFar.toLocaleString() + " added)",
        false
      );
      // Live refresh of "Oldest Data Available" (and its day count) at
      // the top of the panel so it visibly moves while Extend is still
      // running, instead of only jumping once at the very end.
      if (isOpen && window.pywebview && window.pywebview.api && window.pywebview.api.get_db_overview) {
        window.pywebview.api.get_db_overview().then(function (data) {
          rememberBrokerNow(data);
          if (!isOpen) return;
          var oldestTs = data && data.oldest_time;
          if (oldestTs !== null && oldestTs !== undefined) {
            var d = new Date(oldestTs * 1000);
            var newOldestYear = d.getUTCFullYear();
            var newOldestMonth = d.getUTCMonth() + 1;
            // v65: as soon as Extend's rolling oldest bound crosses into a
            // month/year the Year/Month dropdowns didn't have an option
            // for yet, grow those lists right now instead of waiting for
            // "done" (or, previously, for the user to close and reopen
            // the whole panel). Compared before/after the reassignment
            // below so this only fires on an actual crossing (at most
            // once per month/year Extend walks through), not on every
            // progress tick.
            var boundaryChanged = (newOldestYear !== oldestYear || newOldestMonth !== oldestMonth);
            oldestYear = newOldestYear;
            oldestMonth = newOldestMonth;
            oldestDay = d.getUTCDate();
            showOldest(oldestTs);
            if (boundaryChanged) refreshYearMonthOptions();
          }
        }).catch(function () {});
      }
      // v57 Update 4: also refresh the per-day histogram grid for
      // whichever Year/Month is currently displayed, on the same
      // cadence as the oldest-data line above. Before this, the only way to
      // see the day-square histogram move during an Extend was the
      // Refresh button (which already works mid-run - it was never
      // disabled during Extend - but had to be clicked by hand every
      // time); the initial Config.py-driven prefill never needed this
      // because that path already gets a live histogram from the
      // Refresh button the same way. Cheap: get_month_histogram() (v65.1)
      // is one to two bounded, indexed COUNT(*) BETWEEN queries plus one
      // indexed MIN/MAX, all under a single lock acquisition (see its v41
      // perf note and v65.1 docstring in candle_cache.py/chart_bridge.py),
      // and this now fires at most once per Extend chunk (a few seconds to
      // tens of seconds apart, not a tight timer) instead of on every day
      // of a day-by-day walk.
      if (isOpen) {
        loadHistogram();
      }
      return;
    }
    if (state === "done") {
      extendRunning = false;
      if (dom.mdoExtendDateInput) dom.mdoExtendDateInput.disabled = false;
      closeExtendBox();

      var added = (info && Number(info.days_added)) || 0;
      var unreachable = (info && Number(info.days_unreachable)) || 0;
      var summary;
      if (added <= 0 && unreachable <= 0) {
        summary = "Extend Done. No Additional Data Available";
      } else if (unreachable > 0) {
        summary = "Extend Done. " + added.toLocaleString() + " Day" + (added === 1 ? "" : "s") +
          " Added, " + unreachable.toLocaleString() + " Day" + (unreachable === 1 ? "" : "s") +
          " Could Not Be Retrieved";
      } else {
        summary = "Extend Done. " + added.toLocaleString() + " Day" + (added === 1 ? "" : "s") + " Added";
      }
      setExtendStatusText(summary, true);

      // Same reasoning as onBackfillStatus above: reflect the new,
      // further-back Oldest Data Available bound and the histogram right
      // away, instead of waiting for the next poll or a manual
      // Year/Month change.
      if (isOpen && window.pywebview && window.pywebview.api && window.pywebview.api.get_db_overview) {
        window.pywebview.api.get_db_overview().then(function (data) {
          rememberBrokerNow(data);
          if (!isOpen) return;
          var oldestTs = data && data.oldest_time;
          if (oldestTs !== null && oldestTs !== undefined) {
            var d = new Date(oldestTs * 1000);
            oldestYear = d.getUTCFullYear();
            oldestMonth = d.getUTCMonth() + 1;
            oldestDay = d.getUTCDate();
            showOldest(oldestTs);
          }
          // v65: was populateYearMonth(), which force-jumped the
          // dropdowns to the real current year/month on every Extend
          // completion — jarring if the user was reviewing some older
          // month while it ran, and the reason a plain "still nothing
          // new after Extend finished" could look like it needed a
          // close/reopen. refreshYearMonthOptions() grows the lists the
          // same way but leaves whatever the user has selected alone.
          refreshYearMonthOptions();
          loadHistogram();
        }).catch(function () {});
      }
    }
  };

  // v65.1: coalesce a burst of rapid Year/Month/Tolerance changes into a
  // single backend round-trip for whatever value the user actually settles
  // on. A plain native <select> fires one "change" event per keystroke
  // when it has focus and the user steps through options with the arrow
  // keys (not just once on close/blur), so switching through several
  // months quickly used to fire one full histogram load per intermediate
  // value, each queued up behind the last. 120ms is short enough that a
  // single deliberate change still feels instant, but long enough to
  // collapse a fast multi-step burst into the one load that matters.
  var histogramLoadTimer = null;

  function scheduleLoadHistogram() {
    if (histogramLoadTimer) clearTimeout(histogramLoadTimer);
    histogramLoadTimer = setTimeout(function () {
      histogramLoadTimer = null;
      loadHistogram();
    }, 120);
  }

  function setChartLoading(isLoading) {
    if (dom.mdoChartBox) dom.mdoChartBox.classList.toggle("mdo-loading", isLoading);
    if (dom.mdoCheckboxRow) dom.mdoCheckboxRow.classList.toggle("mdo-loading", isLoading);
  }

  // v65.1: every loadHistogram() call is tagged with an increasing sequence
  // number; when its response comes back, it's only applied to the DOM if
  // it is STILL the most recent request. Without this, several rapid
  // Year/Month/Tolerance changes (their round-trips now merged into one
  // each - see get_month_histogram in chart_bridge.py - but still not
  // guaranteed to resolve in the order they were sent once several are in
  // flight at once) could let an older, slower response land after a
  // newer one and silently repaint the box back to a month the user isn't
  // even looking at anymore.
  var histogramRequestSeq = 0;

  function loadHistogram(force) {
    var year = Number(dom.mdoYearSelect.value);
    var month = Number(dom.mdoMonthSelect.value);
    var tf = Number(dom.mdoToleranceSelect.value);
    if (!year || !month || !tf) return Promise.resolve();
    // v63: while the Log view is showing, the histogram is hidden - don't
    // spend three backend queries (per Extend chunk, per dropdown change)
    // on something nobody can see. It is just marked stale and refreshed
    // the moment the user switches back to Chart. Only an explicit
    // Refresh-button click (force === true) still does the work.
    if (viewMode === "log" && force !== true) {
      histogramStale = true;
      return Promise.resolve();
    }
    histogramStale = false;
    var requestId = ++histogramRequestSeq;
    setChartLoading(true);
    // v65.1: one combined bridge call instead of three (see
    // get_month_histogram's docstring in chart_bridge.py for why three
    // separate round-trips, all serialized behind the backend's db lock
    // with no de-duplication, was what actually made month-switching feel
    // slow on a large history - not the SQL itself).
    return window.pywebview.api.get_month_histogram(tf, year, month).then(function (data) {
      if (requestId !== histogramRequestSeq) return; // superseded — a newer change already landed
      if (!isOpen) return; // modal may have been closed while this was in flight
      rememberBrokerNow(data);
      currentDaysInMonth = daysInMonth(year, month);
      renderChart((data && data.counts) || [], year, month, tf, (data && data.counts1m) || []);
      updateBackfillEnabled();
    }).catch(function () {
      if (requestId !== histogramRequestSeq) return;
      renderChart([], year, month, tf, []);
    }).then(function () {
      if (requestId === histogramRequestSeq) setChartLoading(false);
    });
  }

  // v61.2: the live Total Seconds counter (and its 2s poll) is gone - it
  // needed a full COUNT(*) over candles_1s on every tick of the timer. The
  // Oldest Data Available line only changes on Backfill/Extend, which
  // already refresh it from their own status callbacks, so nothing polls
  // in the background while this tab is open.

  // ---- v63: Chart / Log view switch -------------------------------------------
  // Chart (default) shows the per-day histogram. Log shows the DATABASE-
  // category lines of the header Log panel, in a small zoomed-out box. The
  // Log view is a second consumer of App.LogFeed (web/js/log-panel.js): the
  // same single poller and buffer the header panel uses, so it adds no
  // backend call of its own, and it is attached (i.e. polling runs) only
  // while the Log view is actually on screen.
  var viewMode = "chart";
  var histogramStale = false;
  var logView = null;

  function attachLogView() {
    if (!App.LogFeed || !dom.mdoLogBox) return;
    if (!logView) logView = App.LogFeed.createView(dom.mdoLogBox, "DATABASE");
    App.LogFeed.attach(logView);
    logView.scrollToEnd(); // the box only has a scroll height once it is displayed
  }

  function detachLogView() {
    if (logView && App.LogFeed) App.LogFeed.detach(logView);
  }

  function setViewMode(mode) {
    viewMode = mode;
    var isLog = mode === "log";
    if (dom.mdoPane) dom.mdoPane.classList.toggle("mdo-log-mode", isLog);
    if (dom.mdoViewChartBtn) {
      dom.mdoViewChartBtn.classList.toggle("active", !isLog);
      dom.mdoViewChartBtn.setAttribute("aria-pressed", isLog ? "false" : "true");
    }
    if (dom.mdoViewLogBtn) {
      dom.mdoViewLogBtn.classList.toggle("active", isLog);
      dom.mdoViewLogBtn.setAttribute("aria-pressed", isLog ? "true" : "false");
    }
    if (isLog) {
      attachLogView();
    } else {
      detachLogView();
      if (histogramStale && isOpen) loadHistogram();
    }
  }

  function requestViewMode(mode) {
    if (mode !== viewMode) setViewMode(mode);
  }

  // v50: "activate" replaces the old open() — called by settings-panel.js
  // once the Setting backdrop is showing and the user has switched to (or
  // opened straight onto) this tab. No longer owns the backdrop/toggle
  // itself; just (re)loads data and starts the live overview poll.
  function activate() {
    // v63: every time the tab is opened it starts on Chart (the default).
    if (viewMode !== "chart") setViewMode("chart");
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.get_db_overview) return;

    window.pywebview.api.get_db_overview().then(function (data) {
      rememberBrokerNow(data);
      var oldestTs = data && data.oldest_time;

      if (oldestTs === null || oldestTs === undefined) {
        // No candles cached yet — fall back to "now" as the only
        // selectable month so the dropdowns still populate sensibly
        // instead of throwing.
        var now = brokerNowDate();
        oldestYear = now.getUTCFullYear();
        oldestMonth = now.getUTCMonth() + 1;
        oldestDay = now.getUTCDate();
        clearOldest();
      } else {
        var d = new Date(oldestTs * 1000);
        oldestYear = d.getUTCFullYear();
        oldestMonth = d.getUTCMonth() + 1;
        oldestDay = d.getUTCDate();
        showOldest(oldestTs);
      }

      populateYearMonth();
      populateTolerance();
      loadHistogram();

      isOpen = true;
    }).catch(function () {
      // Backend not ready / errored — do nothing rather than show a
      // half-populated pane.
    });
  }

  // v50: "deactivate" replaces the old close() — called when the Setting
  // panel closes entirely or the user switches to a different tab.
  function deactivate() {
    isOpen = false;
    // v65.1: don't let a debounced dropdown-change load fire after the tab
    // has been switched away from/closed — harmless (it's guarded by isOpen
    // inside loadHistogram's own .then) but pointless backend work.
    if (histogramLoadTimer) { clearTimeout(histogramLoadTimer); histogramLoadTimer = null; }
    // v63: stop feeding the (now hidden) Log view - polling stops with it
    // unless the header Log panel is open. Chart is restored on next open.
    detachLogView();
    // v46: just hides the date box — an Extend already in flight keeps
    // running on the backend regardless (same as Backfill), and its
    // eventual onExtendStatus("done", ...) is handled fine whether or not
    // this tab happens to be active when it arrives.
    if (!extendRunning) closeExtendBox();
  }

  App.MarketDataOverview = { activate: activate, deactivate: deactivate };

  // v63: Chart / Log switch buttons (icons: chart.svg glyph / the header's
  // Log glyph, both currentColor so .mdo-view-btn's states colour them).
  if (dom.mdoViewChartBtn) {
    dom.mdoViewChartBtn.innerHTML = App.Icons.chart ? App.Icons.chart() : "";
    dom.mdoViewChartBtn.addEventListener("click", function () { requestViewMode("chart"); });
  }
  if (dom.mdoViewLogBtn) {
    dom.mdoViewLogBtn.innerHTML = App.Icons.log ? App.Icons.log() : "";
    dom.mdoViewLogBtn.addEventListener("click", function () { requestViewMode("log"); });
  }

  dom.mdoYearSelect.addEventListener("change", function () {
    var now = brokerNowDate();
    populateMonthsForYear(Number(dom.mdoYearSelect.value), now.getUTCFullYear(), now.getUTCMonth() + 1);
    scheduleLoadHistogram();
  });
  dom.mdoMonthSelect.addEventListener("change", scheduleLoadHistogram);
  dom.mdoToleranceSelect.addEventListener("change", scheduleLoadHistogram);

  // v38.1: the BackFill button toggles enabled/disabled based on whether
  // at least one day (in the currently displayed month) is checked.
  // v44: clicking it now actually starts a Backfill run (see
  // requestBackfill above).
  dom.mdoBackfillBtn.disabled = true;
  dom.mdoBackfillBtn.addEventListener("click", requestBackfill);

  // v44.1: manual candle re-count button, next to Tolerance.
  if (dom.mdoRefreshBtn) {
    dom.mdoRefreshBtn.innerHTML = App.Icons.refresh ? App.Icons.refresh() : "";
    dom.mdoRefreshBtn.addEventListener("click", requestManualRefresh);
  }

  // v44.1: Select All / Deselect All master checkbox for the currently
  // displayed month's day squares.
  if (dom.mdoSelectAllBtn) {
    dom.mdoSelectAllBtn.addEventListener("click", toggleSelectAll);
  }

  // v46: Extend — button always enabled (no `disabled` toggling, unlike
  // BackFill), opens/closes the date box; the box's own X/checkmark drive
  // cancel vs. start.
  if (dom.mdoExtendBtn) dom.mdoExtendBtn.addEventListener("click", toggleExtendBox);
  if (dom.mdoExtendCancel) {
    dom.mdoExtendCancel.addEventListener("click", function () {
      if (extendRunning) return; // can't cancel a request already sent to the backend
      closeExtendBox();
    });
  }
  if (dom.mdoExtendDateInput) {
    dom.mdoExtendDateInput.addEventListener("input", updateExtendConfirmVisibility);
    dom.mdoExtendDateInput.addEventListener("change", updateExtendConfirmVisibility);
  }
  if (dom.mdoExtendConfirm) dom.mdoExtendConfirm.addEventListener("click", requestExtend);
})();
