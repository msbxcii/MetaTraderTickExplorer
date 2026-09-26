# -*- coding: utf-8 -*-
"""Per-MT5-server symbol discovery and selection persistence (v53)."""
import json
import os
import tempfile


UNKNOWN_SERVER = "unknown-server"
_SELECTED_SUFFIX = "-SelectedSymbol"

# v65.4: session-identity files (which symbol/server was last used, and the
# per-server "SelectedSymbol" files) used to sit loose directly inside
# OUTPUT_DIR, mixed in with the actual per-symbol database files. They now
# live in their own subfolder so the database directory only ever contains
# databases.
_SESSION_SUBDIR = "session"


def _session_dir(output_dir):
    return os.path.join(output_dir, _SESSION_SUBDIR)


def _migrate_legacy_file(old_path, new_path):
    """Move a v65.3-and-earlier file from OUTPUT_DIR's root into its new
    subfolder, the first time it's looked up under the new location. A
    no-op once the move has happened (or if there was never a legacy file
    to begin with) - and deliberately silent on any failure (permissions,
    the file having vanished between the exists()/replace() calls, etc.):
    worst case the legacy file is simply read from again next time, it is
    never lost."""
    if os.path.exists(new_path) or not os.path.exists(old_path):
        return
    try:
        os.makedirs(os.path.dirname(new_path), exist_ok=True)
        os.replace(old_path, new_path)
    except OSError:
        pass


def _safe_server_name(server):
    kept = [c if c.isalnum() or c in ("-", "_", ".") else "_" for c in str(server)]
    return "".join(kept).strip("_") or "unknown-server"


def symbol_list_path(symbol_list_dir, server):
    return os.path.join(symbol_list_dir, f"{_safe_server_name(server)}-SymolList")


def selected_symbol_path(output_dir, server):
    new_path = os.path.join(_session_dir(output_dir), f"{_safe_server_name(server)}-SelectedSymbol")
    _migrate_legacy_file(os.path.join(output_dir, f"{_safe_server_name(server)}-SelectedSymbol"), new_path)
    return new_path


def same_server(a, b):
    """True when two server names map to the same on-disk identity."""
    return _safe_server_name(a).casefold() == _safe_server_name(b).casefold()


def last_session_path(output_dir):
    new_path = os.path.join(_session_dir(output_dir), "last_session.json")
    _migrate_legacy_file(os.path.join(output_dir, "last_session.json"), new_path)
    return new_path


def _atomic_write(path, data):
    """Write `data` as JSON to `path`, atomically.

    v72: the temp file is created with dir=parent (the SAME folder/drive as
    the final path) - previously it defaulted to the OS temp folder, which
    normally sits on the system drive. That was invisible as long as the
    project root was always on that same drive too, but once the user can
    point the Root Project Folder at a different drive (Get Started's Root
    Project Folder picker), os.replace() below cannot move a file across
    drives on Windows, so this silently failed every time the root wasn't on
    the OS temp folder's drive - which is exactly why the last-used symbol/
    server was never remembered after choosing a Root Project Folder on a
    different drive.
    """
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".symbol-", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def _normalize_symbol_items(data):
    """Normalize the persisted list into [{symbol, description}, ...]."""
    if not isinstance(data, list):
        return []
    result = []
    seen = set()
    for item in data:
        if isinstance(item, dict):
            name = str(item.get("symbol", "")).strip()
            description = str(item.get("description", "") or "").strip()
        else:
            # Kept for compatibility with the old simple-string format.
            name = str(item).strip()
            description = ""
        if name and name not in seen:
            seen.add(name)
            result.append({"symbol": name, "description": description})
    return sorted(result, key=lambda x: x["symbol"].casefold())


def load_symbol_list(symbol_list_dir, server):
    path = symbol_list_path(symbol_list_dir, server)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return _normalize_symbol_items(json.load(f))
    except FileNotFoundError:
        return None
    except Exception:
        return []


def discover_and_save_symbol_list(mt5, symbol_list_dir, server, logger):
    """Use the server's existing SymbolList file; create it only if absent.

    V53 intentionally uses file existence as the discovery gate. If the
    per-server SymbolList file exists, MT5 is NOT queried for the full list.
    The file stores both symbol names and the broker-provided descriptions.
    A new server gets one symbols_get() call and the result is persisted.
    """
    path = symbol_list_path(symbol_list_dir, server)
    if os.path.exists(path):
        logger.info(f"Using existing symbol list for MT5 server '{server}': {os.path.abspath(path)}")
        loaded = load_symbol_list(symbol_list_dir, server)
        if loaded is not None:
            return loaded
        # The file exists, so V53 does not rebuild it.
        logger.warning(f"Could not read existing symbol list '{path}'. No MT5 rediscovery will be attempted.")
        return []

    logger.info(f"No saved symbol list found for MT5 server '{server}'. Requesting all symbols and descriptions from MT5 ...")
    try:
        symbols = mt5.symbols_get()
    except Exception as e:
        logger.warning(f"symbols_get() failed for server '{server}': {e}")
        return []

    if symbols is None:
        logger.warning(f"MT5 returned no symbol list for server '{server}'.")
        return []

    items = []
    seen = set()
    for item in symbols:
        name = str(getattr(item, "name", "") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        description = str(getattr(item, "description", "") or "").strip()
        items.append({"symbol": name, "description": description})
    items.sort(key=lambda x: x["symbol"].casefold())

    try:
        _atomic_write(path, items)
        logger.info(f"Saved {len(items):,} symbols with descriptions to {os.path.abspath(path)}")
    except Exception as e:
        logger.warning(f"Could not save symbol list '{path}': {e}")
    return items


def symbol_names(symbol_items):
    return [item["symbol"] for item in (symbol_items or []) if isinstance(item, dict) and item.get("symbol")]


def load_selected_symbol(output_dir, server):
    path = selected_symbol_path(output_dir, server)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        value = data.get("symbol") if isinstance(data, dict) else data
        return str(value).strip() if value else None
    except FileNotFoundError:
        return None
    except Exception:
        return None


def save_selected_symbol(output_dir, server, symbol, logger=None):
    path = selected_symbol_path(output_dir, server)
    try:
        _atomic_write(path, {"symbol": str(symbol).strip()})
        return True
    except Exception as e:
        if logger:
            logger.warning(f"Could not save selected symbol '{path}': {e}")
        return False


def choose_startup_symbol(config_symbol, symbols, saved_symbol):
    """Saved choice wins on later runs; first-run selection is handled by Get Started when no saved symbol exists."""
    names = set(symbol_names(symbols))
    if saved_symbol and (not names or saved_symbol in names):
        return saved_symbol
    if config_symbol in names or not names:
        return config_symbol
    return config_symbol


def save_last_session(output_dir, server, symbol, logger=None):
    """Remember which server/symbol was in use (V62).

    This tiny file is what lets the next launch start from the cached
    candles immediately, without asking MT5 anything first.
    """
    try:
        _atomic_write(last_session_path(output_dir), {"server": str(server), "symbol": str(symbol)})
        return True
    except Exception as e:
        if logger:
            logger.warning(f"Could not save last session '{last_session_path(output_dir)}': {e}")
        return False


def load_last_session(output_dir):
    """Return (server, symbol) of the last known session, or (None, None).

    Pure local disk, never touches MT5. Falls back to the newest
    '<server>-SelectedSymbol' file so data created before last_session.json
    existed (or before it and the SelectedSymbol files moved into their own
    'session' subfolder in v65.4) is still picked up.
    """
    try:
        with open(last_session_path(output_dir), "r", encoding="utf-8") as f:
            data = json.load(f)
        server = str(data.get("server") or "").strip()
        symbol = str(data.get("symbol") or "").strip()
        if server and symbol:
            return server, symbol
    except Exception:
        pass
    try:
        newest = None
        # v65.4: check the new 'session' subfolder and the old flat
        # OUTPUT_DIR root - a fresh v65.4 install pointed at data from an
        # earlier version will still have these files sitting at the root
        # until selected_symbol_path()'s own migration relocates them.
        for scan_dir in (_session_dir(output_dir), output_dir):
            try:
                names = os.listdir(scan_dir)
            except OSError:
                continue
            for name in names:
                if not name.endswith(_SELECTED_SUFFIX):
                    continue
                full = os.path.join(scan_dir, name)
                if not os.path.isfile(full):
                    continue
                mtime = os.path.getmtime(full)
                if newest is None or mtime > newest[0]:
                    newest = (mtime, name[: -len(_SELECTED_SUFFIX)])
        if newest is not None:
            server = newest[1]
            symbol = load_selected_symbol(output_dir, server)
            if server and symbol:
                return server, symbol
    except Exception:
        pass
    return None, None
