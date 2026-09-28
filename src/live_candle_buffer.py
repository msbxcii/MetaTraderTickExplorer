# -*- coding: utf-8 -*-

"""Small in-memory bridge between MT5 ticks and the persistent candle cache.

v61 deliberately has no permanent tick storage. Incoming ticks are collapsed
immediately into 1-second OHLC state. Only the not-yet-flushed candle(s) stay
in RAM; completed seconds are written to candles_1s and raw ticks disappear.
"""

from collections import OrderedDict

import candle_cache


class LiveCandleBuffer:
    def __init__(self, conn, logger=None, max_pending_candles=50_000):
        self._conn = conn
        self._logger = logger
        self._pending = OrderedDict()
        self._max_pending_candles = max(1, int(max_pending_candles))
        self._seed_bucket = candle_cache.get_last_cached_bucket_start_ms(conn)
        self._seed_close = (
            candle_cache.get_last_close_before(conn, self._seed_bucket)
            if self._seed_bucket is not None
            else None
        )
        self._seed_rebuild_pending = self._seed_bucket is not None
        self._last_msc = None
        # V76: 1s buckets touched since the last drain_dirty() call.
        self._dirty = OrderedDict()

    @property
    def last_msc(self):
        return self._last_msc

    @property
    def has_pending(self):
        return bool(self._pending)

    def add(self, time_msc_values, bid_values):
        """Consume an MT5 batch without retaining raw ticks."""
        added = 0
        for raw_msc, raw_bid in zip(time_msc_values, bid_values):
            time_msc = int(raw_msc)
            if self._last_msc is not None and time_msc <= self._last_msc:
                continue

            bid = float(raw_bid)
            bucket = (time_msc // 1000) * 1000
            state = self._pending.get(bucket)

            if state is None:
                # A catch-up batch can span tens of thousands of seconds when
                # the market is sparse. Persist completed pending buckets before
                # adding the next bucket, keeping app-owned candle RAM bounded
                # without doing per-tick SQLite writes.
                if len(self._pending) >= self._max_pending_candles:
                    self._persist_pending(clear_all=True)

                # On the first batch after a restart, the newest cached 1s
                # candle is deliberately rebuilt from MT5's complete bucket
                # rather than incrementally added to. This avoids double-
                # counting its old ticks while still giving us a precise
                # restart seam.
                if self._seed_rebuild_pending and bucket == self._seed_bucket:
                    prev_close = self._seed_close
                    self._seed_rebuild_pending = False
                else:
                    prev_close = self._previous_close(bucket)

                if prev_close is None:
                    open_price = bid
                    high = bid
                    low = bid
                else:
                    open_price = prev_close
                    high = max(prev_close, bid)
                    low = min(prev_close, bid)

                state = [open_price, high, low, bid, 1]
                self._pending[bucket] = state
            else:
                if bid > state[1]:
                    state[1] = bid
                if bid < state[2]:
                    state[2] = bid
                state[3] = bid
                state[4] += 1

            self._dirty[bucket] = state
            self._last_msc = time_msc
            added += 1

        return added

    def drain_dirty(self):
        """V76: return [(bucket, o, h, l, c, n)] touched since the last call."""
        if not self._dirty:
            return []
        out = [(b, st[0], st[1], st[2], st[3], st[4]) for b, st in self._dirty.items()]
        self._dirty.clear()
        return out

    def _previous_close(self, bucket):
        # Most transitions are satisfied from the already-retained newest
        # pending candle. Otherwise use the persistent cache's predecessor.
        for pending_bucket in reversed(self._pending):
            if pending_bucket < bucket:
                return self._pending[pending_bucket][3]
        return candle_cache.get_last_close_before(self._conn, bucket)

    def snapshot_candles(self, time_from_ms=None):
        candles = []
        for bucket, state in self._pending.items():
            if time_from_ms is not None and bucket < int(time_from_ms):
                continue
            candles.append(
                candle_cache.Candle(bucket, state[0], state[1], state[2], state[3], state[4])
            )
        return candles

    def _persist_pending(self, clear_all=False):
        if not self._pending:
            return 0

        candles = self.snapshot_candles()
        candle_cache.refresh_from_candles(self._conn, candles, logger=self._logger)
        count = len(candles)

        if clear_all:
            self._pending.clear()
            return count

        newest_bucket = candles[-1].bucket_start_ms
        newest_state = self._pending[newest_bucket]
        self._pending.clear()
        self._pending[newest_bucket] = newest_state
        return count

    def flush(self):
        """Persist pending candle state and retain only the newest live bucket."""
        return self._persist_pending(clear_all=False)


class LiveTimeframeState:
    """V76: per-timeframe current candles kept in RAM.

    Seeded once from cache + pending 1s state; afterwards only the 1s
    candles touched by new ticks are folded in (O(1) per timeframe), instead
    of re-merging the whole current largest-timeframe bucket on every tick.
    Result is identical to merge_candles() over the 1s stream.
    """

    def __init__(self, timeframes, keep=3):
        self._tfs = sorted(set(int(t) for t in timeframes))
        self._keep = max(2, int(keep))
        self._buffer = None
        self.reset()

    def reset(self):
        self._candles = None  # tf -> list of [bucket, o, h, l, c, n]
        self._last_1s = None  # (bucket, tick_count) already included

    @property
    def ready(self):
        return self._candles is not None

    def seed(self, candle_set, live_buffer, tail_from_ms=None):
        self._buffer = live_buffer
        live_buffer.drain_dirty()  # everything so far is inside candle_set
        cands = {}
        for tf in self._tfs:
            src = candle_set.get(tf) or []
            if tail_from_ms is not None:
                # drop candles cut by the window's left edge (incomplete)
                src = [c for c in src if c[0] >= tail_from_ms]
            cands[tf] = [list(c) for c in src[-self._keep:]]
        one = candle_set.get(1)
        if one is None:
            one = []
            pend = live_buffer.snapshot_candles()
            if pend:
                one = pend
        self._last_1s = (one[-1][0], one[-1][5]) if one else None
        self._candles = cands

    def apply(self, live_buffer):
        """Fold newly touched 1s candles in. Returns False if a reseed is needed."""
        if self._candles is None or live_buffer is not self._buffer:
            return False
        for b, o, h, l, c, n in live_buffer.drain_dirty():
            last = self._last_1s
            if last is not None and b < last[0]:
                continue  # already included (older second)
            if last is not None and b == last[0]:
                delta = n - last[1]
                for tf in self._tfs:
                    cur = self._candles[tf]
                    if not cur:
                        return False
                    k = cur[-1]
                    if h > k[2]:
                        k[2] = h
                    if l < k[3]:
                        k[3] = l
                    k[4] = c
                    k[5] += delta
            else:
                for tf in self._tfs:
                    cur = self._candles[tf]
                    tb = (b // (tf * 1000)) * (tf * 1000)
                    if cur and cur[-1][0] == tb:
                        k = cur[-1]
                        if h > k[2]:
                            k[2] = h
                        if l < k[3]:
                            k[3] = l
                        k[4] = c
                        k[5] += n
                    elif not cur or cur[-1][0] < tb:
                        cur.append([tb, o, h, l, c, n])
                        if len(cur) > self._keep:
                            del cur[0]
                    else:
                        return False  # time went backwards: reseed
            self._last_1s = (b, n)
        return True

    def candle_set(self):
        return {
            tf: [candle_cache.Candle(*k) for k in cur]
            for tf, cur in self._candles.items()
        }
