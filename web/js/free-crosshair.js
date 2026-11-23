// v130: multichart - if the hovered panel's tf is HIGHER than a panel's own, that panel shows
// only the horizontal price line + 2 vertical lines (open/close of the reference candle nearest
// to the mouse: before the mid-point of two candles the left one, after it the right one; same
// style + GAP as the main crosshair). Lines are repainted when data changes (live shift fix).
// v129: multichart - if the hovered panel's timeframe is lower than a panel's own,
// that panel's crosshair snaps down to the open of the candle containing the time.
// v128: vertical line has a 10px empty gap above High / below Low of the nearest
// candle (wicks stay visible); applies to synced panels too.
// V80: free (non-magnetic) vertical crosshair.
// Lightweight Charts always snaps its vertical crosshair line to a bar index
// (no option disables that). The native vertical line/label are hidden and a
// tiny DOM line + time label follow the raw mouse X instead; the time label
// is interpolated between bars. The horizontal line stays native (already
// free in CrosshairMode.Normal). Pure display: no chart data or API behavior
// (drawings, jumps, replay, sliding window) depends on it.
(function () {
  "use strict";
  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmt(sec, tf) {
    var d = new Date((Math.floor(sec) + (window.App && App.Tz && tf < 86400 ? App.Tz.offset(Math.floor(sec)) : 0)) * 1000);  // v92, v116: shift at that time
    var s = d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " '" + pad(d.getUTCFullYear() % 100);
    if (tf < 86400) {
      s += "  " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds());
    }
    return s;
  }
  // v127: every attached chart joins this list; the hovered chart broadcasts
  // its (time, price) so all other charts draw a synced crosshair.
  var ALL = [];
  var DASH = { 0: "solid", 1: "dotted", 2: "dashed", 3: "dashed", 4: "dotted" };
  // v128: vertical line breaks 10px above High / below Low of the nearest candle.
  var GAP = 10;

  // Hide only the plain default (arrow) pointer while it is over the plot
  // area, where the crosshair is drawn. Any element that sets its own cursor
  // (drawing-engine hover/handle cursors: pointer on an object body/border,
  // crosshair/resize on its points, drawing-tool "+" cursor, ...) keeps it:
  // those are inline `style.cursor` values or the .drawing class, which the
  // rule below never matches. Axes, menus and outside the chart are untouched.
  // The ruler tool keeps its own "+" cursor (html.ruler-active).
  (function () {
    var sels = [".fc-nocursor", ".fc-nocursor canvas", ".fc-nocursor table",
                ".fc-nocursor tr", ".fc-nocursor td"];
    var css = "";
    for (var i = 0; i < sels.length; i++) {
      var base = "html:not(.ruler-active) " + sels[i];
      css += base + ":not(.drawing):not([style*=\"cursor\"])," +
             base + "[style*=\"cursor: default\"]," +
             base + "[style*=\"cursor: auto\"]" +
             (i < sels.length - 1 ? "," : "");
    }
    css += " { cursor: none !important; }";
    var st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
  })();

  // getData() -> { candles: [...], tf: seconds }
  function attach(chart, container, getData) {
    if (!chart || !container || container._freeCrosshair) return;
    container._freeCrosshair = true;
    chart.applyOptions({ crosshair: { vertLine: { visible: false, labelVisible: false } } });
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    var line = document.createElement("div");
    line.style.cssText = "position:absolute;top:0;width:0;pointer-events:none;z-index:5;display:none;";
    var label = document.createElement("div");
    label.style.cssText = "position:absolute;pointer-events:none;z-index:6;display:none;white-space:nowrap;" +
      "padding:0 6px;border-radius:2px;color:#fff;transform:translateX(-50%);";
    var line2 = line.cloneNode(false);  // v128: lower segment (below Low gap)
    container.appendChild(line);
    container.appendChild(line2);
    // v130: boundary lines of the higher-tf reference candle (open / close), 2 segments each.
    var bnd = [];
    for (var bi0 = 0; bi0 < 4; bi0++) { var be = line.cloneNode(false); container.appendChild(be); bnd.push(be); }
    container.appendChild(label);

    var pending = null, raf = 0;
    var remote = null;  // v127: {t, price} pushed by the hovered chart
    function hideBnd() { for (var k = 0; k < 4; k++) bnd[k].style.display = "none"; }
    function hide() { line.style.display = "none"; line2.style.display = "none"; label.style.display = "none"; hideBnd(); }

    // v128: y-range kept empty around the candle nearest to x (null = none).
    function gapAt(x) {
      var d = getData && getData(), arr = d && d.candles, s = d && d.series;
      if (!arr || !arr.length || !s) return null;
      var ref = chart.timeScale().coordinateToLogical(x);
      if (ref === null || !isFinite(ref)) return null;
      var i = Math.round(ref);
      if (i < 0 || i >= arr.length) return null;
      var yh = s.priceToCoordinate(arr[i].high), yl = s.priceToCoordinate(arr[i].low);
      if (yh === null || yl === null || yh === undefined || yl === undefined) return null;
      return { a: yh - GAP, b: yl + GAP };
    }

    // v130: one vertical line (upper + lower segment) with the GAP around the nearest candle.
    function seg(l1, l2, x, bl, w, paneH) {
      var lx = (Math.round(x) - Math.floor(w / 2)) + "px";
      var g = gapAt(x);
      var aEnd = g ? Math.max(0, Math.min(paneH, g.a)) : paneH;
      var bSt = g ? Math.max(0, Math.min(paneH, g.b)) : paneH;
      l1.style.borderLeft = bl; l1.style.left = lx;
      l1.style.height = aEnd + "px";
      l1.style.display = aEnd > 0 ? "block" : "none";
      l2.style.borderLeft = bl; l2.style.left = lx;
      l2.style.top = bSt + "px";
      l2.style.height = (paneH - bSt) + "px";
      l2.style.display = (g && paneH - bSt > 0) ? "block" : "none";
    }

    // v130: open/close lines of the (higher-tf) reference candle.
    function showBnd(o0, o1) {
      var ts = chart.timeScale(), paneW = ts.width(), axisH = ts.height();
      var paneH = container.clientHeight - axisH;
      var o = chart.options(), v = (o.crosshair && o.crosshair.vertLine) || {};
      var w = Math.max(1, Number(v.width) || 1);
      var bl = w + "px " + (DASH[v.style] || "dotted") + " " + (v.color || "#6b7686");
      var ts2 = [o0, o1];
      for (var k = 0; k < 2; k++) {
        var x = xAtTime(ts2[k]);
        if (x === null || x === undefined || x < 0 || x > paneW) { bnd[2 * k].style.display = "none"; bnd[2 * k + 1].style.display = "none"; }
        else seg(bnd[2 * k], bnd[2 * k + 1], x, bl, w, paneH);
      }
    }

    // v127: draw the vertical line + time label at x (shared by local/remote).
    function showV(x, t) {
      var ts = chart.timeScale(), paneW = ts.width(), axisH = ts.height();
      var paneH = container.clientHeight - axisH;
      var o = chart.options(), v = (o.crosshair && o.crosshair.vertLine) || {};
      var w = Math.max(1, Number(v.width) || 1);
      var bl = w + "px " + (DASH[v.style] || "dotted") + " " + (v.color || "#6b7686");
      seg(line, line2, x, bl, w, paneH);
      if (t === null) { label.style.display = "none"; return; }
      var data = getData();
      label.textContent = fmt(t, data.tf);
      label.style.background = v.labelBackgroundColor || "#131722";
      label.style.font = (o.layout && o.layout.fontSize ? o.layout.fontSize : 12) + "px " +
        App.FONT_FAMILY;
      label.style.top = (paneH + 1) + "px";
      label.style.lineHeight = Math.max(16, axisH - 6) + "px";
      label.style.display = "block";
      var half = label.offsetWidth / 2;  // keep inside the time axis
      label.style.left = Math.max(half, Math.min(paneW - half, x)) + "px";
    }

    // v127: inverse of timeAt() - time -> x (null if no data).
    function xAtTime(t) {
      var d = getData && getData(), arr = d && d.candles, tf = d && d.tf;
      if (!arr || !arr.length || !tf) return null;
      var n = arr.length, lo = 0, hi = n - 1, i = -1;
      while (lo <= hi) {  // last bar with time <= t
        var m = (lo + hi) >> 1;
        if (arr[m].time <= t) { i = m; lo = m + 1; } else hi = m - 1;
      }
      var logical;
      if (i < 0) logical = (t - arr[0].time) / tf;
      else if (i >= n - 1) logical = (n - 1) + (t - arr[n - 1].time) / tf;
      else logical = i + (t - arr[i].time) / (arr[i + 1].time - arr[i].time);
      // v127: logicalToCoordinate() is only exact for whole indexes (a
      // fractional one gave null/snap -> line flickered); interpolate.
      var ts = chart.timeScale(), f = Math.floor(logical);
      var xa = ts.logicalToCoordinate(f);
      if (logical === f) return xa;
      var xb = ts.logicalToCoordinate(f + 1);
      if (xa === null || xa === undefined || xb === null || xb === undefined) return null;
      return xa + (xb - xa) * (logical - f);
    }

    function clearHorz() { try { chart.clearCrosshairPosition(); } catch (_) {} }

    // v129: effective time - floor to containing candle open when source tf < own tf.
    function effT(t, srcTf) {
      var d = getData && getData(), arr = d && d.candles, tf = d && d.tf;
      if (!arr || !arr.length || !tf || !(srcTf < tf)) return t;
      var lo = 0, hi = arr.length - 1, i = -1;
      while (lo <= hi) { var m = (lo + hi) >> 1; if (arr[m].time <= t) { i = m; lo = m + 1; } else hi = m - 1; }
      if (i < 0) return arr[0].time + Math.floor((t - arr[0].time) / tf) * tf;  // v129: before first bar
      if (i === arr.length - 1) return arr[i].time + Math.floor((t - arr[i].time) / tf) * tf;  // v129: past live candle
      return arr[i].time;
    }

    function paintRemote(force) {
      if (!remote || pending || !container.offsetWidth) return;
      hook();  // v130
      var d = getData && getData(), arr = d && d.candles;
      var ts = chart.timeScale(), paneW = ts.width();
      var rt = effT(remote.t, remote.src);  // v129
      var x = xAtTime(rt);
      if (remote.o !== null && remote.o !== undefined && remote.src > (d && d.tf)) {  // v130: only 2 time lines
        hide();
        // v130.1: right line = last own candle inside the reference candle (e.g. 13:49:55), not its end.
        var e = remote.o + remote.src, arr2 = d.candles, lo2 = 0, hi2 = arr2.length - 1, k2 = -1;
        while (lo2 <= hi2) { var m2 = (lo2 + hi2) >> 1; if (arr2[m2].time < e) { k2 = m2; lo2 = m2 + 1; } else hi2 = m2 - 1; }
        // v130.2: if the reference candle is still forming, its own-tf candles stop at the live one,
        // so the last existing candle is NOT the boundary: use the theoretical last slot (e - tf, e.g. 13:59:55).
        var inRef = k2 >= 0 && arr2[k2].time >= remote.o;
        var live = inRef && k2 === arr2.length - 1;
        showBnd(remote.o, (inRef && !live) ? arr2[k2].time : e - d.tf);
      } else {
        hideBnd();
        if (x === null || x === undefined || x < 0 || x > paneW) hide(); else showV(x, rt);
      }
      if (!arr || !arr.length || !d.series || remote.price === null) { clearHorz(); return; }
      var ref = ts.coordinateToLogical(x === null || x === undefined ? 0 : x);
      var bi = Math.max(0, Math.min(arr.length - 1, Math.round(ref === null ? arr.length - 1 : ref)));
      try { chart.setCrosshairPosition(remote.price, arr[bi].time, d.series); } catch (_) {}
    }
    // v130: live candle / data change shifts the chart: repaint (time-based) once per frame.
    var drf = 0;
    function onData() {
      if (drf) return;
      drf = requestAnimationFrame(function () {
        drf = 0;
        if (pending) { if (!raf) raf = requestAnimationFrame(paint); }
        else if (remote) paintRemote(true);
      });
    }
    function hook() {
      var d = getData && getData(), sr = d && d.series;
      if (!sr || sr._fcHooked) return;
      sr._fcHooked = true;
      ["update", "setData"].forEach(function (m) {
        var f = sr[m];
        if (typeof f !== "function") return;
        sr[m] = function () { var r = f.apply(this, arguments); onData(); return r; };
      });
    }
    try { hook(); } catch (_) {}
    var inst = {
      container: container,
      set: function (t, price, src, op) {
        if (pending) return;
        if (remote && remote.t === t && remote.price === price && remote.src === src && remote.o === op) return;
        remote = { t: t, price: price, src: src, o: op };
        paintRemote();
      },
      clear: function () {
        if (!remote) return;
        remote = null;
        if (!pending) { hide(); clearHorz(); }
      },
    };
    ALL.push(inst);
    // v130: open time of the candle nearest to fractional logical index (mid-point rule).
    function nearestOpen(lg, arr, tf) {
      if (lg === null || !arr || !arr.length || !tf) return null;
      var j = Math.round(lg), n = arr.length;
      return j < 0 ? arr[0].time + j * tf : j > n - 1 ? arr[n - 1].time + (j - (n - 1)) * tf : arr[j].time;
    }
    function broadcast(t, price, op) {
      var stf = 0;
      if (t !== null) { var sd0 = getData && getData(); stf = (sd0 && sd0.tf) || 0; }  // v129
      if (op === undefined) op = null;
      for (var k = 0; k < ALL.length; k++) {
        if (!ALL[k].container.isConnected) { ALL.splice(k--, 1); continue; }  // destroyed panel
        if (ALL[k] !== inst) { if (t === null) ALL[k].clear(); else ALL[k].set(t, price, stf, op); }
      }
    }

    var lastLog = null;
    function timeAt(x) {
      var data = getData && getData();
      var arr = data && data.candles, tf = data && data.tf;
      if (!arr || !arr.length || !tf) return null;
      // V80.1: coordinateToLogical() rounds to a whole bar (that caused the
      // on-the-hour-only / switch-at-midpoint label). Derive the exact
      // fractional index from two bar coordinates instead.
      var ts = chart.timeScale();
      var ref = ts.coordinateToLogical(x);
      if (ref === null || !isFinite(ref)) return null;
      var x0 = ts.logicalToCoordinate(ref), x1 = ts.logicalToCoordinate(ref + 1);
      if (x0 === null || x1 === null || !(x1 - x0)) return null;
      var logical = ref + (x - x0) / (x1 - x0);
      lastLog = logical;  // v130
      var n = arr.length, i = Math.floor(logical), frac = logical - i;
      var t;
      if (i < 0) t = arr[0].time + logical * tf;
      else if (i >= n - 1) t = arr[n - 1].time + (logical - (n - 1)) * tf;
      else {
        // interpolate inside the real gap to the next bar (handles
        // market-closed gaps without inventing times).
        t = arr[i].time + frac * (arr[i + 1].time - arr[i].time);
      }
      // snap down to whole seconds (label resolution)
      return Math.floor(t);
    }

    function indexOfTime(arr, time) {
      var lo = 0, hi = arr.length - 1;
      while (lo <= hi) {
        var m = (lo + hi) >> 1;
        if (arr[m].time === time) return m;
        if (arr[m].time < time) lo = m + 1; else hi = m - 1;
      }
      return -1;
    }
    function restoreRaw(x, y) {
      var d = getData && getData(), arr = d && d.candles;
      if (!d || !d.series || !arr || !arr.length) return;
      var ref = chart.timeScale().coordinateToLogical(x);
      if (ref === null) return;
      var i = Math.max(0, Math.min(arr.length - 1, Math.round(ref)));
      var price = d.series.coordinateToPrice(y);
      if (price === null) return;
      try { chart.setCrosshairPosition(price, arr[i].time, d.series); } catch (_) {}
    }
    container._fcRefresh = function () { if (pending && !raf) raf = requestAnimationFrame(paint); };

    function paint() {
      raf = 0;
      if (!pending) return;
      var x = pending.x, y = pending.y;
      var ts = chart.timeScale();
      var mg = container._magnet, mdata = mg ? getData() : null, mx = null;
      if (mg && mdata && mdata.candles) {
        // v109: Ctrl magnet - draw the crosshair on the snapped candle point.
        var li = indexOfTime(mdata.candles, mg.time);
        mx = li < 0 ? null : ts.logicalToCoordinate(li);
        if (mx === null || mx === undefined) mg = null;
      } else mg = null;
      if (mg && mdata.series) {
        try { chart.setCrosshairPosition(mg.price, mg.time, mdata.series); } catch (_) {}
      } else if (container._fcWasMagnet || (window.App && ((App.currentTool && App.currentTool !== "cursor") || App.interaction))) {
        // Ctrl released, or a drawing tool / handle drag has the overlay canvas
        // on top (the chart's own crosshair gets no mouse events then): drive
        // the horizontal line from the raw mouse position ourselves.
        restoreRaw(x, y);
      }
      container._fcWasMagnet = !!mg;
      var paneW = ts.width(), axisH = ts.height();
      var paneH = container.clientHeight - axisH;
      if (x < 0 || x > paneW || y < 0 || y > container.clientHeight) { hide(); broadcast(null); return; }
      if (mg) x = mx;
      lastLog = null;
      var t = mg ? mg.time : timeAt(x);
      showV(x, t);
      if (t === null) { broadcast(null); return; }
      var price = null;  // v127: sync other charts at this time/price
      if (mg) price = mg.price;
      else if (y <= paneH) {
        var sd = getData();
        if (sd && sd.series) price = sd.series.coordinateToPrice(y);
      }
      var pd = getData();  // v130
      var op = mg ? mg.time : (pd ? nearestOpen(lastLog, pd.candles, pd.tf) : null);
      broadcast(t, price === undefined ? null : price, op);
    }

    function setNoCursor(on) { container.classList.toggle("fc-nocursor", !!on); }
    container.addEventListener("pointermove", function (e) {
      var r = container.getBoundingClientRect();
      pending = { x: e.clientX - r.left, y: e.clientY - r.top };
      var ts = chart.timeScale();
      setNoCursor(pending.x >= 0 && pending.x <= ts.width() &&
                  pending.y >= 0 && pending.y <= container.clientHeight - ts.height());
      if (!raf) raf = requestAnimationFrame(paint);
    });
    container.addEventListener("pointerleave", function () { pending = null; setNoCursor(false); hide(); broadcast(null); });
    // the view can move under a still mouse (zoom/live scroll): repaint label
    chart.timeScale().subscribeVisibleLogicalRangeChange(function () {
      if (pending && !raf) raf = requestAnimationFrame(paint);
      else if (remote && !pending) paintRemote(true);  // v127
    });
  }

  window.App = window.App || {};
  App.FreeCrosshair = { attach: attach };
})();
