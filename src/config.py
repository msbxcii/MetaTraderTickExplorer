# -*- coding: utf-8 -*-

POLL_INTERVAL_SECONDS = 0.1
LOG_DIR = "logs"


OUTPUT_DIR = "output/data"

# v53: permanent per-server MT5 Symbol List files are stored here.
# Change this path if you want the Symbol List cache somewhere else.
SYMBOL_LIST_DIR = "output/data/symbol-list"

# v35.1: folder (relative to the project root) where user-drawn chart objects
# (trend lines, rectangles, horizontal/vertical lines) are persisted to disk
# — one JSON file per symbol — so they survive closing and reopening the
# app. See src/drawing_store.py.
DRAWINGS_DIR = "output/drawings"

# v37: folder (relative to the project root) where the drawing-tool style
# settings — each object type's current default style plus every
# user-saved named preset (see web/js/style-defaults.js) — are persisted to
# disk as a single JSON file, so they too survive closing and reopening the
# app instead of only living in the browser's localStorage. See
# src/style_store.py.
# v65.4: these four settings stores used to each get their own top-level
# folder directly under output/ (output/style_settings, output/
# canvas_settings/, etc.), cluttering that directory. They now share one
# parent "output/settings" folder, each still in its own subfolder so the
# four JSON files never collide.
STYLE_SETTINGS_DIR = "output/settings/style_settings"
CANVAS_SETTINGS_DIR = "output/settings/canvas_settings"
KEYBOARD_SHORTCUTS_DIR = "output/settings/keyboard_shortcuts"
APP_CONFIG_DIR = "output/settings/app_config"

# V66: where the Get Started wizard remembers how far the initial setup got
# (see src/setup_state.py). One tiny JSON file; it lives next to the other
# settings stores for the same reason they share output/settings.
SETUP_STATE_DIR = "output/settings/setup"


LOG_FILE_PREFIX = "tick_explorer"

# v67.3: disk logging is optional. Turning this off removes the daily file
# handler entirely; console output and the in-app session log remain active.
LOG_TO_DISK = True

# v67.3: Log panel initial in-memory window and browser poll cadence.
# These values are retained in config.py because chart_bridge imports them
# directly; keeping them here also preserves compatibility with earlier builds.
LOG_PANEL_INITIAL_BYTES = 20_000
LOG_PANEL_POLL_INTERVAL_MS = 1000


# v67.3: all processes share one append-only daily file named
# tick_explorer_YYYYMMDD.log when LOG_TO_DISK is enabled. DATABASE-category
# records are intentionally excluded from that file because they can be very
# numerous. The console and in-app log views still receive the complete stream.


# Size of each MT5 forward-sync batch. The returned tick array is transient
# RAM only; larger batches reduce MT5 call overhead but briefly use more RAM.
TICKS_BATCH_SIZE = 200_000

# v61.3: first-run history window. It is counted in BROKER days (the MT5
# server clock, read from the live feed - never the PC clock): the initial
# fetch starts at 00:00:00 broker time of the day HISTORY_BACKFILL_MAX_DAYS
# days before the broker's current day, so the oldest day is complete and
# the current broker day is always included (3 -> D-3, D-2, D-1 and today).
HISTORY_BACKFILL_MAX_DAYS = 3

# v61.3: catch-up (first run, and resume after the app was closed) fetches
# the missing span in bounded time chunks of this many seconds instead of
# one open-ended copy_ticks_from() call. A chunk that comes back empty makes
# the next one twice as long (up to 7 days), so a closed-market weekend is
# crossed in a couple of calls.
CATCH_UP_CHUNK_SECONDS = 6 * 3600

# v61.3: MT5 hands back only the ticks its terminal already holds locally and
# downloads the rest from the broker in the background, so a fetch made too
# early can contain a silent hole. Any span with no tick for longer than
# TICK_HOLE_THRESHOLD_SECONDS is therefore re-probed (a tiny read of just the
# hole) for TICK_SYNC_QUIET_SECONDS; if ticks show up the chunk is fetched
# again, and only a hole that stays empty for the whole quiet period is
# accepted as a real market closure. When ticks do arrive, the chunk is read
# again only after TICK_SYNC_SETTLE_SECONDS more, so a download in progress is
# not re-read on every poll. TICK_SYNC_MAX_WAIT_SECONDS caps the total time
# spent on one chunk.
TICK_HOLE_THRESHOLD_SECONDS = 120
TICK_SYNC_QUIET_SECONDS = 5.0
TICK_SYNC_SETTLE_SECONDS = 1.0
TICK_SYNC_MAX_WAIT_SECONDS = 60.0

# Diagnostic-only: when True, fetch_verified_range() logs exactly what each
# hole probe returns (row count + first/last tick timestamps) every time it
# decides a hole has "arrived" ticks and re-reads the whole chunk. Leave this
# False in normal use - it is verbose and only meant for tracking down why a
# specific gap keeps re-triggering "fetching the chunk again" in a loop.
TICK_SYNC_DEBUG = False

# v67.1: on the resume path, get_broker_now_ms() is sampled twice - once
# right before the catch-up pass starts, and again after waiting this many
# seconds - to let the broker-time value settle before it is trusted as the
# catch-up target (see the resume-path sleep in tick_explorer.py).
RESUME_BROKER_TIME_SETTLE_SECONDS = 1.5

# v61: Extend fetches this many calendar days per MT5 request and bounded
# candle-cache transaction. Raw ticks exist only inside the fetched MT5 batch
# long enough to become 1-second candles and are never persisted.
EXTEND_CHUNK_DAYS = 7

# v46: while an Extend request walks backward from the current oldest
# cached data toward the user's requested target date, this is how many
# CONSECUTIVE chunks (see EXTEND_CHUNK_DAYS - a chunk is EXTEND_CHUNK_DAYS
# calendar days) must come back completely empty (no error, just zero
# ticks across the whole chunk) before the walk gives up and reports the
# rest of the range as unreachable, instead of spending one MT5 round trip
# per remaining chunk for no reason.
#
# v57 Update 3: this used to count individual empty DAYS (default 6, kept
# deliberately higher than a normal weekend so real closed-market gaps
# weren't mistaken for the broker's true history limit). Now that the walk
# moves in EXTEND_CHUNK_DAYS-sized chunks, an entire chunk coming back
# empty is already a much stronger signal - a 7-day chunk with genuinely
# no ticks anywhere in it is far more than any normal weekend/holiday gap
# - so this is measured in chunks and lowered accordingly. At the default
# EXTEND_CHUNK_DAYS=7, a value of 2 here still tolerates up to ~2 chunks
# (~14 days) of nothing before concluding the boundary was reached.
EXTEND_CONSECUTIVE_EMPTY_LIMIT = 2

# v23: the 1m/5m/15m/1h/1D (>= 60s) timeframes and the coarse/fine refresh
# split they required were removed entirely, leaving only the sub-minute,
# tick-derived timeframes, all refreshed the same simple way.
#
# v38: 1m/5m/15m/1h are back, but built through that exact same simple
# mechanism instead of a separate coarse/fine split - they are just more
# factors merge_candles() applies on top of the candles_1s base table
# (60/300/900/3600 instead of 5/15), each caught up in the same
# refresh() pass and each persisted to its own dedicated table
# (candles_1m/candles_5m/candles_15m/candles_1h), exactly like
# candles_5s/candles_15s already were. See candle_cache._TF_TABLES.
CHART_TIMEFRAMES_SECONDS = [1, 5, 15, 60, 300, 900, 3600]

# v28: matches TradingView's own website behavior, where the maximum
# number of candles ever shown at Maximum Zoom Out is a fixed 5000 - both
# the very first paint and every later "page" of older history pulled in
# while scrolling back are capped at this same number, so the two stay
# perfectly consistent with each other (see chart-core.js loadPartition).
CHART_INITIAL_CANDLES = 4339

CHART_LAZY_LOAD_CHUNK = 4339

CANDLE_CACHE_REFRESH_INTERVAL_SECONDS = 5.0

LIVE_TAIL_LOOKBACK_SECONDS = 45
# v61: the live tail is reconstructed from persisted 1s candles plus the
# tiny in-memory state of the still-forming seconds. This value controls how
# much persisted 1s history is included in that rebuild; raw ticks are never
# read from SQLite. The sync process may widen the effective left edge to the
# start of the current largest-timeframe bucket to keep Open continuity exact.


# v25.4: how long the status dot is allowed to keep showing "online" (green)
# after the last live tick was actually received, before it is forced back to
# "offline" (red). This is the ONLY thing that decides online vs offline once
# a run has caught up to the live edge - not whether the last MT5 call
# succeeded, and not whether the internet is reachable. copy_ticks_from()
# happily keeps returning "success, zero ticks" (err_code RES_S_OK) both when
# the internet drops out from under an already-connected terminal and when
# the market is simply closed (e.g. a weekend) - in both cases no live tick
# data is arriving, so the dot must not read as green. Kept short (a few
# multiples of a normal idle poll) so a real outage is caught within a few
# seconds, matching how quickly a human would notice ticks had stopped.
LIVE_DATA_STALE_SECONDS = 2

# V66.2 patch: leave empty by default so the MetaTrader5 Python package
# lets the MT5 terminal integration auto-detect the default terminal.
# Set an explicit terminal64.exe path only when the automatic discovery is
# not suitable (for example, when multiple MT5 installations are in use).
MT5_TERMINAL_PATH = ""

# v25.2: if connecting to MT5 (or the initial symbol check) fails - e.g. no
# internet / terminal not reachable yet at startup - the sync process no
# longer gives up permanently. It waits this long and tries again, forever,
# until it succeeds or the app is closed. Kept fairly relaxed (not a tight
# loop) since each failed mt5.initialize() attempt can itself already take
# up to ~60s+ to time out on its own.
MT5_RECONNECT_INTERVAL_SECONDS = 15.0

# v25.2: safety net in app.py in case the sync process ever dies for a
# reason OTHER than a failed connect (e.g. an unhandled exception) - a
# lightweight watchdog thread restarts it after this cooldown, so the app
# self-heals instead of silently going dead until the app is restarted.
SYNC_PROCESS_WATCHDOG_CHECK_INTERVAL_SECONDS = 5.0
SYNC_PROCESS_RESPAWN_COOLDOWN_SECONDS = 15.0


# =============================================================================
# v52: Configuration tab persistence -----------------------------------------
#
# Every constant defined above is also editable at runtime from the Setting
# panel's Configuration tab (see web/js/app-config.js / src/config_store.py
# / ChartBridge.get_app_config/save_app_config/restore_app_config_defaults).
#
# CONFIG_DEFAULTS below is a snapshot of every constant's hardcoded value,
# taken right here, BEFORE any override is applied — it is what
# "Restore to Default" restores to, and what the frontend uses to fill in
# the tab the first time (or after Restore) even if it has never seen this
# app's hardcoded values before.
#
# The block after it then loads whatever the user last saved (if anything)
# and overwrites the matching globals here, in this same module. Because
# Python only ever executes a module's top-level code once and caches the
# result in sys.modules, this happens exactly once, the first time ANY
# other file does `from config import SOME_NAME` — and since that happens
# after this file's own body has finished running top to bottom, every
# other module in the app ends up seeing the user's saved values instead
# of the hardcoded ones above, with no changes needed anywhere else.
#
# Falls back silently to the hardcoded defaults above if nothing has been
# saved yet (first run), the saved file can't be read, or a saved value is
# the wrong shape for its variable (e.g. non-numeric text saved for a
# numeric field) — a bad/missing override for one variable never affects
# any other variable.
# =============================================================================
CONFIG_DEFAULTS = {
    _name: _value
    for _name, _value in list(globals().items())
    if _name.isupper() and not _name.startswith("_")
}


def _load_config_overrides():
    import os as _os
    try:
        from config_store import ConfigStore
    except Exception:
        return {}
    try:
        from runtime_paths import PROJECT_ROOT as _project_root
        _store_dir = _os.path.join(_project_root, APP_CONFIG_DIR)
        # v65.4: APP_CONFIG_DIR moved from output/app_config to
        # output/settings/app_config. Migrate a pre-v65.4 saved override
        # file into the new location the first time it's looked up here,
        # so upgrading never silently resets a user's saved overrides
        # (including any override of APP_CONFIG_DIR/STYLE_SETTINGS_DIR/etc.
        # themselves) back to hardcoded defaults.
        _legacy_dir = _os.path.join(_project_root, "output", "app_config")
        _new_file = _os.path.join(_store_dir, "app_config.json")
        _legacy_file = _os.path.join(_legacy_dir, "app_config.json")
        if not _os.path.exists(_new_file) and _os.path.exists(_legacy_file):
            try:
                _os.makedirs(_store_dir, exist_ok=True)
                _os.replace(_legacy_file, _new_file)
            except OSError:
                pass
        return ConfigStore(_store_dir).load().get("overrides", {})
    except Exception:
        return {}


def _coerce_like(current, raw_value):
    """Best-effort coercion of a saved JSON value `raw_value` to the same
    type as the hardcoded default `current`, so a malformed/mistyped saved
    value can never silently change a variable's type. Returns None (never
    raises) if `raw_value` can't sensibly become that type — the caller
    then just keeps the hardcoded default for that one variable."""
    try:
        if isinstance(current, bool):
            return bool(raw_value)
        if isinstance(current, int):
            return int(raw_value)
        if isinstance(current, float):
            return float(raw_value)
        if isinstance(current, str):
            return str(raw_value)
        if isinstance(current, list):
            if not isinstance(raw_value, list):
                return None
            if not current:
                return list(raw_value)
            item_type = type(current[0])
            return [item_type(v) for v in raw_value]
    except Exception:
        return None
    return None


def _apply_config_overrides():
    _overrides = _load_config_overrides()
    if not isinstance(_overrides, dict):
        return
    _g = globals()
    for _key, _raw in _overrides.items():
        if _key not in CONFIG_DEFAULTS:
            continue  # unknown / stale key from an older version — ignore
        _current = _g.get(_key)
        _coerced = _coerce_like(_current, _raw)
        if _coerced is not None:
            _g[_key] = _coerced


_apply_config_overrides()
