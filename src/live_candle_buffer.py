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

            self._last_msc = time_msc
            added += 1

        return added

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
