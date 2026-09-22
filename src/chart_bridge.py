# -*- coding: utf-8 -*-
import ctypes
import json
import os
import sqlite3
import sys
import threading
import time
from datetime import datetime

import webview

from logger_setup import current_log_path, SessionLogBuffer
import candle_aggregator
import candle_cache
import symbol_manager
import tick_store
from runtime_paths import PROJECT_ROOT as _PROJECT_ROOT, RESOURCE_ROOT as _RESOURCE_ROOT
from config import (
    OUTPUT_DIR,
    CHART_TIMEFRAMES_SECONDS,
    CHART_INITIAL_CANDLES,
    CHART_LAZY_LOAD_CHUNK,
    LOG_PANEL_INITIAL_BYTES,
)

# v61.1: how many of the newest live candles (per timeframe) the window process
# keeps in RAM as a "live overlay" - see ChartBridge.ingest_live_candles().
# The candle cache is only flushed every CANDLE_CACHE_REFRESH_INTERVAL_SECONDS,
# so the overlay only has to cover a few flush intervals; 512 candles is
# ~8.5 minutes of 1s candles (the densest timeframe) and a few KB of RAM.
_LIVE_OVERLAY_MAX_PER_TF = 512

# v66.4: the Setting panel's About tab reads its body text straight from this
# Markdown file (web/About.md) rather than from any hardcoded HTML, so the
# text can be edited without touching index.html - see get_about_text() below
# and web/js/about-panel.js, which renders the returned Markdown client-side.
_ABOUT_MD_PATH = os.path.join(_RESOURCE_ROOT, "web", "About.md")


def _open_readonly_connection(db_path):
    """(v57 Update 2) Open the read-only connection ChartBridge uses for
    every query the frontend triggers, with a page cache and mmap window
    sized for a data file that can now legitimately hold hundreds of days
    of 1-second candles - the sqlite3 default page cache (2MB) meant even
    an already-bounded, indexed read could still fault a lot of pages back
    in from disk on a large file. Purely a disk-I/O smoothing measure, on
    top of (not a replacement for) the _build_recent_hybrid() fix in this
    module that removes the unbounded read/merge itself."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)
    try:
        conn.execute("PRAGMA cache_size = -40000")  # ~40 MB page cache
        conn.execute("PRAGMA mmap_size = 268435456")  # 256 MB memory-mapped I/O
        conn.execute("PRAGMA temp_store = MEMORY")
    except Exception:
        pass
    return conn


def _candles_to_dicts(candles, limit):
    if limit and len(candles) > limit:
        candles = candles[-limit:]
    return [
        {
            "time": c.bucket_start_ms // 1000,
            "open": c.open,
            "high": c.high,
            "low": c.low,
            "close": c.close,
        }
        for c in candles
    ]


# ----------------------------------------------------------------------
# v53.1: raw Win32 geometry helpers for the custom frameless title bar's
# maximize/restore and resize-grip support (see ChartBridge.window_* below).
#
# Why not just use pywebview's own Window.move()/resize()? Because on the
# WinForms backend a frameless window's Window.x/y/width/height getters
# just echo back whatever was last *set* through pywebview, rather than
# re-querying the OS - so any attempt to self-calibrate against a DWM/
# resize-border offset by reading those properties back reads the same
# numbers we just wrote and "corrects" nothing (this is exactly the bug
# the user kept seeing: the close button still sat a hair inside the
# right edge with only a sliver of gap on the left). Going straight to
# GetWindowRect/SetWindowPos on the actual HWND gives the OS's real,
# current pixel geometry and sets it with pixel-perfect precision,
# sidestepping that whole layer.
# ----------------------------------------------------------------------
_IS_WINDOWS = sys.platform == "win32"

if _IS_WINDOWS:
    import ctypes.wintypes as _wintypes

    # v53.2: on 64-bit Windows, HWND/HMONITOR are 64-bit pointers. Without
    # explicit argtypes/restypes, ctypes assumes plain 32-bit c_int for
    # every arg and return value of a windll function, which silently
    # truncates those pointers - this was the real cause of maximize
    # suddenly doing *nothing* the moment MonitorFromWindow's return value
    # (an HMONITOR) got threaded through GetMonitorInfoW: the truncated
    # handle is invalid, the call fails, and the surrounding try/except
    # swallowed it into a debug-log line the user never saw. Declaring the
    # real prototypes below fixes that at the root instead of guessing at
    # symptoms again.
    _user32 = ctypes.windll.user32

    class _RECT(ctypes.Structure):
        _fields_ = [
            ("left", ctypes.c_long), ("top", ctypes.c_long),
            ("right", ctypes.c_long), ("bottom", ctypes.c_long),
        ]

    class _MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", _wintypes.DWORD),
            ("rcMonitor", _RECT),
            ("rcWork", _RECT),
            ("dwFlags", _wintypes.DWORD),
        ]

    _HMONITOR = getattr(_wintypes, "HMONITOR", ctypes.c_void_p)

    _user32.FindWindowW.restype = _wintypes.HWND
    _user32.FindWindowW.argtypes = [_wintypes.LPCWSTR, _wintypes.LPCWSTR]

    _user32.GetWindowRect.restype = _wintypes.BOOL
    _user32.GetWindowRect.argtypes = [_wintypes.HWND, ctypes.POINTER(_RECT)]

    _user32.SetWindowPos.restype = _wintypes.BOOL
    _user32.SetWindowPos.argtypes = [
        _wintypes.HWND, _wintypes.HWND,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        ctypes.c_uint,
    ]

    _user32.MonitorFromWindow.restype = _HMONITOR
    _user32.MonitorFromWindow.argtypes = [_wintypes.HWND, ctypes.c_uint]

    _user32.GetMonitorInfoW.restype = _wintypes.BOOL
    _user32.GetMonitorInfoW.argtypes = [_HMONITOR, ctypes.POINTER(_MONITORINFO)]

    _SWP_NOZORDER = 0x0004
    _SWP_NOACTIVATE = 0x0010
    # HWND_TOPMOST / HWND_NOTOPMOST from the Win32 headers: (HWND)-1 /
    # (HWND)-2. Passed as plain Python ints - ctypes' pointer-argument
    # conversion (PyLong_AsVoidPtr under the hood) reinterprets a negative
    # int as its unsigned bit pattern, which is exactly what these two
    # sentinel "handles" are; no separate HWND(...) wrapper needed.
    _HWND_TOPMOST = -1
    _HWND_NOTOPMOST = -2
    _MONITOR_DEFAULTTONEAREST = 2

    def _win32_get_rect(hwnd):
        rect = _RECT()
        _user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return rect.left, rect.top, rect.right, rect.bottom

    def _win32_set_rect(hwnd, x, y, w, h, topmost=None):
        """topmost=True raises the window above the taskbar's own z-order
        (used for maximize, so the window fully covers the taskbar the
        way the old accidental-fullscreen maximize did); topmost=False
        drops it back to normal (used on restore); None leaves the
        current z-order alone (used for the resize grips)."""
        if topmost is True:
            insert_after, flags = _HWND_TOPMOST, _SWP_NOACTIVATE
        elif topmost is False:
            insert_after, flags = _HWND_NOTOPMOST, _SWP_NOACTIVATE
        else:
            insert_after, flags = 0, _SWP_NOZORDER | _SWP_NOACTIVATE
        _user32.SetWindowPos(
            hwnd, insert_after, int(x), int(y), int(w), int(h), flags,
        )

    def _win32_work_area(hwnd):
        """The monitor's work area (screen minus taskbar)."""
        monitor = _user32.MonitorFromWindow(hwnd, _MONITOR_DEFAULTTONEAREST)
        info = _MONITORINFO()
        info.cbSize = ctypes.sizeof(_MONITORINFO)
        _user32.GetMonitorInfoW(monitor, ctypes.byref(info))
        wa = info.rcWork
        return wa.left, wa.top, wa.right - wa.left, wa.bottom - wa.top

    def _win32_full_monitor(hwnd):
        """The monitor's full bounds, taskbar included - used for
        'maximize' so the window covers the whole screen the same way the
        old accidental-fullscreen behavior did (the user specifically
        asked to keep that over the taskbar-respecting work area)."""
        monitor = _user32.MonitorFromWindow(hwnd, _MONITOR_DEFAULTTONEAREST)
        info = _MONITORINFO()
        info.cbSize = ctypes.sizeof(_MONITORINFO)
        _user32.GetMonitorInfoW(monitor, ctypes.byref(info))
        rm = info.rcMonitor
        return rm.left, rm.top, rm.right - rm.left, rm.bottom - rm.top

    def _win32_find_hwnd(title):
        hwnd = _user32.FindWindowW(None, title)
        return hwnd or None

class ChartBridge:
    def log_frontend(self, event, payload=""):
        """Compatibility no-op for retired verbose frontend diagnostics."""
        return None

    def __init__(self, db_path, logger, drawing_store=None, style_store=None, canvas_settings_store=None, keyboard_shortcuts_store=None, config_store=None, backfill_cmd_queue=None, symbol=None, server="unknown-server", symbol_list=None, switch_symbol_callback=None, log_path=None):
        self._db_path = db_path
        # v67.3: the in-app Log feed is backed by this process's bounded
        # in-memory session buffer, not by the shared daily disk file. This
        # keeps previous executions out of the UI and keeps the UI functional
        # when disk logging is disabled.
        self._log_path = log_path
        self._session_log_buffer = getattr(logger, "_tick_session_log_buffer", None)
        if not isinstance(self._session_log_buffer, SessionLogBuffer):
            self._session_log_buffer = None
        self._symbol = symbol
        self._server = server
        self._symbol_list = list(symbol_list or [])
        self._switch_symbol_callback = switch_symbol_callback
        self._logger = logger
        self._lock = threading.Lock()
        # v53: pywebview Window instance, set later via set_window() once
        # app.py has actually created it (the bridge exists before the
        # window does). Backs the custom title bar's minimize/maximize/
        # close buttons and the drag-handle-driven resize grips - see
        # window_minimize/window_toggle_maximize/window_close/window_resize
        # below and #custom-titlebar in index.html.
        self._window = None
        self._maximized = False
        self._restore_geometry = None
        # v69: About-tab update download/apply state - see
        # check_for_updates/start_update_download/apply_update_now below.
        self._update_download_thread = None
        self._update_cancel_event = None
        self._pending_update_info = None
        # v33: optional — passed in from app.py. Kept optional (rather than
        # required) so any other embedder of ChartBridge that doesn't care
        # about drawing persistence still works unchanged.
        self._drawing_store = drawing_store
        # v37: optional, same reasoning — persists the drawing tool's style
        # defaults/presets (see style_store.py).
        self._style_store = style_store
        # v50.1: optional, same reasoning — persists the Setting panel's
        # Canvas tab settings/presets (see canvas_settings_store.py).
        self._canvas_settings_store = canvas_settings_store
        # v51: Keyboard Shortcuts tab bindings (see keyboard_shortcuts_store.py).
        self._keyboard_shortcuts_store = keyboard_shortcuts_store
        # v52: optional, same reasoning — persists the Setting panel's
        # Configuration tab overrides (see config_store.py).
        self._config_store = config_store
        # v44: optional — the window->sync-process command queue used to
        # ask for a Backfill (see sync_process._process_backfill_request).
        # ChartBridge itself never touches MT5; it only enqueues the
        # request and returns immediately. Optional for the same reason as
        # the stores above.
        self._backfill_cmd_queue = backfill_cmd_queue

        self._conn = _open_readonly_connection(db_path)

        # v61.1: tiny in-RAM overlay of the newest live candles per timeframe,
        # fed by app.py's live-queue consumer (ingest_live_candles). It has its
        # own lock so the consumer thread never waits behind a slow SQLite read
        # holding self._lock. Layout: {tf_seconds: {time_seconds: candle_dict}}.
        self._live_overlay = {}
        self._live_overlay_lock = threading.Lock()
        # V64: newest live ASK (display-only, RAM only, never persisted).
        self._live_ask = None

    def get_config(self):

        return {
            # v48 Update 1: the header badge used to show a hardcoded
            # "XAUUSD" regardless of config.py, so it never reflected the
            # user's actual SYMBOL setting. It now reads this field (see
            # web/js/chart-core.js's init()) instead of a static string.
            "symbol": self._symbol,
            "symbols": list(self._symbol_list),
            "cached_symbols": list(self.get_cached_symbols()),
            "timeframes_seconds": list(CHART_TIMEFRAMES_SECONDS),
            "initial_candles": CHART_INITIAL_CANDLES,
            "lazy_load_chunk": CHART_LAZY_LOAD_CHUNK,
        }

    def get_cached_symbols(self):
        """v65.2: which symbols in the current dropdown already have a candle
        database on disk for this broker server - used to pin them to the
        top of the symbol picker. Cheap (one directory listing), so it is
        safe to call again whenever the symbol list itself changes."""
        with self._lock:
            symbols, server = list(self._symbol_list), self._server
        return sorted(tick_store.list_cached_symbols(OUTPUT_DIR, server, symbols))

    def set_symbol_list(self, symbol_list):
        """Replace the symbol dropdown contents (V62: discovered in the background)."""
        with self._lock:
            self._symbol_list = list(symbol_list or [])

    def set_sync_log_path(self, path):
        """Compatibility no-op retained for older embedders.

        V67.3 uses one shared daily log for every process, so there is no
        second sync-specific path to register anymore.
        """
        return True

    def apply_identity(self, server, symbol, symbol_list, db_path):
        """Point the bridge at another broker server's database (V62).

        Same connection swap as set_symbol(), but the server changes too.
        Called by app.py when the background sync process reports that the
        logged-in account is not on the server the window started with.
        """
        with self._lock:
            self._conn.close()
            self._conn = _open_readonly_connection(db_path)
            self._db_path = db_path
            self._server = server
            self._symbol = symbol
            self._symbol_list = list(symbol_list or [])
            self.clear_live_overlay()
            if self._drawing_store is not None and hasattr(self._drawing_store, "set_symbol"):
                self._drawing_store.set_symbol(symbol)

    def get_symbols(self):
        return {"server": self._server, "symbols": list(self._symbol_list), "selected": self._symbol}

    def set_symbol(self, symbol):
        symbol = str(symbol or "").strip()
        if not symbol or symbol not in [x.get("symbol") for x in self._symbol_list if isinstance(x, dict)]:
            return {"ok": False, "error": "symbol_not_available"}
        if symbol == self._symbol:
            return {"ok": True, "symbol": symbol, "changed": False}
        if self._switch_symbol_callback is None:
            return {"ok": False, "error": "symbol_switch_unavailable"}
        try:
            new_db_path = self._switch_symbol_callback(symbol)
            with self._lock:
                self._conn.close()
                self._conn = _open_readonly_connection(new_db_path)
                self._db_path = new_db_path
                self._symbol = symbol
                self.clear_live_overlay()
                if self._drawing_store is not None and hasattr(self._drawing_store, "set_symbol"):
                    self._drawing_store.set_symbol(symbol)
            symbol_manager.save_selected_symbol(OUTPUT_DIR, self._server, symbol, self._logger)
            return {"ok": True, "symbol": symbol, "changed": True}
        except Exception as e:
            self._logger.warning(f"set_symbol: failed to switch to {symbol}: {e}")
            return {"ok": False, "error": "switch_failed"}

    def get_history_set(self, timeframe_seconds=None, limit=None):
        """Return a bounded latest partition.

        v30: when ``timeframe_seconds`` is supplied, only that timeframe is
        built. This prevents startup/timeframe switches from retaining unused
        timeframe arrays in the browser process. The no-argument form is kept
        for compatibility with older callers.

        v61: timeframe history is fully candle-backed. The live sync process
        owns the transient MT5 tick arrays and pushes the still-forming candle
        state separately, so this GUI-side history request never reads raw ticks.

        v61.1: the cache tail can be up to CANDLE_CACHE_REFRESH_INTERVAL_SECONDS
        stale, so the newest live candles remembered by ingest_live_candles()
        are laid over it (see _merge_live_overlay) - the switch-timeframe gap
        fix, still with zero raw-tick reads.
        """
        effective_limit = CHART_INITIAL_CANDLES if limit is None else max(1, int(limit))
        if timeframe_seconds is None:
            timeframes = sorted(set(int(t) for t in CHART_TIMEFRAMES_SECONDS))
        else:
            try:
                timeframes = [int(timeframe_seconds)]
            except (TypeError, ValueError):
                return {}

        result = {}
        with self._lock:
            for tf in timeframes:
                try:
                    candles = self._build_recent_hybrid(tf, effective_limit)
                except Exception as e:
                    self._logger.warning(f"get_history_set: failed to build {tf}s candles: {e}")
                    candles = []
                result[str(tf)] = self._merge_live_overlay(
                    tf, _candles_to_dicts(candles, None), limit=effective_limit
                )
        return result

    # ---- v61.1: live overlay (fixes the timeframe-switch gap) ---------------
    def ingest_live_candles(self, message):
        """Remember the newest live candles the sync process pushed.

        v61.1 fix for the "candle gap after switching timeframe" bug (same
        symptom as v56.4, new cause). Since v61 the raw ticks are gone from
        SQLite, and the still-unflushed candles live only in the sync
        process's RAM; the candles_1s/5s/... tables are refreshed every
        CANDLE_CACHE_REFRESH_INTERVAL_SECONDS. A history request landing between
        two flushes therefore returned a partition that stopped a few seconds
        in the past, while the very next live push carried the *current*
        candles - so the chart showed a time/price gap that vanished on reload.

        The fix needs no extra SQLite writes and no tick reads: every live
        "candles" message already crosses into this process (app.py's queue
        consumer), so it is recorded here (a dict update per candle, capped at
        _LIVE_OVERLAY_MAX_PER_TF per timeframe) and get_history_set() /
        get_candles_after() lay it over the cache tail. Called from the
        consumer thread for EVERY candles message, before the consumer's
        coalescing, so no candle is lost to it.
        """
        try:
            if (message or {}).get("type") != "candles":
                return
            msg_symbol = message.get("symbol")
            if msg_symbol and msg_symbol != self._symbol:
                return  # stale message from the previous symbol's sync process
            data = message.get("data") or {}
            with self._live_overlay_lock:
                for tf_key, candles in data.items():
                    try:
                        tf = int(tf_key)
                    except (TypeError, ValueError):
                        continue
                    if not candles:
                        continue
                    per_tf = self._live_overlay.setdefault(tf, {})
                    for c in candles:
                        per_tf[int(c["time"])] = c
                    excess = len(per_tf) - _LIVE_OVERLAY_MAX_PER_TF
                    if excess > 0:
                        for old_time in sorted(per_tf)[:excess]:
                            del per_tf[old_time]
        except Exception as e:
            self._logger.debug(f"ingest_live_candles failed: {e}")

    def clear_live_overlay(self):
        with self._live_overlay_lock:
            self._live_overlay.clear()
        self._live_ask = None

    # ---- V64: live ASK (display-only) -----------------------------------------
    def ingest_live_ask(self, message):
        """Remember the newest ASK the sync process pushed; return it if fresh.

        The ASK is only ever drawn as a line on the chart. It is kept in one
        attribute (RAM), never written to SQLite, so a page that (re)loads while
        the market is quiet can still ask for it via get_live_ask().
        """
        try:
            msg_symbol = (message or {}).get("symbol")
            if msg_symbol and msg_symbol != self._symbol:
                return None  # stale message from the previous symbol's sync process
            ask = float((message or {}).get("data"))
            if not (ask > 0.0):
                return None
            self._live_ask = ask
            return ask
        except Exception as e:
            self._logger.debug(f"ingest_live_ask failed: {e}")
            return None

    def get_live_ask(self):
        """Newest known ASK for the selected symbol, or None (JS: page start-up)."""
        return self._live_ask

    def _merge_live_overlay(self, tf, base, limit=None, min_time=None):
        """Lay the live overlay over a cache-built list of candle dicts.

        Only overlay candles at or after the cache's newest candle (and at or
        after ``min_time`` when given) are used - everything older is already
        in the cache. On the same bucket the overlay wins, because the sync
        process always flushes the cache *before* pushing, so the overlay is
        never older than the cache for a bucket both contain.
        """
        with self._live_overlay_lock:
            per_tf = self._live_overlay.get(tf)
            if not per_tf:
                return base
            floor = base[-1]["time"] if base else None
            if min_time is not None and (floor is None or min_time > floor):
                floor = min_time
            tail = [per_tf[t] for t in sorted(per_tf) if floor is None or t >= floor]
        if not tail:
            return base
        if base and base[-1]["time"] >= tail[0]["time"]:
            base = [c for c in base if c["time"] < tail[0]["time"]]
        merged = base + tail
        if limit and len(merged) > limit:
            merged = merged[-limit:]
        return merged

    def _build_recent_hybrid(self, tf, limit):
        """Return the latest bounded partition from the persisted candle cache.

        v61 removes raw-tick reads from the window process entirely. The sync
        process keeps the live edge responsive through its live candle queue;
        history reads therefore stay purely candle-backed and bounded.
        """
        return candle_cache.build_recent_candles_from_cache(self._conn, tf, limit)

    def get_candles_after(self, after_by_tf):
        """Return candle-cache rows newer than the frontend's last candle.

        v61: this gap-fill path is candle-only. Raw ticks are owned solely by
        the sync process and never enter the GUI process or SQLite file.
        """
        result = {}
        with self._lock:
            for tf_key, after_time in (after_by_tf or {}).items():
                try:
                    tf = int(tf_key)
                except (TypeError, ValueError):
                    continue
                try:
                    if after_time is None:
                        candles = candle_cache.build_recent_candles_from_cache(
                            self._conn, tf, CHART_INITIAL_CANDLES
                        )
                    else:
                        lower_ms = (int(after_time) + tf) * 1000
                        if candle_cache.has_direct_table(tf):
                            candles = candle_cache.load_cached_candles_direct(
                                self._conn, tf, time_from_ms=lower_ms
                            ) or []
                        else:
                            last_cached = candle_cache.get_last_cached_bucket_start_ms(self._conn)
                            if last_cached is None or lower_ms > last_cached:
                                candles = []
                            else:
                                base_1s = candle_cache.load_cached_1s_candles(
                                    self._conn, time_from_ms=lower_ms, time_to_ms=last_cached
                                )
                                candles = (
                                    base_1s if tf == 1
                                    else candle_aggregator.merge_candles(
                                        base_1s, base_bucket_ms=1000, factor=tf
                                    )
                                )
                                candles = [c for c in candles if c.bucket_start_ms >= lower_ms]
                except Exception as e:
                    self._logger.warning(f"get_candles_after: failed to build {tf}s candles: {e}")
                    candles = []
                min_time = None if after_time is None else int(after_time) + tf
                result[str(tf)] = self._merge_live_overlay(
                    tf, _candles_to_dicts(candles, None),
                    limit=CHART_INITIAL_CANDLES if after_time is None else None,
                    min_time=min_time,
                )
        return result

    def get_oldest_history_partition(self, timeframe_seconds, limit=None):
        """Return the oldest bounded candle partition for HOME."""
        try:
            timeframe_seconds = int(timeframe_seconds)
        except (TypeError, ValueError):
            return []
        effective_limit = CHART_LAZY_LOAD_CHUNK if limit is None else max(1, int(limit))
        with self._lock:
            try:
                candles = candle_cache.build_oldest_candles_from_cache(
                    self._conn, timeframe_seconds, effective_limit
                )
            except Exception as e:
                self._logger.warning(f"get_oldest_history_partition: failed: {e}")
                return []
        return _candles_to_dicts(candles, None)

    def get_history_bounds(self, timeframe_seconds):
        """Return the true available output-candle time range in SQLite."""
        try:
            timeframe_seconds = int(timeframe_seconds)
        except (TypeError, ValueError):
            return {"first_time": None, "last_time": None}
        with self._lock:
            try:
                # v34: 1s/5s/15s each read their own dedicated table now
                # (see candle_cache.get_history_bounds_from_cache), instead
                # of always computing bounds off candles_1s.
                first_time, last_time = candle_cache.get_history_bounds_from_cache(
                    self._conn, timeframe_seconds
                )
                return {"first_time": first_time, "last_time": last_time}
            except Exception as e:
                self._logger.warning(f"get_history_bounds: failed: {e}")
                return {"first_time": None, "last_time": None}

    def get_history_window(self, timeframe_seconds, target_time, limit=None):
        """Return one bounded partition ending at target plus one after it."""
        try:
            timeframe_seconds = int(timeframe_seconds)
            target_time = int(target_time)
        except (TypeError, ValueError):
            return {"before": [], "after": [], "target_time": None}
        effective_limit = CHART_LAZY_LOAD_CHUNK if limit is None else max(1, int(limit))
        with self._lock:
            try:
                result = candle_cache.build_candle_window_from_cache(
                    self._conn, timeframe_seconds, target_time * 1000,
                    effective_limit, effective_limit
                )
            except Exception as e:
                self._logger.warning(f"get_history_window: failed to build window: {e}")
                return {"before": [], "after": [], "target_time": None}
        return {
            "before": _candles_to_dicts(result.get("before", []), None),
            "after": _candles_to_dicts(result.get("after", []), None),
            "target_time": result.get("target_time"),
        }

    def get_history_page_after(self, timeframe_seconds, after_time, limit=None):
        """Return up to ``limit`` candles strictly newer than ``after_time``.

        v30 sliding-window support. This is the forward counterpart of
        get_history_page(): the frontend uses it when the user reaches the
        right edge while browsing older partitions. The read stays bounded
        to one partition, so moving toward the live edge never materializes
        the whole missing history in RAM.
        """
        try:
            timeframe_seconds = int(timeframe_seconds)
            after_time_ms = int(after_time) * 1000
        except (TypeError, ValueError):
            self._logger.warning(
                f"get_history_page_after: invalid args timeframe_seconds={timeframe_seconds!r} after_time={after_time!r}"
            )
            return []

        if timeframe_seconds < 1:
            self._logger.warning(
                f"get_history_page_after: timeframe_seconds must be >= 1, got {timeframe_seconds}"
            )
            return []

        effective_limit = CHART_LAZY_LOAD_CHUNK if limit is None else max(1, int(limit))
        with self._lock:
            try:
                candles = candle_cache.build_candles_page_after_from_cache(
                    self._conn, timeframe_seconds, after_time_ms, effective_limit
                )
                last_cached_ms = candle_cache.get_last_cached_bucket_start_ms(self._conn)
            except Exception as e:
                self._logger.warning(f"get_history_page_after: failed to build candles: {e}")
                return []

            payload = _candles_to_dicts(candles, None)
            if last_cached_ms is None:
                is_latest = not payload
            else:
                latest_bucket_ms = (last_cached_ms // (timeframe_seconds * 1000)) * (timeframe_seconds * 1000)
                is_latest = bool(payload) and payload[-1]["time"] * 1000 >= latest_bucket_ms
        return {"candles": payload, "is_latest": is_latest}

    def get_history_page(self, timeframe_seconds, before_time, limit=None):

        try:
            timeframe_seconds = int(timeframe_seconds)
            before_time_ms = int(before_time) * 1000
        except (TypeError, ValueError):
            self._logger.warning(
                f"get_history_page: invalid args timeframe_seconds={timeframe_seconds!r} before_time={before_time!r}"
            )
            return []

        if timeframe_seconds < 1:
            self._logger.warning(f"get_history_page: timeframe_seconds must be >= 1, got {timeframe_seconds}")
            return []

        effective_limit = CHART_LAZY_LOAD_CHUNK if limit is None else int(limit)

        with self._lock:
            try:
                candles = candle_cache.build_candles_page_from_cache(
                    self._conn, timeframe_seconds, before_time_ms, effective_limit
                )
                first_cached_ms = candle_cache.get_first_cached_bucket_start_ms(self._conn)
            except Exception as e:
                self._logger.warning(f"get_history_page: failed to build candles: {e}")
                return []

            payload = _candles_to_dicts(candles, None)
            if not payload or first_cached_ms is None:
                is_oldest = not payload
            else:
                bucket_ms = timeframe_seconds * 1000
                first_output_ms = (first_cached_ms // bucket_ms) * bucket_ms
                is_oldest = payload[0]["time"] * 1000 <= first_output_ms
        return {"candles": payload, "is_oldest": is_oldest}

    def get_history(self, timeframe_seconds, limit=None):

        try:
            timeframe_seconds = int(timeframe_seconds)
        except (TypeError, ValueError):
            self._logger.warning(f"get_history: invalid timeframe_seconds={timeframe_seconds!r}")
            return []

        if timeframe_seconds < 1:
            self._logger.warning(f"get_history: timeframe_seconds must be >= 1, got {timeframe_seconds}")
            return []

        with self._lock:
            try:
                candles = candle_cache.build_candles_from_cache(self._conn, timeframe_seconds)
            except Exception as e:
                self._logger.warning(f"get_history: failed to build candles: {e}")
                return []

        return _candles_to_dicts(candles, limit)

    # ---- v33: drawn-object persistence (trend lines, rectangles, etc.) ----
    # v33.1: also carries Object Tree folders (Fix 4) alongside objects.
    def get_drawings(self):
        """Return the previously-saved drawing state for this symbol — a
        dict with ``objects`` and ``folders`` — called once by the frontend
        at startup (drawing-persistence.js) to repopulate App.drawObjects
        and App.objectFolders."""
        if self._drawing_store is None:
            return {"objects": [], "folders": []}
        try:
            return self._drawing_store.load()
        except Exception as e:
            self._logger.warning(f"get_drawings: failed: {e}")
            return {"objects": [], "folders": []}

    def save_drawings(self, objects, folders=None):
        """Overwrite the on-disk store with the frontend's current full set
        of drawn objects and Object Tree folders. Called (debounced) after
        every create/move/resize/style/lock/hide/delete/rename/folder
        change — see drawing-persistence.js."""
        if self._drawing_store is None:
            return False
        try:
            return self._drawing_store.save(objects, folders)
        except Exception as e:
            self._logger.warning(f"save_drawings: failed: {e}")
            return False

    # ---- v37: drawing-tool style defaults/presets persistence -------------
    def get_style_settings(self):
        """Return the previously-saved style settings — a dict with
        ``defaults`` (per-object-type current default style) and
        ``presets`` (per-object-type named presets) — called once by the
        frontend at startup (style-defaults.js) to repopulate its in-memory
        cache."""
        if self._style_store is None:
            return {"defaults": {}, "presets": {}}
        try:
            return self._style_store.load()
        except Exception as e:
            self._logger.warning(f"get_style_settings: failed: {e}")
            return {"defaults": {}, "presets": {}}

    def save_style_settings(self, settings):
        """Overwrite the on-disk store with the frontend's current full set
        of per-type default styles and named presets. Called (debounced)
        whenever either changes — see style-defaults.js."""
        if self._style_store is None:
            return False
        try:
            settings = settings or {}
            defaults = settings.get("defaults") if isinstance(settings, dict) else None
            presets = settings.get("presets") if isinstance(settings, dict) else None
            return self._style_store.save(
                defaults if isinstance(defaults, dict) else {},
                presets if isinstance(presets, dict) else {},
            )
        except Exception as e:
            self._logger.warning(f"save_style_settings: failed: {e}")
            return False

    # ---- v50.1: Canvas tab settings/presets persistence --------------------
    def get_canvas_settings(self):
        """Return the previously-saved Canvas tab state — a dict with
        ``settings`` (current field values) and ``presets`` (user-saved
        named Canvas presets) — called once by the frontend at startup
        (canvas-settings.js) to repopulate its in-memory cache."""
        if self._canvas_settings_store is None:
            return {"settings": {}, "presets": []}
        try:
            return self._canvas_settings_store.load()
        except Exception as e:
            self._logger.warning(f"get_canvas_settings: failed: {e}")
            return {"settings": {}, "presets": []}

    def save_canvas_settings(self, settings):
        """Overwrite the on-disk store with the frontend's current Canvas
        tab field values and named presets. Called (debounced) whenever
        either changes — see canvas-settings.js."""
        if self._canvas_settings_store is None:
            return False
        try:
            settings = settings or {}
            fields = settings.get("settings") if isinstance(settings, dict) else None
            presets = settings.get("presets") if isinstance(settings, dict) else None
            return self._canvas_settings_store.save(
                fields if isinstance(fields, dict) else {},
                presets if isinstance(presets, list) else [],
            )
        except Exception as e:
            self._logger.warning(f"save_canvas_settings: failed: {e}")
            return False

    # ---- v51: Keyboard Shortcuts tab bindings persistence -------------------
    def get_keyboard_shortcuts(self):
        """Return the previously-saved key bindings — a dict with
        ``bindings`` (actionId -> {ctrl, shift, alt, code} or None) —
        called once by the frontend at startup (keyboard-shortcuts.js) to
        repopulate its in-memory cache."""
        if self._keyboard_shortcuts_store is None:
            return {"bindings": {}}
        try:
            return self._keyboard_shortcuts_store.load()
        except Exception as e:
            self._logger.warning(f"get_keyboard_shortcuts: failed: {e}")
            return {"bindings": {}}

    def save_keyboard_shortcuts(self, data):
        """Overwrite the on-disk store with the frontend's current key
        bindings. Called whenever the user assigns, changes, or clears a
        shortcut — see keyboard-shortcuts.js."""
        if self._keyboard_shortcuts_store is None:
            return False
        try:
            data = data or {}
            bindings = data.get("bindings") if isinstance(data, dict) else None
            return self._keyboard_shortcuts_store.save(
                bindings if isinstance(bindings, dict) else {}
            )
        except Exception as e:
            self._logger.warning(f"save_keyboard_shortcuts: failed: {e}")
            return False

    # ---- v52: Configuration tab (config.py variable overrides) --------------
    def get_app_config(self):
        """Return everything the Configuration tab needs to render itself:
        ``defaults`` (every config.py variable's original hardcoded value,
        for the tab's built-in field metadata and for "Restore to
        Default") and ``current`` (this run's actual value for each —
        i.e. the default with any saved override already applied, since
        config.py applies overrides at import time). Called once by the
        frontend at startup (app-config.js)."""
        import config
        try:
            return {
                "defaults": dict(config.CONFIG_DEFAULTS),
                "current": {k: getattr(config, k, v) for k, v in config.CONFIG_DEFAULTS.items()},
            }
        except Exception as e:
            self._logger.warning(f"get_app_config: failed: {e}")
            return {"defaults": {}, "current": {}}

    def save_app_config(self, overrides):
        """Overwrite the on-disk store with the frontend's current
        Configuration tab field values. Called (debounced) whenever the
        user edits a field — see app-config.js. Takes effect starting
        with the next launch of the app (config.py applies overrides at
        import time, before anything else has read the old values), not
        on this already-running instance."""
        if self._config_store is None:
            return False
        try:
            overrides = overrides or {}
            return self._config_store.save(overrides if isinstance(overrides, dict) else {})
        except Exception as e:
            self._logger.warning(f"save_app_config: failed: {e}")
            return False

    def restore_app_config_defaults(self):
        """Clears every saved override (equivalent to saving an empty
        overrides dict), so the next launch starts from config.py's
        original hardcoded values again. Returns the defaults dict so the
        frontend can immediately repaint the tab without a extra round
        trip. See app-config.js's "Restore to Default" button."""
        import config
        try:
            if self._config_store is not None:
                self._config_store.save({})
            return dict(config.CONFIG_DEFAULTS)
        except Exception as e:
            self._logger.warning(f"restore_app_config_defaults: failed: {e}")
            return {}

    # ---- v67.3: app name/version (single source: src/version.py) -----------
    def get_app_info(self):
        """Return the app's display name and version tag from src/version.py
        - the one place both are defined - so the frontend (custom title
        bar, About tab) never hardcodes its own copy that could drift out
        of sync with the window title/log lines this same module drives on
        the Python side."""
        import version as app_version
        return {"name": app_version.APP_NAME, "version": app_version.VERSION,
                "title": app_version.app_title()}

    # ---- v68/v69: About tab update flow (check / download / apply) ----------
    def check_for_updates(self):
        """Called from the About tab's "Check for Updates" button (see
        about-panel.js). Hits GitHub's releases API once and compares the
        latest release tag to this build's own VERSION. pywebview runs each
        exposed api call on its own thread, so this network call never
        blocks the UI even though it's written synchronously here."""
        import version as app_version
        import update_checker
        return update_checker.check_for_update(app_version.VERSION)

    def start_update_download(self, download_url, download_size, latest_version):
        """Called once the About tab shows "update available" and the user
        clicks the download control. Runs the actual download on a
        background thread (returning immediately) and pushes progress to
        the frontend via window.evaluate_js as it goes, since a bridge
        call itself can only return once, at the very end - see
        web/js/about-panel.js's window.onUpdateDownloadProgress /
        window.onUpdateDownloadDone handlers for the JS side of this.
        Only one download runs at a time; a second click while one is
        already in flight is ignored rather than starting a race."""
        if self._update_download_thread is not None and self._update_download_thread.is_alive():
            return {"status": "already_downloading"}

        self._update_cancel_event = threading.Event()
        self._pending_update_info = None

        def _progress(downloaded, total):
            self._push_update_event("progress", {"downloaded": downloaded, "total": total})

        def _run():
            import update_installer
            try:
                exe_path = update_installer.download_update(
                    download_url, download_size, latest_version,
                    progress_callback=_progress, cancel_event=self._update_cancel_event,
                )
                self._pending_update_info = {"version": latest_version, "exe_path": exe_path}
                self._push_update_event("done", {"version": latest_version})
            except update_installer.DownloadCancelled:
                self._push_update_event("cancelled", {})
            except Exception as e:
                self._logger.warning(f"start_update_download: failed: {e}")
                self._push_update_event("error", {"message": str(e)})

        self._update_download_thread = threading.Thread(target=_run, daemon=True)
        self._update_download_thread.start()
        return {"status": "started"}

    def cancel_update_download(self):
        """Called if the user closes the progress UI mid-download. The
        background thread notices the event on its next chunk (at most
        ~256 KB later) and cleans up its partial file itself."""
        if self._update_cancel_event is not None:
            self._update_cancel_event.set()

    def apply_update_now(self):
        """Called from the "Update" button that appears once a download
        has finished. Hands off to the detached helper script (see
        update_installer.apply_pending_update_and_restart) and then closes
        this window - app.py's normal shutdown path takes it from there,
        and the helper script relaunches the (by then updated) EXE once
        this process has actually exited. If nothing has finished
        downloading yet (stale click, or the info was lost to an app
        restart), returns an error status instead of closing anything."""
        if not self._pending_update_info:
            import update_installer
            self._pending_update_info = update_installer.get_pending_update_info()
        if not self._pending_update_info:
            return {"status": "no_pending_update"}

        import update_installer
        update_installer.apply_pending_update_and_restart(self._pending_update_info, wait_pid=os.getpid())
        self.window_close()
        return {"status": "applying"}

    def _push_update_event(self, event, payload):
        """Pushes one {event, ...payload} object to
        window.onUpdateDownloadEvent in the frontend (see about-panel.js).
        Swallowed rather than raised if the window has since closed or
        the page hasn't wired up the handler yet - a missed progress tick
        is harmless, unlike every other evaluate_js call site in this
        file, which already follow the same never-raise pattern."""
        if self._window is None:
            return
        try:
            data = dict(payload)
            data["event"] = event
            self._window.evaluate_js(f"window.onUpdateDownloadEvent && window.onUpdateDownloadEvent({json.dumps(data)})")
        except Exception as e:
            self._logger.debug(f"_push_update_event failed: {e}")

    # ---- v66.4: About tab (reads web/About.md) -------------------------------
    def get_about_text(self):
        """Return the raw Markdown contents of web/About.md for the Setting
        panel's About tab to render (see about-panel.js). Read fresh every
        call (the file is tiny and only opened once per Setting-panel visit)
        so an edit to About.md shows up without restarting the app. Returns
        an empty string - the frontend just shows nothing - if the file is
        missing or unreadable, rather than raising into the webview bridge."""
        try:
            with open(_ABOUT_MD_PATH, "r", encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            self._logger.warning(f"get_about_text: failed: {e}")
            return ""

    # ---- v56.6: MT5 Terminal Path native browse dialog ----------------------
    def browse_mt5_terminal_path(self):
        """Opens the OS's native "choose file" dialog (pywebview's
        create_file_dialog, not a hand-rolled one) so the user can point
        the MT5 Terminal Path field at their terminal.exe the same way any
        other desktop app lets you browse to an executable, instead of
        typing/pasting the full path by hand. Returns the chosen path (a
        string) or None if the dialog was cancelled or no window/dialog
        support is available. All matching of the current field value
        (pre-selecting its folder) and writing the result back into the
        input happens in app-config.js - this only ever returns a path."""
        if self._window is None:
            return None
        try:
            start_dir = ""
            try:
                import config
                current_path = getattr(config, "MT5_TERMINAL_PATH", "") or ""
                if current_path:
                    start_dir = os.path.dirname(current_path)
            except Exception:
                start_dir = ""
            result = self._window.create_file_dialog(
                webview.FileDialog.OPEN,
                directory=start_dir,
                allow_multiple=False,
                file_types=("Executable (*.exe)", "All files (*.*)"),
            )
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else str(result)
        except Exception as e:
            self._logger.warning(f"browse_mt5_terminal_path: failed: {e}")
            return None

    # ---- v38.1: Market Data Overview modal ---------------------------------
    def get_db_overview(self):
        """Return the oldest and newest available 1-second candle times for
        Market Data Overview (the frontend derives the "days of history"
        figure from the oldest, and the broker's current day from the newest).

        v61.2: the Total Seconds statistic was removed - it required a
        COUNT(*) over the whole candles_1s table on every poll, which grows
        with the history and ran under self._lock. The only query left is the
        indexed MIN(bucket_start_ms) lookup.
        """
        try:
            oldest_time, newest_time = candle_cache.get_history_bounds_from_cache(self._conn, 1)
        except Exception as e:
            self._logger.warning(f"get_db_overview: failed to read oldest/newest bucket: {e}")
            oldest_time, newest_time = None, None
        # v61.3: newest_time (same indexed lookup, MAX instead of MIN only)
        # is the broker's "now" for the Market Data Overview tab - the tab
        # must not use the PC clock to decide which calendar day is today.
        return {"oldest_time": oldest_time, "newest_time": newest_time}

    def get_daily_candle_counts(self, timeframe_seconds, year, month):
        """Per-day candle counts for one calendar month (UTC), for the
        Market Data Overview modal's per-day bar histogram — one dedicated
        table lookup per configured tolerance timeframe (see
        candle_cache._TF_TABLES), never a re-aggregation from ticks.

        v65.1: kept as its own standalone bridge method for any other/future
        caller, but the histogram itself now goes through the combined
        get_month_histogram() below instead of calling this twice (once per
        tolerance) plus get_db_overview() separately - see that method's
        docstring for why."""
        try:
            timeframe_seconds = int(timeframe_seconds)
            year = int(year)
            month = int(month)
        except (TypeError, ValueError):
            return []
        with self._lock:
            try:
                return candle_cache.get_daily_candle_counts(self._conn, timeframe_seconds, year, month)
            except Exception as e:
                self._logger.warning(f"get_daily_candle_counts: failed: {e}")
                return []

    def get_month_histogram(self, timeframe_seconds, year, month):
        """v65.1: single combined call for the Market Data Overview
        histogram - replaces the three separate pywebview bridge round-trips
        loadHistogram() used to fire on every single Year/Month/Tolerance
        change: get_daily_candle_counts(tf), get_daily_candle_counts(60), and
        get_db_overview(). Each of those is individually cheap SQL (see
        get_daily_candle_counts's own v41 perf note - an indexed per-day
        COUNT(*) BETWEEN, whose cost depends only on that one day's row
        count, never on how many total days/months the database holds), but
        every pywebview call is its own JS<->Python dispatch under
        self._lock, and the panel fired three of them, back to back, for
        every single dropdown change with no de-duplication - so switching
        months several times quickly (e.g. arrow-keying through a focused
        <select>, which fires one native "change" event per keypress) queued
        up three round-trips per keypress behind self._lock, all serialized,
        and none of them cancelled even once a later one superseded it. That
        queueing (not the SQL) is what made the tab feel sluggish once a
        database held hundreds of days: the per-request COST never grew with
        history size, but the NUMBER of requests in flight at once could.

        This does the same three lookups under ONE lock acquisition, and
        skips the second COUNT() entirely when the selected tolerance IS the
        1-minute reference (the modal's default) - the two result sets would
        be byte-for-byte identical, so there is nothing to gain from asking
        twice. The frontend's own de-duplication (a request sequence number
        in market-data-overview.js) still ignores whichever of these arrives
        after it's already been superseded.
        """
        try:
            timeframe_seconds = int(timeframe_seconds)
            year = int(year)
            month = int(month)
        except (TypeError, ValueError):
            return {"counts": [], "counts1m": [], "oldest_time": None, "newest_time": None}
        with self._lock:
            try:
                counts = candle_cache.get_daily_candle_counts(self._conn, timeframe_seconds, year, month)
                counts1m = counts if timeframe_seconds == 60 else \
                    candle_cache.get_daily_candle_counts(self._conn, 60, year, month)
                oldest_time, newest_time = candle_cache.get_history_bounds_from_cache(self._conn, 1)
            except Exception as e:
                self._logger.warning(f"get_month_histogram: failed: {e}")
                return {"counts": [], "counts1m": [], "oldest_time": None, "newest_time": None}
        return {
            "counts": counts,
            "counts1m": counts1m,
            "oldest_time": oldest_time,
            "newest_time": newest_time,
        }

    def start_backfill(self, year, month, days):
        """(v44) Fire-and-forget: enqueues a Backfill request for the given
        day numbers of one calendar month onto the window->sync-process
        command queue and returns immediately. The actual work (finding
        each day's gap(s), fetching them from MT5, writing them, rebuilding
        the affected candle-cache span) happens over in sync_process.py -
        this bridge has no MT5 connection of its own. Progress/result comes
        back asynchronously as window.onBackfillStatus(...) calls, pushed
        through live_queue by app.py's queue consumer.

        Returns {"ok": True} once the request is queued, or
        {"ok": False} if there's no command queue to send it on (e.g. an
        embedder that didn't wire one up) or the days list is empty."""
        if self._backfill_cmd_queue is None:
            self._logger.warning("start_backfill: no backfill command queue is configured; ignoring request.")
            return {"ok": False}
        try:
            year = int(year)
            month = int(month)
            days = sorted(set(int(d) for d in (days or [])))
        except (TypeError, ValueError):
            return {"ok": False}
        if not days:
            return {"ok": False}
        try:
            self._backfill_cmd_queue.put_nowait({
                "type": "backfill_request",
                "year": year,
                "month": month,
                "days": days,
            })
            return {"ok": True}
        except Exception as e:
            self._logger.warning(f"start_backfill: failed to enqueue request: {e}")
            return {"ok": False}

    def start_extend(self, target_date):
        """(v46) Fire-and-forget, mirroring start_backfill() above: enqueues
        an Extend request (push the oldest available history back to
        `target_date`, a "YYYY-MM-DD" string) onto the window->sync-process
        command queue and returns immediately. The actual day-by-day MT5
        fetch and the single bounded candle-cache rebuild at the end happen
        in sync_process.py's _process_extend_request - this bridge has no
        MT5 connection of its own. Progress/result comes back asynchronously
        as window.onExtendStatus(...) calls, pushed through live_queue by
        app.py's queue consumer.

        Returns {"ok": True} once the request is queued, or {"ok": False}
        if there's no command queue configured, target_date isn't a
        well-formed "YYYY-MM-DD" string, or it isn't strictly older than
        the currently cached oldest data (mirrors the frontend's own check
        mark visibility rule, so a stale/tampered call can't slip through)."""
        if self._backfill_cmd_queue is None:
            self._logger.warning("start_extend: no backfill command queue is configured; ignoring request.")
            return {"ok": False}
        try:
            target_date = str(target_date).strip()
            datetime.strptime(target_date, "%Y-%m-%d")
        except (TypeError, ValueError):
            return {"ok": False}
        with self._lock:
            try:
                oldest_sec, _ = candle_cache.get_history_bounds_from_cache(self._conn, 1)
            except Exception as e:
                self._logger.warning(f"start_extend: failed to read oldest bucket: {e}")
                oldest_sec = None
        if oldest_sec is not None:
            oldest_date_str = datetime.utcfromtimestamp(oldest_sec).strftime("%Y-%m-%d")
            if target_date >= oldest_date_str:  # plain ISO-8601 strings compare chronologically
                self._logger.info(
                    f"start_extend: target {target_date} is not older than the current oldest data "
                    f"({oldest_date_str}); ignoring."
                )
                return {"ok": False}
        try:
            self._backfill_cmd_queue.put_nowait({
                "type": "extend_request",
                "target_date": target_date,
            })
            return {"ok": True}
        except Exception as e:
            self._logger.warning(f"start_extend: failed to enqueue request: {e}")
            return {"ok": False}

    # ------------------------------------------------------------------
    # v53: custom frameless title bar support. The native OS title bar is
    # gone (see webview.create_window(frameless=True) in app.py), so the
    # page's own #custom-titlebar strip drives window movement (via the
    # ".pywebview-drag-region" CSS class - handled natively by pywebview,
    # no python call involved) and these three window actions plus the
    # edge/corner resize grips below.
    # ------------------------------------------------------------------
    def set_window(self, window, title=None):
        self._window = window
        # v53.1: the exact title string the window was created with, used
        # to locate its real OS HWND via FindWindowW - see the _win32_*
        # helpers above. The app never calls window.set_title() at
        # runtime (confirmed: no such call anywhere in this codebase), so
        # this stays valid for the whole run even after a symbol switch.
        self._window_title = title
        self._hwnd_cache = None

    def _hwnd(self):
        if not _IS_WINDOWS or not self._window_title:
            return None
        if self._hwnd_cache:
            return self._hwnd_cache
        try:
            hwnd = _win32_find_hwnd(self._window_title)
        except Exception as e:
            self._logger.debug(f"_hwnd lookup failed: {e}")
            hwnd = None
        self._hwnd_cache = hwnd
        return hwnd

    def window_minimize(self):
        if self._window is None:
            return
        try:
            self._window.minimize()
        except Exception as e:
            self._logger.debug(f"window_minimize failed: {e}")

    def window_close(self):
        if self._window is None:
            return
        try:
            self._window.destroy()
        except Exception as e:
            self._logger.debug(f"window_close failed: {e}")

    def window_toggle_maximize(self):
        """Pseudo-maximize/restore. pywebview frameless windows don't wire
        up to the OS's real maximize (see project notes / upstream
        pywebview issue #1420 - it behaves like fullscreen instead), so
        this fakes it: remembers the current geometry, then resizes/moves
        the window to cover the current monitor's work area; a second
        call restores the remembered geometry. Returns the new
        is_maximized state so the frontend can flip the button's icon.

        Goes through the real Win32 HWND (see _win32_* helpers above)
        rather than pywebview's own move()/resize(), which is what was
        causing the persistent few-pixel offset (window creeping right,
        a barely-visible gap on the left) - pywebview's Window.x/y/width/
        height on WinForms just echo back the last values *we* set, so
        self-calibrating against them corrected nothing. GetWindowRect/
        SetWindowPos read and set the OS's actual pixel geometry.
        """
        if self._window is None:
            return False
        hwnd = self._hwnd()
        try:
            if hwnd:
                if self._maximized and self._restore_geometry:
                    x, y, w, h = self._restore_geometry
                    _win32_set_rect(hwnd, x, y, w, h, topmost=False)
                    self._maximized = False
                else:
                    l, t, r, b = _win32_get_rect(hwnd)
                    self._restore_geometry = (l, t, r - l, b - t)
                    x, y, w, h = _win32_full_monitor(hwnd)
                    _win32_set_rect(hwnd, x, y, w, h, topmost=True)
                    self._maximized = True
            else:
                # Non-Windows (or HWND not found) fallback: the older,
                # pywebview-only approach. Still self-calibrates once,
                # which is enough on platforms without the WinForms
                # echo-back quirk.
                if self._maximized and self._restore_geometry:
                    w, h, x, y = self._restore_geometry
                    self._window.resize(w, h)
                    self._window.move(x, y)
                    self._maximized = False
                else:
                    self._restore_geometry = (
                        self._window.width, self._window.height,
                        self._window.x, self._window.y,
                    )
                    screen = webview.screens[0]
                    self._window.move(0, 0)
                    self._window.resize(screen.width, screen.height)
                    self._maximized = True
        except Exception as e:
            self._logger.debug(f"window_toggle_maximize failed: {e}")
        return self._maximized

    _MIN_W, _MIN_H = 800, 500

    # v55.4: explicit custom-titlebar dragging. The previous version relied
    # on pywebview's internal .pywebview-drag-region handling, which is not
    # consistently honored by all supported backends/configurations when
    # easy_drag=False is used. Keep the same baseline+cumulative-delta model
    # as resize so movement remains exact and does not accumulate drift.
    def window_drag_begin(self):
        """Snapshot the real OS window position before a title-bar drag."""
        if self._window is None:
            return
        hwnd = self._hwnd()
        try:
            if hwnd:
                l, t, r, b = _win32_get_rect(hwnd)
                self._drag_baseline = (l, t)
            else:
                self._drag_baseline = (self._window.x, self._window.y)
            # A manual drag is a user move, so it leaves pseudo-maximized mode.
            self._maximized = False
        except Exception as e:
            self._logger.debug(f"window_drag_begin failed: {e}")
            self._drag_baseline = None

    def window_drag_move(self, dx, dy):
        """Move the frameless window by cumulative screen-pixel deltas."""
        if self._window is None or not getattr(self, "_drag_baseline", None):
            return
        try:
            x0, y0 = self._drag_baseline
            x, y = x0 + int(dx), y0 + int(dy)
            hwnd = self._hwnd()
            if hwnd:
                # Keep the current size; only the top-left position changes.
                l, t, r, b = _win32_get_rect(hwnd)
                _win32_set_rect(hwnd, x, y, r - l, b - t)
            else:
                self._window.move(x, y)
        except Exception as e:
            self._logger.debug(f"window_drag_move failed: {e}")

    def window_drag_end(self):
        self._drag_baseline = None

    def window_resize_begin(self):
        """Called on mousedown on one of the .resize-grip edge/corner
        strips in index.html - snapshots the window's geometry so every
        subsequent window_resize_move() call during that same drag can
        compute an absolute new geometry from a fixed baseline plus the
        cumulative screen-pixel delta, instead of compounding small
        per-frame deltas (which drifts under the throttling used on the
        JS side). Uses the real Win32 HWND when available - same reason
        as window_toggle_maximize above (pywebview's own Window.x/y/
        width/height don't reflect the OS's actual geometry on WinForms).
        """
        if self._window is None:
            return
        hwnd = self._hwnd()
        try:
            if hwnd:
                l, t, r, b = _win32_get_rect(hwnd)
                self._resize_baseline = (r - l, b - t, l, t)
            else:
                self._resize_baseline = (
                    self._window.width, self._window.height,
                    self._window.x, self._window.y,
                )
        except Exception as e:
            self._logger.debug(f"window_resize_begin failed: {e}")
            self._resize_baseline = None

    def window_resize_move(self, edge, dx, dy):
        """edge is one of n/s/e/w/ne/nw/se/sw. dx/dy are the cumulative
        mouse movement in screen pixels since window_resize_begin(). Grips
        on the top/left move the window as well as resizing it, so that
        edge stays under the cursor - the opposite edge/corner stays fixed
        in place, exactly like a native OS resize border.
        """
        if self._window is None or not getattr(self, "_resize_baseline", None):
            return
        try:
            w0, h0, x0, y0 = self._resize_baseline
            dx, dy = int(dx), int(dy)
            w, h, x, y = w0, h0, x0, y0
            if "e" in edge:
                w = w0 + dx
            if "s" in edge:
                h = h0 + dy
            if "w" in edge:
                w = w0 - dx
                x = x0 + dx
            if "n" in edge:
                h = h0 - dy
                y = y0 + dy
            w = max(w, self._MIN_W)
            h = max(h, self._MIN_H)
            # If a min-size clamp kicked in on an edge that also moves the
            # window, keep the fixed edge fixed rather than letting x/y
            # drift past it.
            if "w" in edge and w == self._MIN_W:
                x = x0 + (w0 - self._MIN_W)
            if "n" in edge and h == self._MIN_H:
                y = y0 + (h0 - self._MIN_H)
            hwnd = self._hwnd()
            if hwnd:
                _win32_set_rect(hwnd, x, y, w, h)
            else:
                self._window.resize(w, h)
                if "w" in edge or "n" in edge:
                    self._window.move(x, y)
            self._maximized = False
        except Exception as e:
            self._logger.debug(f"window_resize_move failed: {e}")

    def window_resize_end(self):
        self._resize_baseline = None

    def _read_log_file(self, path, start):
        """Read appended bytes from one daily log file.

        ``start`` is a byte offset. If the active system-day file changes or
        becomes smaller, the caller resets the visible tail rather than mixing
        two days.
        """
        if not path:
            return "", start, False
        try:
            size = os.path.getsize(path)
        except OSError:
            return "", start, False

        reset = False
        if start is None:
            start = max(0, size - LOG_PANEL_INITIAL_BYTES)
        elif start > size:
            start = 0
            reset = True

        try:
            with open(path, "rb") as f:
                f.seek(start)
                chunk = f.read()
        except OSError as e:
            self._logger.debug(f"read_log_tail: could not read {path!r}: {e}")
            return "", start, False

        return chunk.decode("utf-8", errors="replace"), start + len(chunk), reset

    def read_log_tail(self, offset=None):
        """Return only the current application's in-memory session log.

        The UI no longer reads the shared daily disk file. A monotonic sequence
        cursor lets the frontend fetch only newly appended records, while the
        bounded buffer makes the display memory usage predictable. The daily
        file remains an output sink for non-DATABASE records only.
        """
        buffer = self._session_log_buffer
        previous = offset or {}
        cursor = previous.get("seq")

        if buffer is not None:
            text, new_cursor, reset = buffer.read_since(
                cursor=cursor,
                initial_bytes=LOG_PANEL_INITIAL_BYTES,
            )
            return {
                "path": None,
                "text": text,
                "offset": {"seq": new_cursor},
                "reset": bool(reset),
            }

        # Compatibility fallback for embedders that construct ChartBridge
        # without the standard logger_setup session buffer.
        active_path = current_log_path()
        previous_path = previous.get("path")
        start = previous.get("offset")
        reset = bool(previous_path and previous_path != active_path)
        if reset:
            start = None
        text, new_offset, file_reset = self._read_log_file(active_path, start)
        return {
            "path": active_path,
            "text": text,
            "offset": {"path": active_path, "offset": new_offset},
            "reset": bool(reset or file_reset),
        }

    def close(self):
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass

