# -*- coding: utf-8 -*-

import ctypes
import os
import sqlite3
import sys


# v61: the market-data database is candle-only. Raw MT5 ticks are never
# persisted; they live only long enough to become 1-second candle state in
# the sync process. This module keeps the SQLite lifecycle/name helpers so
# existing callers do not need to know the storage implementation details.

_FILE_ATTRIBUTE_HIDDEN = 0x2


def _hide_path(path):
    """Best-effort: set the Windows "hidden" attribute on a file so it stops
    cluttering Explorer (v65.3). No-op, silently, on any platform other than
    Windows, on a file that doesn't exist yet, or if the OS call fails for
    any reason - this is purely cosmetic and never something a caller should
    have to handle."""
    if sys.platform != "win32":
        return
    try:
        if os.path.exists(path):
            ctypes.windll.kernel32.SetFileAttributesW(str(path), _FILE_ATTRIBUTE_HIDDEN)
    except Exception:
        pass


def hide_wal_sidecars(db_path):
    """Hide the -wal/-shm sidecar files SQLite maintains next to db_path.
    They're pure journal/index state, never anything a user opens directly,
    so they only add noise to the database folder."""
    _hide_path(db_path + "-wal")
    _hide_path(db_path + "-shm")


def hide_unknown_server_artifacts(output_dir, server_placeholder="unknown-server"):
    """Hide any leftover '<symbol>-unknown-server[-wal/-shm]' files still
    sitting in output_dir. These are startup-fallback databases written
    before the real broker server was confirmed (see symbol_manager.
    UNKNOWN_SERVER / app.py's offline-first start) - superseded the moment
    the sync process reports the real identity, but never deleted, since a
    user's cached data is never removed automatically. Matched by filename
    only; no file is opened or its content touched, so this is cheap enough
    to call on every startup and every identity switch."""
    try:
        names = os.listdir(output_dir)
    except OSError:
        return
    marker = f"-{server_placeholder}"
    for name in names:
        if marker in name:
            _hide_path(os.path.join(output_dir, name))


def _sanitize_component(value):
    """Turn one naming component into a filesystem-safe fragment."""
    kept = [c if (c.isalnum() or c in ("-", "_", ".")) else "_" for c in str(value)]
    return "".join(kept).strip("_") or "unknown"


def resolve_db_basename(symbol, server):
    """Build the per-symbol/per-broker database basename."""
    return f"{_sanitize_component(symbol)}-{_sanitize_component(server)}"


def list_cached_symbols(output_dir, server, symbols):
    """Return the subset of `symbols` that already have a candle database on
    disk for `server` (v65.2 symbol-dropdown "pin known symbols to top").

    Cheap by design: one os.listdir() (not one os.path.exists() per symbol -
    a broker list can be 1000+ symbols) turned into a set, then a plain
    membership test per symbol name."""
    try:
        existing = set(os.listdir(output_dir))
    except OSError:
        return set()
    found = set()
    for item in symbols or []:
        name = item.get("symbol") if isinstance(item, dict) else item
        if not name:
            continue
        if resolve_db_basename(name, server) in existing:
            found.add(str(name))
    return found


def table_exists(conn, table_name):
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (str(table_name),),
    ).fetchone()
    return row is not None


def open_database(db_path, logger):
    parent_dir = os.path.dirname(db_path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)

    is_new_file = not os.path.exists(db_path)
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)

    # WAL + NORMAL is still a good fit for one writer process and a read-only
    # ChartBridge connection. No tick-table-specific tuning remains because
    # v61 no longer writes raw ticks to SQLite at all.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA cache_size = -20000")  # ~20 MB page cache

    # v65.3: the PRAGMA above is what makes SQLite create/touch the -wal and
    # -shm sidecar files, so hide them right after - they exist for every
    # open from here on (including reopens after a checkpoint on close).
    hide_wal_sidecars(db_path)

    legacy = table_exists(conn, "ticks")
    if is_new_file:
        logger.info(f"DB created: {os.path.abspath(db_path)}", extra={"category": "DATABASE"})
    elif legacy:
        logger.info(
            f"DB opened (legacy ticks pending migration): {os.path.abspath(db_path)}",
            extra={"category": "DATABASE"},
        )
    else:
        logger.info(f"DB opened: {os.path.abspath(db_path)}", extra={"category": "DATABASE"})

    return conn


def close_database(conn, logger):
    if conn is None:
        return
    try:
        try:
            checkpoint_result = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            busy, log_pages, checkpointed_pages = checkpoint_result if checkpoint_result else (None, None, None)
            if busy:
                logger.warning(
                    f"WAL checkpoint on close incomplete ({checkpointed_pages}/{log_pages} page(s) merged)",
                    extra={"category": "DATABASE"},
                )
            else:
                logger.debug(
                    f"WAL checkpoint merged {checkpointed_pages} page(s) on close",
                    extra={"category": "DATABASE"},
                )
        except Exception as e:
            logger.warning(f"WAL checkpoint on close failed: {e}", extra={"category": "DATABASE"})
        conn.close()
        logger.info("DB closed.", extra={"category": "DATABASE"})
    except Exception as e:
        logger.warning(f"Error closing DB: {e}", extra={"category": "DATABASE"})
