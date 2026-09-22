# -*- coding: utf-8 -*-
import time

from candle_aggregator import Candle, iter_candles, ticks_to_candles, merge_candles

# v34: candles_1s used to be the only persisted candle table - the 5s and
# 15s timeframes were always re-derived from it (merge_candles()) on every
# single read, in every ChartBridge method. This map is the only thing that
# changed conceptually: each configured sub-minute timeframe that has its
# own entry here now also gets its own persisted SQLite table, built once
# in refresh() and then read directly - same table shape, same columns,
# same PRIMARY KEY style as candles_1s. A timeframe with no entry here
# still falls back to the original on-the-fly merge_candles() path against
# candles_1s, so nothing breaks if a future timeframe is added to the
# config without a matching table.
#
# v38: 1m/5m/15m/1h added, exactly the same way 5s/15s were added in v34 -
# same merge_candles() call, same _refresh_derived_table() tail-rebuild,
# just a bigger `factor` (60/300/900/3600 seconds instead of 5/15). No
# aggregation logic changed at all, only this map grew four more entries.
_TF_TABLES = {
    1: "candles_1s",
    5: "candles_5s",
    15: "candles_15s",
    60: "candles_1m",
    300: "candles_5m",
    900: "candles_15m",
    3600: "candles_1h",
}

_TABLE_COLUMNS = "bucket_start_ms, open, high, low, close, tick_count"


def _direct_table(timeframe_seconds):
    """Return the dedicated table name for this timeframe, or None if it
    must still be derived on the fly from candles_1s."""
    return _TF_TABLES.get(int(timeframe_seconds))


def _table_schema(table_name):
    return (
        f"CREATE TABLE IF NOT EXISTS {table_name} ("
        "    bucket_start_ms INTEGER PRIMARY KEY,"
        "    open       REAL NOT NULL,"
        "    high       REAL NOT NULL,"
        "    low        REAL NOT NULL,"
        "    close      REAL NOT NULL,"
        "    tick_count INTEGER NOT NULL"
        ")"
    )


def ensure_schema(conn):
    # v34: one table per directly-cached timeframe (candles_1s, candles_5s,
    # candles_15s), all with the identical shape candles_1s already had.
    for table_name in _TF_TABLES.values():
        conn.execute(_table_schema(table_name))


def _last_cached_bucket_start_ms(conn, table_name="candles_1s"):
    row = conn.execute(f"SELECT MAX(bucket_start_ms) FROM {table_name}").fetchone()
    return row[0] if row and row[0] is not None else None


def _last_close_before(conn, before_bucket_start_ms=None, table_name="candles_1s"):
    """Close of the last candle strictly before ``before_bucket_start_ms``
    (or the very last candle in the table when None). Used to seed
    open-continuity (Open[n] == Close[n-1]) whenever we resume building
    candles - on every live tail-refresh() and on every bounded
    refresh_range() backfill - so continuity holds across calls, not just
    within a single batch of fresh ticks. One indexed lookup (PRIMARY KEY
    on bucket_start_ms), negligible cost."""
    if before_bucket_start_ms is None:
        row = conn.execute(
            f"SELECT close FROM {table_name} ORDER BY bucket_start_ms DESC LIMIT 1"
        ).fetchone()
    else:
        row = conn.execute(
            f"SELECT close FROM {table_name} WHERE bucket_start_ms < ? "
            "ORDER BY bucket_start_ms DESC LIMIT 1",
            (before_bucket_start_ms,),
        ).fetchone()
    return row[0] if row is not None else None


def get_last_cached_bucket_start_ms(conn):
    """Public wrapper around _last_cached_bucket_start_ms(), for callers
    outside this module (e.g. ChartBridge) that need to know how far the
    candles_1s cache currently reaches without duplicating the query.

    Deliberately always about candles_1s specifically (not a derived
    table): callers use this to judge how fresh/caught-up the underlying
    per-second cache is, which is exactly what governs when every derived
    table (5s/15s/1m/5m/15m/1h, all built from it in refresh(), below)
    can be trusted too."""
    return _last_cached_bucket_start_ms(conn, "candles_1s")


def get_last_close_before(conn, before_bucket_start_ms=None, table_name="candles_1s"):
    """Public wrapper around _last_close_before(), for callers outside this
    module (e.g. sync_process.py's push_live_tick) that need the correct
    open-continuity seed for a candle rebuild that only covers a bounded
    recent tail instead of the full table.

    v55 Update 1: without this, a tail-bounded rebuild (see
    candle_aggregator.build_candle_set()'s ``prev_close`` parameter) has no
    way to know the true Close that came before its window and falls back
    to seeding Open from whatever tick happens to be first inside that
    window - which drifts every time the window's left edge lands at a
    different point, rather than reflecting the real previous candle."""
    return _last_close_before(conn, before_bucket_start_ms, table_name)


def get_first_cached_bucket_start_ms(conn):
    """Return the earliest raw cached 1-second bucket, or None when empty."""
    row = conn.execute("SELECT MIN(bucket_start_ms) FROM candles_1s").fetchone()
    return row[0] if row and row[0] is not None else None


def align_down_ms(ms_value, bucket_ms):
    """Public wrapper around _align_down(), for callers outside this
    module that need to align a millisecond timestamp down to a bucket
    boundary the same way the cache itself does."""
    return _align_down(ms_value, bucket_ms)


def _refresh_derived_table(conn, timeframe_seconds, fresh_1s_candles):
    """Rebuild the tail of one dedicated timeframe table (candles_5s,
    candles_15s, ...) that could have changed because of the just-inserted
    ``fresh_1s_candles``.

    Rebuilding only the *tail* (not touching anything older) is what keeps
    this cheap on every incremental refresh: we start from the aligned-down
    boundary of the tf-bucket that the earliest fresh 1s candle falls into
    - the one tf-bucket that could have been left incomplete by a previous
    refresh - and re-merge everything in candles_1s from that boundary
    onward (old rows already committed earlier + the fresh rows from this
    same transaction; SQLite sees both from the same connection before
    COMMIT). INSERT OR REPLACE then overwrites any previously-stored
    partial bucket with its now-complete version, exactly like candles_1s
    already does for its own rows - no change to the merge_candles()
    aggregation logic itself, only to where its output is stored.
    """
    if not fresh_1s_candles:
        return 0

    table_name = _TF_TABLES[timeframe_seconds]
    bucket_ms = timeframe_seconds * 1000
    boundary_ms = _align_down(fresh_1s_candles[0].bucket_start_ms, bucket_ms)

    base = load_cached_1s_candles(conn, time_from_ms=boundary_ms)
    derived_candles = merge_candles(base, base_bucket_ms=1000, factor=timeframe_seconds)
    if not derived_candles:
        return 0

    conn.executemany(
        f"INSERT OR REPLACE INTO {table_name} ({_TABLE_COLUMNS}) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            (c.bucket_start_ms, c.open, c.high, c.low, c.close, c.tick_count)
            for c in derived_candles
        ),
    )
    return len(derived_candles)


def _write_1s_and_derived(conn, fresh_1s_candles):
    """Write an already-aggregated 1s candle stream and rebuild derived tails.

    The input is deliberately candle state, not raw ticks. This is the core
    v61 storage boundary: SQLite only sees 1-second-and-higher candles.
    """
    if not fresh_1s_candles:
        return 0

    conn.execute("BEGIN")
    try:
        conn.executemany(
            f"INSERT OR REPLACE INTO candles_1s ({_TABLE_COLUMNS}) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                (c.bucket_start_ms, c.open, c.high, c.low, c.close, c.tick_count)
                for c in fresh_1s_candles
            ),
        )

        for tf in _TF_TABLES:
            if tf == 1:
                continue
            _refresh_derived_table(conn, tf, fresh_1s_candles)

        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    return len(fresh_1s_candles)


def refresh_from_candles(conn, fresh_1s_candles, logger=None):
    """Persist freshly aggregated 1-second candles; never reads raw ticks."""
    ensure_schema(conn)
    t0 = time.monotonic()
    count = _write_1s_and_derived(conn, fresh_1s_candles)
    if logger is not None and count:
        elapsed = time.monotonic() - t0
        logger.info(
            f"Candle cache: persisted {count:,} 1s candle(s) in {elapsed:.2f}s",
            extra={"category": "DATABASE"},
        )
    return count


def refresh_from_tick_arrays(conn, time_msc_values, bid_values, prev_close=None, logger=None):
    """Convert one in-memory MT5 batch to candles and persist only the candles."""
    if time_msc_values is None or len(time_msc_values) == 0:
        return 0
    ticks = zip(time_msc_values, bid_values)
    candles = ticks_to_candles(ticks, bucket_ms=1000, prev_close=prev_close)
    return refresh_from_candles(conn, candles, logger=logger)


def refresh(conn, logger=None):
    """Compatibility wrapper for legacy callers.

    v61 removes the raw-tick table, so normal refresh has nothing to scan.
    Live synchronization supplies candle state explicitly through
    refresh_from_candles(). Keeping this no-op wrapper makes older embedder
    code harmless while avoiding any hidden disk scan or tick persistence.
    """
    ensure_schema(conn)
    return 0

def _load_candles_from_table(conn, table_name, time_from_ms=None, time_to_ms=None):
    """Read already-built candles straight from ``table_name`` (no raw
    ticks and no merge_candles() involved), ascending by bucket_start_ms."""
    if time_from_ms is not None and time_to_ms is not None:
        cur = conn.execute(
            f"SELECT {_TABLE_COLUMNS} FROM {table_name} "
            "WHERE bucket_start_ms BETWEEN ? AND ? ORDER BY bucket_start_ms ASC",
            (time_from_ms, time_to_ms),
        )
    elif time_from_ms is not None:
        cur = conn.execute(
            f"SELECT {_TABLE_COLUMNS} FROM {table_name} "
            "WHERE bucket_start_ms >= ? ORDER BY bucket_start_ms ASC",
            (time_from_ms,),
        )
    elif time_to_ms is not None:
        cur = conn.execute(
            f"SELECT {_TABLE_COLUMNS} FROM {table_name} "
            "WHERE bucket_start_ms <= ? ORDER BY bucket_start_ms ASC",
            (time_to_ms,),
        )
    else:
        cur = conn.execute(
            f"SELECT {_TABLE_COLUMNS} FROM {table_name} ORDER BY bucket_start_ms ASC"
        )
    return [Candle(*row) for row in cur]


def load_cached_1s_candles(conn, time_from_ms=None, time_to_ms=None):
    """
    Read already-built 1-second candles straight from the cache table
    (no raw ticks touched at all), ascending by bucket_start_ms.
    """
    return _load_candles_from_table(conn, "candles_1s", time_from_ms, time_to_ms)


def build_candle_set_from_cache(conn, timeframe_seconds_list, time_from_ms=None, time_to_ms=None):

    result = {}
    for tf in sorted(set(int(t) for t in timeframe_seconds_list)):
        if tf < 1:
            raise ValueError("timeframe_seconds must be a positive whole number of seconds")
        table_name = _direct_table(tf)
        if table_name is not None:
            # v34: 1s/5s/15s all have their own table now - read it
            # directly, same as candles_1s always did.
            result[tf] = _load_candles_from_table(conn, table_name, time_from_ms, time_to_ms)
        else:
            base_candles = load_cached_1s_candles(conn, time_from_ms, time_to_ms)
            result[tf] = merge_candles(base_candles, base_bucket_ms=1000, factor=tf)
    return result


def build_candles_from_cache(conn, timeframe_seconds, time_from_ms=None, time_to_ms=None):
    """Single-timeframe convenience wrapper around build_candle_set_from_cache()."""
    timeframe_seconds = int(timeframe_seconds)
    return build_candle_set_from_cache(conn, [timeframe_seconds], time_from_ms, time_to_ms)[timeframe_seconds]


def _align_down(ms_value, bucket_ms):
    if ms_value <= 0:
        return 0
    return (ms_value // bucket_ms) * bucket_ms


def has_direct_table(timeframe_seconds):
    """Public wrapper around _direct_table(): True when ``timeframe_seconds``
    has its own dedicated cache table (see _TF_TABLES) that can be read
    straight from disk, instead of always being re-derived from candles_1s.

    v57 Update 1: pulled out of build_recent_candles_from_cache() so
    chart_bridge.py's _build_recent_hybrid() can make the same
    direct-table-vs-1s-merge decision that every other read path in this
    module already makes (see that function's v57 note for why it
    previously never did).
    """
    return _direct_table(int(timeframe_seconds)) is not None


def load_cached_candles_direct(conn, timeframe_seconds, time_from_ms=None, time_to_ms=None):
    """Read a bounded range straight from ``timeframe_seconds``'s own
    dedicated table (candles_5s, candles_1h, ...) - no 1-second rows
    touched, no Python-side merge_candles() call. Returns None if this
    timeframe has no dedicated table (caller must fall back to loading
    candles_1s + merge_candles() instead, same as every other call site in
    this module already does)."""
    table_name = _direct_table(int(timeframe_seconds))
    if table_name is None:
        return None
    return _load_candles_from_table(conn, table_name, time_from_ms, time_to_ms)


def build_recent_candles_from_cache(conn, timeframe_seconds, limit):
    """Return the newest ``limit`` output candles.

    V64.2: bounded by the NUMBER of output candles, exactly like the history
    page builders, and no longer by a wall-clock window of ``limit`` buckets.
    A wall-clock window returns fewer than ``limit`` candles whenever the
    market had a closure inside it (Gold: the daily 1h break, the weekend),
    so the resident live slot came out shorter than a history page and the
    Sliding Window geometry no longer matched. It is also cheaper: the direct
    tables are read with one indexed ``ORDER BY ... DESC LIMIT`` instead of
    loading a time span and trimming it in Python.
    """
    timeframe_seconds = int(timeframe_seconds)
    if timeframe_seconds < 1:
        raise ValueError("timeframe_seconds must be a positive whole number of seconds")
    limit = max(1, int(limit))
    bucket_ms = timeframe_seconds * 1000
    table_name = _direct_table(timeframe_seconds)

    if table_name is not None:
        cur = conn.execute(
            f"SELECT {_TABLE_COLUMNS} FROM {table_name} "
            "ORDER BY bucket_start_ms DESC LIMIT ?",
            (limit,),
        )
        return [Candle(*row) for row in reversed(cur.fetchall())]

    last_bucket = _last_cached_bucket_start_ms(conn, "candles_1s")
    if last_bucket is None:
        return []
    # Everything up to and including the newest bucket: the page builder
    # (strictly-before) with an upper bound one bucket past the newest 1s row.
    return build_candles_page_from_cache(
        conn, timeframe_seconds, last_bucket + bucket_ms, limit
    )


def count_candles_in_cache(conn, timeframe_seconds):
    """Count non-empty output candles without materializing candle data."""
    timeframe_seconds = int(timeframe_seconds)
    if timeframe_seconds < 1:
        raise ValueError("timeframe_seconds must be a positive whole number of seconds")
    table_name = _direct_table(timeframe_seconds)
    if table_name is not None:
        row = conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
    else:
        bucket_ms = timeframe_seconds * 1000
        row = conn.execute(
            "SELECT COUNT(DISTINCT (bucket_start_ms / ?)) FROM candles_1s",
            (bucket_ms,),
        ).fetchone()
    return int(row[0] or 0)


def build_oldest_candles_from_cache(conn, timeframe_seconds, limit):
    """Build the first bounded candle page from the beginning of the cache."""
    timeframe_seconds = int(timeframe_seconds)
    limit = max(1, int(limit))
    if timeframe_seconds < 1:
        raise ValueError("timeframe_seconds must be a positive whole number of seconds")

    table_name = _direct_table(timeframe_seconds)
    if table_name is not None:
        cur = conn.execute(
            f"SELECT {_TABLE_COLUMNS} FROM {table_name} "
            "ORDER BY bucket_start_ms ASC LIMIT ?",
            (limit,),
        )
        return [Candle(*row) for row in cur]

    bucket_ms = timeframe_seconds * 1000
    keys = conn.execute(
        "SELECT (bucket_start_ms / ?) AS bucket_id "
        "FROM candles_1s GROUP BY bucket_id ORDER BY bucket_id ASC LIMIT ?",
        (bucket_ms, limit),
    ).fetchall()
    if not keys:
        return []

    first_bucket_ms = int(keys[0][0]) * bucket_ms
    last_bucket_ms = (int(keys[-1][0]) + 1) * bucket_ms - 1
    base = load_cached_1s_candles(
        conn, time_from_ms=first_bucket_ms, time_to_ms=last_bucket_ms
    )
    candles = merge_candles(base, base_bucket_ms=1000, factor=timeframe_seconds)
    return candles[:limit]


def build_candles_page_after_from_cache(conn, timeframe_seconds, after_time_ms, limit):
    """Build one bounded page strictly after ``after_time_ms``.

    The page is bounded by the number of *output* candles, not by a fixed
    wall-clock span. This distinction matters when the cache contains gaps:
    a sparse market can otherwise make a valid middle page look prematurely
    exhausted simply because fewer than ``limit`` buckets exist in the first
    time slice we happened to inspect.
    """
    timeframe_seconds = int(timeframe_seconds)
    if timeframe_seconds < 1:
        raise ValueError("timeframe_seconds must be a positive whole number of seconds")
    limit = max(1, int(limit))
    after_time_ms = int(after_time_ms)

    bucket_ms = timeframe_seconds * 1000
    table_name = _direct_table(timeframe_seconds)
    if table_name is not None:
        cur = conn.execute(
            f"SELECT {_TABLE_COLUMNS} FROM {table_name} "
            "WHERE bucket_start_ms > ? "
            "ORDER BY bucket_start_ms ASC LIMIT ?",
            (after_time_ms, limit),
        )
        return [Candle(*row) for row in cur]

    # For aggregated timeframes with no dedicated table, select the first
    # `limit` non-empty output buckets directly. Using a candle-count limit
    # on the 1s rows is not sufficient when large gaps exist between
    # available seconds.
    start_bucket_id = after_time_ms // bucket_ms
    keys = conn.execute(
        "SELECT (bucket_start_ms / ?) AS bucket_id "
        "FROM candles_1s "
        "WHERE bucket_start_ms >= ? "
        "GROUP BY bucket_id "
        "ORDER BY bucket_id ASC LIMIT ?",
        (bucket_ms, (start_bucket_id + 1) * bucket_ms, limit),
    ).fetchall()
    if not keys:
        return []

    first_bucket_id = int(keys[0][0])
    last_bucket_id = int(keys[-1][0])
    first_bucket_ms = first_bucket_id * bucket_ms
    last_bucket_end_ms = (last_bucket_id + 1) * bucket_ms - 1
    base = load_cached_1s_candles(
        conn, time_from_ms=first_bucket_ms, time_to_ms=last_bucket_end_ms
    )
    candles = merge_candles(base, base_bucket_ms=1000, factor=timeframe_seconds)
    candles = [c for c in candles if c.bucket_start_ms > after_time_ms]
    if len(candles) > limit:
        candles = candles[:limit]
    return candles


def build_candle_window_from_cache(conn, timeframe_seconds, target_time_ms, before_limit, after_limit):
    """Build a bounded two-sided window around the candle at/just before target.

    The returned ``before`` page includes the resolved target candle as its
    last item, while ``after`` contains strictly newer candles. Both sides are
    bounded by output-candle count, so gaps in the cache never force a wide
    wall-clock scan.
    """
    timeframe_seconds = int(timeframe_seconds)
    if timeframe_seconds < 1:
        raise ValueError("timeframe_seconds must be a positive whole number of seconds")
    before_limit = max(1, int(before_limit))
    after_limit = max(0, int(after_limit))
    target_time_ms = int(target_time_ms)

    bucket_ms = timeframe_seconds * 1000
    target_bucket_ms = _align_down(target_time_ms, bucket_ms)
    table_name = _direct_table(timeframe_seconds)

    if table_name is not None:
        row = conn.execute(
            f"SELECT {_TABLE_COLUMNS} FROM {table_name} WHERE bucket_start_ms <= ? "
            "ORDER BY bucket_start_ms DESC LIMIT 1",
            (target_bucket_ms,),
        ).fetchone()
        if row is None:
            row = conn.execute(
                f"SELECT {_TABLE_COLUMNS} FROM {table_name} "
                "ORDER BY bucket_start_ms ASC LIMIT 1"
            ).fetchone()
            if row is None:
                return {"before": [], "after": [], "target_time": None}

        target_ms = int(row[0])
        before_rows = conn.execute(
            f"SELECT {_TABLE_COLUMNS} FROM {table_name} WHERE bucket_start_ms <= ? "
            "ORDER BY bucket_start_ms DESC LIMIT ?",
            (target_ms, before_limit),
        ).fetchall()
        before_rows.reverse()
        after_rows = []
        if after_limit:
            after_rows = conn.execute(
                f"SELECT {_TABLE_COLUMNS} FROM {table_name} WHERE bucket_start_ms > ? "
                "ORDER BY bucket_start_ms ASC LIMIT ?",
                (target_ms, after_limit),
            ).fetchall()
        return {
            "before": [Candle(*row) for row in before_rows],
            "after": [Candle(*row) for row in after_rows],
            "target_time": target_ms,
        }
    else:
        target_bucket_id = target_bucket_ms // bucket_ms
        row = conn.execute(
            "SELECT (bucket_start_ms / ?) AS bucket_id "
            "FROM candles_1s WHERE (bucket_start_ms / ?) <= ? "
            "GROUP BY bucket_id ORDER BY bucket_id DESC LIMIT 1",
            (bucket_ms, bucket_ms, target_bucket_id),
        ).fetchone()
        if row is None:
            row = conn.execute(
                "SELECT (bucket_start_ms / ?) AS bucket_id "
                "FROM candles_1s GROUP BY bucket_id ORDER BY bucket_id ASC LIMIT 1",
                (bucket_ms,),
            ).fetchone()
            if row is None:
                return {"before": [], "after": [], "target_time": None}

        target_bucket_id = int(row[0])
        target_ms = target_bucket_id * bucket_ms

        before_keys = conn.execute(
            "SELECT (bucket_start_ms / ?) AS bucket_id "
            "FROM candles_1s WHERE (bucket_start_ms / ?) <= ? "
            "GROUP BY bucket_id ORDER BY bucket_id DESC LIMIT ?",
            (bucket_ms, bucket_ms, target_bucket_id, before_limit),
        ).fetchall()
        before_keys = [int(r[0]) for r in reversed(before_keys)]

        after_keys = []
        if after_limit:
            after_rows_raw = conn.execute(
                "SELECT (bucket_start_ms / ?) AS bucket_id "
                "FROM candles_1s WHERE (bucket_start_ms / ?) > ? "
                "GROUP BY bucket_id ORDER BY bucket_id ASC LIMIT ?",
                (bucket_ms, bucket_ms, target_bucket_id, after_limit),
            ).fetchall()
            after_keys = [int(r[0]) for r in after_rows_raw]

        if not before_keys:
            return {"before": [], "after": [], "target_time": None}

        first_bucket_ms = before_keys[0] * bucket_ms
        last_bucket_ms = (before_keys[-1] + 1) * bucket_ms - 1
        base_before = load_cached_1s_candles(
            conn, time_from_ms=first_bucket_ms, time_to_ms=last_bucket_ms
        )
        before_candles = merge_candles(base_before, base_bucket_ms=1000, factor=timeframe_seconds)
        before_candles = [c for c in before_candles if c.bucket_start_ms <= target_ms]
        if len(before_candles) > before_limit:
            before_candles = before_candles[-before_limit:]

        after_candles = []
        if after_keys:
            first_after_ms = after_keys[0] * bucket_ms
            last_after_ms = (after_keys[-1] + 1) * bucket_ms - 1
            base_after = load_cached_1s_candles(
                conn, time_from_ms=first_after_ms, time_to_ms=last_after_ms
            )
            after_candles = merge_candles(base_after, base_bucket_ms=1000, factor=timeframe_seconds)
            after_candles = [c for c in after_candles if c.bucket_start_ms > target_ms]
            if len(after_candles) > after_limit:
                after_candles = after_candles[:after_limit]

        return {
            "before": before_candles,
            "after": after_candles,
            "target_time": target_ms,
        }


def get_daily_candle_counts(conn, timeframe_seconds, year, month):
    """Return a list of per-day candle counts for one calendar month (UTC),
    one entry per day of that month in order, for the dedicated table of
    ``timeframe_seconds`` (see _TF_TABLES) — used by the Market Data
    Overview modal's per-day histogram (v38.1).

    Each day's count is simply how many of that timeframe's own candle
    rows fall inside the day's UTC millisecond range — a plain indexed
    COUNT(*) BETWEEN query against the already-materialized table, not a
    re-aggregation, so this stays cheap even for a whole month at once.

    v41 perf note: V41-Optimization_Ideas_2.md proposed collapsing this
    into one GROUP BY query over a computed day-index expression. Measured
    against this schema (bucket_start_ms INTEGER PRIMARY KEY, WAL mode, on
    disk) that rewrite was actually SLOWER, not faster: 31 small BETWEEN
    range scans each hit the PRIMARY KEY index directly and return fast,
    while the GROUP BY version has to evaluate an expression per row and
    can no longer use that index the same way, so it scans the whole
    month's rows unconditionally. Benchmarked here at roughly 4x slower
    than the original loop, the reverse of the doc's synthetic result — so
    the per-day loop is kept as-is.
    """
    import calendar
    from datetime import datetime, timezone

    timeframe_seconds = int(timeframe_seconds)
    table_name = _TF_TABLES.get(timeframe_seconds)
    if table_name is None:
        return []

    year = int(year)
    month = int(month)
    days_in_month = calendar.monthrange(year, month)[1]

    counts = []
    for day in range(1, days_in_month + 1):
        day_start_ms = int(datetime(year, month, day, tzinfo=timezone.utc).timestamp() * 1000)
        day_end_ms = day_start_ms + 24 * 3600 * 1000 - 1
        row = conn.execute(
            f"SELECT COUNT(*) FROM {table_name} WHERE bucket_start_ms BETWEEN ? AND ?",
            (day_start_ms, day_end_ms),
        ).fetchone()
        counts.append(row[0] if row else 0)
    return counts




def get_history_bounds_from_cache(conn, timeframe_seconds):
    """Return the true available output-candle time range, in whole output
    seconds, for ``timeframe_seconds``.

    v34: for a directly-cached timeframe (1s/5s/15s) this is now a plain
    MIN/MAX over that table's own bucket_start_ms - no division/grouping
    needed, since every row already sits on a tf-aligned boundary. Falls
    back to the original bucket_start_ms/bucket_ms grouping against
    candles_1s for any timeframe without its own table.
    """
    timeframe_seconds = int(timeframe_seconds)
    table_name = _direct_table(timeframe_seconds)
    if table_name is not None:
        row = conn.execute(
            f"SELECT MIN(bucket_start_ms), MAX(bucket_start_ms) FROM {table_name}"
        ).fetchone()
        if not row or row[0] is None or row[1] is None:
            return None, None
        return int(row[0]) // 1000, int(row[1]) // 1000

    bucket_ms = timeframe_seconds * 1000
    row = conn.execute(
        "SELECT MIN(bucket_start_ms / ?), MAX(bucket_start_ms / ?) FROM candles_1s",
        (bucket_ms, bucket_ms),
    ).fetchone()
    if not row or row[0] is None or row[1] is None:
        return None, None
    first_ms = int(row[0]) * bucket_ms
    last_ms = int(row[1]) * bucket_ms
    return first_ms // 1000, last_ms // 1000


def build_candles_page_from_cache(conn, timeframe_seconds, before_time_ms, limit):
    """Build one bounded page strictly before ``before_time_ms``.

    Like the forward page builder, this is bounded by the number of output
    candles rather than a fixed wall-clock interval, so gaps do not produce
    unnecessarily short history pages.
    """
    timeframe_seconds = int(timeframe_seconds)
    if timeframe_seconds < 1:
        raise ValueError("timeframe_seconds must be a positive whole number of seconds")
    limit = max(1, int(limit))
    before_time_ms = int(before_time_ms)

    bucket_ms = timeframe_seconds * 1000
    table_name = _direct_table(timeframe_seconds)
    if table_name is not None:
        cur = conn.execute(
            f"SELECT {_TABLE_COLUMNS} FROM {table_name} WHERE bucket_start_ms < ? "
            "ORDER BY bucket_start_ms DESC LIMIT ?",
            (before_time_ms, limit),
        )
        return [Candle(*row) for row in reversed(cur.fetchall())]

    last_bucket_id = (before_time_ms - 1) // bucket_ms
    if last_bucket_id < 0:
        return []

    keys = conn.execute(
        "SELECT (bucket_start_ms / ?) AS bucket_id "
        "FROM candles_1s "
        "WHERE bucket_start_ms <= ? "
        "GROUP BY bucket_id "
        "ORDER BY bucket_id DESC LIMIT ?",
        (bucket_ms, (last_bucket_id + 1) * bucket_ms - 1, limit),
    ).fetchall()
    if not keys:
        return []

    first_bucket_id = int(keys[-1][0])
    last_bucket_id = int(keys[0][0])
    first_bucket_ms = first_bucket_id * bucket_ms
    last_bucket_end_ms = (last_bucket_id + 1) * bucket_ms - 1
    base = load_cached_1s_candles(
        conn, time_from_ms=first_bucket_ms, time_to_ms=last_bucket_end_ms
    )
    candles = merge_candles(base, base_bucket_ms=1000, factor=timeframe_seconds)
    candles = [c for c in candles if c.bucket_start_ms < before_time_ms]
    candles.sort(key=lambda c: c.bucket_start_ms)
    if len(candles) > limit:
        candles = candles[-limit:]
    return candles


# =============================================================================
# v44: Backfill support for the Market Data Overview panel.
#
# Two pieces live here (kept alongside the rest of the cache logic since
# both work directly against candles_1s / the dedicated timeframe tables):
#
#   - find_missing_ranges(): given one calendar day, finds the actual
#     sub-ranges of that day with a tick-data hole, instead of treating the
#     whole day as "missing". This is what lets the caller ask MT5 for only
#     the gap(s), not the full 24h.
#
#   - refresh_range(): a BOUNDED counterpart to refresh() above. refresh()
#     is tail-only (it always walks forward from the current end of
#     candles_1s), which is correct for live sync but wrong for patching an
#     old day - _refresh_derived_table() (used by refresh()) rebuilds a
#     derived table's tail from its boundary all the way to whatever is
#     currently the newest 1s candle, which for a months-old gap would mean
#     re-reading and re-writing everything between that old day and now.
#     refresh_range() instead rebuilds only the bounded span it's given -
#     cheap and safe to call for a single historical day no matter how old.
# =============================================================================


def refresh_range_from_tick_arrays(conn, time_from_ms, time_to_ms, time_msc_values, bid_values, logger=None):
    """Convert one fetched MT5 range to candles and persist only candle rows.

    The MT5 NumPy arrays are transient RAM input. Conversion is streamed into
    50k-candle SQLite batches so no second, range-sized Python candle list is
    created.

    v61.5: returns the count of candles that were genuinely NEW (buckets
    that had no row in candles_1s before this call) - not the total number
    of candles written. find_missing_ranges() pads its returned ranges with
    real, already-correct surrounding data (so the exact gap edge is never
    missed), so almost every Backfill re-fetches and re-writes a lot of
    candles that do not actually change. Counting those as "recovered" made
    a day whose only remaining hole is a permanent market closure (no ticks
    will ever exist there) report the same large "Seconds Recovered" number
    on every single click forever, even though nothing on the chart ever
    changes - which read as a bug ("it says something was recovered, but
    nothing fills"). Counting only genuinely-new buckets makes a day with
    no real gap left correctly report 0.

    V62.3: a candle that already existed but is REWRITTEN WITH DIFFERENT VALUES
    (the spike after a filled gap, or a broken chain) is counted as well; a
    candle rewritten with identical values still is not.
    """
    if time_msc_values is None or len(time_msc_values) == 0:
        return 0

    ensure_schema(conn)
    prev_close = _last_close_before(conn, int(time_from_ms), "candles_1s")
    ticks = zip(time_msc_values, bid_values)

    # V62.3: the stored values of the candles that already exist in this range,
    # so a candle that is CORRECTED (e.g. the spike after a filled gap) counts as
    # recovered, while a candle re-written with identical values still does not.
    existing = {
        row[0]: row[1:]
        for row in conn.execute(
            "SELECT bucket_start_ms, open, high, low, close, tick_count FROM candles_1s "
            "WHERE bucket_start_ms BETWEEN ? AND ?",
            (int(time_from_ms), int(time_to_ms)),
        )
    }

    t0 = time.monotonic()
    written = 0
    new_written = 0
    corrected = 0
    conn.execute("BEGIN")
    try:
        pending = []
        for candle in iter_candles(ticks, bucket_ms=1000, prev_close=prev_close):
            pending.append(candle)
            before = existing.get(candle.bucket_start_ms)
            if before is None:
                new_written += 1
            elif before != tuple(candle[1:]):
                corrected += 1
            if len(pending) >= 50_000:
                conn.executemany(
                    f"INSERT OR REPLACE INTO candles_1s ({_TABLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        (c.bucket_start_ms, c.open, c.high, c.low, c.close, c.tick_count)
                        for c in pending
                    ),
                )
                written += len(pending)
                pending.clear()

        if pending:
            conn.executemany(
                f"INSERT OR REPLACE INTO candles_1s ({_TABLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    (c.bucket_start_ms, c.open, c.high, c.low, c.close, c.tick_count)
                    for c in pending
                ),
            )
            written += len(pending)

        for tf in _TF_TABLES:
            if tf == 1:
                continue
            _refresh_derived_table_range(conn, tf, int(time_from_ms), int(time_to_ms))

        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    if logger is not None and written:
        logger.info(
            f"Bounded refresh: {written:,} candle(s) ({new_written:,} new, {corrected:,} corrected) "
            f"{time_from_ms}..{time_to_ms} in {time.monotonic() - t0:.2f}s",
            extra={"category": "DATABASE"},
        )
    return new_written + corrected

def _iter_legacy_tick_candles(conn, batch_size=200_000):
    """Stream the legacy ticks table into continuous 1-second candles."""
    cur = conn.execute("SELECT time_msc, bid FROM ticks ORDER BY time_msc ASC")
    prev_close = None
    current_bucket = None
    o = h = l = c = None
    count = 0

    while True:
        rows = cur.fetchmany(int(batch_size))
        if not rows:
            break
        for time_msc, bid in rows:
            bucket = (int(time_msc) // 1000) * 1000
            bid = float(bid)
            if bucket != current_bucket:
                if current_bucket is not None:
                    candle = _finalize_migrated_candle(current_bucket, o, h, l, c, count, prev_close)
                    prev_close = candle.close
                    yield candle
                current_bucket = bucket
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
        yield _finalize_migrated_candle(current_bucket, o, h, l, c, count, prev_close)


def _finalize_migrated_candle(bucket_start, o, h, l, c, count, prev_close):
    if prev_close is None:
        return Candle(bucket_start, o, h, l, c, count)
    if h < prev_close:
        h = prev_close
    if l > prev_close:
        l = prev_close
    return Candle(bucket_start, prev_close, h, l, c, count)


def migrate_legacy_ticks(conn, logger=None, batch_size=200_000):
    """One-time V60 -> V61 migration.

    Existing V60 files may still contain a permanent ``ticks`` table. If the
    1-second cache already exists, its candle history is retained and the raw
    table is simply removed. If no 1-second history exists, the legacy ticks
    are streamed into candles without loading the whole tick set into RAM,
    then the derived timeframe tables are rebuilt from the compact 1s cache.

    Returns True when a legacy tick table was found and removed.
    """
    if not any(
        row[0] == "ticks"
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ticks'")
    ):
        return False

    # Bootstrap callers normally use a fresh connection, but sqlite3 may still
    # be inside a transaction after schema creation or an earlier caller
    # operation. Migration is a startup boundary, so finish that transaction
    # before issuing explicit bulk transactions / VACUUM.
    if conn.in_transaction:
        conn.commit()

    ensure_schema(conn)
    existing_1s = _last_cached_bucket_start_ms(conn, "candles_1s")
    t0 = time.monotonic()

    if existing_1s is None:
        # Write the compact base cache in batches. We deliberately avoid a
        # giant Python list of candles for large legacy files.
        conn.execute("BEGIN")
        try:
            pending = []
            total = 0
            for candle in _iter_legacy_tick_candles(conn, batch_size=batch_size):
                pending.append(candle)
                if len(pending) >= 50_000:
                    conn.executemany(
                        f"INSERT OR REPLACE INTO candles_1s ({_TABLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)",
                        ((c.bucket_start_ms, c.open, c.high, c.low, c.close, c.tick_count) for c in pending),
                    )
                    total += len(pending)
                    pending.clear()
            if pending:
                conn.executemany(
                    f"INSERT OR REPLACE INTO candles_1s ({_TABLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)",
                    ((c.bucket_start_ms, c.open, c.high, c.low, c.close, c.tick_count) for c in pending),
                )
                total += len(pending)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        # Build each derived table from the now-compact 1s cache. This is
        # still one pass over candles, not over raw ticks.
        base = load_cached_1s_candles(conn)
        try:
            conn.execute("BEGIN")
            for tf, table_name in _TF_TABLES.items():
                if tf == 1:
                    continue
                derived = merge_candles(base, base_bucket_ms=1000, factor=tf)
                conn.execute(f"DELETE FROM {table_name}")
                conn.executemany(
                    f"INSERT INTO {table_name} ({_TABLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)",
                    ((c.bucket_start_ms, c.open, c.high, c.low, c.close, c.tick_count) for c in derived),
                )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        if logger is not None:
            logger.info(
                f"Legacy migration: converted {total:,} tick-second(s) to candles in {time.monotonic() - t0:.2f}s",
                extra={"category": "DATABASE"},
            )

    conn.execute("DROP TABLE ticks")
    try:
        conn.execute("VACUUM")
    except Exception as e:
        if logger is not None:
            logger.debug(f"Legacy tick-table VACUUM skipped: {e}", extra={"category": "DATABASE"})
    if logger is not None:
        logger.info(
            f"Legacy ticks table removed; candle-only storage active ({time.monotonic() - t0:.2f}s total)",
            extra={"category": "DATABASE"},
        )
    return True

def find_missing_ranges(conn, day_start_ms, day_end_ms, merge_gap_ms=55_000, buffer_ms=1_000,
                        max_chain_repairs=50):
    """Find what Backfill must re-read for one UTC day, as a list of
    (from_ms, to_ms) millisecond ranges suitable for handing straight to an
    MT5 copy_ticks_range() call.

    Gaps are found against candles_1s (an existing 1-second candle means
    at least one tick landed in that second; a missing one is a hole).
    Only the intersection with the overall data range already on disk
    (the true first/last cached 1-second bucket) is considered - this
    keeps the function from ever proposing a range before the dataset's
    real start or after its real end (e.g. "right now").

    Gaps separated by less than ``merge_gap_ms`` of already-present data
    are merged into a single range, so a day with many small holes close
    together doesn't turn into dozens of separate MT5 round trips. Each
    final range also gets a small ``buffer_ms`` pad on both sides so the
    exact boundary second is never missed because of an off-by-one.

    V62.3 - the candle AFTER a gap is always rebuilt, also at a day edge.
    Every candle has Open = the Close of the candle before it, so the one
    candle that sits right after a gap was built with the Close from before
    the gap (a spike: Open and High/Low stretched across the jump). Only that
    ONE candle is wrong - the next one opens at this candle's own Close - so
    one more second is all that has to be re-read. V61.3 did this, but the
    lookup was clipped to the selected day: a gap that runs to the end of the
    day (00:59:59 ... 23:59:59, with the live data restarting at 00:00:00 the
    next day) never got its next-day candle rebuilt, and that candle stayed
    a spike after the gap was filled.

    V62.3 - leftover spikes are repaired too. A candle whose Open differs from
    the Close of the candle before it is a broken chain (what an earlier
    Backfill left behind); its own second is re-read. One indexed scan of the
    day, no MT5 call unless something is actually wrong. At most
    ``max_chain_repairs`` such candles per day and call.

    Returns an empty list when there is nothing to repair.
    """
    global_first = get_first_cached_bucket_start_ms(conn)
    global_last = _last_cached_bucket_start_ms(conn, "candles_1s")
    if global_first is None or global_last is None:
        return []

    lo = max(int(day_start_ms), global_first)
    hi = min(int(day_end_ms), global_last)
    if lo > hi:
        return []

    bucket_ms = 1000
    hi_b = (hi // bucket_ms) * bucket_ms  # start of the last whole second of the day
    # One read: the day plus the first candle after it (chain check / post-gap check).
    rows = conn.execute(
        "SELECT bucket_start_ms, open, close FROM candles_1s WHERE bucket_start_ms BETWEEN ? AND ? "
        "ORDER BY bucket_start_ms ASC",
        (lo, hi_b + bucket_ms),
    ).fetchall()
    present = {r[0] for r in rows}
    existing = [r[0] for r in rows if r[0] <= hi_b]

    # Raw gaps: maximal runs of missing seconds within [lo, hi_b].
    raw_gaps = []
    cursor = lo
    for ts in existing:
        if ts > cursor:
            raw_gaps.append((cursor, ts - bucket_ms))
        cursor = max(cursor, ts + bucket_ms)
    if cursor <= hi_b:
        raw_gaps.append((cursor, hi_b))

    ranges = []
    if raw_gaps:
        # Merge gaps that are close together (small island of real data between
        # two holes) so we don't fire off a separate MT5 call for each one.
        merged = [list(raw_gaps[0])]
        for start, end in raw_gaps[1:]:
            if start - merged[-1][1] <= merge_gap_ms:
                merged[-1][1] = end
            else:
                merged.append([start, end])

        # Pad each final range slightly and clip back to the known-data bounds.
        for start, end in merged:
            padded_start = max(global_first, start - buffer_ms)
            # copy_ticks_range() treats the end timestamp as inclusive. A full
            # one-second pad therefore ends at +999ms; +1000ms would include the
            # first millisecond of the next already-present bucket and could turn
            # the overlap candle into a partial replacement.
            padded_end = min(global_last, end + buffer_ms - 1)

            # The candle right after the gap (see the docstring). Never done
            # for the newest (still-forming) bucket, which the live buffer owns.
            next_bucket = end + bucket_ms
            if next_bucket < global_last and next_bucket in present:
                padded_end = next_bucket + bucket_ms - 1
            ranges.append((padded_start, padded_end))

    # Leftover spikes: Open must equal the Close of the candle before it.
    if max_chain_repairs and rows:
        prev_close = _last_close_before(conn, lo, "candles_1s")
        broken = []
        for bucket, o, c in rows:
            if prev_close is not None and abs(o - prev_close) > 1e-9 and bucket < global_last:
                broken.append(bucket)
                if len(broken) >= max_chain_repairs:
                    break
            prev_close = c
        for bucket in broken:
            ranges.append((bucket, bucket + bucket_ms - 1))

    if len(ranges) < 2:
        return ranges

    # Sorted and merged: ranges are written in order, and each one seeds its
    # first Open from the candle already stored before it.
    ranges.sort()
    out = [list(ranges[0])]
    for a, b in ranges[1:]:
        if a <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def _refresh_derived_table_range(conn, timeframe_seconds, time_from_ms, time_to_ms):
    """BOUNDED counterpart to _refresh_derived_table(): rebuilds one
    dedicated timeframe table's rows only across [time_from_ms, time_to_ms]
    (rounded out to that timeframe's own bucket boundaries), never touching
    anything outside that span. Safe to call for an arbitrarily old range
    without reading or rewriting the rows in between it and "now"."""
    table_name = _TF_TABLES[timeframe_seconds]
    bucket_ms = timeframe_seconds * 1000
    boundary_start = _align_down(time_from_ms, bucket_ms)
    boundary_end = _align_down(time_to_ms, bucket_ms) + bucket_ms - 1

    base = load_cached_1s_candles(conn, time_from_ms=boundary_start, time_to_ms=boundary_end)
    derived_candles = merge_candles(base, base_bucket_ms=1000, factor=timeframe_seconds)
    if not derived_candles:
        return 0

    conn.executemany(
        f"INSERT OR REPLACE INTO {table_name} ({_TABLE_COLUMNS}) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            (c.bucket_start_ms, c.open, c.high, c.low, c.close, c.tick_count)
            for c in derived_candles
        ),
    )
    return len(derived_candles)


def refresh_range(conn, time_from_ms, time_to_ms, logger=None):
    """Deprecated raw-tick DB wrapper retained for external embedders.

    V61 no longer has a raw-tick table, so normal code must call
    refresh_range_from_tick_arrays() immediately after an MT5 fetch.
    """
    raise RuntimeError(
        "V61 removed the permanent tick table; use refresh_range_from_tick_arrays() "
        "with the just-fetched MT5 batch instead."
    )
