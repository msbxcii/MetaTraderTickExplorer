# -*- coding: utf-8 -*-


import time

import numpy as np

import candle_cache
from datetime import datetime, timezone

from config import (
    POLL_INTERVAL_SECONDS,
    TICKS_BATCH_SIZE,
    HISTORY_BACKFILL_MAX_DAYS,
    LIVE_DATA_STALE_SECONDS,
    CATCH_UP_CHUNK_SECONDS,
    TICK_HOLE_THRESHOLD_SECONDS,
    TICK_SYNC_QUIET_SECONDS,
    TICK_SYNC_SETTLE_SECONDS,
    TICK_SYNC_MAX_WAIT_SECONDS,
    TICK_SYNC_DEBUG,
    RESUME_BROKER_TIME_SETTLE_SECONDS,
)

_DAY_MS = 86_400_000
_MAX_CHUNK_MS = 7 * _DAY_MS
_MAX_HOLES_PROBED = 5

# V62.2: sequential-read rescue for a terminal tick store that is out of
# chronological order (see _rescue_from_sequential). The probe read is small;
# only when it proves that ticks really exist inside a supposedly empty hole
# is the read escalated, up to _RESCUE_MAX_TICKS, and kept as a cache.
_RESCUE_PROBE_TICKS = 100_000
_RESCUE_MAX_TICKS = 1_500_000
_RESCUE_LOOKAHEAD_MS = _DAY_MS
_COMPACT_DTYPE = np.dtype([("time_msc", "<i8"), ("bid", "<f8")])
_RESCUE = {"t": None, "lo": None, "hi": None}

# V62.3: repair of ONE candle whose ticks a time-range request cannot see (see
# _ticks_of_hidden_second). The misplaced block sits about a day before its own
# time in the stored order, so the read starts that far (plus a margin) back.
_HIDDEN_SECOND_LOOKBACK_MS = _DAY_MS + 3_600_000
_HIDDEN_SECOND_READ_TICKS = 200_000
_HIDDEN_SECOND_MAX_READS = 3  # per Backfill request: a candle whose ticks do not exist must not cost a read each


def _msc_to_datetime_utc(time_msc):
    """Convert a millisecond Unix timestamp to a UTC datetime for MT5 calls."""
    return datetime.fromtimestamp(time_msc / 1000.0, tz=timezone.utc)


def get_broker_now_ms(mt5, symbol=None):
    """Current time on the BROKER's clock, in milliseconds, or None.

    v61.3: this is the only notion of "now" the data pipeline uses. MT5 stamps
    every tick with the broker server's clock (UTC+3 for many brokers) and
    the whole app treats those stamps as plain epoch milliseconds. The
    PC clock is a different number (the PC's real UTC is hours behind such a
    broker, and it may simply be wrong), so it is never consulted: "now" is
    the timestamp of the newest tick the terminal has for the symbol.
    """
    sym = symbol
    try:
        tick = mt5.symbol_info_tick(sym)
    except Exception:
        tick = None
    if tick is not None:
        msc = int(getattr(tick, "time_msc", 0) or 0)
        if msc <= 0:
            msc = int(getattr(tick, "time", 0) or 0) * 1000
        if msc > 0:
            return msc
    try:
        info = mt5.symbol_info(sym)
    except Exception:
        info = None
    if info is not None:
        msc = int(getattr(info, "time", 0) or 0) * 1000
        if msc > 0:
            return msc
    return None


def first_run_backfill_start_ms(broker_now_ms):
    """Where the very first fetch begins: 00:00:00 broker time of the day
    HISTORY_BACKFILL_MAX_DAYS days before the broker's current day."""
    broker_day_start = int(broker_now_ms) - (int(broker_now_ms) % _DAY_MS)
    return broker_day_start - int(HISTORY_BACKFILL_MAX_DAYS) * _DAY_MS


def _first_run_backfill_start(broker_now_ms):
    return _msc_to_datetime_utc(first_run_backfill_start_ms(broker_now_ms))


def _sleep(stop_event, seconds):
    """Interruptible sleep; returns True when a stop was requested."""
    if stop_event is not None:
        return bool(stop_event.wait(seconds))
    time.sleep(seconds)
    return False


def _copy_range(mt5, symbol, from_ms, to_ms, logger=None):
    """copy_ticks_range() with one retry; None when MT5 reports an error."""
    from_dt = _msc_to_datetime_utc(from_ms)
    to_dt = _msc_to_datetime_utc(to_ms)
    ticks = None
    for attempt in range(2):
        try:
            ticks = mt5.copy_ticks_range(symbol, from_dt, to_dt, mt5.COPY_TICKS_ALL)
        except Exception as e:
            if logger is not None:
                logger.warning(
                    f"copy_ticks_range failed for {from_dt.isoformat()} .. {to_dt.isoformat()} "
                    f"(attempt {attempt + 1}/2): {e}"
                )
            ticks = None
        if ticks is not None:
            break
        time.sleep(0.5)
    return ticks


def _find_suspect_holes(time_msc, from_ms, to_ms, check_tail):
    """Spans of a fetched range that hold no tick for longer than the hole
    threshold: (after_ms, before_ms) pairs, biggest first, at most a few.
    An empty fetch is one hole covering the whole range."""
    threshold = int(TICK_HOLE_THRESHOLD_SECONDS * 1000)
    n = len(time_msc)
    if n == 0:
        return [(from_ms - 1, to_ms + 1)] if (to_ms - from_ms) > threshold else []

    holes = []
    first = int(time_msc[0])
    if first - from_ms > threshold:
        holes.append((from_ms - 1, first))
    if n > 1:
        gaps = np.diff(time_msc)
        for i in np.nonzero(gaps > threshold)[0]:
            holes.append((int(time_msc[i]), int(time_msc[i + 1])))
    last = int(time_msc[-1])
    if check_tail and to_ms - last > threshold:
        holes.append((last, to_ms + 1))

    holes.sort(key=lambda h: h[1] - h[0], reverse=True)
    return holes[:_MAX_HOLES_PROBED]


def _fmt_ms(ms):
    return _msc_to_datetime_utc(ms).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]


def _holes_have_ticks(mt5, symbol, holes, logger=None):
    """Cheap probe: read only the inside of each hole (normally 0 rows).

    v61.5 fix: copy_ticks_range()'s datetime parameters only have whole-second
    resolution in the underlying MT5 API - any fractional second we pass gets
    truncated. Requesting lo=after_ms+1 (a fractional second) therefore often
    gets silently rounded down to the start of that same second by MT5, so
    the "probe" can hand back ticks we ALREADY saw in the full fetch (the
    very last tick(s) right before the hole), not new ones. That made a
    hole look "arrived" forever, since those old ticks never disappear.
    Fix: always accept the probe's own tick timestamps as ground truth and
    only count a hit when at least one returned tick is strictly inside the
    millisecond-precise hole (after_ms, before_ms) - i.e. genuinely new.
    """
    for after_ms, before_ms in holes:
        lo, hi = after_ms + 1, before_ms - 1
        if hi < lo:
            if TICK_SYNC_DEBUG and logger is not None:
                logger.info(
                    f"[TICK_SYNC_DEBUG] probe skipped, empty range: hole=({_fmt_ms(after_ms)} .. "
                    f"{_fmt_ms(before_ms)}) collapses to lo>hi"
                )
            continue
        try:
            probe = mt5.copy_ticks_range(
                symbol, _msc_to_datetime_utc(lo), _msc_to_datetime_utc(hi), mt5.COPY_TICKS_ALL
            )
        except Exception as e:
            probe = None
            if TICK_SYNC_DEBUG and logger is not None:
                logger.info(f"[TICK_SYNC_DEBUG] probe raised for hole ({_fmt_ms(after_ms)} .. {_fmt_ms(before_ms)}): {e}")
        n = 0 if probe is None else len(probe)
        genuinely_new = 0
        if n > 0:
            mask = (probe["time_msc"] > after_ms) & (probe["time_msc"] < before_ms)
            genuinely_new = int(np.count_nonzero(mask))
        if TICK_SYNC_DEBUG and logger is not None:
            if n > 0:
                logger.info(
                    f"[TICK_SYNC_DEBUG] probe HOLE=({_fmt_ms(after_ms)} .. {_fmt_ms(before_ms)}) "
                    f"queried=({_fmt_ms(lo)} .. {_fmt_ms(hi)}) -> {n} tick(s) returned, "
                    f"{genuinely_new} strictly inside the hole; "
                    f"first={_fmt_ms(int(probe['time_msc'][0]))} last={_fmt_ms(int(probe['time_msc'][-1]))} "
                    f"bid_first={probe['bid'][0]} bid_last={probe['bid'][-1]}"
                )
            else:
                logger.info(
                    f"[TICK_SYNC_DEBUG] probe HOLE=({_fmt_ms(after_ms)} .. {_fmt_ms(before_ms)}) "
                    f"queried=({_fmt_ms(lo)} .. {_fmt_ms(hi)}) -> 0 ticks"
                )
        if genuinely_new > 0:
            return True
    return False


def _last_valid_ask(ask_values):
    """Newest positive ASK of a live batch, or None (V64).

    The ASK is display-only: it is never aggregated into candles and never
    written to SQLite. Scanning from the end keeps this O(1) in the normal case
    (the last tick of a batch already carries a valid ASK); the batch is only
    scanned further back when its tail holds a zero (a bid-only quote).
    """
    if ask_values is None:
        return None
    n = len(ask_values)
    for i in range(n - 1, max(n - 65, -1), -1):
        v = float(ask_values[i])
        if v > 0.0:
            return v
    if n > 64:
        idx = np.flatnonzero(ask_values > 0.0)
        if idx.size:
            return float(ask_values[idx[-1]])
    return None


def _compact(ticks):
    out = np.empty(len(ticks), dtype=_COMPACT_DTYPE)
    out["time_msc"] = ticks["time_msc"]
    out["bid"] = ticks["bid"]
    return out


def _sort_ticks(ticks):
    """copy_ticks_* normally return ascending ticks; make sure of it (V62.2)."""
    tm = ticks["time_msc"]
    if len(tm) > 1 and bool(np.any(tm[1:] < tm[:-1])):
        return ticks[np.argsort(tm, kind="stable")]
    return ticks


def _merge_ticks(ticks, extra):
    merged = np.concatenate([_compact(ticks), extra])
    return merged[np.argsort(merged["time_msc"], kind="stable")]


def _read_sequential(mt5, symbol, a_ms, b_ms, logger):
    """Read the terminal's tick store in its stored order, starting just
    before a hole, and keep the result (sorted) as the rescue cache.

    Returns the cache or None when the probe shows nothing hidden in the hole.
    """
    start_ms = (int(a_ms) // 1000) * 1000 - 1000
    count = _RESCUE_PROBE_TICKS
    while True:
        try:
            raw = mt5.copy_ticks_from(symbol, _msc_to_datetime_utc(start_ms), count, mt5.COPY_TICKS_ALL)
        except Exception:
            return None
        if raw is None or len(raw) == 0:
            return None
        tm = raw["time_msc"]
        if not bool(np.any((tm > a_ms) & (tm < b_ms))):
            return None  # ordinary closure: nothing is hidden in this hole
        reached = int(tm.max())
        if reached >= b_ms + _RESCUE_LOOKAHEAD_MS or len(raw) < count or count >= _RESCUE_MAX_TICKS:
            break
        count = min(count * 4, _RESCUE_MAX_TICKS)
        del raw
    disordered = bool(np.any(tm[1:] < tm[:-1]))
    cache = _compact(raw)
    cache = cache[np.argsort(cache["time_msc"], kind="stable")]
    del raw
    _RESCUE.update({"t": cache, "lo": start_ms, "hi": int(cache["time_msc"][-1])})
    logger.warning(
        "Tick sync: the terminal returned ticks for a span that a time-range request reported as empty"
        + (" (its tick store is out of chronological order there)" if disordered else "")
        + f"; read {len(cache):,} ticks sequentially and sorted them to recover it."
    )
    return cache


def _rescue_from_sequential(mt5, symbol, holes, logger, allow_read):
    """Ticks that lie strictly inside ``holes`` although range requests
    reported them empty (V62.2), or None.

    Some terminals hold a stretch of ticks out of order (e.g. a few minutes of
    the NEXT day stored in the middle of a day). Range requests find their
    start/end by binary search over the stored order, so everything after such
    a misplaced block can look missing. Reading N ticks in stored order from a
    point BEFORE the block has no such problem. Ordinary closures cost only
    one small probe read.
    """
    found = []
    for a, b in holes:
        cache = _RESCUE["t"]
        if cache is None or not (_RESCUE["lo"] <= a and _RESCUE["hi"] >= b):
            cache = _read_sequential(mt5, symbol, a, b, logger) if allow_read else None
        if cache is None:
            continue
        tm = cache["time_msc"]
        lo = int(np.searchsorted(tm, a, "right"))
        hi = int(np.searchsorted(tm, b, "left"))
        if hi > lo:
            found.append(cache[lo:hi])
    return np.concatenate(found) if found else None


def _ticks_of_hidden_second(mt5, symbol, bucket_ms, logger, allow_read=True):
    """Ticks of the one whole second starting at ``bucket_ms`` although a
    time-range request returned none for it (V62.3), or None.

    First choice is the sequential-read cache the same Backfill may already
    hold (no MT5 call). Otherwise one bounded stored-order read starts about a
    day BEFORE the second: in a terminal whose tick store is out of order, the
    ticks of a second can sit far earlier in the stored order than their own
    time (the 19th 00:00:00 block sits after the 18th 00:59:59), where a read
    that starts at the second itself never passes.
    """
    a, b = int(bucket_ms) - 1, int(bucket_ms) + 1000
    cache = _RESCUE["t"]
    if cache is not None and _RESCUE["lo"] <= a and _RESCUE["hi"] >= b:
        tm = cache["time_msc"]
        lo = int(np.searchsorted(tm, a, "right"))
        hi = int(np.searchsorted(tm, b, "left"))
        return cache[lo:hi] if hi > lo else None
    if not allow_read:
        return None
    start_ms = (int(bucket_ms) // 1000) * 1000 - _HIDDEN_SECOND_LOOKBACK_MS
    try:
        raw = mt5.copy_ticks_from(symbol, _msc_to_datetime_utc(start_ms), _HIDDEN_SECOND_READ_TICKS, mt5.COPY_TICKS_ALL)
    except Exception:
        return None
    if raw is None or len(raw) == 0:
        return None
    tm = raw["time_msc"]
    mask = (tm > a) & (tm < b)
    if not bool(np.any(mask)):
        return None
    found = _compact(raw[mask])
    found = found[np.argsort(found["time_msc"], kind="stable")]
    logger.warning(
        f"Backfill: the ticks of {_fmt_ms(int(bucket_ms))} were not returned by a time-range request "
        f"(tick store out of order there); found {len(found):,} of them with a stored-order read."
    )
    return found


def _terminal_connected(mt5):
    """True when the terminal reports a live connection to the broker.

    Unknown (terminal_info() failing or returning nothing) counts as
    connected, so an odd API answer can never stall the sync forever.
    """
    try:
        info = mt5.terminal_info()
    except Exception:
        return True
    if info is None:
        return True
    return bool(getattr(info, "connected", True))


def _wait_for_hole_sync(mt5, symbol, holes, stop_event, quiet_seconds=None,
                        on_status=None, logger=None):
    """Give the terminal time to download the ticks of ``holes``.

    Returns ``(arrived, offline_seconds)``. ``arrived`` is True as soon as any
    tick appears inside a hole (the caller should fetch again) and False when
    the holes stayed empty for a whole quiet period - i.e. the market really
    had no ticks there.

    v61.4: "empty" only counts while the terminal is CONNECTED to the broker.
    With the connection down the terminal cannot download anything, so silence
    proves nothing: the check pauses, and the quiet period starts over once
    the connection is back. A gap can therefore only be accepted as a closure
    after a full quiet period of uninterrupted connection. ``offline_seconds``
    lets the caller keep that paused time out of its own time limit.
    """
    quiet = float(TICK_SYNC_QUIET_SECONDS if quiet_seconds is None else quiet_seconds)
    offline_total = 0.0
    window_start = time.monotonic()
    was_offline = False

    while True:
        if not _terminal_connected(mt5):
            if not was_offline:
                was_offline = True
                if logger is not None:
                    logger.warning(
                        "Tick sync: the terminal is not connected to the broker - the gap check "
                        "is paused (an empty gap proves nothing while offline) and restarts on reconnect."
                    )
                if on_status is not None:
                    on_status("offline")
            paused_at = time.monotonic()
            if _sleep(stop_event, 0.5):
                return False, offline_total + (time.monotonic() - paused_at)
            offline_total += time.monotonic() - paused_at
            window_start = time.monotonic()
            continue

        if was_offline:
            was_offline = False
            window_start = time.monotonic()
            if logger is not None:
                logger.info("Tick sync: the terminal is connected again; the gap check restarts its quiet period.")
            if on_status is not None:
                on_status("syncing")

        if _holes_have_ticks(mt5, symbol, holes, logger=logger):
            return True, offline_total
        if time.monotonic() - window_start >= quiet and _terminal_connected(mt5):
            return False, offline_total
        if _sleep(stop_event, 0.5):
            return False, offline_total


def fetch_verified_range(mt5, symbol, from_ms, to_ms, logger, stop_event=None, check_tail=True, on_status=None):
    """Fetch [from_ms, to_ms] and make sure it is not silently incomplete.

    MT5 returns whatever ticks the terminal holds locally and downloads the
    remainder in the background, so a single read can miss hours of history
    without any error. A hole is re-checked with a tiny probe until the
    terminal either delivers its ticks (then the whole chunk is read again) or
    the hole stays empty for TICK_SYNC_QUIET_SECONDS (a genuine closure).
    Returns the NumPy tick array, or None if MT5 keeps failing.

    """
    started = time.monotonic()
    while True:
        ticks = _copy_range(mt5, symbol, from_ms, to_ms, logger)
        if ticks is None:
            return None
        ticks = _sort_ticks(ticks)
        holes = _find_suspect_holes(ticks["time_msc"], from_ms, to_ms, check_tail)
        if _RESCUE["t"] is not None and _RESCUE["hi"] < from_ms:
            _RESCUE.update({"t": None, "lo": None, "hi": None})  # cache is behind us
        if holes and _RESCUE["t"] is not None:
            extra = _rescue_from_sequential(mt5, symbol, holes, logger, allow_read=False)
            if extra is not None:
                ticks = _merge_ticks(ticks, extra)
                holes = _find_suspect_holes(ticks["time_msc"], from_ms, to_ms, check_tail)
        if TICK_SYNC_DEBUG:
            n = len(ticks)
            if n:
                logger.info(
                    f"[TICK_SYNC_DEBUG] full fetch {_fmt_ms(from_ms)} .. {_fmt_ms(to_ms)} "
                    f"(check_tail={check_tail}) -> {n} tick(s), "
                    f"first={_fmt_ms(int(ticks['time_msc'][0]))} last={_fmt_ms(int(ticks['time_msc'][-1]))}, "
                    f"holes={[(_fmt_ms(a), _fmt_ms(b)) for a, b in holes]}"
                )
            else:
                logger.info(
                    f"[TICK_SYNC_DEBUG] full fetch {_fmt_ms(from_ms)} .. {_fmt_ms(to_ms)} "
                    f"(check_tail={check_tail}) -> 0 ticks, holes={[(_fmt_ms(a), _fmt_ms(b)) for a, b in holes]}"
                )
        if not holes:
            return ticks
        rescue_holes = list(holes)
        if time.monotonic() - started >= TICK_SYNC_MAX_WAIT_SECONDS:
            logger.warning(
                f"Tick sync: giving up waiting for {len(holes)} gap(s) in "
                f"{_msc_to_datetime_utc(from_ms).strftime('%Y-%m-%d %H:%M:%S')} .. "
                f"{_msc_to_datetime_utc(to_ms).strftime('%Y-%m-%d %H:%M:%S')} after "
                f"{TICK_SYNC_MAX_WAIT_SECONDS:.0f}s; keeping what MT5 returned "
                "(use Backfill in Market Data Overview to retry)."
            )
            return ticks
        arrived, offline_seconds = _wait_for_hole_sync(
            mt5, symbol, holes, stop_event, on_status=on_status, logger=logger
        )
        started += offline_seconds  # time spent offline does not count against the limit
        if not arrived:
            # holes stayed empty while connected: real closure (or stop requested)
            extra = _rescue_from_sequential(mt5, symbol, rescue_holes, logger, allow_read=True)
            if extra is not None:
                return _merge_ticks(ticks, extra)  # the next chunks reuse the rescue cache
            return ticks
        # Ticks are arriving: let the download run a little before re-reading
        # the whole chunk, instead of re-reading it on every poll.
        if _sleep(stop_event, float(TICK_SYNC_SETTLE_SECONDS)):
            return ticks
        logger.info(
            "Tick sync: the terminal delivered more history for a gap inside "
            f"{_msc_to_datetime_utc(from_ms).strftime('%Y-%m-%d %H:%M:%S')} .. "
            f"{_msc_to_datetime_utc(to_ms).strftime('%Y-%m-%d %H:%M:%S')}; fetching the chunk again."
        )
        del ticks


def catch_up_forward(mt5, logger, start_ms, symbol=None, on_new_ticks=None, on_status=None,
                     stop_event=None, on_idle=None):
    """Bring the candle cache from ``start_ms`` up to the broker's current time.

    Used for the first run and for every resume after the app was closed. The
    span is fetched in bounded, hole-verified chunks (see fetch_verified_range)
    and every chunk is handed to ``on_new_ticks`` exactly like a live batch;
    only the final chunk is flagged as the live edge. Returns the newest tick
    time delivered (ms) or None.
    """
    sym = symbol
    cursor_ms = int(start_ms)
    last_msc = None
    span_ms = int(CATCH_UP_CHUNK_SECONDS * 1000)
    total = 0

    while True:
        if stop_event is not None and stop_event.is_set():
            return last_msc
        if on_idle is not None:
            try:
                on_idle()
            except Exception as e:
                logger.warning(f"on_idle (backfill) callback raised an exception: {e}")

        target_ms = get_broker_now_ms(mt5, sym)
        if target_ms is None or target_ms < cursor_ms:
            target_ms = cursor_ms  # nothing newer is known: one last chunk, then live
        chunk_end_ms = min(cursor_ms + span_ms - 1, target_ms)
        is_last = chunk_end_ms >= target_ms

        ticks = fetch_verified_range(
            mt5, sym, cursor_ms, chunk_end_ms, logger, stop_event=stop_event,
            check_tail=not is_last, on_status=on_status,
        )
        if ticks is None:
            err_code, err_desc = mt5.last_error()
            logger.warning(f"Catch-up: MT5 returned no data (last_error={err_code}: {err_desc}). Retrying ...")
            if on_status is not None:
                on_status("offline")
            if _sleep(stop_event, max(POLL_INTERVAL_SECONDS, 1.0)):
                return last_msc
            continue

        count = len(ticks)
        if count:
            total += count
            last_msc = int(ticks["time_msc"][-1])
            logger.info(
                f"Catch-up: +{count:,} tick(s) for "
                f"{_msc_to_datetime_utc(cursor_ms).strftime('%Y-%m-%d %H:%M:%S')} .. "
                f"{_msc_to_datetime_utc(chunk_end_ms).strftime('%Y-%m-%d %H:%M:%S')} (broker clock) "
                f"| total this run: {total:,}"
            )
            span_ms = int(CATCH_UP_CHUNK_SECONDS * 1000)
        else:
            span_ms = min(span_ms * 2, _MAX_CHUNK_MS)

        if on_status is not None:
            on_status("online" if is_last else "syncing")
        if on_new_ticks is not None:
            try:
                on_new_ticks(ticks["time_msc"], ticks["bid"], is_last)
            except Exception as e:
                logger.warning(f"on_new_ticks callback raised an exception: {e}")
        del ticks

        if is_last:
            return last_msc
        # Chain the next chunk from the last tick actually received when the
        # chunk's tail is only a short quiet spell (the tail of a chunk whose
        # download may still be in progress cannot be told apart from it);
        # a long empty tail was already verified above, so skip past it.
        # Duplicated ticks are ignored downstream (time_msc <= last).
        if count and (chunk_end_ms - last_msc) <= int(TICK_HOLE_THRESHOLD_SECONDS * 1000):
            cursor_ms = last_msc
        else:
            cursor_ms = chunk_end_ms + 1


def backfill_ranges(mt5, conn, logger, ranges, on_range=None, symbol=None):
    """Fetch exact missing ranges and hand each result to an in-memory consumer.

    v61: MT5 ticks are never persisted. ``on_range`` receives the raw NumPy
    arrays immediately so the caller can aggregate them to candles and then
    let the arrays be released. The connection argument is retained for API
    compatibility with existing embedders but is not written to.

    V62.3: copy_ticks_range() has whole-second resolution - a fractional end
    such as 00:00:00.998 is cut to 00:00:00, so the last second of a range
    (its ticks .001-.999) was never returned and that candle was either not
    rebuilt or rebuilt from a tick or two. The request now ends on the next
    whole second and the result is trimmed to the exact millisecond range.
    A range that ends on an existing candle (the candle after a gap) must
    contain that candle's ticks; if the request missed them, they are taken
    from the sequential-read cache or one bounded stored-order read.
    """
    total_recovered = 0
    sym = symbol
    reads_left = _HIDDEN_SECOND_MAX_READS

    for range_from_ms, range_to_ms in ranges:
        from_dt = _msc_to_datetime_utc(range_from_ms)
        to_dt = _msc_to_datetime_utc(range_to_ms)

        fetch_from_ms = (int(range_from_ms) // 1000) * 1000
        fetch_to_ms = (int(range_to_ms) // 1000 + 1) * 1000

        # v61.3: hole-verified fetch (see fetch_verified_range) - a Backfill
        # that ran before the terminal had finished downloading the day used
        # to return a partial range and report it as done.
        ticks = fetch_verified_range(mt5, sym, fetch_from_ms, fetch_to_ms, logger)

        if ticks is None:
            err_code, err_desc = mt5.last_error()
            logger.warning(
                f"Backfill: giving up on range {from_dt.isoformat()} .. "
                f"{to_dt.isoformat()} after retrying (MT5 last_error="
                f"{err_code}: {err_desc})."
            )
            continue

        # Trim to the exact range (the request ended on a whole second, and a
        # rescue merge is sorted): ticks are ascending, so two binary searches.
        if len(ticks):
            tm = ticks["time_msc"]
            i0 = int(np.searchsorted(tm, range_from_ms, "left"))
            i1 = int(np.searchsorted(tm, range_to_ms, "right"))
            ticks = ticks[i0:i1]

        # The last whole second of the range is the candle after a gap when
        # that candle exists in the cache: its ticks must be there.
        tail_bucket = (int(range_to_ms) // 1000) * 1000
        if (
            int(range_to_ms) % 1000 == 999
            and tail_bucket >= int(range_from_ms)
            and (len(ticks) == 0 or int(ticks["time_msc"][-1]) < tail_bucket)
            and conn is not None
            and conn.execute(
                "SELECT 1 FROM candles_1s WHERE bucket_start_ms = ?", (tail_bucket,)
            ).fetchone() is not None
        ):
            cache_covers = _RESCUE["t"] is not None and _RESCUE["lo"] <= tail_bucket - 1 and _RESCUE["hi"] >= tail_bucket + 1000
            extra = _ticks_of_hidden_second(mt5, sym, tail_bucket, logger, allow_read=cache_covers or reads_left > 0)
            if not cache_covers and extra is None:
                reads_left -= 1
            if extra is not None:
                ticks = _merge_ticks(ticks, extra) if len(ticks) else extra
            else:
                logger.warning(
                    f"Backfill: no ticks could be read for {_fmt_ms(tail_bucket)}, the candle after this range; "
                    "it stays as it is (tools/check_tick_order.py shows what the terminal holds)."
                )

        if len(ticks) == 0:
            logger.info(
                f"Backfill: no ticks available from the server for "
                f"{from_dt.isoformat()} .. {to_dt.isoformat()} "
                "(market likely closed in this span)."
            )
            continue

        fetched_count = len(ticks)
        recovered = on_range(range_from_ms, range_to_ms, ticks["time_msc"], ticks["bid"]) if on_range else 0
        total_recovered += int(recovered or 0)
        del ticks
        # v61.3: the count is taken BEFORE ``del ticks``. V61 logged
        # len(ticks) after deleting it, which raised UnboundLocalError once
        # per recovered range, aborted the rest of the Backfill request and
        # made a successful run report "No Data Recovered".
        logger.info(
            f"Backfill: converted {fetched_count:,} fetched tick(s) into {int(recovered or 0):,} "
            f"one-second candle(s) for {from_dt.isoformat()} .. {to_dt.isoformat()}; raw ticks discarded."
        )

    return total_recovered


def sync_ticks_forward(mt5, conn, logger, on_new_ticks=None, on_status=None, stop_event=None, on_idle=None, symbol=None):

    last_cached_bucket_ms = candle_cache.get_last_cached_bucket_start_ms(conn)
    last_msc = None
    sym = symbol

    if last_cached_bucket_ms is None:
        # v61.3: the very first run. "Now" is the BROKER's clock, taken from
        # the live feed (never the PC clock); wait for it if the feed has
        # not delivered a first tick yet.
        broker_now_ms = get_broker_now_ms(mt5, sym)
        waited = 0.0
        while broker_now_ms is None:
            if stop_event is not None and stop_event.is_set():
                logger.info("Stop requested before the broker time was known; exiting the sync loop.")
                return 0
            if waited == 0.0 or int(waited) % 10 == 0:
                logger.warning(f"Waiting for broker time from '{sym}' (no tick yet)")
                if on_status is not None:
                    on_status("offline")
            if _sleep(stop_event, 1.0):
                return 0
            waited += 1.0
            broker_now_ms = get_broker_now_ms(mt5, sym)

        start_ms = first_run_backfill_start_ms(broker_now_ms)
        logger.info(
            f"Database is empty. Broker time: {_msc_to_datetime_utc(broker_now_ms).strftime('%Y-%m-%d %H:%M:%S')}, "
            f"starting at {_msc_to_datetime_utc(start_ms).strftime('%Y-%m-%d %H:%M:%S')}",
            extra={"category": "DATABASE"},
        )
    else:
        start_ms = last_cached_bucket_ms
        resume_readable = _msc_to_datetime_utc(last_cached_bucket_ms).strftime("%Y-%m-%d %H:%M:%S")
        logger.info(
            f"Resuming from last candle: {resume_readable} UTC",
            extra={"category": "DATABASE"},
        )
        # v67.1: let the broker-time value settle before catch-up trusts it
        # as the target (see RESUME_BROKER_TIME_SETTLE_SECONDS in config.py).
        _sleep(stop_event, float(RESUME_BROKER_TIME_SETTLE_SECONDS))

    # v61.3: catch up to the broker's current time in bounded, hole-verified
    # chunks (see catch_up_forward). Before, this was an open-ended
    # copy_ticks_from() loop that decided it had reached the live edge as soon
    # as a batch came back smaller than TICKS_BATCH_SIZE - which also happens
    # when the terminal simply had no more LOCAL history and jumped straight
    # to today's ticks, gluing the two together and leaving a permanent gap.
    if get_broker_now_ms(mt5, sym) is not None:
        last_msc = catch_up_forward(
            mt5, logger, start_ms, symbol=sym, on_new_ticks=on_new_ticks,
            on_status=on_status, stop_event=stop_event, on_idle=on_idle,
        )
        if stop_event is not None and stop_event.is_set():
            logger.info("Stop requested; exiting the sync loop.")
            return 0
    else:
        logger.warning(
            "Broker time is not available yet; resuming from the cache without a catch-up pass."
        )
    cursor_dt = _msc_to_datetime_utc(last_msc if last_msc is not None else start_ms)
    verified_gap_ends = set()

    logger.info(f"Watching symbol '{symbol}'. Press Ctrl+C to stop ...")

    total_received = 0
    caught_up_announced = False

    # (v25.4) Wall-clock proof of a genuinely live feed. Unlike the previous
    # logic, this is updated ONLY when a tick is actually received - never by a
    # successful-but-empty MT5 call - so it can't be fooled by a terminal
    # that keeps answering "no ticks" while the broker feed behind it is
    # dead (internet drop while already online) or simply closed for the
    # weekend. Every "no new data this iteration" status decision below is
    # judged against how long it's been since this last moved, instead of
    # against whether the last MT5 call merely succeeded. See
    # LIVE_DATA_STALE_SECONDS in config.py for the reasoning on the cutoff.
    last_live_tick_monotonic = time.monotonic()

    def _idle_status():
        """Status for an iteration where no new tick came in, based purely
        on elapsed time since the last one actually did - not on whether
        MT5's call itself succeeded."""
        stale = (time.monotonic() - last_live_tick_monotonic) >= LIVE_DATA_STALE_SECONDS
        return "offline" if stale else "online"

    LOG_MIN_INTERVAL_SECONDS = 1.0
    last_progress_log_monotonic = 0.0

    try:
        while True:
            if stop_event is not None and stop_event.is_set():
                logger.info("Stop requested; exiting the sync loop.")
                break

            # (v44) Cheap, non-blocking check for a pending Backfill
            # request, serviced right here on this same MT5-owning thread
            # (one iteration between live-sync polls) instead of on a
            # separate thread/process - MT5's Python module isn't meant to
            # be driven concurrently, so this keeps every MT5 call
            # strictly sequential while still not requiring the live feed
            # to fully stop for the whole duration of a run.
            if on_idle is not None:
                try:
                    on_idle()
                except Exception as e:
                    logger.warning(f"on_idle (backfill) callback raised an exception: {e}")

            try:
                ticks = mt5.copy_ticks_from(symbol, cursor_dt, TICKS_BATCH_SIZE, mt5.COPY_TICKS_ALL)
            except Exception as e:
                logger.warning(f"copy_ticks_from raised an exception: {e}. Retrying ...")
                if on_status is not None:
                    on_status("offline")
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            if ticks is None or len(ticks) == 0:

                err_code, err_desc = mt5.last_error()
                if err_code != 1:  # 1 == RES_S_OK
                    logger.warning(f"No ticks returned (MT5 last_error={err_code}: {err_desc}). Retrying ...")
                    if on_status is not None:
                        on_status("offline")
                else:
                    # (v25.3, refined in v25.4) Called every healthy idle
                    # iteration, not just the first one - a transient error
                    # earlier (handled above) may have already reported
                    # "offline". This used to report "online" unconditionally
                    # here, on the assumption that "MT5 call succeeded with
                    # no error" meant "connected". It doesn't: this exact
                    # branch also fires when the internet has dropped out
                    # from under an already-connected terminal, or when the
                    # market is simply closed (weekend) - MT5 still answers
                    # RES_S_OK with zero ticks either way. So the real
                    # recovery-to-online signal is judged by _idle_status()
                    # instead: only "online" if a live tick has actually
                    # landed within LIVE_DATA_STALE_SECONDS, else "offline".
                    # status_state's own dedup (sync_process.py) keeps this
                    # from spamming the queue while nothing has changed.
                    if on_status is not None:
                        on_status(_idle_status())
                    if not caught_up_announced:
                        logger.info(f"Caught up to the broker's latest tick. Now streaming live (ticks processed this run: {total_received:,}).")
                        caught_up_announced = True
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            caught_up_announced = False

            new_msc = ticks["time_msc"]
            new_bid = ticks["bid"]
            # V64: the ASK column rides along for the live ASK line only. It is
            # never stored; only the newest value of a live-edge batch is used.
            new_ask = ticks["ask"] if "ask" in (ticks.dtype.names or ()) else None

            if last_msc is not None:
                mask = new_msc > last_msc
                new_msc = new_msc[mask]
                new_bid = new_bid[mask]
                if new_ask is not None:
                    new_ask = new_ask[mask]

            # v61.3: the same silent-hole risk exists here (after a reconnect,
            # or when resuming without a catch-up pass): the terminal can hand
            # back ticks that jump over history it has not downloaded yet -
            # either right after the last tick we have, or inside the batch.
            # Any span longer than the hole threshold is probed first (a tiny
            # read of just that span) and the batch is re-read if the
            # terminal delivers ticks for it. A span that stays empty is a real
            # closure (weekend): it is accepted once and remembered.
            if len(new_msc) > 0:
                batch_from_ms = last_msc if last_msc is not None else int(cursor_dt.timestamp() * 1000)
                holes = [
                    h for h in _find_suspect_holes(new_msc, batch_from_ms, int(new_msc[-1]), False)
                    if h[1] not in verified_gap_ends
                ]
                if holes:
                    arrived, _offline = _wait_for_hole_sync(
                        mt5, sym, holes, stop_event, on_status=on_status, logger=logger
                    )
                    if arrived:
                        logger.info(
                            "Tick sync: the terminal delivered history for a gap in the ticks just "
                            f"read (after {_msc_to_datetime_utc(holes[0][0]).strftime('%Y-%m-%d %H:%M:%S')}); re-reading."
                        )
                        _sleep(stop_event, float(TICK_SYNC_SETTLE_SECONDS))
                        del new_msc, new_bid, new_ask, ticks
                        continue
                    if len(verified_gap_ends) > 1000:
                        verified_gap_ends.clear()
                    verified_gap_ends.update(h[1] for h in holes)

            got_full_batch = len(ticks) >= TICKS_BATCH_SIZE

            made_progress = len(new_msc) > 0

            if made_progress:
                total_received += len(new_msc)
                last_msc = int(new_msc[-1])
                cursor_dt = _msc_to_datetime_utc(last_msc)

                last_live_tick_monotonic = time.monotonic()

                now_mono = time.monotonic()
                should_log = got_full_batch or (
                    now_mono - last_progress_log_monotonic >= LOG_MIN_INTERVAL_SECONDS
                )
                if should_log:
                    last_progress_log_monotonic = now_mono
                    newest_readable = _msc_to_datetime_utc(last_msc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                    logger.info(
                        f"+{len(new_msc):,} tick(s) received -> in-memory candle aggregation | "
                        f"total this run: {total_received:,} | latest: bid={float(new_bid[-1]):.2f} "
                        f"at {newest_readable} UTC",
                        extra={"category": "DATABASE"},
                    )
                if on_new_ticks is not None:
                    try:
                        # V64: the 4th argument is the newest ASK of the batch,
                        # only looked up at the live edge (a full batch is
                        # still catching up and has no live line to feed).
                        live_ask = None if got_full_batch else _last_valid_ask(new_ask)
                        on_new_ticks(new_msc, new_bid, not got_full_batch, live_ask)
                    except Exception as e:
                        logger.warning(f"on_new_ticks callback raised an exception: {e}")

                if on_status is not None:
                    on_status("syncing" if got_full_batch else "online")

            elif on_status is not None:
                # (v25.4) MT5 returned a non-empty batch, but every tick in
                # it was one already stored (e.g. right after resuming from
                # a saved cursor - a stale batch can be handed back before
                # the feed catches up, or after being closed over a
                # weekend). No new tick landed, so judge this exactly like
                # the healthy-idle/empty-batch case above instead of leaving
                # the dot on whatever it last happened to show.
                on_status(_idle_status())

            # Release the NumPy views/array as soon as this batch has been
            # consumed; the next copy_ticks_from() call would replace them
            # anyway, but explicit cleanup keeps the raw batch lifetime as
            # short as practical during long catch-up runs.
            del new_msc, new_bid, new_ask, ticks

            # A full but stale batch means the cursor made no progress;
            # always yield in that case to avoid a tight MT5 polling loop.
            if not got_full_batch or not made_progress:
                time.sleep(POLL_INTERVAL_SECONDS)


    except KeyboardInterrupt:
        logger.info("Stopped by user (Ctrl+C).")

    logger.info(f"Total ticks processed this run (not persisted): {total_received:,}")
    return total_received
