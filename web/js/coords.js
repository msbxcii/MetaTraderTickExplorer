// =============================================================================
// coords.js — logical/time/pixel coordinate conversion helpers.
// =============================================================================
// v38: generalized into a factory so every chart panel (primary + companion
// multi-chart panels — see multi-panel.js) gets its OWN coordinate context,
// bound to that panel's own chart/series/timeframe/candle-array. Before v38
// this module only ever read the primary chart's globals (App.chart/
// App.series/App.currentTf/App.candlesByTf); drawing-engine.js now asks for
// a context per panel via App.Coords.createSurfaceCoords(...) instead of
// reaching for those globals directly, which is what lets objects be drawn,
// hit-tested and dragged correctly on ANY panel, not just the primary one.
// App.Coords itself is kept as the primary panel's own context (same shape
// as before) so nothing else that already reads it has to change.

(function () {
  "use strict";

  var App = window.App;

  // opts: { getChart(), getSeries(), getTf(): number|null, getCandles(): array }
  // getChart/getSeries are functions (not plain values) deliberately: this
  // file loads and builds the PRIMARY App.Coords context before chart-
  // core.js has created App.chart/App.series (see index.html's script
  // order), so a snapshotted value would freeze on `null` forever — every
  // lookup below re-reads through the getter instead.
  function createSurfaceCoords(opts) {
    var getChart = opts.getChart;
    var getSeries = opts.getSeries;
    var getTf = opts.getTf;
    var getCandles = opts.getCandles;

    // v15 Fix (see original note): lightweight-charts' logicalToCoordinate
    // only computes correctly for a WHOLE-NUMBER logical index; a fractional
    // one silently snaps to 0. Interpolate between the two whole-number
    // neighbors ourselves whenever the requested logical isn't an integer.
    function logicalToX(logical) {
      var ts = getChart().timeScale();
      var lo = Math.floor(logical);
      if (logical === lo) {
        var xw = ts.logicalToCoordinate(lo);
        return xw === null || xw === undefined ? null : xw;
      }
      var hi = lo + 1;
      var xLo = ts.logicalToCoordinate(lo);
      var xHi = ts.logicalToCoordinate(hi);
      if (xLo === null || xLo === undefined || xHi === null || xHi === undefined) return null;
      var frac = logical - lo;
      return xLo + (xHi - xLo) * frac;
    }
    function xToLogical(x) {
      var l = getChart().timeScale().coordinateToLogical(x);
      return l === null || l === undefined ? null : l;
    }
    function priceToY(price) {
      var y = getSeries().priceToCoordinate(price);
      return y === null || y === undefined ? null : y;
    }
    function yToPrice(y) {
      return getSeries().coordinateToPrice(y);
    }

    // Real Unix-seconds time <-> this panel's own current-timeframe logical
    // index, extrapolating past either edge — see the v14 note preserved in
    // drawing-engine.js for why objects are stored as real time rather than
    // a bar-count logical index (it's what makes the SAME object line up
    // correctly on every panel/timeframe at once, which is what makes
    // objects global across the whole multi-chart layout, not just the
    // single active chart).
    function timeToLogical(time) {
      var tf = getTf();
      var arr = tf ? getCandles() : null;
      if (!arr || !arr.length || !tf) return null;
      var n = arr.length;
      if (n === 1 || time <= arr[0].time) {
        return (time - arr[0].time) / tf;
      }
      if (time >= arr[n - 1].time) {
        return (n - 1) + (time - arr[n - 1].time) / tf;
      }
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (arr[mid].time <= time) lo = mid; else hi = mid;
      }
      var span = arr[hi].time - arr[lo].time;
      var frac = span > 0 ? (time - arr[lo].time) / span : 0;
      return lo + frac;
    }

    function logicalToTime(logical) {
      var tf = getTf();
      var arr = tf ? getCandles() : null;
      if (!arr || !arr.length || !tf) return null;
      var n = arr.length;
      if (n === 1 || logical <= 0) {
        return arr[0].time + logical * tf;
      }
      if (logical >= n - 1) {
        return arr[n - 1].time + (logical - (n - 1)) * tf;
      }
      var i0 = Math.floor(logical), i1 = i0 + 1;
      var frac = logical - i0;
      return arr[i0].time + frac * (arr[i1].time - arr[i0].time);
    }

    return {
      logicalToX: logicalToX,
      xToLogical: xToLogical,
      priceToY: priceToY,
      yToPrice: yToPrice,
      timeToLogical: timeToLogical,
      logicalToTime: logicalToTime,
    };
  }

  App.Coords = createSurfaceCoords({
    getChart: function () { return App.chart; },
    getSeries: function () { return App.series; },
    getTf: function () { return App.currentTf; },
    getCandles: function () { return App.currentTf !== null ? App.candlesByTf[App.currentTf] : null; },
  });
  App.Coords.createSurfaceCoords = createSurfaceCoords;
})();
