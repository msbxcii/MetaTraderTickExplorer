# -*- coding: utf-8 -*-
"""v33: persists user-drawn chart objects (trend lines, rectangles,
horizontal/vertical lines) to a JSON file on disk, so they survive closing
and reopening the app. v33.1: also persists Object Tree folders (see Fix 4
in web/js/object-panel.js) alongside the objects list.

Before v33, every drawn object lived purely in the browser's in-memory
`App.drawObjects` array (see web/js/drawing-engine.js) and was gone the
moment the pywebview window closed — by design, at the time. This module
gives that same data a home on disk: one plain JSON file per symbol, inside
the `output/drawings/` folder under the project root (see config.DRAWINGS_DIR), so the
frontend's ChartBridge.get_drawings()/save_drawings() calls have somewhere
real to read from and write to.

Kept intentionally dumb: this module has no idea what a "trend line" or a
"rectangle" is. It just stores/returns whatever JSON-able list the frontend
hands it, exactly as-is — all interpretation of `type`/`points`/`style`
stays in JS, same as before. That keeps this file stable even if the
drawing engine grows new object types or style fields later.
"""
import json
import os
import tempfile
import threading


def _safe_filename(symbol):
    """Turn a symbol name into a filesystem-safe '<symbol>.json' filename.
    Symbols are normally plain alnum (e.g. "XAUUSD"), but this guards
    against anything unexpected making it into config.SYMBOL."""
    kept = [c if (c.isalnum() or c in ("-", "_")) else "_" for c in str(symbol)]
    name = "".join(kept).strip("_") or "symbol"
    return name + ".json"


class DrawingStore:
    def __init__(self, drawings_dir, symbol, logger=None):
        self._dir = drawings_dir
        self._path = os.path.join(drawings_dir, _safe_filename(symbol))
        self._logger = logger
        self._lock = threading.Lock()
        os.makedirs(self._dir, exist_ok=True)

    def set_symbol(self, symbol):
        with self._lock:
            self._path = os.path.join(self._dir, _safe_filename(symbol))

    def load(self):
        """Return the previously-saved drawing state: a dict with
        ``objects`` (the drawn objects list) and ``folders`` (v33.1 Object
        Tree folders — see web/js/object-panel.js). Returns empty lists for
        both if nothing has been saved yet (first run) or the file can't be
        read (never raises — a corrupt/missing file just means "start
        empty", it should never keep the chart itself from opening)."""
        with self._lock:
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except FileNotFoundError:
                return {"objects": [], "folders": []}
            except Exception as e:
                if self._logger:
                    self._logger.warning(
                        f"DrawingStore.load: failed to read {self._path}: {e}"
                    )
                return {"objects": [], "folders": []}
        if isinstance(data, dict):
            objects = data.get("objects")
            folders = data.get("folders")
        else:
            # Pre-v33.1 file: a bare list of objects, no folders concept yet.
            objects = data
            folders = None
        return {
            "objects": objects if isinstance(objects, list) else [],
            "folders": folders if isinstance(folders, list) else [],
        }

    def save(self, objects, folders=None):
        """Atomically overwrite the store with `objects` (a JSON-able
        list) and, v33.1, `folders` (a JSON-able list of Object Tree
        folders; defaults to an empty list so older callers that only pass
        `objects` still work). Writes to a temp file in the same directory
        first, then renames it over the real path — os.replace() is atomic
        on both POSIX and Windows, so a crash or the window being
        force-closed mid-write can never leave a half-written, corrupt file
        behind; readers always see either the old complete file or the new
        one."""
        if not isinstance(objects, list):
            return False
        if folders is None:
            folders = []
        if not isinstance(folders, list):
            return False
        payload = {"version": 2, "objects": objects, "folders": folders}
        with self._lock:
            tmp_path = None
            try:
                fd, tmp_path = tempfile.mkstemp(
                    prefix=".drawings-", suffix=".tmp", dir=self._dir
                )
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
                os.replace(tmp_path, self._path)
                tmp_path = None
                return True
            except Exception as e:
                if self._logger:
                    self._logger.warning(
                        f"DrawingStore.save: failed to write {self._path}: {e}"
                    )
                return False
            finally:
                if tmp_path is not None:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
