# -*- coding: utf-8 -*-
"""
Runs entirely inside its own OS process, spawned by app.py.

Why a process and not a thread (like v17/v18 used):
`mt5.initialize()` (and the other MetaTrader5 calls) block on a local
IPC/named-pipe round trip to the terminal, and the compiled MetaTrader5
extension does not release the Python GIL while it waits. A thread still
shares the GIL with the main process/thread, so a slow or failing
connection (observed taking 20-65+ seconds) fully starves the main
thread and delays the pywebview window from appearing until the call
returns. A separate OS process has its own independent GIL, so nothing
it does - however long it blocks - can ever delay the window process.

Communication back to the window process happens two ways:
- Historical/cached candles: both processes read/write the same
  `market-data` SQLite file, which is already opened in WAL mode
  (see tick_store.open_database), so the window's read-only
  ChartBridge connection is safe to use concurrently with this
  process's read-write connection.
- Live candle updates while running: pushed through a
  multiprocessing.Queue (`live_queue`) as plain JSON-able dicts;
  app.py's queue-consumer thread forwards each one to the page via
  window.evaluate_js(), exactly like the old in-process callback did.
"""
import time
import traceback
from datetime import datetime, timedelta, timezone

import candle_aggregator as ca
import candle_cache
import mt5_connector
import symbol_manager
import tick_explorer
import tick_store
from live_candle_buffer import LiveCandleBuffer
from tick_explorer import _msc_to_datetime_utc  # (v46.2) was used below but
# never imported - every Extend request crashed with a NameError on its very
# first day, silently swallowed by sync_ticks_forward's on_idle try/except
# (tick_explorer.py), so Extend appeared to do nothing / behave inconsistently.
from logger_setup import setup_logger, register_sensitive_values, current_log_path
from config import (
    CHART_TIMEFRAMES_SECONDS,
    LIVE_TAIL_LOOKBACK_SECONDS,
    CANDLE_CACHE_REFRESH_INTERVAL_SECONDS,
    MT5_RECONNECT_INTERVAL_SECONDS,
    OUTPUT_DIR,
    SYMBOL_LIST_DIR,
    EXTEND_CONSECUTIVE_EMPTY_LIMIT,
    EXTEND_CHUNK_DAYS,
)


def _candle_dict(c):
    return {
        "time": c.bucket_start_ms // 1000,
        "open": c.open,
        "high": c.high,
        "low": c.low,
        "close": c.close,
    }


def _build_live_tail_candle_set(conn, timeframes, tail_from_ms, live_buffer):
    """Build the live tail from persisted candles plus tiny in-RAM candle state.

    V61 never reads raw ticks from SQLite. The cache supplies the stable
    history and ``live_buffer`` supplies only the still-unflushed 1-second
    buckets. This preserves per-tick responsiveness without repeatedly
    scanning the raw tick history.
    """
    pending = live_buffer.snapshot_candles(tail_from_ms)
    last_cached_ms = candle_cache.get_last_cached_bucket_start_ms(conn)

    if pending:
        base_to_ms = pending[0].bucket_start_ms - 1
    else:
        base_to_ms = last_cached_ms

    base_1s = []
    if base_to_ms is None or base_to_ms >= tail_from_ms:
        base_1s = candle_cache.load_cached_1s_candles(
            conn, time_from_ms=tail_from_ms, time_to_ms=base_to_ms
        )

    combined_1s = base_1s + pending
    if not combined_1s:
        return {}

    result = {}
    for tf in sorted(set(int(t) for t in timeframes)):
        result[tf] = (
            combined_1s if tf == 1
            else ca.merge_candles(combined_1s, base_bucket_ms=1000, factor=tf)
        )
    return result

def _day_bounds_ms(year, month, day):
    """UTC millisecond [start, end] range for one calendar day, inclusive."""
    start = datetime(int(year), int(month), int(day), tzinfo=timezone.utc)
    start_ms = int(start.timestamp() * 1000)
    end_ms = start_ms + 24 * 3600 * 1000 - 1
    return start_ms, end_ms


def _process_backfill_request(mt5, conn, logger, live_queue, cmd, symbol=None):
    """Fetch selected gaps, convert each MT5 batch directly to candles, discard ticks."""
    year = cmd.get("year")
    month = cmd.get("month")
    days = cmd.get("days") or []

    logger.info(f"Backfill requested for {year}-{month:02d}, day(s): {days}")
    try:
        live_queue.put_nowait({"type": "backfill_status", "data": {"state": "processing"}})
    except Exception as e:
        logger.debug(f"live_queue.put_nowait (backfill processing) failed: {e}")

    total_seconds = 0

    def consume_range(time_from_ms, time_to_ms, time_msc_values, bid_values):
        return candle_cache.refresh_range_from_tick_arrays(
            conn, time_from_ms, time_to_ms, time_msc_values, bid_values, logger=logger
        )

    try:
        for day in days:
            day_start_ms, day_end_ms = _day_bounds_ms(year, month, day)
            ranges = candle_cache.find_missing_ranges(conn, day_start_ms, day_end_ms)
            if not ranges:
                logger.info(f"Backfill: day {year}-{month:02d}-{day:02d} has no gap and no broken candle; skipping.")
                continue

            recovered = tick_explorer.backfill_ranges(
                mt5, conn, logger, ranges, on_range=consume_range, symbol=symbol
            )
            total_seconds += recovered
    except Exception:
        logger.error("Backfill: unexpected error while processing the request:")
        for line in traceback.format_exc().splitlines():
            logger.error(f"  {line}")

    logger.info(
        f"Backfill finished for {year}-{month:02d}: {total_seconds:,} one-second candle(s) recovered."
    )
    try:
        live_queue.put_nowait({
            "type": "backfill_status",
            "data": {"state": "done", "recovered": total_seconds},
        })
    except Exception as e:
        logger.debug(f"live_queue.put_nowait (backfill done) failed: {e}")

def _process_extend_request(mt5, conn, logger, live_queue, cmd, symbol=None):
    """(v46, v46.1, v46.2, v57 Update 3) Services one {"type": "extend_request",
    "target_date": "YYYY-MM-DD"} command from the window process: pushes the
    oldest available history back in time, in EXTEND_CHUNK_DAYS-sized
    chunks, from the day just before whatever is currently the oldest
    cached 1-second candle, down to (and including) the requested target
    date.

    Design notes (see the update-4 spec this implements):
      - Walks in descending chronological order (newest of the missing
        span first, oldest last) - EXTEND_CHUNK_DAYS calendar days at a
        time (config.py; 1 restores the original one-day-at-a-time walk),
        one bounded copy_ticks_range() call per chunk, mirroring the
        per-range fetch style already used by backfill_ranges() above
        rather than introducing a second fetch strategy. (v57 Update 3:
        previously always exactly one day per call - see EXTEND_CHUNK_DAYS
        in config.py for why that got expensive at hundreds of days of
        history and why chunking it fixes that without giving up
        progress reporting or per-chunk fault isolation.)
      - NOT a retry-forever loop: each chunk gets at most two quick
        attempts (same as backfill_ranges), then the walk moves on to the
        next (older) day - a single flaky day can never stall the whole
        request.
      - Bounded overall by construction: the day count is fixed the
        moment the request is queued (today's oldest cached day minus the
        target date), so there is no scenario where this keeps running
        indefinitely.
      - Extra safety valve: if EXTEND_CONSECUTIVE_EMPTY_LIMIT consecutive
        chunks come back with zero ticks across the whole chunk (not an
        error - MT5 genuinely has nothing for them), the walk assumes it
        has reached the broker's true history boundary and stops asking
        for the remaining, older span rather than burning one MT5 round
        trip per remaining chunk for data that will never come. Those
        trailing empty days plus every day that was never attempted are
        reported back as "days_unreachable".
      - (v46.1) A cold `copy_ticks_range()` call for a date range the MT5
        terminal has not already cached locally can itself take a long
        time per call (the terminal has to fetch that history from the
        broker first - the same kind of delay documented for
        mt5.initialize() at the top of this file) - a handful of such
        days in a row can look, from the UI, exactly like the request is
        stuck even though it's working exactly as designed. Two things
        address that instead of trying to make the individual MT5 call
        itself faster (which this process does not control):
          1. After EVERY day (successful, empty, or failed) an
             {"type": "extend_status", "data": {"state": "progress", ...}}
             message is pushed with the running day/added counts, so the
             frontend's status line can show real, moving progress
             instead of a single static "Processing..." for the whole
             request.
          2. The candle-cache rebuild for a day that added ticks now
             happens for THAT DAY immediately (via the existing bounded
             refresh_range(), same as _process_backfill_request already
             does per day above) instead of being deferred to one big
             rebuild at the very end. "Oldest Data Available" and the
             per-day histogram therefore advance while Extend is still
             running, rather than only jumping once at the very end -
             each single-day refresh_range() call stays just as cheap as
             Backfill's already-proven per-day calls, so this does not
             trade away the "fast, bounded resource use" requirement.
      - (v46.2) Fixes a bug introduced in v46.1: this function calls
        `_msc_to_datetime_utc()` (see the module-level import above) but
        that name was never imported into this module - every Extend
        request raised a NameError on the very first day of the walk.
        That exception was silently swallowed by
        tick_explorer.sync_ticks_forward()'s `on_idle` try/except (it only
        logs a warning), so from the user's perspective Extend looked like
        it started, then did nothing, or produced inconsistent partial
        results - depending on what other requests happened to be
        in-flight around the same crash. Fixed by importing
        `_msc_to_datetime_utc` from tick_explorer at module load time.
      - (v46.2) Second, separate fix: the very first run ever (empty
        database) seeds its initial data via
        tick_explorer._first_run_backfill_start(), which starts from
        `now - HISTORY_BACKFILL_MAX_DAYS days` - an arbitrary WALL-CLOCK
        time, not a UTC midnight boundary. That leaves the oldest cached
        calendar day only PARTIALLY filled (e.g. data from 23:00:32 UTC
        onward, nothing before it that same day). The old walk_start
        computation ("the day before the oldest cached day") skipped
        straight past that partial day forever - Extend could push the
        boundary back to any older target date, but the gap at the very
        start of the oldest cached day itself was never revisited, since
        no future Extend call ever walks forward again into a day it
        already considers "cached". Fixed by checking, before the
        backward walk, whether the oldest cached day has such a
        same-day gap (via the same find_missing_ranges/backfill_ranges
        helpers _process_backfill_request already uses) and closing it
        first - independent of, and before, the day-by-day walk further
        back to target_date.
    """
    target_date_str = (cmd.get("target_date") or "").strip()

    try:
        target_dt = datetime.strptime(target_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        logger.warning(f"Extend: ignoring malformed target_date {target_date_str!r}.")
        try:
            live_queue.put_nowait({
                "type": "extend_status",
                "data": {"state": "done", "days_added": 0, "days_unreachable": 0},
            })
        except Exception as e:
            logger.debug(f"live_queue.put_nowait (extend done/malformed) failed: {e}")
        return

    oldest_bucket_ms = candle_cache.get_first_cached_bucket_start_ms(conn)
    if oldest_bucket_ms is None:
        # No cached data at all yet - nothing to anchor "the day before the
        # oldest cached day" to. Extend only ever pushes an existing oldest
        # boundary further back, so there is nothing this request can do.
        logger.info("Extend: no cached candle data yet; nothing to extend from.")
        try:
            live_queue.put_nowait({
                "type": "extend_status",
                "data": {"state": "done", "days_added": 0, "days_unreachable": 0},
            })
        except Exception as e:
            logger.debug(f"live_queue.put_nowait (extend done/empty-cache) failed: {e}")
        return

    oldest_dt = datetime.fromtimestamp(oldest_bucket_ms / 1000.0, tz=timezone.utc)

    # (v46.2) Close out any gap at the START of the oldest cached day
    # itself before walking further back. This matters for the very first
    # Extend a user ever runs against a freshly-seeded database: the
    # initial forward backfill (tick_explorer._first_run_backfill_start())
    # begins at an arbitrary wall-clock cutoff, not a UTC midnight, so the
    # oldest cached calendar day can start mid-day with everything before
    # that missing.
    #
    # find_missing_ranges() is NOT usable here: by design it only looks
    # for gaps *inside* [global_first, global_last] (see its own
    # docstring: "keeps the function from ever proposing a range before
    # the dataset's real start") - and global_first IS this exact seam
    # boundary, so it can never see anything before it as a gap. This is
    # a distinct situation (a hole *before* the earliest known data, not
    # a hole *within* it), so it's handled directly: if oldest_bucket_ms
    # isn't already sitting on its own day's UTC midnight, everything
    # from that midnight up to oldest_bucket_ms is, by definition, an
    # unfetched span - fetch it with the same bounded
    # tick_explorer.backfill_ranges() call the rest of this module
    # already uses, rather than introducing a new fetch strategy.
    oldest_day_start_ms, oldest_day_end_ms = _day_bounds_ms(
        oldest_dt.year, oldest_dt.month, oldest_dt.day
    )
    if oldest_bucket_ms > oldest_day_start_ms:
        seam_ranges = [(oldest_day_start_ms, oldest_bucket_ms - 1)]
        logger.info(
            f"Extend: oldest cached day {oldest_dt.strftime('%Y-%m-%d')} starts mid-day "
            f"({oldest_dt.strftime('%H:%M:%S')} UTC); filling the "
            f"00:00:00..{oldest_dt.strftime('%H:%M:%S')} seam before walking further back."
        )
        try:
            seam_recovered = tick_explorer.backfill_ranges(
                mt5,
                conn,
                logger,
                seam_ranges,
                on_range=lambda from_ms, to_ms, msc, bids: candle_cache.refresh_range_from_tick_arrays(
                    conn, from_ms, to_ms, msc, bids, logger=logger
                ),
                symbol=symbol,
            )
        except Exception as e:
            logger.warning(f"Extend: same-day seam fetch failed for {oldest_dt.strftime('%Y-%m-%d')}: {e}")
            seam_recovered = 0
        if seam_recovered > 0:
            logger.info(
                f"Extend: recovered {seam_recovered:,} one-second candle(s) in the same-day seam."
            )
            # The oldest cached bucket may now be earlier THE SAME DAY (or
            # exactly at its midnight) - re-read it so walk_start below is
            # computed from the true, now-gap-free oldest day, not a stale
            # in-memory value.
            refreshed_oldest_ms = candle_cache.get_first_cached_bucket_start_ms(conn)
            if refreshed_oldest_ms is not None:
                oldest_bucket_ms = refreshed_oldest_ms
                oldest_dt = datetime.fromtimestamp(oldest_bucket_ms / 1000.0, tz=timezone.utc)

    walk_start = datetime(oldest_dt.year, oldest_dt.month, oldest_dt.day, tzinfo=timezone.utc) - timedelta(days=1)

    if walk_start < target_dt:
        # Already at/beyond the requested date (e.g. a Backfill or another
        # Extend already reached it since the user opened the date box).
        logger.info(f"Extend: target {target_date_str} is not older than the current oldest data; nothing to do.")
        try:
            live_queue.put_nowait({
                "type": "extend_status",
                "data": {"state": "done", "days_added": 0, "days_unreachable": 0},
            })
        except Exception as e:
            logger.debug(f"live_queue.put_nowait (extend done/no-op) failed: {e}")
        return

    total_days_requested = (walk_start - target_dt).days + 1
    logger.info(
        f"Extend requested: {total_days_requested} day(s), from "
        f"{walk_start.strftime('%Y-%m-%d')} back to {target_date_str}."
    )

    try:
        live_queue.put_nowait({
            "type": "extend_status",
            "data": {"state": "processing", "days_total": total_days_requested},
        })
    except Exception as e:
        logger.debug(f"live_queue.put_nowait (extend processing) failed: {e}")

    days_added = 0
    days_processed = 0
    consecutive_empty = 0
    stopped_early = False
    # (v57 Update 3) Oldest day reached by the most recent chunk that
    # actually added at least one tick - None until the first such chunk.
    # Used only to compute days_unreachable below if the walk stops early.
    last_success_oldest_dt = None

    chunk_days = max(1, int(EXTEND_CHUNK_DAYS))

    cursor_dt = walk_start
    while cursor_dt >= target_dt:
        # (v57 Update 3) Walk in EXTEND_CHUNK_DAYS-sized chunks instead of
        # one calendar day at a time: `cursor_dt` is the newest day of this
        # chunk, `chunk_oldest_dt` its oldest (clamped so the very last
        # chunk never overshoots past target_dt). One copy_ticks_range()
        # call and one refresh_range() transaction now covers the whole
        # chunk, cutting MT5 round trips and SQLite transactions by
        # roughly chunk_days-fold versus the old one-day-at-a-time walk.
        chunk_oldest_dt = max(target_dt, cursor_dt - timedelta(days=chunk_days - 1))
        chunk_day_count = (cursor_dt - chunk_oldest_dt).days + 1

        chunk_start_ms, _ = _day_bounds_ms(chunk_oldest_dt.year, chunk_oldest_dt.month, chunk_oldest_dt.day)
        _, chunk_end_ms = _day_bounds_ms(cursor_dt.year, cursor_dt.month, cursor_dt.day)
        from_dt = _msc_to_datetime_utc(chunk_start_ms)
        to_dt = _msc_to_datetime_utc(chunk_end_ms)

        chunk_label = (
            chunk_oldest_dt.strftime("%Y-%m-%d") if chunk_day_count == 1
            else f"{chunk_oldest_dt.strftime('%Y-%m-%d')}..{cursor_dt.strftime('%Y-%m-%d')}"
        )

        ticks = None
        for attempt in range(2):  # one retry on a transient failure, same as backfill_ranges
            try:
                ticks = mt5.copy_ticks_range(symbol, from_dt, to_dt, mt5.COPY_TICKS_ALL)
            except Exception as e:
                logger.warning(
                    f"Extend: copy_ticks_range failed for {chunk_label} "
                    f"(attempt {attempt + 1}/2): {e}"
                )
                ticks = None
            if ticks is not None:
                break
            time.sleep(0.5)

        got_ticks = ticks is not None and len(ticks) > 0
        if got_ticks:
            recovered_seconds = candle_cache.refresh_range_from_tick_arrays(
                conn, chunk_start_ms, chunk_end_ms, ticks["time_msc"], ticks["bid"], logger=logger
            )
            if recovered_seconds > 0:
                days_added += chunk_day_count
                last_success_oldest_dt = chunk_oldest_dt
            consecutive_empty = 0
            del ticks
        else:
            consecutive_empty += 1

        days_processed += chunk_day_count
        try:
            live_queue.put_nowait({
                "type": "extend_status",
                "data": {
                    "state": "progress",
                    "days_total": total_days_requested,
                    "days_processed": days_processed,
                    "days_added": days_added,
                    "current_date": chunk_oldest_dt.strftime("%Y-%m-%d"),
                },
            })
        except Exception as e:
            logger.debug(f"live_queue.put_nowait (extend progress) failed: {e}")

        if consecutive_empty >= EXTEND_CONSECUTIVE_EMPTY_LIMIT:
            logger.info(
                f"Extend: {consecutive_empty} consecutive empty chunk(s) "
                f"({consecutive_empty * chunk_days} day(s) worth) reached at "
                f"{chunk_label}; assuming the broker's history boundary was hit "
                "and stopping instead of walking the remaining span."
            )
            stopped_early = True
            break

        cursor_dt = chunk_oldest_dt - timedelta(days=1)

    if stopped_early:
        # (v57 Update 3) Everything from one day older than the last chunk
        # that actually produced data (or from walk_start, if no chunk
        # ever did) down to target_dt is reported as unreachable - the
        # chunked equivalent of the old day-by-day rollback.
        boundary_dt = (last_success_oldest_dt - timedelta(days=1)) if last_success_oldest_dt else walk_start
        remaining_days = max(0, (boundary_dt - target_dt).days + 1)
    else:
        remaining_days = 0

    logger.info(
        f"Extend finished: {days_added} day(s) added"
        + (f", {remaining_days} day(s) could not be retrieved" if remaining_days else "") + "."
    )
    try:
        live_queue.put_nowait({
            "type": "extend_status",
            "data": {"state": "done", "days_added": days_added, "days_unreachable": remaining_days},
        })
    except Exception as e:
        logger.debug(f"live_queue.put_nowait (extend done) failed: {e}")


def run(db_path, live_queue, stop_event, backfill_cmd_queue=None, symbol=None, expected_server=None, log_lock=None, session_log_queue=None):
    """Entry point executed inside the child process. Must stay picklable-
    argument-friendly: db_path is a str, live_queue/stop_event are
    multiprocessing primitives - no logger or window object is passed in,
    since those cannot cross the process boundary.

    v62: ``expected_server`` is the server the window started with (read
    from disk, never from MT5). This process is the ONLY place that asks
    MT5 who the account really is: it reports the answer back through an
    "identity" message, so the window process never has to call MT5 at all
    (a blocking mt5.initialize() there froze the window for ~65 s).

    V67.3: ``log_lock`` is the shared process lock used by the daily integrated
    logger so the main window, wizard and sync process can append safely to
    the same file without interleaving records."""

    logger, log_filename = setup_logger(file_lock=log_lock, session_log_queue=session_log_queue)
    logger.info("#" * 60)
    logger.info("MT5 sync process started.")
    logger.info(f"Target symbol: {symbol}")
    register_sensitive_values(logger, expected_server)
    logger.info("#" * 60)

    mt5 = None
    conn = None
    # v61.2: created once the DB is open; declared here so the shutdown path
    # in ``finally`` below can flush it however the run ends.
    live_buffer = None

    # (v25.3) Drives the header's status dot on the frontend. Purely an
    # observer over states the code already computes/reaches on its own
    # (connect retry loop, tick_explorer's error/caught-up branches,
    # backfill-vs-live-edge) - nothing here changes any existing decision.
    # Dedup on the last-sent value keeps this from spamming the queue when
    # nothing has actually changed (e.g. every idle healthy poll).
    status_state = {"current": None}

    def send_status(status):
        if status_state["current"] == status:
            return
        status_state["current"] = status
        try:
            live_queue.put_nowait({"type": "status", "data": status})
        except Exception as e:
            logger.debug(f"live_queue.put_nowait (status) failed: {e}")

    def confirm_identity(candidate):
        """Ask the connected terminal which server this is (v62).

        Returns True when syncing can go on with the database the window
        already opened. Returns False when the account belongs to a
        DIFFERENT server than the window assumed: the app is told via an
        "identity" message and this process parks (MT5 released) until the
        app stops it and starts a fresh one for the right database.
        """
        real_server = mt5_connector.get_server_name(candidate)
        if not real_server:
            return True  # login not finished yet: keep the startup identity
        same = expected_server is None or symbol_manager.same_server(real_server, expected_server)
        had_list = symbol_manager.load_symbol_list(SYMBOL_LIST_DIR, real_server) is not None
        symbols = None
        try:
            symbols = symbol_manager.discover_and_save_symbol_list(candidate, SYMBOL_LIST_DIR, real_server, logger)
        except Exception as e:
            logger.warning(f"Symbol list discovery failed: {e}")
        if same:
            symbol_manager.save_last_session(OUTPUT_DIR, real_server, symbol, logger)
        if same and had_list:
            return True
        payload = {"server": real_server, "symbols": symbols if not had_list else None}
        try:
            live_queue.put_nowait({"type": "identity", "data": payload})
        except Exception as e:
            logger.warning(f"live_queue.put_nowait (identity) failed: {e}")
        return same

    try:
        send_status("offline")  # true by definition until connect() succeeds

        # (v25.2) Keep retrying to connect - instead of giving up after one
        # failed attempt - so a startup with no internet/terminal reachable
        # self-recovers on its own the moment MT5 becomes reachable, rather
        # than requiring the app to be restarted. stop_event.wait() returns
        # immediately once the app requests a shutdown, so this never delays
        # closing the app by the full retry interval.
        while not stop_event.is_set():
            candidate = mt5_connector.connect(logger)

            if candidate is not None and not confirm_identity(candidate):
                logger.info(
                    "The MT5 account belongs to a different broker server than the window "
                    "started with; waiting for the app to switch to the right database."
                )
                mt5_connector.shutdown(candidate, logger)
                stop_event.wait()  # the app stops this process and spawns a new one
                return

            if candidate is not None and not mt5_connector.check_symbol(candidate, symbol, logger):
                logger.error("Symbol is not usable.")
                mt5_connector.shutdown(candidate, logger)
                candidate = None

            if candidate is not None:
                mt5 = candidate
                break

            send_status("offline")
            logger.warning(
                f"Will retry connecting to MT5 in {MT5_RECONNECT_INTERVAL_SECONDS:.0f}s "
                "(the chart window stays usable on cached data meanwhile) ..."
            )
            if stop_event.wait(MT5_RECONNECT_INTERVAL_SECONDS):
                break  # stop was requested while waiting

        if mt5 is None:
            logger.info("Stop requested before a connection was established. Stopping the sync process.")
            return

        conn = tick_store.open_database(db_path, logger)

        try:
            candle_cache.ensure_schema(conn)
        except Exception as e:
            logger.warning(f"Candle cache schema ensure failed: {e}")

        try:
            candle_cache.refresh(conn, logger)
        except Exception as e:
            logger.warning(f"Initial candle cache refresh failed (will retry while running): {e}")

        tail_lookback_ms = int(LIVE_TAIL_LOOKBACK_SECONDS * 1000)

        # v55.2: the rebuild below still reads the whole required current
        # largest-timeframe bucket so the live Open can never drift, but the
        # frontend only needs the newest candle plus the immediately previous
        # one to patch the bounded live slot. Sending the entire rebuild window
        # on every tick caused the inter-process Queue to retain large, mostly
        # redundant payloads whenever the UI consumer briefly lagged. Keeping
        # this transport payload tiny preserves the candle-building logic while
        # removing that memory-growth path. The previous candle is included so
        # the exact bucket-boundary transition remains correct (old live candle
        # can be finalized while the new one is appended).
        #
        # v55.5: this tiny patch is only correct when at most
        # LIVE_PUSH_CANDLES_PER_TF candles, per timeframe, closed since the
        # previous push - true for the ordinary one-tick-at-a-time steady
        # state, but NOT true right after the feed falls behind and catches
        # back up (MT5/internet reconnect, or the terminal handing back a
        # buffered burst): several candles can close in that gap and only
        # the newest two would ever reach the chart, leaving a permanent
        # visual gap until a manual reload. The `last_sent_bucket_ms` check
        # further down detects exactly that situation, per timeframe, and
        # sends a full 'reload' instead of trusting this patch to cover it -
        # LIVE_PUSH_CANDLES_PER_TF itself does not need to grow to fix that.
        LIVE_PUSH_CANDLES_PER_TF = 2

        # (v25) `caught_up` tracks whether *this run* has reached the
        # broker's live edge at least once yet. Until then we're in a
        # (possibly large) backfill: no chart updates are pushed at all -
        # only the candles_1s cache is kept incrementally caught up, one
        # already-bounded MT5 batch (TICKS_BATCH_SIZE) at a time, instead
        # of letting a multi-day gap of raw ticks pile up unprocessed until
        # the first throttled refresh fires. The moment we do reach the
        # live edge, the cache is by definition fully caught up too, so we
        # tell the frontend to simply reload its bounded, cache-backed
        # initial history (see app.py / window.onCacheReady) rather than
        # asking it to gap-fill a potentially huge range from raw ticks.
        cache_state = {"last_refresh_monotonic": 0.0, "caught_up": False}

        # v55.5: per-timeframe bucket_start_ms of the newest candle actually
        # confirmed delivered to the chart (via a "candles" push or a
        # "reload"). Lets push_live_tick() tell a normal single-candle
        # rollover apart from a real gap - see the LIVE_PUSH_CANDLES_PER_TF
        # comment below.
        last_sent_bucket_ms = {}

        # v57 Update 4: memo for the cache-backed part of the live-tail
        # window (see _build_live_tail_candle_set), plus the last candle
        # payload actually pushed, so a tick that leaves every rendered field
        # untouched (same OHLC, only the tick count moved - common in a quiet
        # market, and on every duplicate/stale tick MT5 hands back) doesn't
        # pay for a queue round trip and a window.evaluate_js() call that
        # cannot change a single pixel.
        last_pushed_payload = {"data": None}

        def refresh_cache_now():
            try:
                live_buffer.flush()
            except Exception as e:
                logger.warning(f"candle cache refresh failed: {e}")
            cache_state["last_refresh_monotonic"] = time.monotonic()

        live_buffer = LiveCandleBuffer(conn, logger=logger)

        # V64: live ASK line. The ASK is display-only: it is never aggregated,
        # never stored in SQLite and never enters a candle. Only its newest value
        # crosses to the window, as a tiny {"type": "ask"} message, and only when
        # it differs from the last one sent. It has its own message (instead of
        # riding in the "candles" payload) because an ASK-only quote change leaves
        # every candle untouched, and the v57 "nothing changed" check below would
        # rightly drop that payload.
        ask_state = {"sent": None, "seeded": False}

        def push_live_ask(ask):
            if ask is None or not (ask > 0.0) or ask == ask_state["sent"]:
                return
            ask_state["sent"] = ask
            try:
                live_queue.put_nowait({"type": "ask", "data": ask, "symbol": symbol})
            except Exception as e:
                logger.debug(f"live_queue.put_nowait (ask) failed: {e}")

        def probe_ask():
            # One-off seed for the moments a batch carries no ASK of its own: right
            # after the catch-up ends (or in a closed market that delivers no live
            # tick at all), so the line still appears at the last quoted ASK.
            try:
                tick = mt5.symbol_info_tick(symbol)
                if tick is not None and float(tick.ask) > 0.0:
                    return float(tick.ask)
            except Exception as e:
                logger.debug(f"symbol_info_tick failed: {e}")
            return None

        def push_live_tick(new_msc, new_bid, is_live_edge, ask=None):
            accepted = live_buffer.add(new_msc, new_bid)
            if is_live_edge:
                if ask is None and not ask_state["seeded"]:
                    ask = probe_ask()
                if ask is not None:
                    ask_state["seeded"] = True
                    push_live_ask(ask)
            # v61.3: the final catch-up chunk can legitimately be empty (a
            # closed market right after the history was fetched). It must
            # still reach the "live edge" branch below so the chart gets its
            # first reload; every other empty batch is a no-op as before.
            if accepted <= 0 and not (is_live_edge and not cache_state["caught_up"]):
                return

            if not cache_state["caught_up"]:
                # Still backfilling: refresh after every batch. Each batch
                # is already bounded (TICKS_BATCH_SIZE) and paced by its own
                # MT5 round trip, so this can't turn into a tight loop - it
                # just means the cache never falls more than one batch
                # behind, however large the *overall* gap being backfilled
                # is.
                live_buffer.flush()

                if not is_live_edge:
                    return  # nothing to show the chart yet; keep catching up quietly

                cache_state["caught_up"] = True
                # The reload about to be sent gives the frontend a fresh,
                # fully authoritative history, so there is no prior baseline
                # left to compare future live-tail patches against.
                last_sent_bucket_ms.clear()
                last_pushed_payload["data"] = None
                logger.info(
                    "Reached the broker's live edge for the first time this run; "
                    "candles_1s cache is caught up. Sending 'reload' to the chart "
                    "window instead of a raw-tick gap-fill."
                )
                try:
                    live_queue.put_nowait({"type": "reload"})
                except Exception as e:
                    logger.debug(f"live_queue.put_nowait (reload) failed: {e}")
                return

            # Steady-state: only candle state is persisted on the normal
            # throttle. Raw ticks never touch SQLite.
            now_mono = time.monotonic()
            if (now_mono - cache_state["last_refresh_monotonic"]) >= CANDLE_CACHE_REFRESH_INTERVAL_SECONDS:
                refresh_cache_now()

            if not is_live_edge:
                return

            newest_ms = int(new_msc[-1])
            payload = {}

            # v38: minute/hour timeframes (1m/5m/15m/1h) sit alongside the
            # sub-minute ones again, but every configured timeframe - short
            # or long - is still refreshed the same simple way on every
            # call: rebuild a short recent tail straight from SQLite. For
            # the longer timeframes this just recomputes their current
            # still-open bucket on each live tick, which is cheap since
            # ca.build_candle_set() only re-merges the last
            # LIVE_TAIL_LOOKBACK_SECONDS of 1s candles, never the whole
            # table.
            if CHART_TIMEFRAMES_SECONDS:
                # v55 Update 1: tail_from_ms must never land *inside* the
                # still-forming bucket of any configured timeframe - only
                # before it. A flat "last LIVE_TAIL_LOOKBACK_SECONDS"
                # window (the only thing this used to compute) satisfies
                # that for 1s/5s/15s, whose current bucket is always
                # younger than tail_lookback_ms - but 1m/5m/15m/1h buckets
                # routinely run longer than that, so the window's left
                # edge kept cutting into the middle of them. merge_candles()
                # then had to build that candle's Open from whatever 1s
                # sub-candle happened to be first *inside* the truncated
                # window - not the real first sub-candle of that bucket -
                # so the Open it produced depended on exactly where the
                # window edge fell, and kept changing as that edge slid
                # forward tick by tick (previously reported as an
                # unpredictable "AutoShift" of the Open candle, seen only
                # on 1m+ timeframes; there was never such a mechanism -
                # this truncated window was the actual cause). Anchoring
                # the window to the start of the *largest* configured
                # timeframe's current bucket guarantees every smaller
                # timeframe's current bucket is covered too, since they
                # all divide evenly into it.
                largest_tf_ms = max(CHART_TIMEFRAMES_SECONDS) * 1000
                current_largest_bucket_start_ms = candle_cache.align_down_ms(newest_ms, largest_tf_ms)
                tail_from_ms = min(newest_ms - tail_lookback_ms, current_largest_bucket_start_ms)
                try:
                    # v57 Update 4: same window, same candles, but read from
                    # the candles_1s cache plus only the raw ticks the cache
                    # hasn't absorbed yet - instead of re-aggregating every
                    # raw tick of the current 1h bucket ~10 times a second.
                    # Open-continuity (Open[n] == Close[n-1]) is preserved
                    # across the cache/raw join by seeding the fresh part
                    # from the last cached Close - see the helper's own
                    # docstring at the top of this file.
                    candle_set = _build_live_tail_candle_set(
                        conn, CHART_TIMEFRAMES_SECONDS, tail_from_ms, live_buffer
                    )

                    # v55.5: the LIVE_PUSH_CANDLES_PER_TF truncation above is
                    # only safe when at most that many candles closed, per
                    # timeframe, since the last successful push - true for
                    # ordinary one-tick-at-a-time ticking, but not after the
                    # feed falls behind and catches back up (MT5/internet
                    # reconnect, a buffered burst, or even the UI consumer
                    # simply having been busy): several candles can close in
                    # that gap and only the newest two would ever reach the
                    # chart, leaving a permanent visual gap until a manual
                    # reload. Rather than guess *when* that can happen, check
                    # directly: compare this rebuild against the last bucket
                    # actually confirmed sent, per timeframe. If any
                    # timeframe closed more candles than the patch below can
                    # carry, send a full 'reload' instead - exactly the same
                    # recovery already used for the initial backfill catch-up
                    # above - so the frontend re-fetches its bounded history
                    # and the gap self-heals with no user action needed.
                    needs_reload = False
                    for tf, candles in candle_set.items():
                        if not candles:
                            continue
                        last_sent = last_sent_bucket_ms.get(tf)
                        if last_sent is None:
                            continue  # no baseline yet (e.g. just reloaded) - nothing to compare
                        unsent = sum(1 for c in candles if c.bucket_start_ms > last_sent)
                        if unsent > LIVE_PUSH_CANDLES_PER_TF:
                            needs_reload = True
                            break

                    if needs_reload:
                        for tf, candles in candle_set.items():
                            if candles:
                                last_sent_bucket_ms[tf] = candles[-1].bucket_start_ms
                        refresh_cache_now()
                        logger.info(
                            "Live tail fell behind by more than the live-patch can "
                            "carry (reconnect or buffered burst); sending 'reload' "
                            "to the chart window instead of a partial live-tail patch."
                        )
                        last_pushed_payload["data"] = None
                        try:
                            live_queue.put_nowait({"type": "reload"})
                        except Exception as e:
                            logger.debug(f"live_queue.put_nowait (reload) failed: {e}")
                        return

                    payload.update(
                        {
                            str(tf): [
                                _candle_dict(c)
                                for c in candles[-LIVE_PUSH_CANDLES_PER_TF:]
                            ]
                            for tf, candles in candle_set.items()
                        }
                    )
                    for tf, candles in candle_set.items():
                        if candles:
                            last_sent_bucket_ms[tf] = candles[-1].bucket_start_ms
                except Exception as e:
                    logger.warning(f"push_live_tick: failed to rebuild the live tail from SQLite: {e}")

            if not payload:
                return

            # v57 Update 4: nothing the chart renders has changed since the
            # last push - skip it. (`last_sent_bucket_ms` above is already
            # updated either way, so the reconnect/gap detector's baseline
            # stays correct regardless.)
            if payload == last_pushed_payload["data"]:
                return
            last_pushed_payload["data"] = payload

            try:
                live_queue.put_nowait({"type": "candles", "data": payload, "symbol": symbol})
            except Exception as e:
                logger.debug(f"live_queue.put_nowait failed (queue full or window process gone?): {e}")


        def check_backfill_queue():
            # (v44) Non-blocking: only acts when the window process has
            # actually put something in the queue, so this costs nothing
            # on every normal live-sync iteration.
            if backfill_cmd_queue is None:
                return
            try:
                cmd = backfill_cmd_queue.get_nowait()
            except Exception:
                return
            if not cmd:
                return
            cmd_type = cmd.get("type")
            if cmd_type == "backfill_request":
                _process_backfill_request(mt5, conn, logger, live_queue, cmd, symbol=symbol)
            elif cmd_type == "extend_request":
                _process_extend_request(mt5, conn, logger, live_queue, cmd, symbol=symbol)
            # v57 Update 4: Backfill/Extend rewrite candle rows through
            # refresh_range(), which can touch rows INSIDE the live-tail
            # window without moving the newest cached bucket that the memo is
            # keyed on. Dropping the memo here is a single dict clear and
            # removes that edge case entirely rather than relying on the next
            # ordinary refresh() to invalidate it.

        tick_explorer.sync_ticks_forward(
            mt5, conn, logger, on_new_ticks=push_live_tick, on_status=send_status,
            stop_event=stop_event, on_idle=check_backfill_queue, symbol=symbol,
        )

    except Exception:
        logger.error("Unexpected error in the MT5 sync process:")
        for line in traceback.format_exc().splitlines():
            logger.error(f"  {line}")
    finally:
        # (v25.3) Whatever reason this process is ending for (crash, stop
        # requested, connect never succeeded), it can no longer supply live
        # data - make sure the dot doesn't stay on a stale "online"/"syncing"
        # reading while the watchdog (app.py) restarts it.
        send_status("offline")
        # v61.2: candles are only persisted on the refresh throttle, so up to
        # CANDLE_CACHE_REFRESH_INTERVAL_SECONDS of freshly aggregated candles
        # (plus the still-forming second) exist only in this process's RAM.
        # Persist them before the connection closes - on a normal stop or a
        # symbol switch nothing is left to be re-fetched from MT5 next start.
        if live_buffer is not None and conn is not None:
            try:
                flushed = live_buffer.flush()
                if flushed:
                    logger.info(f"Shutdown: persisted {flushed:,} pending 1s candle(s)", extra={"category": "DATABASE"})
            except Exception as e:
                logger.warning(f"Shutdown flush failed (re-fetched from MT5 next start): {e}", extra={"category": "DATABASE"})
        if conn is not None:
            tick_store.close_database(conn, logger)
        if mt5 is not None:
            mt5_connector.shutdown(mt5, logger)
        logger.info(f"Daily log remains active: {current_log_path()}")
        logger.info("Sync process end.")
