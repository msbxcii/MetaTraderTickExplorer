// =============================================================================
// economic-news.js — v110: Setting > Market Data Overview > Economic News.
// One square per week (Sunday-Saturday), 20 per row. Solid = downloaded (not
// selectable), hollow = missing (selectable -> BackFill). Extend downloads
// older weeks back to a chosen date. Downloading runs in the backend
// (news_service.py, Scrabber code); this file only draws and sends requests.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  if (!dom.nwsBox) return;

  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAY = 86400000;

  var isOpen = false;
  var running = false;       // a Backfill/Extend job is in flight
  var runningKind = null;    // "extend" | "backfill" while running
  var stopping = false;      // Stop was pressed, waiting for the job to wind down
  var info = { rangeStart: null, currentWeek: null, oldest: null, years: [], solid: {}, partial: {} };
  var year = null;
  var visible = [];          // weeks currently drawn: {key, solid}
  var sel = {};              // selected hollow weeks, by week key
  var lastIdx = -1;
  var pendingKeys = [];
  var note = "";             // last finished-job message (shown while nothing is selected)
  var viewMode = "chart";
  var logView = null;
  var loadSeq = 0;

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function iso(t) {
    var d = new Date(t);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }
  function parseIso(s) {
    var p = s.split("-");
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }
  function sundayOf(t) { return t - new Date(t).getUTCDay() * DAY; }
  function todayIso() { return iso(Date.now()); }
  function plural(n, w) { return n.toLocaleString() + " " + w + (n === 1 ? "" : "s"); }

  function api() { return window.pywebview && window.pywebview.api; }

  // ---- status line (shared look with Price Data) ---------------------------
  function setStatus(text, done) {
    dom.nwsStatus.textContent = text || "\u00a0";
    dom.nwsStatus.classList.toggle("mdo-backfill-status-done", !!done);
  }

  function selectedKeys() {
    return visible.filter(function (w) { return !w.solid && sel[w.key]; }).map(function (w) { return w.key; });
  }

  function refreshControls() {
    var n = selectedKeys().length;
    dom.nwsBackfillBtn.disabled = running || n === 0;
    if (running) return;
    if (n) setStatus(plural(n, "Week") + " Selected", false);
    else setStatus(note, !!note);
  }

  // ---- week grid -------------------------------------------------------------
  function weekLabel(t, i) {
    var a = new Date(t), z = new Date(t + 6 * DAY);
    return "Week" + (i + 1) + " : " + a.getUTCDate() + MON[a.getUTCMonth()] + " - " + z.getUTCDate() + MON[z.getUTCMonth()];
  }

  function render() {
    visible = [];
    var html = "";
    if (info.rangeStart && year) {
      var lo = parseIso(info.rangeStart), hi = parseIso(info.currentWeek);
      var t = sundayOf(Date.UTC(year, 0, 1)), last = sundayOf(Date.UTC(year, 11, 31));
      for (var i = 0; t <= last; i++, t += 7 * DAY) {
        if (t < lo || t > hi) continue;
        var key = iso(t);
        var n = info.solid[key];
        var solid = n !== undefined;
        var part = !solid && info.partial[key] !== undefined;   // running week: has data, still updatable
        if (solid) delete sel[key];
        var label = weekLabel(t, i) + (solid ? " \u2014 " + plural(n, "event")
          : part ? " \u2014 " + plural(info.partial[key], "event") + " (in progress)" : " \u2014 missing");
        html += '<div class="nws-sq' + (solid ? "" : part ? " p" : " e") + (sel[key] ? " s" : "") +
          '" data-i="' + visible.length + '" data-t="' + label + '"></div>';
        visible.push({ key: key, solid: solid });
      }
    }
    dom.nwsBox.innerHTML = html;
    dom.nwsHoverInfo.innerHTML = "&nbsp;";
    lastIdx = -1;
    refreshControls();
  }

  function applyOverview(d) {
    if (!d || !d.ok) return;
    info = { rangeStart: d.range_start, currentWeek: d.current_week, oldest: d.oldest,
             years: d.years || [], solid: d.solid || {}, partial: d.partial || {} };
    dom.nwsOldest.textContent = d.oldest ? d.oldest.replace(/-/g, ".") : "\u2014";
    var want = year && info.years.indexOf(year) !== -1 ? year : info.years[0];
    var have = Array.prototype.map.call(dom.nwsYearSelect.options, function (o) { return o.value; }).join(",");
    if (have !== info.years.join(",")) {
      dom.nwsYearSelect.innerHTML = info.years.map(function (y) { return "<option value=\"" + y + "\">" + y + "</option>"; }).join("");
    }
    dom.nwsYearSelect.value = String(want);
    if (want !== year) {          // first load / the year disappeared: ask again for that year
      year = want;
      return loadOverview();
    }
    render();
  }

  function loadOverview() {
    var a = api();
    if (!a || !a.get_news_overview) return Promise.resolve();
    var my = ++loadSeq;
    return a.get_news_overview(year || 0).then(function (d) {
      if (my === loadSeq) return applyOverview(d);
    }).catch(function () {});
  }

  var refreshTimer = null;
  function scheduleOverview() {
    if (refreshTimer || !isOpen) return;
    refreshTimer = setTimeout(function () { refreshTimer = null; loadOverview(); }, 300);
  }

  // hover line + selection (event delegation: one listener for all squares)
  dom.nwsBox.addEventListener("mouseover", function (e) {
    var q = e.target.closest(".nws-sq");
    // the gap between squares belongs to the box itself -> clear the text there
    if (q) dom.nwsHoverInfo.textContent = q.getAttribute("data-t");
    else dom.nwsHoverInfo.innerHTML = "&nbsp;";
  });
  dom.nwsBox.addEventListener("mouseleave", function () { dom.nwsHoverInfo.innerHTML = "&nbsp;"; });
  dom.nwsBox.addEventListener("click", function (e) {
    var q = e.target.closest(".nws-sq");
    if (!q) return;
    var i = +q.getAttribute("data-i");
    var w = visible[i];
    if (!w || w.solid) return;                 // downloaded weeks can never be selected
    var nodes = dom.nwsBox.children;
    if (e.shiftKey && lastIdx >= 0) {
      for (var k = Math.min(i, lastIdx); k <= Math.max(i, lastIdx); k++) {
        if (!visible[k].solid) { sel[visible[k].key] = 1; nodes[k].classList.add("s"); }
      }
    } else {
      if (sel[w.key]) delete sel[w.key]; else sel[w.key] = 1;
      q.classList.toggle("s", !!sel[w.key]);
      lastIdx = i;
    }
    note = "";
    refreshControls();
  });

  // ---- proxy ----------------------------------------------------------------
  function syncProxyUI() {
    var manual = dom.nwsProxySelect.value === "manual";
    dom.nwsTypeSelect.disabled = !manual;
    dom.nwsPortInput.disabled = !manual;
  }
  dom.nwsProxySelect.addEventListener("change", syncProxyUI);
  dom.nwsPortInput.addEventListener("input", function () {
    var v = dom.nwsPortInput.value.replace(/\D/g, "");
    if (v !== dom.nwsPortInput.value) dom.nwsPortInput.value = v;
  });

  // null = invalid manual port
  function proxyConfig() {
    var manual = dom.nwsProxySelect.value === "manual";
    var port = parseInt(dom.nwsPortInput.value, 10);
    if (manual && !(port >= 1 && port <= 65535)) return null;
    var cfg = { mode: manual ? "manual" : "auto", type: dom.nwsTypeSelect.value, port: manual ? port : null };
    var dl = App.AppConfig && App.AppConfig.getNewsDelay && App.AppConfig.getNewsDelay();
    if (dl) { cfg.delay_min = dl.min; cfg.delay_max = dl.max; }   // Setting > Configuration > News Request Interval
    return cfg;
  }

  App.NewsProxy = proxyConfig;   // v111: News tab Refresh reuses the same proxy settings

  // ---- jobs -----------------------------------------------------------------
  function startJob(label, call) {
    var proxy = proxyConfig();
    if (!proxy) { setStatus("Invalid Proxy Port", false); return false; }
    running = true;
    runningKind = label.toLowerCase();
    stopping = false;
    setStatus(label + " Processing...", false);
    dom.nwsBackfillBtn.disabled = true;
    syncExtendBtn();
    function failed(res) {
      running = false;
      runningKind = null;
      syncExtendBtn();
      var pk = res && res.error === "packages";
      setStatus(pk ? "Install curl_cffi and beautifulsoup4 First" : label + " Unavailable", false);
      refreshControls();
    }
    call(proxy).then(function (res) { if (!res || !res.ok) failed(res); }).catch(function () { failed(null); });
    return true;
  }

  function requestBackfill() {
    var keys = selectedKeys();
    var a = api();
    if (running || !keys.length || !a || !a.start_news_backfill) return;
    pendingKeys = keys;
    note = "";
    startJob("Backfill", function (proxy) { return a.start_news_backfill(keys, proxy); });
  }

  window.onNewsStatus = function (kind, state, d) {
    d = d || {};
    var label = kind === "extend" ? "Extend" : "Backfill";
    if (state === "processing" || state === "progress") {
      running = true;
      runningKind = kind;
      dom.nwsBackfillBtn.disabled = true;
      dom.nwsExtendDateInput.disabled = true;
      syncExtendBtn();
      setStatus(label + " Processing... (" + (d.processed || 0).toLocaleString() + "/" +
        (d.total || 0).toLocaleString() + " weeks checked, " + (d.added || 0).toLocaleString() + " added)", false);
      if (state === "progress") scheduleOverview();
      return;
    }
    if (state !== "done") return;
    running = false;
    runningKind = null;
    stopping = false;
    syncExtendBtn();
    dom.nwsExtendDateInput.disabled = false;
    closeExtendBox();
    var added = d.added || 0, miss = d.unreachable || 0;
    if (d.stopped) {
      note = label + " Stopped. " + plural(added, "Week") + " Added";
      pendingKeys = [];
    } else if (kind === "extend") {
      note = (added <= 0 && miss <= 0) ? "Extend Done. No Additional Data Available"
        : "Extend Done. " + plural(added, "Week") + " Added" + (miss > 0 ? ", " + plural(miss, "Week") + " Could Not Be Retrieved" : "");
    } else {
      note = added > 0 ? "Backfill Done, " + plural(added, "Week") + " Recovered" + (miss > 0 ? ", " + miss.toLocaleString() + " Still Missing" : "")
        : "Backfill Done, No Data Recovered";
      pendingKeys.forEach(function (k) { delete sel[k]; });
      pendingKeys = [];
    }
    refreshControls();
    if (isOpen) loadOverview();
  };

  // ---- v126: weekly auto-sync (starts once the app is connected; backend decides if a week is due) ----
  var autoDone = false, autoTimer = 0;
  function autoToast(msg, kind) { if (App.Trade && App.Trade.toast) App.Trade.toast(msg, kind); }
  function tryAutoSync() {
    autoTimer = 0;
    var a = api();
    if (autoDone || !a || !a.start_news_autosync || App.backendStatus === "offline" || App.backendStatus === "syncing") return;
    var proxy = proxyConfig();
    if (!proxy) return;
    a.start_news_autosync(proxy).then(function (res) {
      // up to date / not set up -> finished for this session; busy or unreachable -> retry on the next "live"
      if (res && (res.started || res.reason === "uptodate" || res.reason === "nodb" || res.reason === "packages")) autoDone = true;
    }).catch(function () {});
  }
  document.addEventListener("App:backendStatus", function (e) {
    if (autoDone || autoTimer || !e.detail || e.detail === "offline" || e.detail === "syncing") return;
    autoTimer = setTimeout(tryAutoSync, 4000);   // let the chart finish its first draw first
  });
  window.onNewsAutoSync = function (kind, state, d) {
    d = d || {};
    if (state === "start") {
      autoToast("Syncing economic news \u2014 " + plural(d.total || 0, "week"), "info");
      return;
    }
    if (state !== "done") return;
    if (d.added > 0 && App.News && App.News.dataChanged) App.News.dataChanged();
    if (isOpen) loadOverview();
    if (d.ok) autoToast("Economic news synced \u2014 " + plural(d.added || 0, "week") + " updated", "ok");
    else autoToast("Economic news sync incomplete \u2014 will retry on next launch", "err");
  };

  // ---- Extend (calendar, like Price Data) -----------------------------------
  var extendBoxOpen = false;

  function extendValid() {
    var v = dom.nwsExtendDateInput.value;
    if (!v) return false;
    if (info.rangeStart) return sundayOf(parseIso(v)) < parseIso(info.rangeStart);
    return v <= todayIso();
  }
  function updateExtendConfirm() {
    dom.nwsExtendConfirm.classList.toggle("visible", !running && extendValid());
  }
  function openExtendBox() {
    var top = info.oldest || todayIso();
    dom.nwsExtendDateInput.max = top;
    dom.nwsExtendDateInput.value = top;
    dom.nwsExtendDateBox.classList.add("open");
    dom.nwsExtendBtn.classList.add("active");
    extendBoxOpen = true;
    updateExtendConfirm();
  }
  function closeExtendBox() {
    dom.nwsExtendDateBox.classList.remove("open");
    dom.nwsExtendBtn.classList.remove("active");
    extendBoxOpen = false;
  }
  function requestExtend() {
    var a = api();
    if (running || !extendValid() || !a || !a.start_news_extend) return;
    var target = dom.nwsExtendDateInput.value;
    dom.nwsExtendConfirm.classList.remove("visible");
    note = "";
    startJob("Extend", function (proxy) { return a.start_news_extend(target, proxy); });
  }
  // Extend <-> Stop: while an Extend job runs the same button becomes "Stop"
  function syncExtendBtn() {
    var isStop = running && runningKind === "extend";
    dom.nwsExtendBtn.textContent = isStop ? "Stop" : "Extend";
    dom.nwsExtendBtn.disabled = stopping || (running && !isStop);
    dom.nwsExtendBtn.classList.toggle("stop", isStop);
  }
  function requestStop() {
    var a = api();
    if (!running || stopping) return;
    stopping = true;
    setStatus("Stopping...", false);
    syncExtendBtn();
    if (a && a.stop_news_job) a.stop_news_job();
  }
  dom.nwsExtendBtn.addEventListener("click", function () {
    if (running) {
      if (runningKind === "extend") requestStop();
      return;
    }
    if (extendBoxOpen) closeExtendBox(); else openExtendBox();
  });
  dom.nwsExtendCancel.addEventListener("click", function () { if (!running) closeExtendBox(); });
  dom.nwsExtendDateInput.addEventListener("input", updateExtendConfirm);
  dom.nwsExtendDateInput.addEventListener("change", updateExtendConfirm);
  dom.nwsExtendConfirm.addEventListener("click", requestExtend);
  dom.nwsBackfillBtn.addEventListener("click", requestBackfill);

  // ---- refresh, year, Chart / Log -------------------------------------------
  dom.nwsRefreshBtn.innerHTML = App.Icons.refresh ? App.Icons.refresh() : "";
  dom.nwsRefreshBtn.addEventListener("click", function () {
    if (dom.nwsRefreshBtn.classList.contains("spinning")) return;
    dom.nwsRefreshBtn.classList.add("spinning");
    var done = function () { dom.nwsRefreshBtn.classList.remove("spinning"); };
    loadOverview().then(done, done);
  });
  dom.nwsYearSelect.addEventListener("change", function () {
    year = Number(dom.nwsYearSelect.value) || null;
    loadOverview();
  });

  function setViewMode(mode) {
    viewMode = mode;
    var isLog = mode === "log";
    dom.mdoSrcNews.classList.toggle("mdo-log-mode", isLog);
    dom.nwsViewChartBtn.classList.toggle("active", !isLog);
    dom.nwsViewChartBtn.setAttribute("aria-pressed", isLog ? "false" : "true");
    dom.nwsViewLogBtn.classList.toggle("active", isLog);
    dom.nwsViewLogBtn.setAttribute("aria-pressed", isLog ? "true" : "false");
    if (isLog) {
      if (App.LogFeed) {
        if (!logView) logView = App.LogFeed.createView(dom.nwsLogBox, "DATABASE", { include: "[NEWS]" });
        App.LogFeed.attach(logView);
        logView.scrollToEnd();
      }
    } else if (logView && App.LogFeed) {
      App.LogFeed.detach(logView);
    }
  }
  dom.nwsViewChartBtn.innerHTML = App.Icons.chart ? App.Icons.chart() : "";
  dom.nwsViewLogBtn.innerHTML = App.Icons.log ? App.Icons.log() : "";
  dom.nwsViewChartBtn.addEventListener("click", function () { if (viewMode !== "chart") setViewMode("chart"); });
  dom.nwsViewLogBtn.addEventListener("click", function () { if (viewMode !== "log") setViewMode("log"); });

  syncProxyUI();

  App.EconomicNews = {
    activate: function () {
      isOpen = true;
      if (viewMode !== "chart") setViewMode("chart");
      refreshControls();
      loadOverview();
    },
    deactivate: function () {
      isOpen = false;
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      if (logView && App.LogFeed) App.LogFeed.detach(logView);
      if (!running) closeExtendBox();
    },
  };
})();
