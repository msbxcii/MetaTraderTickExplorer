// =============================================================================
// sliding-window.js — pure Sliding Window state transitions
// =============================================================================
(function () {
  "use strict";

  var App = window.App;

  // Sliding Window state changes are intentionally not logged in release
  // builds; keeping this no-op preserves the existing call sites without
  // flooding the CMD/log file with routine merge/apply events.
  function diag() {}

  function createWindow() {
    return {
      older: null,
      newer: null,
      rightIsLive: false,
      rightIsReplay: false,
      exhaustedOlder: false,
      oldestRenderBuffer: null,
    };
  }

  function cloneWindow(w) {
    return {
      older: w && w.older ? w.older : null,
      newer: w && w.newer ? w.newer : null,
      rightIsLive: !!(w && w.rightIsLive),
      rightIsReplay: !!(w && w.rightIsReplay),
      exhaustedOlder: !!(w && w.exhaustedOlder),
      oldestRenderBuffer: w && w.oldestRenderBuffer ? w.oldestRenderBuffer : null,
    };
  }

  // v41 perf: build the combined array with slice()+push.apply instead of
  // concat(). Same output (a fresh array, older followed by newer), but
  // avoids concat()'s extra intermediate-array allocation when both sides
  // are non-empty. Benchmarked as the cheaper of the two on this hot path
  // (combine() runs on every render).
  // v57 Update 8 (perf): the combined LENGTH without building the combined
  // ARRAY. combine() allocates and copies up to 2 * LAZY_LOAD_CHUNK entries;
  // several call sites below only ever wanted the count, and one of them
  // (mergeLiveTail) runs on every live tick.
  function combinedLength(w) {
    if (!w) return 0;
    return (w.older ? w.older.length : 0) + (w.newer ? w.newer.length : 0);
  }

  // v57 Update 8: true when two candles are identical in every field the
  // chart actually renders. The live tail is pushed on a timer, not on price
  // change, so in a quiet market the backend re-sends a byte-identical
  // current candle several times a second. Treating that as a change forced
  // a full window clone, a series update and an overlay repaint each time,
  // for a picture that could not possibly differ.
  function sameCandle(a, b) {
    return a.time === b.time && a.open === b.open && a.high === b.high &&
      a.low === b.low && a.close === b.close;
  }

  function combine(w) {
    if (!w) return [];
    var out = w.older && w.older.length ? w.older.slice() : [];
    if (w.newer && w.newer.length) Array.prototype.push.apply(out, w.newer);
    return out;
  }


  function combineRender(w) {
    var out = combine(w);
    if (w && w.oldestRenderBuffer && w.oldestRenderBuffer.length) {
      out = out.concat(w.oldestRenderBuffer);
    }
    return out;
  }

  function initialLive(candles) {
    var w = createWindow();
    w.newer = candles || [];
    w.rightIsLive = true;
    return w;
  }

  function initialOldest(candles) {
    var w = createWindow();
    w.older = candles || [];
    w.rightIsLive = false;
    w.exhaustedOlder = true;
    return w;
  }


  function fromJump(before, after, bounds) {
    before = before || [];
    after = after || [];
    var lastTime = bounds && bounds.lastTime !== undefined ? Number(bounds.lastTime) : NaN;
    var firstTime = bounds && bounds.firstTime !== undefined ? Number(bounds.firstTime) : NaN;
    var w = createWindow();

    if (!before.length) return w;
    w.older = before;
    w.newer = after;
    w.rightIsLive = after.length === 0 ||
      (Number.isFinite(lastTime) && after[after.length - 1].time >= lastTime);
    w.exhaustedOlder = Number.isFinite(firstTime) && before[0].time <= firstTime;

    if (!after.length) {
      w.older = before.length > 1 ? before.slice(0, -1) : [];
      w.newer = [before[before.length - 1]];
      w.rightIsLive = true;
    }
    return w;
  }
  // Returns the complete deterministic result of inserting one history page.
  // No chart calls, DOM access, or drag-anchor access live here.
  function applyHistoryPage(current, direction, candles, meta) {
    var w = cloneWindow(current || createWindow());
    var oldOlder = w.older;
    var oldNewer = w.newer;
    var shift = 0;
    var pageIsLatest = !!(meta && meta.pageIsLatest);
    var pageIsOldest = !!(meta && meta.pageIsOldest);
    var firstLiveToTwoSlotPatch = direction === "older" && !oldOlder && !!oldNewer;
    var firstOldestToTwoSlotPatch = direction === "newer" && !!oldOlder && !oldNewer;

    if (direction === "older") {
      if (oldOlder && oldNewer) {
        w.older = candles;
        w.newer = oldOlder;
        w.rightIsLive = false;
        w.rightIsReplay = false;

        // When the final historical page is partial, keep the physical chart
        // series at the previous length by retaining the missing tail portion
        // of the adjacent newer partition as a temporary render buffer.
        if (pageIsOldest && candles.length < oldOlder.length) {
          var missing = oldOlder.length - candles.length;
          w.oldestRenderBuffer = oldNewer.slice(0, missing);
        } else {
          w.oldestRenderBuffer = null;
        }
      } else if (oldOlder) {
        w.older = candles;
        w.newer = oldOlder;
        w.rightIsLive = false;
        w.rightIsReplay = false;
        w.oldestRenderBuffer = null;
      } else {
        w.older = candles;
        w.newer = oldNewer;
        // With only the newer/live slot resident, the existing newer slot
        // remains live/replay-live. The new page simply becomes its historical neighbor.
        w.rightIsReplay = !!w.rightIsReplay;
        w.oldestRenderBuffer = null;
      }
      w.exhaustedOlder = pageIsOldest;
      shift = candles.length;
    } else {
      // If an oldest-partial render buffer is present, a newer page completes
      // it. Normalize back to two regular resident partitions without ever
      // shrinking the rendered series during the active drag.
      if (oldOlder && oldNewer && w.oldestRenderBuffer && w.exhaustedOlder) {
        var buffered = w.oldestRenderBuffer.slice();
        var completionCount = oldOlder.length;
        var completion = (candles || []).slice(0, completionCount);
        w.older = oldNewer;
        w.newer = buffered.concat(completion);
        w.rightIsLive = pageIsLatest && !(meta && meta.pageIsReplayLatest);
        w.rightIsReplay = !!(meta && meta.pageIsReplayLatest);
        w.exhaustedOlder = false;
        w.oldestRenderBuffer = null;
        shift = -completion.length;
      } else if (oldOlder && oldNewer) {
        // Latest-page responses are often partial. Shift only by the number
        // of newly available bars so the two resident slots stay bounded and
        // the visible logical position remains stable.
        if (pageIsLatest && candles.length < oldOlder.length) {
          var advanceCount = candles.length;
          w.older = oldOlder.slice(advanceCount).concat(oldNewer.slice(0, advanceCount));
          w.newer = oldNewer.slice(advanceCount).concat(candles);
          w.rightIsLive = !((meta && meta.pageIsReplayLatest));
          w.rightIsReplay = !!(meta && meta.pageIsReplayLatest);
          w.exhaustedOlder = false;
          shift = -advanceCount;
        } else {
          var evictedCount = oldOlder.length;
          w.older = oldNewer;
          w.newer = candles;
          w.rightIsLive = pageIsLatest && !(meta && meta.pageIsReplayLatest);
          w.rightIsReplay = !!(meta && meta.pageIsReplayLatest);
          w.exhaustedOlder = false;
          w.oldestRenderBuffer = null;
          shift = -evictedCount;
        }
      } else if (oldOlder) {
        w.older = oldOlder;
        w.newer = candles;
        w.rightIsLive = pageIsLatest && !(meta && meta.pageIsReplayLatest);
        w.rightIsReplay = !!(meta && meta.pageIsReplayLatest);
        w.oldestRenderBuffer = null;
      } else {
        w.older = oldNewer;
        w.newer = candles;
        w.rightIsLive = pageIsLatest && !(meta && meta.pageIsReplayLatest);
        w.rightIsReplay = !!(meta && meta.pageIsReplayLatest);
        w.oldestRenderBuffer = null;
      }
    }

    diag("applyHistoryPage", {
      direction: direction, pageIsLatest: pageIsLatest, pageIsOldest: pageIsOldest,
      oldOlderLen: oldOlder ? oldOlder.length : 0, oldNewerLen: oldNewer ? oldNewer.length : 0,
      newOlderLen: w.older ? w.older.length : 0, newNewerLen: w.newer ? w.newer.length : 0,
      oldestRenderBufferLen: w.oldestRenderBuffer ? w.oldestRenderBuffer.length : 0, shift: shift
    });

    return {
      window: w,
      shift: shift,
      firstLiveToTwoSlotPatch: firstLiveToTwoSlotPatch,
      firstOldestToTwoSlotPatch: firstOldestToTwoSlotPatch,
      activeLength: combinedLength(w),
      addedCount: candles.length,
      oldestRenderBuffer: w.oldestRenderBuffer,
    };
  }

  // Merge the authoritative live tail into the explicit newer/live slot.
  // Returns only data/state changes; rendering stays outside this module.
  function mergeLiveTail(current, tailCandles, chunkSize) {
    if (!current || !current.rightIsLive || !current.newer || !current.newer.length) {
      return { changed: false, window: current, rolled: [], overflowCount: 0 };
    }

    // v57 Update 8: cheap pre-check first - only clone/copy once we know
    // this tail genuinely moves the window. `tailCandles` is ascending and
    // short (2 entries in the steady state), so this is a couple of
    // comparisons against the current last candle.
    if (!tailChangesWindow(current.newer, tailCandles)) {
      return { changed: false, window: current, rolled: [], overflowCount: 0 };
    }

    var w = cloneWindow(current);
    var livePart = w.newer.slice();

    (tailCandles || []).forEach(function (c) {
      var lastIdx = livePart.length - 1;
      if (lastIdx >= 0 && livePart[lastIdx].time === c.time) {
        livePart[lastIdx] = c;
      } else if (lastIdx < 0 || c.time > livePart[lastIdx].time) {
        livePart.push(c);
      }
    });

    var capacity = chunkSize || App.LAZY_LOAD_CHUNK;
    var overflowCount = Math.max(0, livePart.length - capacity);
    var rolled = overflowCount ? livePart.splice(0, overflowCount) : [];

    w.newer = livePart;
    if (rolled.length && w.older) {
      var older = w.older.slice();
      Array.prototype.push.apply(older, rolled);
      var oldOverflow = Math.max(0, older.length - capacity);
      if (oldOverflow) older.splice(0, oldOverflow);
      w.older = older;
    }

    diag("mergeLiveTail", {changed:true, beforeLen: current.newer ? current.newer.length : 0, afterLen: w.newer ? w.newer.length : 0, rolled: rolled.length, overflowCount: overflowCount, hasOlder:!!w.older});

    return {
      changed: true,
      window: w,
      rolled: rolled,
      overflowCount: overflowCount,
      activeLength: combinedLength(w),
    };
  }

  // Would applying `tailCandles` to the resident live/replay partition
  // `livePart` actually change it? Mirrors the merge loop's own rules
  // exactly (replace the last candle when the time matches, append when
  // strictly newer, ignore anything older) with one addition: replacing a
  // candle with an identical copy is not a change.
  function tailChangesWindow(livePart, tailCandles) {
    if (!tailCandles || !tailCandles.length) return false;
    var last = livePart.length ? livePart[livePart.length - 1] : null;
    for (var i = 0; i < tailCandles.length; i++) {
      var c = tailCandles[i];
      if (!last) return true;
      if (c.time > last.time) return true;
      if (c.time === last.time) {
        if (!sameCandle(c, last)) return true;
        last = c;
      }
    }
    return false;
  }

  // Replay counterpart of mergeLiveTail. It is intentionally the same
  // bounded two-slot transition, but gated by rightIsReplay rather than
  // rightIsLive so Replay never contaminates ordinary Live semantics.
  function mergeReplayTail(current, tailCandles, chunkSize) {
    if (!current || !current.rightIsReplay || !current.newer || !current.newer.length) {
      return { changed: false, window: current, rolled: [], overflowCount: 0 };
    }

    if (!tailChangesWindow(current.newer, tailCandles)) {
      return { changed: false, window: current, rolled: [], overflowCount: 0 };
    }

    var w = cloneWindow(current);
    var livePart = w.newer.slice();

    (tailCandles || []).forEach(function (c) {
      var lastIdx = livePart.length - 1;
      if (lastIdx >= 0 && livePart[lastIdx].time === c.time) {
        livePart[lastIdx] = c;
      } else if (lastIdx < 0 || c.time > livePart[lastIdx].time) {
        livePart.push(c);
      }
    });

    var capacity = chunkSize || App.LAZY_LOAD_CHUNK;
    var overflowCount = Math.max(0, livePart.length - capacity);
    var rolled = overflowCount ? livePart.splice(0, overflowCount) : [];

    w.newer = livePart;
    w.rightIsReplay = true;
    w.rightIsLive = false;
    if (rolled.length && w.older) {
      var older = w.older.slice();
      Array.prototype.push.apply(older, rolled);
      var oldOverflow = Math.max(0, older.length - capacity);
      if (oldOverflow) older.splice(0, oldOverflow);
      w.older = older;
    }

    return {
      changed: true,
      window: w,
      rolled: rolled,
      overflowCount: overflowCount,
      activeLength: combinedLength(w),
    };
  }

  App.SlidingWindow = {
    create: createWindow,
    clone: cloneWindow,
    combine: combine,
    combineRender: combineRender,
    initialLive: initialLive,
    initialOldest: initialOldest,
    fromJump: fromJump,
    applyHistoryPage: applyHistoryPage,
    mergeLiveTail: mergeLiveTail,
    mergeReplayTail: mergeReplayTail,
  };
})();
