# -*- coding: utf-8 -*-


class Candle(tuple):
    """Drop-in replacement for the original namedtuple("Candle", [...]).

    Benchmarked (see V41-Optimization_Ideas_2.md, Candidate 4): a plain
    namedtuple costs ~2.5x a bare tuple to construct at the row counts this
    app builds candles at (100K-500K+ rows during backfill/refresh), because
    every namedtuple instantiation goes through its generated __new__ plus
    per-field descriptors. A __slots__-based tuple subclass with plain
    properties keeps the exact same attribute API (c.open, c.high, ...),
    the exact same positional/indexing/equality/iteration behavior as a
    tuple, and the exact same construction call Candle(a, b, c, d, e, f) or
    Candle(*row) used everywhere in this codebase - only the internal cost
    of building one changes (~1.65x faster than namedtuple per benchmark).
    No call site elsewhere needs to change.
    """

    __slots__ = ()

    def __new__(cls, bucket_start_ms, open, high, low, close, tick_count):
        return tuple.__new__(cls, (bucket_start_ms, open, high, low, close, tick_count))

    bucket_start_ms = property(lambda self: self[0])
    open = property(lambda self: self[1])
    high = property(lambda self: self[2])
    low = property(lambda self: self[3])
    close = property(lambda self: self[4])
    tick_count = property(lambda self: self[5])

    def __repr__(self):
        return (
            "Candle(bucket_start_ms=%r, open=%r, high=%r, low=%r, close=%r, tick_count=%r)"
            % (self[0], self[1], self[2], self[3], self[4], self[5])
        )


def iter_candles(ticks, bucket_ms, prev_close=None):
    """Yield candles directly from an in-memory raw-tick iterable.

    Backfill/Extend use this streaming form so a large MT5 response never
    creates a second, full-size Python list of converted candles.
    """
    current_bucket = None
    o = h = l = c = None
    count = 0

    for time_msc, bid in ticks:
        time_msc = int(time_msc)
        bid = float(bid)
        bucket_start = (time_msc // bucket_ms) * bucket_ms

        if bucket_start != current_bucket:
            if current_bucket is not None:
                candle = _finalize_candle(current_bucket, o, h, l, c, count, prev_close)
                yield candle
                prev_close = candle.close
            current_bucket = bucket_start
            o = h = l = c = bid
            count = 1
        else:
            if bid > h:
                h = bid
            if bid < l:
                l = bid
            c = bid
            count += 1

    if current_bucket is not None:
        yield _finalize_candle(current_bucket, o, h, l, c, count, prev_close)


def ticks_to_candles(ticks, bucket_ms, prev_close=None):
    """Build candles from raw ticks and return them as a list.

    Kept as the convenient API for small in-memory workloads. Use
    ``iter_candles()`` for large fetched ranges that are going to disk.
    """
    return list(iter_candles(ticks, bucket_ms=bucket_ms, prev_close=prev_close))

def _finalize_candle(bucket_start, o, h, l, c, count, prev_close):
    """Build the Candle for one finished bucket, with Open forced to
    ``prev_close`` (open-continuity) except for the very first candle of
    all of history, where there is no previous candle to chain to."""
    if prev_close is None:
        return Candle(bucket_start, o, h, l, c, count)
    # Force Open to the previous candle's Close, then widen High/Low only
    # if that forced Open would otherwise fall outside the real tick range
    # - High/Low must always stay true to the ticks that actually traded.
    if h < prev_close:
        h = prev_close
    if l > prev_close:
        l = prev_close
    return Candle(bucket_start, prev_close, h, l, c, count)


def merge_candles(candles, base_bucket_ms, factor):

    if factor <= 1:
        return list(candles)

    out_size = base_bucket_ms * factor
    merged = []
    current_out_bucket = None
    o = h = l = c = None
    tick_count = 0

    for cand in candles:
        out_bucket = (cand.bucket_start_ms // out_size) * out_size

        if out_bucket != current_out_bucket:
            if current_out_bucket is not None:
                merged.append(Candle(current_out_bucket, o, h, l, c, tick_count))
            current_out_bucket = out_bucket
            o, h, l, c = cand.open, cand.high, cand.low, cand.close
            tick_count = cand.tick_count
        else:
            if cand.high > h:
                h = cand.high
            if cand.low < l:
                l = cand.low
            c = cand.close
            tick_count += cand.tick_count

    if current_out_bucket is not None:
        merged.append(Candle(current_out_bucket, o, h, l, c, tick_count))

    return merged



# V61 deliberately keeps the aggregator independent of SQLite. The only
# raw-tick entry point is ticks_to_candles(), which consumes an in-memory
# iterable supplied directly by the MT5 sync/backfill path.

def _self_test():

    ticks = []

    # second 0: 10 ticks, price drifts up then down -> tests high/low/open/close
    base = 0
    prices = [100.0, 100.5, 101.0, 100.8, 101.2, 100.9, 100.7, 100.6, 100.4, 100.5]
    for i, p in enumerate(prices):
        ticks.append((base + i * 90, p))  # 10 ticks spread across the second

    # second 1: completely empty -> must produce NO candle, but the NEXT
    # candle's Open must still equal this candle's Close (continuity).

    # second 2: 3 ticks
    base = 2000
    for i, p in enumerate([99.0, 99.8, 99.3]):
        ticks.append((base + i * 300, p))

    # second 3: 5 ticks
    base = 3000
    for i, p in enumerate([99.3, 99.1, 99.6, 99.5, 99.4]):
        ticks.append((base + i * 180, p))

    base_candles = ticks_to_candles(ticks, bucket_ms=1000)

    assert len(base_candles) == 3, f"expected 3 candles (gap at second 1), got {len(base_candles)}"
    assert [c.bucket_start_ms for c in base_candles] == [0, 2000, 3000], "gap at second 1 was not preserved"

    c0 = base_candles[0]
    # No previous candle exists yet -> falls back to its own first tick.
    assert c0.open == 100.0 and c0.close == 100.5 and c0.high == 101.2 and c0.low == 100.0 and c0.tick_count == 10

    c2 = base_candles[1]
    # Open-continuity: Open == previous candle's Close (100.5), even
    # though a full second (second 1) had zero ticks in between. High/Low
    # widen to include that forced Open since the real ticks (99.0-99.8)
    # don't reach up to 100.5.
    assert c2.open == c0.close == 100.5
    assert c2.close == 99.3 and c2.high == 100.5 and c2.low == 99.0 and c2.tick_count == 3

    c3 = base_candles[2]
    # Open-continuity again: Open == previous candle's Close (99.3), which
    # here happens to already match the raw first tick, so High/Low need
    # no widening.
    assert c3.open == c2.close == 99.3
    assert c3.close == 99.4 and c3.high == 99.6 and c3.low == 99.1 and c3.tick_count == 5

    # Merging into a 5-second timeframe: seconds 0,2,3 all fall in the
    # same 5s bucket [0,5000) -> must merge into exactly ONE 5s candle.
    five_sec = merge_candles(base_candles, base_bucket_ms=1000, factor=5)
    assert len(five_sec) == 1
    merged = five_sec[0]
    assert merged.bucket_start_ms == 0
    assert merged.open == 100.0          # open of the very first underlying candle
    assert merged.close == 99.4          # close of the very last underlying candle
    assert merged.high == 101.2          # max high across all underlying candles
    assert merged.low == 99.0            # min low across all underlying candles
    assert merged.tick_count == 10 + 3 + 5

    print("All candle_aggregator self-tests passed.")
    print(f"1s candles : {base_candles}")
    print(f"5s merged  : {five_sec}")


if __name__ == "__main__":
    _self_test()
