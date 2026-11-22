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
    container.appendChild(line);
    container.appendChild(label);

    var pending = null, raf = 0;
    var remote = null;  // v127: {t, price} pushed by the hovered chart
    function hide() { line.style.display = "none"; label.style.display = "none"; }

    // v127: draw the vertical line + time label at x (shared by local/remote).
    function showV(x, t) {
      var ts = chart.timeScale(), paneW = ts.width(), axisH = ts.height();
      var paneH = container.clientHeight - axisH;
      var o = chart.options(), v = (o.crosshair && o.crosshair.vertLine) || {};
      var w = Math.max(1, Number(v.width) || 1);
      line.style.borderLeft = w + "px " + (DASH[v.style] || "dotted") + " " + (v.color || "#6b7686");
      line.style.left = (Math.round(x) - Math.floor(w / 2)) + "px";
      line.style.height = paneH + "px";
      line.style.display = "block";
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

    function paintRemote(force) {
      if (!remote || pending || !container.offsetWidth) return;
      var d = getData && getData(), arr = d && d.candles;
      var ts = chart.timeScale(), paneW = ts.width();
      var x = xAtTime(remote.t);
      if (x === null || x === undefined || x < 0 || x > paneW) hide(); else showV(x, remote.t);
      if (!arr || !arr.length || !d.series || remote.price === null) { clearHorz(); return; }
      var ref = ts.coordinateToLogical(x === null || x === undefined ? 0 : x);
      var bi = Math.max(0, Math.min(arr.length - 1, Math.round(ref === null ? arr.length - 1 : ref)));
      try { chart.setCrosshairPosition(remote.price, arr[bi].time, d.series); } catch (_) {}
    }
    var inst = {
      container: container,
      set: function (t, price) {
        if (pending) return;
        if (remote && remote.t === t && remote.price === price) return;
        remote = { t: t, price: price };
        paintRemote();
      },
      clear: function () {
        if (!remote) return;
        remote = null;
        if (!pending) { hide(); clearHorz(); }
      },
    };
    ALL.push(inst);
    function broadcast(t, price) {
      for (var k = 0; k < ALL.length; k++) {
        if (!ALL[k].container.isConnected) { ALL.splice(k--, 1); continue; }  // destroyed panel
        if (ALL[k] !== inst) { if (t === null) ALL[k].clear(); else ALL[k].set(t, price); }
      }
    }

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
      var t = mg ? mg.time : timeAt(x);
      showV(x, t);
      if (t === null) { broadcast(null); return; }
      var price = null;  // v127: sync other charts at this time/price
      if (mg) price = mg.price;
      else if (y <= paneH) {
        var sd = getData();
        if (sd && sd.series) price = sd.series.coordinateToPrice(y);
      }
      broadcast(t, price === undefined ? null : price);
    }

    container.addEventListener("pointermove", function (e) {
      var r = container.getBoundingClientRect();
      pending = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!raf) raf = requestAnimationFrame(paint);
    });
    container.addEventListener("pointerleave", function () { pending = null; hide(); broadcast(null); });
    // the view can move under a still mouse (zoom/live scroll): repaint label
    chart.timeScale().subscribeVisibleLogicalRangeChange(function () {
      if (pending && !raf) raf = requestAnimationFrame(paint);
      else if (remote && !pending) paintRemote(true);  // v127
    });
  }

  window.App = window.App || {};
  App.FreeCrosshair = { attach: attach };
})();
