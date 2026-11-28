// v131: Market Profile (TPO). v132: row count from Configuration (2..100); never drawn on 1s/5s/15s panels; Ruler range profile. Drawn only while the toolbar icon is on.
// The hovered candle's Low..High is split into 8 equal bands; each band counts the 1s candles that touched it
// (time spent at price). Counted in the backend (get_market_profile); results of finished candles are cached.
(function () {
  "use strict";
  var MAX_CACHE = 400, LIVE_MS = 500, MAX_TF_HIDDEN = 15;  // v132: no profile on panels with tf <= 15s
  function rows() {  // v132: live row count (Configuration), 2..100
    var f = window.App && App.AppConfig && App.AppConfig.getMarketProfileRows;
    return f ? f() : 12;
  }
  var on = false, cache = new Map(), pending = {}, insts = [], colors = null, colorsAt = 0;
  var btn = document.getElementById("market-profile-toggle");

  function request(key, sp, live, n, cb) {
    var q = pending[key];
    if (q) { q.push(cb); return; }
    var api = window.pywebview && window.pywebview.api;
    if (!api || !api.get_market_profile) return;
    pending[key] = [cb];
    api.get_market_profile(sp.start, sp.end, sp.lo, sp.hi, n).then(function (r) {
      var cbs = pending[key]; delete pending[key];
      var c = r && r.c;
      if (!c || c.length !== n) return;
      if (!live) {
        cache.set(key, c);
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      }
      for (var i = 0; i < cbs.length; i++) cbs[i](c);
    }, function () { delete pending[key]; });
  }

  function theme() {
    var now = Date.now();
    if (!colors || now - colorsAt > 2000) {
      var cs = getComputedStyle(document.body);
      colors = {
        acc: cs.getPropertyValue("--gold").trim() || "#888888",
        mut: cs.getPropertyValue("--muted").trim() || "#888888",
      };
      colorsAt = now;
    }
    return colors;
  }

  // v132: draws the bars of counts `c` (row 0 = lowest band) between y yA..yB, from x, longest bar = w. Shared with the Ruler.
  function paintBars(cx, c, x, w, yA, yB) {
    var n = c.length, max = 0, tot = 0, i;
    for (i = 0; i < n; i++) { tot += c[i]; if (c[i] > max) max = c[i]; }
    if (!max) return false;
    var mid = (n - 1) / 2, poc = -1;  // POC: highest count, ties -> nearest the middle
    for (i = 0; i < n; i++) if (c[i] === max && (poc < 0 || Math.abs(i - mid) < Math.abs(poc - mid))) poc = i;
    var L = poc, H = poc, sum = c[poc];  // Value Area: 70% of the time around POC
    while (sum < tot * 0.7 && (L > 0 || H < n - 1)) {
      var dn = L > 0 ? c[L - 1] : -1, up = H < n - 1 ? c[H + 1] : -1;
      if (up >= dn) { H++; sum += c[H]; } else { L--; sum += c[L]; }
    }
    var top = Math.min(yA, yB), rh = (Math.max(yA, yB) - top) / n, gap = rh >= 5 ? 1 : 0, th = theme();
    for (var r = 0; r < n; r++) {  // row 0 = top = highest band; rows tile Low..High exactly
      var lv = n - 1 - r, y0 = Math.round(top + r * rh), y1 = Math.round(top + (r + 1) * rh);
      var hgt = Math.max(1, y1 - y0 - (r < n - 1 ? gap : 0));
      if (lv === poc) { cx.fillStyle = th.acc; cx.globalAlpha = 0.7; }
      else if (lv >= L && lv <= H) { cx.fillStyle = th.acc; cx.globalAlpha = 0.32; }
      else { cx.fillStyle = th.mut; cx.globalAlpha = 0.32; }
      cx.fillRect(x, y0, Math.max(1, c[lv] / max * w), hgt);
    }
    cx.globalAlpha = 1;
    return true;
  }

  // v132: Ruler range profile. Counts of the 1s candles in [start, end) with the range's own Low/High; one request
  // in flight, latest range wins; returns the last result (maybe of the previous range) until the new one arrives.
  var rng = { res: null, busy: false, want: null, cb: null };
  function range(start, end, cb) {
    if (!on) return null;
    if (App.replayActive && App.ReplayBar && App.ReplayBar.getReplayPointTime) {  // never read past the Replay playhead
      var pt = App.ReplayBar.getReplayPointTime();
      if (pt !== null && pt !== undefined && pt + 1 < end) end = pt + 1;
    }
    if (end <= start) return null;
    var n = rows(), key = start + "|" + end + "|" + n;
    rng.cb = cb;
    if (rng.res && rng.res.key === key) return rng.res;
    rng.want = { start: start, end: end, n: n, key: key };
    pumpRange();
    return rng.res;
  }
  function pumpRange() {
    var api = window.pywebview && window.pywebview.api;
    if (rng.busy || !rng.want || !api || !api.get_market_profile) return;
    var w = rng.want; rng.want = null; rng.busy = true;
    api.get_market_profile(w.start, w.end, null, null, w.n).then(function (r) {
      rng.busy = false;
      if (r && r.c && r.c.length === w.n && r.lo !== undefined && r.lo !== null) rng.res = { key: w.key, c: r.c, lo: r.lo, hi: r.hi };
      if (rng.cb && on) rng.cb();
      if (rng.want) pumpRange();
    }, function () { rng.busy = false; });
  }
  function resetRange() { rng.res = null; rng.want = null; rng.cb = null; }

  // getData() -> {candles, tf, series}; xAt(time) -> x pixel of that candle (crosshair's own mapping).
  function create(chart, container, getData, xAt) {
    var cv = null, cx = null, cw = 0, ch = 0, dpr = 1, drawn = false;
    var cur = { spec: null, counts: null, cstart: null, sig: "", dc: null, timer: 0, lastReq: 0 };

    function clear() {
      if (cx && drawn) { cx.clearRect(0, 0, cw, ch); drawn = false; cur.sig = ""; cur.dc = null; }
    }

    function ensure(pw, ph) {
      if (!cv) {
        cv = document.createElement("canvas");
        cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:4;";
        container.appendChild(cv);
        cx = cv.getContext("2d");
      }
      var r = window.devicePixelRatio || 1;
      if (pw !== cw || ph !== ch || r !== dpr) {
        cw = pw; ch = ph; dpr = r;
        cv.style.width = pw + "px"; cv.style.height = ph + "px";
        cv.width = Math.max(1, Math.round(pw * r)); cv.height = Math.max(1, Math.round(ph * r));
        cx.setTransform(r, 0, 0, r, 0, 0);
        drawn = false; cur.sig = "";
      }
    }

    function draw() {
      var sp = cur.spec, c = cur.counts;
      if (!sp || !c) { clear(); return; }
      var d = getData && getData(), s = d && d.series;
      if (!s) { clear(); return; }
      var ts = chart.timeScale(), pw = Math.floor(ts.width()), ph = Math.floor(container.clientHeight - ts.height());
      var yA = s.priceToCoordinate(sp.hi), yB = s.priceToCoordinate(sp.lo), x1 = xAt(sp.start);
      if (yA === null || yB === null || yA === undefined || yB === undefined || x1 === null || x1 === undefined || pw <= 0 || ph <= 0) { clear(); return; }
      var x, w;
      if (sp.t2 !== null) {  // lower-tf panel: from the left boundary line to the right one
        var x2 = xAt(sp.t2);
        if (x2 === null || x2 === undefined) { clear(); return; }
        x = x1; w = Math.max(x2 - x1, 12);
      } else {  // candle's own panel: right of the candle, 4 candle slots wide
        var nx = xAt(sp.start + sp.tf), sl = (nx === null || nx === undefined) ? 8 : Math.abs(nx - x1);
        x = x1 + sl / 2 + 2; w = Math.max(36, Math.min(sl * 4, 160));
      }
      var sig = x + "," + w + "," + yA + "," + yB + "," + pw + "," + ph;
      if (drawn && cur.dc === c && cur.sig === sig) return;
      ensure(pw, ph);
      cx.clearRect(0, 0, cw, ch);
      if (!paintBars(cx, c, x, w, yA, yB)) { drawn = false; return; }
      drawn = true; cur.sig = sig; cur.dc = c;
    }

    function fire() {
      cur.timer = 0;
      var sp = cur.spec;
      if (!sp || !on) return;
      var n = rows(), key = sp.start + "|" + sp.end + "|" + sp.lo + "|" + sp.hi + "|" + n;
      if (!sp.live && cache.has(key)) { cur.counts = cache.get(key); cur.cstart = sp.start; draw(); return; }
      cur.lastReq = Date.now();
      request(key + (sp.live ? "|L" : ""), sp, sp.live, n, function (c) {
        var s2 = cur.spec;
        if (!s2 || s2.start !== sp.start || s2.end !== sp.end) return;  // hover moved on
        cur.counts = c; cur.cstart = sp.start; draw();
      });
    }

    function hide() {
      if (cur.timer) { clearTimeout(cur.timer); cur.timer = 0; }
      cur.spec = null; cur.counts = null; cur.cstart = null;
      clear();
    }

    // sp: {start, end, tf, t2|undefined, hi, lo, live}
    function show(sp) {
      if (!on || !sp || sp.tf <= MAX_TF_HIDDEN || (App.Ruler && App.Ruler.isActive())) { hide(); return; }  // v132: none for 1s/5s/15s candles, none while the Ruler is active
      var end = sp.end;
      if (App.replayActive && App.ReplayBar && App.ReplayBar.getReplayPointTime) {  // never read past the Replay playhead
        var pt = App.ReplayBar.getReplayPointTime();
        if (pt !== null && pt !== undefined && pt + 1 < end) end = pt + 1;
      }
      if (end <= sp.start) { hide(); return; }
      cur.spec = { start: sp.start, end: end, tf: sp.tf, t2: sp.t2 === undefined ? null : sp.t2, hi: sp.hi, lo: sp.lo, live: !!sp.live };
      if (cur.cstart !== sp.start) cur.counts = null;
      var key = sp.start + "|" + end + "|" + sp.lo + "|" + sp.hi + "|" + rows();
      if (!sp.live && cache.has(key)) {
        if (cur.timer) { clearTimeout(cur.timer); cur.timer = 0; }
        cur.counts = cache.get(key); cur.cstart = sp.start; draw(); return;
      }
      draw();  // old counts of the same candle (live) or nothing until the reply arrives
      if (!cur.timer) {
        var since = Date.now() - cur.lastReq;
        cur.timer = setTimeout(fire, sp.live ? Math.max(0, LIVE_MS - since) : 20);
      }
    }

    var inst = { container: container, show: show, hide: hide };
    insts = insts.filter(function (o) { return o.container.isConnected; });
    insts.push(inst);
    return inst;
  }

  function setOn(v) {
    on = !!v;
    if (btn) { btn.classList.toggle("active", on); btn.setAttribute("aria-pressed", on ? "true" : "false"); }
    if (!on) { insts.forEach(function (o) { o.hide(); }); resetRange(); }
  }

  // v132: tooltip = "Market Profile (P)": the shortcut is taken live from the Keyboard Shortcuts tab.
  function refreshTitle() {
    if (!btn) return;
    var ks = window.App && App.KeyboardShortcuts && App.KeyboardShortcuts.getLabel ? App.KeyboardShortcuts.getLabel("marketProfile") : null;
    btn.title = ks ? "Market Profile (" + ks + ")" : "Market Profile";
  }
  document.addEventListener("App:shortcutsChanged", refreshTitle);
  refreshTitle();

  if (btn) {
    if (window.App && App.Icons && App.Icons.marketProfile) btn.innerHTML = App.Icons.marketProfile();
    btn.addEventListener("click", function () { setOn(!on); });
  }

  window.App = window.App || {};
  App.MarketProfile = { create: create, isOn: function () { return on; }, setOn: setOn, rows: rows, paintBars: paintBars,
    range: range, resetRange: resetRange, hideAll: function () { insts.forEach(function (o) { o.hide(); }); }, minTf: MAX_TF_HIDDEN };
})();
