# -*- coding: utf-8 -*-
"""v37: persists the drawing tool's per-type "current default style" and
user-saved named presets (see web/js/style-defaults.js) to a JSON file on
disk, so they too survive closing and reopening the app instead of only
living in the browser's localStorage.

Unlike DrawingStore (drawing_store.py), which keeps one file per symbol
because drawn objects belong to a specific chart, a style default/preset is
a *tool* setting — it isn't tied to any one symbol and should stay put
across symbols — so this keeps a single JSON file inside the
`output/style_settings/` folder under the project root (see
config.STYLE_SETTINGS_DIR).

Kept intentionally dumb, same as DrawingStore: this module has no idea what
"borderColor" or "middleLine" mean. It just stores/returns whatever
JSON-able dict the frontend hands it, exactly as-is — all interpretation of
the style shape stays in JS (style-defaults.js), so this file stays stable
even if the style editor grows new fields later.
"""
import json
import os
import tempfile
import threading

_FILENAME = "style_settings.json"


class StyleStore:
    def __init__(self, settings_dir, logger=None):
        self._dir = settings_dir
        self._path = os.path.join(settings_dir, _FILENAME)
        self._logger = logger
        self._lock = threading.Lock()
        os.makedirs(self._dir, exist_ok=True)

    def load(self):
        """Return the previously-saved style settings: a dict with
        ``defaults`` (per-object-type current default style) and
        ``presets`` (per-object-type list of named presets). Returns empty
        dicts for both if nothing has been saved yet (first run) or the
        file can't be read (never raises — a corrupt/missing file just
        means "start empty", same policy as DrawingStore.load())."""
        with self._lock:
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except FileNotFoundError:
                return {"defaults": {}, "presets": {}}
            except Exception as e:
                if self._logger:
                    self._logger.warning(
                        f"StyleStore.load: failed to read {self._path}: {e}"
                    )
                return {"defaults": {}, "presets": {}}
        if not isinstance(data, dict):
            return {"defaults": {}, "presets": {}}
        defaults = data.get("defaults")
        presets = data.get("presets")
        return {
            "defaults": defaults if isinstance(defaults, dict) else {},
            "presets": presets if isinstance(presets, dict) else {},
        }

    def save(self, defaults, presets):
        """Atomically overwrite the store with `defaults` and `presets`
        (both JSON-able dicts). Writes to a temp file in the same
        directory first, then renames it over the real path — same
        crash-safe atomic-replace pattern as DrawingStore.save()."""
        if not isinstance(defaults, dict) or not isinstance(presets, dict):
            return False
        payload = {"version": 1, "defaults": defaults, "presets": presets}
        with self._lock:
            tmp_path = None
            try:
                fd, tmp_path = tempfile.mkstemp(
                    prefix=".style-settings-", suffix=".tmp", dir=self._dir
                )
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
                os.replace(tmp_path, self._path)
                tmp_path = None
                return True
            except Exception as e:
                if self._logger:
                    self._logger.warning(
                        f"StyleStore.save: failed to write {self._path}: {e}"
                    )
                return False
            finally:
                if tmp_path is not None:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
