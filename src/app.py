# -*- coding: utf-8 -*-
import json
import multiprocessing as mp
import os
import queue
import sys
import threading
import traceback

import webview

from logger_setup import setup_logger, register_sensitive_values, current_log_path, append_session_log
import candle_cache
import get_started
import sync_process
import tick_store
import symbol_manager
from chart_bridge import ChartBridge
from drawing_store import DrawingStore
from style_store import StyleStore
from canvas_settings_store import CanvasSettingsStore
from keyboard_shortcuts_store import KeyboardShortcutsStore
from config_store import ConfigStore
import version as app_version
from runtime_paths import PROJECT_ROOT as _PROJECT_ROOT, RESOURCE_ROOT as _RESOURCE_ROOT
from config import (
    OUTPUT_DIR,
    SYMBOL_LIST_DIR,
    DRAWINGS_DIR,
    STYLE_SETTINGS_DIR,
    CANVAS_SETTINGS_DIR,
    KEYBOARD_SHORTCUTS_DIR,
    APP_CONFIG_DIR,
    SYNC_PROCESS_WATCHDOG_CHECK_INTERVAL_SECONDS,
    SYNC_PROCESS_RESPAWN_COOLDOWN_SECONDS,
)

_INDEX_HTML = os.path.join(_RESOURCE_ROOT, "web", "index.html")


def _handle_live_queue_message(window, bridge, message, logger, identity_callback=None, sync_log_callback=None):
    """Handle one message emitted by the sync process."""
    try:
        kind = (message or {}).get("type")
        if kind == "reload":
            logger.info("Reload received from sync process; refreshing chart from cache.")
            window.evaluate_js("window.onCacheReady && window.onCacheReady()")
        elif kind == "candles":
            payload_json = json.dumps(message.get("data") or {})
            window.evaluate_js(f"window.onLiveCandles && window.onLiveCandles({payload_json})")
        elif kind == "ask":
            # V64: display-only live ASK. The bridge keeps the newest value in RAM
            # (for a page that loads while the market is quiet) and rejects a
            # stale message from a previous symbol's sync process.
            ask = bridge.ingest_live_ask(message)
            if ask is not None:
                window.evaluate_js(f"window.onLiveAsk && window.onLiveAsk({json.dumps(ask)})")
        elif kind == "status":
            status_json = json.dumps(message.get("data"))
            window.evaluate_js(f"window.onStatus && window.onStatus({status_json})")
        elif kind == "backfill_status":
            data = message.get("data") or {}
            state_json = json.dumps(data.get("state"))
            recovered_json = json.dumps(data.get("recovered"))
            window.evaluate_js(
                f"window.onBackfillStatus && window.onBackfillStatus({state_json}, {recovered_json})"
            )
        elif kind == "extend_status":
            data = message.get("data") or {}
            state_json = json.dumps(data.get("state"))
            # (v46) The whole data dict (days_added/days_unreachable on
            # "done", nothing extra on "processing") is handed to the
            # page as-is - market-data-overview.js reads whichever
            # fields it needs off it.
            data_json = json.dumps(data)
            window.evaluate_js(
                f"window.onExtendStatus && window.onExtendStatus({state_json}, {data_json})"
            )
        elif kind == "identity":
            # v62: the sync process (the only place that talks to MT5)
            # reports the real broker server / a freshly discovered symbol list.
            if identity_callback is not None:
                identity_callback(message.get("data") or {})
        else:
            logger.debug(f"Unknown live_queue message type: {kind!r}")
    except Exception as e:
        logger.debug(f"evaluate_js failed (window may not be ready yet): {e}")


def _live_queue_consumer(window, bridge, live_queue, consumer_stop, logger, identity_callback=None, sync_log_callback=None):
    """Consume sync-process messages without retaining stale live candle tails.

    v55.2: a live tick stream can produce candle messages faster than a
    temporarily busy webview can execute JavaScript. Candle messages are
    state updates, not events: only the newest one is authoritative. When a
    candle message arrives, drain any already-queued messages and keep only
    the newest candle payload; control/status messages are still processed in
    their original relative order. This makes the queue resilient to short UI
    stalls and prevents duplicated candle snapshots from accumulating in RAM.

    Other message types remain lossless from the consumer's perspective, and
    no cache/history logic is changed here - this is only a transport-level
    coalescing optimization.
    """
    while not consumer_stop.is_set():
        try:
            message = live_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        except (OSError, EOFError):
            break

        if (message or {}).get("type") not in ("candles", "ask"):
            _handle_live_queue_message(window, bridge, message, logger, identity_callback, sync_log_callback)
            continue

        # A candle payload represents the current state of the live edge.
        # Collapse all queued candle snapshots into the newest one before
        # crossing the Python -> WebView boundary, which is the slowest part
        # of this path and the main reason stale snapshots could accumulate.
        # V64: the live ASK is the same kind of message (a state, not an
        # event): only the newest one is delivered.
        latest_candles = None
        latest_ask = None
        deferred_controls = []
        pending = message
        while pending is not None:
            pending_type = (pending or {}).get("type")
            if pending_type == "candles":
                # v61.1: record EVERY candles message in the bridge's live
                # overlay before the coalescing discards the stale ones - this
                # is what lets a timeframe switch / reload see the
                # not-yet-flushed live edge.
                bridge.ingest_live_candles(pending)
                latest_candles = pending
            elif pending_type == "ask":
                latest_ask = pending
            else:
                deferred_controls.append(pending)
            try:
                pending = live_queue.get_nowait()
            except queue.Empty:
                break
            except (OSError, EOFError):
                break

        # Controls/status updates are still delivered; only redundant candle
        # snapshots are coalesced. A reload supersedes any stale candle state
        # collected before it, so discard the coalesced payload in that case.
        has_reload = any((m or {}).get("type") == "reload" for m in deferred_controls)
        for control in deferred_controls:
            _handle_live_queue_message(window, bridge, control, logger, identity_callback, sync_log_callback)

        if latest_candles is not None and not has_reload:
            _handle_live_queue_message(window, bridge, latest_candles, logger, identity_callback, sync_log_callback)
        if latest_ask is not None:
            _handle_live_queue_message(window, bridge, latest_ask, logger, identity_callback, sync_log_callback)


def _migrate_settings_file(legacy_dir, new_dir, filename, logger=None):
    """v65.4: STYLE_SETTINGS_DIR/CANVAS_SETTINGS_DIR/KEYBOARD_SHORTCUTS_DIR
    each moved from their own output/*_settings folder into a shared
    output/settings/ parent. Move a pre-v65.4 saved file into its new
    location the first time it's looked up there, so upgrading never looks
    like the user's saved presets/bindings were reset. Silent, best-effort:
    if anything goes wrong the legacy file is simply left where it was and
    picked up again on the next launch."""
    new_path = os.path.join(new_dir, filename)
    legacy_path = os.path.join(legacy_dir, filename)
    if os.path.exists(new_path) or not os.path.exists(legacy_path):
        return
    try:
        os.makedirs(new_dir, exist_ok=True)
        os.replace(legacy_path, new_path)
        if logger:
            logger.info(f"Migrated '{legacy_path}' -> '{new_path}'.", extra={"category": "SETTINGS"})
    except OSError as e:
        if logger:
            logger.debug(f"Settings-file migration skipped for '{legacy_path}': {e}")


def _bootstrap_database(db_path, logger, label=""):
    """Create/upgrade the candle SQLite file. Plain local file I/O, no MT5."""
    conn = tick_store.open_database(db_path, logger)
    candle_cache.ensure_schema(conn)
    try:
        candle_cache.migrate_legacy_ticks(conn, logger=logger)
    except Exception as e:
        logger.error(f"Legacy tick migration failed{label}: {e}", extra={"category": "DATABASE"})
        tick_store.close_database(conn, logger)
        raise
    tick_store.close_database(conn, logger)


def _spawn_sync_process(
    db_path,
    live_queue,
    stop_event,
    backfill_cmd_queue,
    symbol,
    expected_server=None,
    log_lock=None,
    session_log_queue=None,
):
    proc = mp.Process(
        target=sync_process.run,
        args=(
            db_path,
            live_queue,
            stop_event,
            backfill_cmd_queue,
            symbol,
            expected_server,
            log_lock,
            session_log_queue,
        ),
        daemon=True,
        name="mt5-sync-process",
    )
    proc.start()
    return proc


def _sync_process_watchdog(runtime_state, logger, log_lock):
    """Lightweight safety net: only acts if the sync process has actually
    died (e.g. an unhandled exception) - the normal connect-retry path in
    sync_process.py handles the common "no internet yet" case on its own
    without ever exiting, so this thread does nothing in that case. Just a
    cheap is_alive() poll on a slow interval, no MT5/DB work of its own, so
    it adds negligible overhead. A cooldown after each respawn keeps a
    process that dies immediately (e.g. a bad symbol) from being restarted
    in a tight loop."""
    while not runtime_state["app_stop_event"].is_set():
        if runtime_state["app_stop_event"].wait(SYNC_PROCESS_WATCHDOG_CHECK_INTERVAL_SECONDS):
            break
        if runtime_state.get("switching"):
            continue
        if runtime_state["proc"].is_alive():
            continue
        logger.warning(
            "MT5 sync process is no longer running; restarting it "
            f"in {SYNC_PROCESS_RESPAWN_COOLDOWN_SECONDS:.0f}s ..."
        )
        if runtime_state["app_stop_event"].wait(SYNC_PROCESS_RESPAWN_COOLDOWN_SECONDS):
            break
        if runtime_state["app_stop_event"].is_set():
            break
        runtime_state["proc"] = _spawn_sync_process(
            runtime_state["db_path"],
            runtime_state["live_queue"],
            runtime_state["stop_event"],
            runtime_state["backfill_cmd_queue"],
            runtime_state["symbol"],
            runtime_state["server"],
            log_lock,
            runtime_state["session_log_queue"],
        )


def _session_log_queue_consumer(log_queue, stop_event, logger):
    """Move formatted sync-process records into the main process's session log buffer."""
    while not stop_event.is_set():
        try:
            message = log_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        except (OSError, EOFError):
            break
        if (message or {}).get("type") == "session_log":
            append_session_log(logger, (message or {}).get("text", ""))


def main():
    log_lock = mp.Lock()
    session_log_queue = mp.Queue(maxsize=20_000)
    session_log_stop = threading.Event()
    logger, log_filename = setup_logger(file_lock=log_lock)
    session_log_thread = threading.Thread(
        target=_session_log_queue_consumer,
        args=(session_log_queue, session_log_stop, logger),
        daemon=True,
        name="session-log-queue-consumer",
    )
    session_log_thread.start()

    logger.info("#" * 60)
    logger.info(f"Starting {app_version.app_title()}")
    logger.info("No default symbol configured. Symbol selection is handled by Get Started.")
    logger.info("#" * 60)

    # V66: first run (or a run after every symbol database was deleted) goes
    # through the Get Started window first. It runs in its own process with
    # its own webview loop (see src/get_started.py), so by the time it
    # returns the requirements are installed, MT5 is reachable, a symbol is
    # chosen and its first days of history are already on disk - the normal
    # offline-first start below then finds real data instead of nothing.
    if not get_started.ensure_setup(logger, log_lock):
        return

    # v62: TRUE offline start. The window process never calls MT5 - not even
    # on a background thread: the MetaTrader5 extension holds the GIL while
    # mt5.initialize() waits (65 s when the terminal cannot log in), which
    # froze the whole window on every offline launch. The server/symbol of
    # the last session come straight from disk, so the cached candles show
    # instantly; the sync process (own OS process, own GIL) confirms the real
    # identity and reports it back through the live queue.
    last_server, last_symbol = symbol_manager.load_last_session(OUTPUT_DIR)
    broker_server = last_server or symbol_manager.UNKNOWN_SERVER
    saved_symbol = symbol_manager.load_selected_symbol(OUTPUT_DIR, broker_server)
    symbol_list = symbol_manager.load_symbol_list(SYMBOL_LIST_DIR, broker_server) or []
    if last_symbol:
        selected_symbol = last_symbol
    else:
        selected_symbol = symbol_manager.choose_startup_symbol(None, symbol_list, saved_symbol)
    if last_server:
        register_sensitive_values(logger, broker_server)
        logger.info(f"Offline-first start (server: {broker_server}, symbol: {selected_symbol})")
    else:
        logger.info("No previous session found; starting with the config default symbol.")

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    # v65.3: hide any 'unknown-server' fallback databases left over from a
    # previous run before this run's own identity is even resolved - purely
    # cosmetic Explorer cleanup, independent of whichever database this
    # launch itself ends up using.
    tick_store.hide_unknown_server_artifacts(OUTPUT_DIR)
    db_filename = tick_store.resolve_db_basename(selected_symbol, broker_server)
    db_path = os.path.join(OUTPUT_DIR, db_filename)

    # Prepare the SQLite file/schema up front. Plain local file I/O.
    _bootstrap_database(db_path, logger)

    # ChartBridge opens its own read-only SQLite connection and serves
    # whatever cached history already exists on disk - completely
    # independent of whether MT5 is reachable.
    # v33: drawn chart objects (trend lines, rectangles, horizontal/vertical
    # lines) are persisted to <project root>/output/drawings/<symbol>.json, so they
    # survive closing and reopening the app. Store is per-symbol, mirroring
    # how the tick database is already per-run/per-symbol.
    drawings_dir = os.path.join(_PROJECT_ROOT, DRAWINGS_DIR)
    drawing_store = DrawingStore(drawings_dir, selected_symbol, logger)

    # v37: drawing-tool style defaults/presets are persisted to
    # <project root>/output/settings/style_settings/style_settings.json — a
    # single file (not per-symbol, since these are tool settings, not chart
    # data).
    style_settings_dir = os.path.join(_PROJECT_ROOT, STYLE_SETTINGS_DIR)
    _migrate_settings_file(os.path.join(_PROJECT_ROOT, "output", "style_settings"), style_settings_dir, "style_settings.json", logger)
    style_store = StyleStore(style_settings_dir, logger)

    # v50.1: Setting panel Canvas tab settings/presets are persisted to
    # <project root>/output/settings/canvas_settings/canvas_settings.json —
    # a single file (not per-symbol, same reasoning as style_store above).
    canvas_settings_dir = os.path.join(_PROJECT_ROOT, CANVAS_SETTINGS_DIR)
    _migrate_settings_file(os.path.join(_PROJECT_ROOT, "output", "canvas_settings"), canvas_settings_dir, "canvas_settings.json", logger)
    canvas_settings_store = CanvasSettingsStore(canvas_settings_dir, logger)

    # v51: Setting panel Keyboard Shortcuts tab bindings are persisted to
    # <project root>/output/settings/keyboard_shortcuts/keyboard_shortcuts.json
    # — a single file (not per-symbol, same reasoning as canvas_settings_store
    # above).
    keyboard_shortcuts_dir = os.path.join(_PROJECT_ROOT, KEYBOARD_SHORTCUTS_DIR)
    _migrate_settings_file(os.path.join(_PROJECT_ROOT, "output", "keyboard_shortcuts"), keyboard_shortcuts_dir, "keyboard_shortcuts.json", logger)
    keyboard_shortcuts_store = KeyboardShortcutsStore(keyboard_shortcuts_dir, logger)

    # v52: Setting panel Configuration tab overrides (one override per
    # config.py variable) are persisted to
    # <project root>/output/settings/app_config/app_config.json — a single
    # file (not per-symbol, same reasoning as keyboard_shortcuts_store
    # above). config.py itself already loaded and applied whatever was
    # saved here (migrating it from its pre-v65.4 location if needed) from a
    # previous run, before this line even executes.
    app_config_dir = os.path.join(_PROJECT_ROOT, APP_CONFIG_DIR)
    config_store = ConfigStore(app_config_dir, logger)

    # (v44) Window -> Sync process command channel, used only for Backfill
    # requests from the Market Data Overview panel.
    backfill_cmd_queue = mp.Queue()
    stop_event = mp.Event()
    live_queue = mp.Queue()
    runtime_state = {
        "symbol": selected_symbol, "db_path": db_path, "server": broker_server,
        "proc": None, "stop_event": stop_event, "app_stop_event": threading.Event(), "switching": False,
        "live_queue": live_queue, "backfill_cmd_queue": backfill_cmd_queue,
        "session_log_queue": session_log_queue,
    }

    def switch_runtime_symbol(new_symbol):
        if new_symbol == runtime_state["symbol"]:
            return runtime_state["db_path"]
        runtime_state["switching"] = True
        old_proc = runtime_state["proc"]
        old_stop = runtime_state["stop_event"]
        old_stop.set()
        if old_proc is not None:
            old_proc.join(timeout=5)
            if old_proc.is_alive():
                logger.warning("Old MT5 sync process did not exit during symbol switch; terminating it.")
                old_proc.terminate()
                old_proc.join(timeout=5)

        new_db_path = os.path.join(OUTPUT_DIR, tick_store.resolve_db_basename(new_symbol, runtime_state["server"]))
        _bootstrap_database(new_db_path, logger, label=f" for {new_symbol}")

        runtime_state["symbol"] = new_symbol
        runtime_state["db_path"] = new_db_path
        runtime_state["stop_event"] = mp.Event()
        runtime_state["proc"] = _spawn_sync_process(
            new_db_path, runtime_state["live_queue"], runtime_state["stop_event"],
            runtime_state["backfill_cmd_queue"], new_symbol, runtime_state["server"], log_lock,
            runtime_state["session_log_queue"]
        )
        symbol_manager.save_selected_symbol(OUTPUT_DIR, runtime_state["server"], new_symbol, logger)
        symbol_manager.save_last_session(OUTPUT_DIR, runtime_state["server"], new_symbol, logger)
        runtime_state["switching"] = False
        return new_db_path

    bridge = ChartBridge(
        db_path, logger, drawing_store=drawing_store, style_store=style_store,
        canvas_settings_store=canvas_settings_store,
        keyboard_shortcuts_store=keyboard_shortcuts_store,
        config_store=config_store,
        backfill_cmd_queue=backfill_cmd_queue, symbol=selected_symbol, server=broker_server,
        symbol_list=symbol_list, switch_symbol_callback=switch_runtime_symbol,
        log_path=log_filename,
    )

    # v55.4: frameless window with a custom, theme-matched title bar drawn in
    # the page itself. easy_drag=False is intentional: movement is handled
    # explicitly by window_drag_* in ChartBridge so the custom frame behaves
    # consistently across pywebview backends.
    window_title = app_version.app_title(selected_symbol)
    window = webview.create_window(
        window_title,
        _INDEX_HTML,
        js_api=bridge,
        width=1280,
        height=820,
        min_size=(800, 500),
        background_color="#0a0e17",
        frameless=True,
        easy_drag=False,
    )
    bridge.set_window(window, title=window_title)

    # --- MT5 connection + tick sync: separate OS process ------------------
    # mt5.initialize() blocks without releasing the GIL, so it must not
    # run on any thread inside this process - only a genuinely separate
    # process guarantees it can never delay webview.start() below.
    runtime_state["proc"] = _spawn_sync_process(
        db_path, live_queue, stop_event, backfill_cmd_queue, selected_symbol,
        broker_server, log_lock, runtime_state["session_log_queue"],
    )

    def handle_identity(data):
        """Runs on the queue-consumer thread when the sync process reports
        the real server (v62). Same server: just refresh the symbol list.
        Different server: switch the database, then reload the page."""
        server = str(data.get("server") or "").strip()
        symbols = data.get("symbols")
        register_sensitive_values(logger, server)
        if not server:
            return
        if symbol_manager.same_server(server, runtime_state["server"]):
            if symbols:
                bridge.set_symbol_list(symbols)
                try:
                    cached = bridge.get_cached_symbols()
                    window.evaluate_js(
                        f"window.onSymbolList && window.onSymbolList({json.dumps(symbols)}, {json.dumps(cached)})"
                    )
                except Exception as e:
                    logger.debug(f"evaluate_js (symbol list) failed: {e}")
            return

        logger.info(f"Broker server changed to '{server}' (was '{runtime_state['server']}'); switching database.")
        runtime_state["switching"] = True
        try:
            old_proc = runtime_state["proc"]
            runtime_state["stop_event"].set()
            if old_proc is not None:
                old_proc.join(timeout=5)
                if old_proc.is_alive():
                    old_proc.terminate()
                    old_proc.join(timeout=5)

            new_list = symbols or symbol_manager.load_symbol_list(SYMBOL_LIST_DIR, server) or []
            saved = symbol_manager.load_selected_symbol(OUTPUT_DIR, server)
            new_symbol = symbol_manager.choose_startup_symbol(None, new_list, saved)
            if not saved:
                symbol_manager.save_selected_symbol(OUTPUT_DIR, server, new_symbol, logger)
            new_db_path = os.path.join(OUTPUT_DIR, tick_store.resolve_db_basename(new_symbol, server))
            _bootstrap_database(new_db_path, logger, label=f" for {new_symbol}")

            runtime_state.update({"server": server, "symbol": new_symbol, "db_path": new_db_path})
            runtime_state["stop_event"] = mp.Event()
            bridge.apply_identity(server, new_symbol, new_list, new_db_path)
            symbol_manager.save_last_session(OUTPUT_DIR, server, new_symbol, logger)
            # v65.3: the previous 'unknown-server' fallback database(s), if
            # any, are now definitively stale - hide them from Explorer.
            tick_store.hide_unknown_server_artifacts(OUTPUT_DIR)
            runtime_state["proc"] = _spawn_sync_process(
                new_db_path, runtime_state["live_queue"], runtime_state["stop_event"],
                runtime_state["backfill_cmd_queue"], new_symbol, server, log_lock,
                runtime_state["session_log_queue"],
            )
            try:
                window.evaluate_js("window.onIdentityChanged && window.onIdentityChanged()")
            except Exception as e:
                logger.debug(f"evaluate_js (identity changed) failed: {e}")
        except Exception as e:
            logger.error(f"Switching to broker server '{server}' failed: {e}")
        finally:
            runtime_state["switching"] = False

    consumer_stop = threading.Event()
    consumer_thread = threading.Thread(
        target=_live_queue_consumer,
        args=(window, bridge, runtime_state["live_queue"], consumer_stop, logger, handle_identity, None),
        daemon=True,
        name="live-queue-consumer",
    )
    consumer_thread.start()

    # (v25.2) Watchdog: only a fallback for a sync process dying outright
    # (unhandled exception) - the ordinary "MT5 unreachable" case is now
    # handled inside sync_process.py itself via its own retry loop, so this
    # thread stays idle almost all the time.
    watchdog_thread = threading.Thread(
        target=_sync_process_watchdog,
        args=(runtime_state, logger, log_lock),
        daemon=True,
        name="sync-process-watchdog",
    )
    watchdog_thread.start()

    try:
        webview.start()
    finally:
        runtime_state["app_stop_event"].set()
        runtime_state["stop_event"].set()
        consumer_stop.set()
        session_log_stop.set()

        sync_proc = runtime_state["proc"]
        sync_proc.join(timeout=5)
        if sync_proc.is_alive():
            logger.warning("MT5 sync process did not exit in time; terminating it.")
            sync_proc.terminate()
            sync_proc.join(timeout=5)

        try:
            runtime_state["live_queue"].close()
        except Exception:
            pass
        try:
            backfill_cmd_queue.close()
        except Exception:
            pass
        try:
            session_log_thread.join(timeout=1.0)
        except Exception:
            pass
        try:
            session_log_queue.close()
            session_log_queue.join_thread()
        except Exception:
            pass

        bridge.close()
        if getattr(logger, "_tick_file_log_enabled", False):
            logger.info(f"Log saved to: {current_log_path()}")
        else:
            logger.info("Disk logging disabled; no log file was written.")
        logger.info("Program end.")


if __name__ == "__main__":
    mp.freeze_support()

    # In a PyInstaller one-file build, the process working directory may be
    # inherited from the launcher rather than the EXE location. The app's
    # existing relative output/log paths (config.py's OUTPUT_DIR/LOG_DIR) are
    # intentionally kept as relative strings, so normalize the working
    # directory once for the frozen release - to runtime_paths.PROJECT_ROOT
    # (v69: %LOCALAPPDATA%\MT-TickExplorer, not the EXE's own folder - see
    # runtime_paths.py), which is what actually keeps a portable copy of the
    # EXE from spilling output/logs folders next to itself. Source launches
    # are unchanged.
    if getattr(sys, "frozen", False):
        from runtime_paths import PROJECT_ROOT as _frozen_project_root
        os.chdir(_frozen_project_root)

        # v69: if a newer version finished downloading in a previous
        # session but the user closed the app instead of clicking
        # "Update" then, apply it now - before webview, the logger, or
        # anything else starts up. This call returns False (and does
        # nothing further) in the ordinary case where no update is
        # pending, so it adds no real startup cost. When it does find one,
        # it hands off to the swap-and-restart helper and calls
        # os._exit(0) itself - main() below is never reached for this
        # (old) process in that case.
        from update_installer import check_and_apply_pending_update_at_startup
        check_and_apply_pending_update_at_startup()

    try:
        main()
    except Exception:
        # Release builds use PyInstaller's windowed/no-console mode. Never
        # attempt to read from stdin there: doing so would raise EOFError and
        # can make an otherwise handled startup failure look like a second
        # exception. Developer launches retain the existing visible console.
        if getattr(sys, "frozen", False):
            sys.exit(1)
        print("A fatal error occurred:")
        traceback.print_exc()
        input("\nPress Enter to close this window ...")
        sys.exit(1)
