# -*- coding: utf-8 -*-
"""V66.2 - the Get Started window (first-run setup wizard).

Why its own process
-------------------
pywebview's event loop can only be started once per process, and the main
chart window must still be created normally after the wizard is done. So
``ensure_setup()`` runs the wizard in a short-lived child process that owns
its own webview loop, exits when the user finishes (or closes) it, and
reports the outcome back through a queue. Nothing of the wizard is left in
memory while the chart is running.

What each step does (mirrors web/get-started.html)
--------------------------------------------------
1. Welcome.
2. MetaTrader preparation - shows web/assets/prepare.png and, on Next,
   probes MT5 in a throwaway process (src/mt5_probe.py) for the broker
   server + symbol list. Failure keeps the user on this step.
3. Choose symbol - the broker's own symbol list; selecting one persists the
   choice and starts the normal sync process (src/sync_process.py) to prefill
   HISTORY_BACKFILL_MAX_DAYS days.
4. Finish - marks the setup complete; the wizard never shows again while at
   least one symbol database exists.
"""
import multiprocessing as mp
import os
import queue
import sqlite3
import threading
import time

import candle_cache
import mt5_probe
import runtime_paths
import setup_state
import symbol_manager
import sync_process
import tick_store
import win_drag
import version as app_version
from logger_setup import register_sensitive_values
from runtime_paths import PROJECT_ROOT as _PROJECT_ROOT, RESOURCE_ROOT as _RESOURCE_ROOT
from config import (
    HISTORY_BACKFILL_MAX_DAYS,
    OUTPUT_DIR,
    SETUP_STATE_DIR,
    SYMBOL_LIST_DIR,
)

_GET_STARTED_HTML = os.path.join(_RESOURCE_ROOT, "web", "get-started.html")
_WINDOW_TITLE = app_version.app_title("Get Started")

# How long a freshly started prefill may stay completely empty before the
# wizard tells the user something is wrong (the market can simply be closed).
_PREFILL_EMPTY_HINT_SECONDS = 45.0
# Once candles exist, the prefill counts as finished when the count stops
# growing for this long (catch-up is done, only live ticks remain).
_PREFILL_SETTLE_SECONDS = 3.0


def _count_candles(db_path):
    """Cheap read-only count of the 1s base table; 0 if it does not exist."""
    if not os.path.exists(db_path):
        return 0, None, None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
        try:
            row = conn.execute(
                "SELECT COUNT(*), MIN(bucket_start_ms), MAX(bucket_start_ms) FROM candles_1s"
            ).fetchone()
        finally:
            conn.close()
        return int(row[0] or 0), row[1], row[2]
    except Exception:
        return 0, None, None


def _prune_empty_dirs(base_dir):
    """v72: best-effort cleanup after a Root Project Folder change - remove
    `base_dir` and any of its subdirectories that turn out to be completely
    empty, deepest first. Only ever touches directories that already have
    nothing left in them (no file, no non-empty subdirectory), so genuine
    data anywhere in the tree makes the whole thing a silent no-op.

    Needed because several of this app's stores (e.g. ConfigStore) create
    their own output/settings/<...>/ folder purely as a side effect of
    being asked to *load* whatever was previously saved there - even on a
    process that never saves anything (like this wizard, before a Root
    Project Folder was ever chosen). Left alone, those empty folders - and
    the "output" tree around them - would linger forever at the default
    location once the user points the app somewhere else.
    """
    if not os.path.isdir(base_dir):
        return
    for dirpath, _dirnames, _filenames in os.walk(base_dir, topdown=False):
        try:
            os.rmdir(dirpath)
        except OSError:
            pass  # not actually empty (real data) - leave it alone


class SetupBridge:
    """js_api for web/get-started.html. Every method returns plain JSON."""

    def __init__(self, logger, setup_dir, output_dir, symbol_list_dir, root, log_lock=None):
        self._logger = logger
        self._setup_dir = setup_dir
        self._output_dir = output_dir
        self._symbol_list_dir = symbol_list_dir
        # v72: the Root Project Folder shown/changed on the Preparation step.
        # Starts as whatever this process already resolved (see
        # runtime_paths.PROJECT_ROOT) - the previous override, if any, or the
        # default location - and can be changed once, in place, before the
        # symbol/prefill step below ever touches disk.
        self._root = root
        self._log_lock = log_lock
        self._window = None
        self._dragger = win_drag.WindowDragger(_WINDOW_TITLE, logger)
        self._state = setup_state.load_state(setup_dir)
        register_sensitive_values(logger, self._state.get("server"))
        self._symbols = []
        self._probe_running = False
        self._prefill = None
        self.result = {"completed": False, "server": "", "symbol": ""}

    # -- window plumbing --------------------------------------------------
    def set_window(self, window):
        self._window = window

    # v67.2: same single-source app name/version as ChartBridge.get_app_info()
    # - see src/version.py - so this wizard window's brand text/title never
    # drifts from the main chart window's.
    def get_app_info(self):
        return {"name": app_version.APP_NAME, "version": app_version.VERSION,
                "title": app_version.app_title()}

    def _close_window(self):
        try:
            if self._window is not None:
                self._window.destroy()
        except Exception as e:
            self._logger.debug(f"Get Started window destroy failed: {e}")

    # -- title-bar dragging (V66.2; native implementation introduced in V66.1) ---
    def drag_begin(self):
        """Two calls per drag (begin/end); the move itself runs natively in
        src/win_drag.py, with no per-mouse-move round-trip."""
        return self._dragger.begin()

    def drag_end(self):
        self._dragger.end()
        return True

    # -- state ------------------------------------------------------------
    def get_state(self):
        server = self._state.get("server") or ""
        if not self._symbols and server:
            self._symbols = symbol_manager.load_symbol_list(self._symbol_list_dir, server) or []
        # A half-finished run may only resume from a step whose
        # precondition still holds: the symbol step needs a symbol list.
        step = int(self._state.get("step") or setup_state.STEP_WELCOME)
        if step >= setup_state.STEP_SYMBOL and not self._symbols:
            step = setup_state.STEP_PREPARATION
        return {
            "step": step,
            "server": server,
            "symbol": self._state.get("symbol") or "",
            "symbols": self._symbols,
            "max_prefill_days": int(HISTORY_BACKFILL_MAX_DAYS),
            "root": self._root,
            "default_root": runtime_paths.DEFAULT_PROJECT_ROOT,
        }

    def save_step(self, step):
        self._state = setup_state.save_state(self._setup_dir, step=int(step))
        return True

    # -- v72: Root Project Folder ------------------------------------------
    def browse_root_folder(self):
        """Open a native folder picker starting at the current root, and
        apply whatever the user chooses in one round trip."""
        try:
            import webview
            result = self._window.create_file_dialog(webview.FOLDER_DIALOG, directory=self._root)
        except Exception as e:
            self._logger.debug(f"Root folder picker failed: {e}")
            return {"ok": False, "error": "Could not open the folder picker."}
        if not result:
            return {"ok": False, "cancelled": True}
        chosen = result[0] if isinstance(result, (list, tuple)) else result
        return self.set_root_folder(chosen)

    def set_root_folder(self, path):
        """Move where this app reads/writes everything (data, logs,
        settings) to `path`, effective immediately for the rest of this
        wizard run and for every future launch.

        Only ever called before step 3 (Choose Symbol) starts downloading
        anything, so there is never any existing data to migrate - the new
        root simply becomes the destination for the first download onward.
        """
        path = str(path or "").strip()
        if not path:
            return {"ok": False, "error": "Choose a folder first."}
        new_root = os.path.abspath(path)
        old_root = self._root
        try:
            os.makedirs(new_root, exist_ok=True)
        except OSError as e:
            return {"ok": False, "error": f"That folder can't be used: {e}"}

        # Every other path this process uses (OUTPUT_DIR, SYMBOL_LIST_DIR,
        # and any future relative path) is a bare relative string resolved
        # against the current working directory - the same convention the
        # rest of the app relies on (see runtime_paths.py). Moving the CWD
        # here is therefore enough to redirect all of them at once, and it
        # carries over to the prefill sync process spawned below, which
        # inherits this process's CWD.
        try:
            os.chdir(new_root)
        except OSError as e:
            return {"ok": False, "error": f"That folder can't be used: {e}"}

        old_setup_dir = self._setup_dir
        self._setup_dir = os.path.join(new_root, SETUP_STATE_DIR)
        carry_over = {k: v for k, v in self._state.items() if k in ("completed", "server", "symbol", "step")}
        self._state = setup_state.save_state(self._setup_dir, **carry_over)

        # v72: stepping past Welcome (before this folder was ever chosen)
        # already wrote a setup_state.json at the OLD default location -
        # now superseded by the copy just written above. Remove it (and its
        # now-likely-empty parent folder) so a stray, unused copy doesn't
        # keep sitting in the default location forever. Best-effort: if
        # anything's odd about it (already gone, folder not actually empty,
        # a permissions quirk), it's simply left alone.
        if os.path.abspath(old_setup_dir) != os.path.abspath(self._setup_dir):
            try:
                os.remove(setup_state.state_path(old_setup_dir))
                os.rmdir(old_setup_dir)
            except OSError:
                pass
            # The setup-state folder was just one leaf under the old root's
            # "output" tree - prune whatever else was left empty there too
            # (e.g. ConfigStore's output/settings/app_config/, created just
            # by loading config.py before any root was ever chosen).
            if os.path.abspath(old_root) != os.path.abspath(new_root):
                _prune_empty_dirs(os.path.join(old_root, "output"))

        runtime_paths.write_root_override(new_root)
        self._root = new_root
        self._logger.info(f"Get Started: Root Project Folder set to '{new_root}'.")
        return {"ok": True, "root": new_root}

    # -- step 2 -----------------------------------------------------------
    def connect_mt5(self):
        """Probe MT5 once. The frontend disables Next while this runs; this
        guard makes that guarantee server-side too, so repeated clicks can
        never start a second probe process."""
        if self._probe_running:
            return {"ok": False, "busy": True, "error": "A connection attempt is already running."}
        self._probe_running = True
        try:
            self._logger.info("Get Started: probing the MetaTrader 5 terminal ...")
            result = mt5_probe.probe()
            if not result.get("ok"):
                self._logger.warning(f"Get Started: MT5 probe failed - {result.get('error')}")
                return result
            server = result["server"]
            register_sensitive_values(
                self._logger, result.get("server"), result.get("company"), result.get("login")
            )
            self._symbols = result["symbols"]
            path = symbol_manager.symbol_list_path(self._symbol_list_dir, server)
            if not os.path.exists(path):
                try:
                    symbol_manager._atomic_write(path, self._symbols)
                except Exception as e:
                    self._logger.warning(f"Could not save the symbol list: {e}")
            self._state = setup_state.save_state(
                self._setup_dir, server=server, step=setup_state.STEP_SYMBOL
            )
            self._logger.info(
                f"Get Started: connected to '{result.get('company') or server}' "
                f"({len(self._symbols):,} symbols)."
            )
            return result
        finally:
            self._probe_running = False

    # -- step 3 -----------------------------------------------------------
    def start_prefill(self, symbol):
        """Persist the chosen symbol and let the ordinary sync process fill
        the first HISTORY_BACKFILL_MAX_DAYS days into its database."""
        symbol = str(symbol or "").strip()
        server = self._state.get("server") or ""
        if not symbol or not server:
            return {"ok": False, "error": "Choose a symbol first."}

        self.stop_prefill()
        os.makedirs(self._output_dir, exist_ok=True)
        db_path = os.path.join(self._output_dir, tick_store.resolve_db_basename(symbol, server))
        try:
            conn = tick_store.open_database(db_path, self._logger)
            candle_cache.ensure_schema(conn)
            tick_store.close_database(conn, self._logger)
        except Exception as e:
            return {"ok": False, "error": f"Could not create the database: {e}"}

        symbol_manager.save_selected_symbol(self._output_dir, server, symbol, self._logger)
        symbol_manager.save_last_session(self._output_dir, server, symbol, self._logger)
        self._state = setup_state.save_state(self._setup_dir, symbol=symbol, step=setup_state.STEP_SYMBOL)

        live_queue = mp.Queue()
        stop_event = mp.Event()
        proc = mp.Process(
            target=sync_process.run,
            args=(db_path, live_queue, stop_event, None, symbol, server, self._log_lock),
            daemon=True, name="mt5-sync-process-setup",
        )
        proc.start()
        state = {
            "proc": proc, "stop": stop_event, "queue": live_queue, "db_path": db_path,
            "symbol": symbol, "started": time.time(), "status": "connecting",
            "count": 0, "last_growth": time.time(), "drain_stop": threading.Event(),
        }
        state["drain_thread"] = threading.Thread(
            target=self._drain_queue, args=(state,), daemon=True, name="setup-queue-drain")
        state["drain_thread"].start()
        self._prefill = state
        self._logger.info(f"Get Started: prefilling {symbol} ({HISTORY_BACKFILL_MAX_DAYS} days) ...")
        return {"ok": True, "symbol": symbol}

    def _drain_queue(self, state):
        """The wizard has no chart to feed, but the queue must not fill up.
        Only the status messages are kept; everything else is discarded."""
        q = state["queue"]
        while not state["drain_stop"].is_set():
            try:
                message = q.get(timeout=0.5)
            except queue.Empty:
                continue
            except (OSError, EOFError, ValueError):
                break
            if (message or {}).get("type") == "status":
                state["status"] = message.get("data") or state["status"]

    def poll_prefill(self):
        state = self._prefill
        if state is None:
            return {"state": "idle"}
        count, first_ms, last_ms = _count_candles(state["db_path"])
        now = time.time()
        if count > state["count"]:
            state["count"] = count
            state["last_growth"] = now

        done = count > 0 and (now - state["last_growth"]) >= _PREFILL_SETTLE_SECONDS
        payload = {
            "state": "done" if done else "working",
            "status": state["status"],
            "symbol": state["symbol"],
            "candles": count,
            "first_ms": first_ms,
            "last_ms": last_ms,
            "elapsed": int(now - state["started"]),
            "hint": "",
        }
        if not done and count == 0 and (now - state["started"]) > _PREFILL_EMPTY_HINT_SECONDS:
            payload["hint"] = (
                "Still waiting for the first candles. The terminal may still be downloading "
                "history, or the market for this symbol may be closed right now."
            )
        return payload

    def stop_prefill(self):
        state = self._prefill
        self._prefill = None
        if state is None:
            return True
        try:
            state["drain_stop"].set()
            state["stop"].set()
            state["proc"].join(timeout=5)
            if state["proc"].is_alive():
                state["proc"].terminate()
                state["proc"].join(timeout=5)
            state["queue"].close()
        except Exception as e:
            self._logger.debug(f"Stopping the setup sync process failed: {e}")
        return True

    # -- step 4 -----------------------------------------------------------
    def finish(self):
        """Hand the chosen identity to app.py and close the wizard."""
        self.stop_prefill()
        self._state = setup_state.save_state(
            self._setup_dir, completed=True, step=setup_state.STEP_FINISH)
        self.result = {
            "completed": True,
            "server": self._state.get("server") or "",
            "symbol": self._state.get("symbol") or "",
        }
        self._logger.info("Get Started: initial setup completed.")
        self._close_window()
        return True

    def exit_app(self):
        """Close (X / Exit). Whatever was reached so far is already saved,
        so the next launch resumes from the same step."""
        self.stop_prefill()
        self.result = {"completed": False, "server": "", "symbol": ""}
        self._close_window()
        return True


def _wizard_process(result_queue, log_lock=None):
    """Child-process body: owns its own webview loop."""
    import webview  # imported here so the parent never pays for it twice
    from logger_setup import setup_logger

    logger, _ = setup_logger(file_lock=log_lock)
    setup_dir = os.path.join(_PROJECT_ROOT, SETUP_STATE_DIR)

    bridge = SetupBridge(logger, setup_dir, OUTPUT_DIR, SYMBOL_LIST_DIR, _PROJECT_ROOT, log_lock=log_lock)
    window = webview.create_window(
        _WINDOW_TITLE,
        _GET_STARTED_HTML,
        js_api=bridge,
        width=1180, height=820, min_size=(940, 660),
        background_color="#0a0e17",
        frameless=True,
        # Native drag behavior introduced in V66.1 remains unchanged in V66.2.
        # Dragging is done by win_drag.WindowDragger via bridge.drag_begin().
        easy_drag=False,
    )
    bridge.set_window(window)
    try:
        webview.start()
    finally:
        bridge.stop_prefill()
        try:
            result_queue.put(bridge.result)
        except Exception:
            pass


def ensure_setup(logger, log_lock=None):
    """Show the Get Started window when the app has no data yet.

    Returns True when the app may continue starting normally, False when the
    user closed the wizard before finishing (the app then exits, and the
    wizard resumes from the same step next time).
    """
    setup_dir = os.path.join(_PROJECT_ROOT, SETUP_STATE_DIR)
    if not setup_state.needs_setup(setup_dir, OUTPUT_DIR):
        return True

    logger.info("No completed setup found - opening the Get Started window.")
    result_queue = mp.Queue()
    proc = mp.Process(target=_wizard_process, args=(result_queue, log_lock), name="get-started")
    proc.start()
    proc.join()
    try:
        result = result_queue.get_nowait()
    except Exception:
        result = {"completed": False}
    if not result.get("completed"):
        logger.info("Get Started was closed before the setup was finished; exiting.")
        return False
    register_sensitive_values(logger, result.get("server"))
    logger.info(
        f"Get Started finished (server: {result.get('server')}, symbol: {result.get('symbol')})."
    )
    return True
