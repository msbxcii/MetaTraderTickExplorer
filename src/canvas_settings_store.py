# -*- coding: utf-8 -*-
"""v50.1: persists the Setting panel's Canvas tab — its current field
values (background/crosshair/text/candle/grid-line colors, text size,
crosshair style, grid-line enable toggles, Dark Theme) and every
user-saved named Canvas preset (see web/js/canvas-settings.js) — to a
JSON file on disk, so they survive closing and reopening the app instead
of only living in the browser's localStorage.

Mirrors style_store.py's StyleStore exactly (single file, not per-symbol,
since Canvas theme is a tool/app setting, not chart data), just under its
own `output/canvas_settings/` folder (see config.CANVAS_SETTINGS_DIR) and
its own top-level keys (`settings` + `presets` instead of `defaults` +
`presets`).

Kept intentionally dumb, same as StyleStore/DrawingStore: this module has
no idea what "background" or "gridHorzColor" mean. It just stores/returns
whatever JSON-able dict the frontend hands it, exactly as-is — all
interpretation of the Canvas settings shape stays in JS
(canvas-settings.js), so this file stays stable even if the Canvas tab
grows new fields later.
"""
import json
import os
import tempfile
import threading

_FILENAME = "canvas_settings.json"


class CanvasSettingsStore:
    def __init__(self, settings_dir, logger=None):
        self._dir = settings_dir
        self._path = os.path.join(settings_dir, _FILENAME)
        self._logger = logger
        self._lock = threading.Lock()
        os.makedirs(self._dir, exist_ok=True)

    def load(self):
        """Return the previously-saved Canvas settings: a dict with
        ``settings`` (the Canvas tab's current field values) and
        ``presets`` (the list of user-saved named Canvas presets).
        Returns empty for both if nothing has been saved yet (first run)
        or the file can't be read (never raises — a corrupt/missing file
        just means "start empty", same policy as StyleStore.load())."""
        with self._lock:
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except FileNotFoundError:
                return {"settings": {}, "presets": []}
            except Exception as e:
                if self._logger:
                    self._logger.warning(
                        f"CanvasSettingsStore.load: failed to read {self._path}: {e}"
                    )
                return {"settings": {}, "presets": []}
        if not isinstance(data, dict):
            return {"settings": {}, "presets": []}
        settings = data.get("settings")
        presets = data.get("presets")
        return {
            "settings": settings if isinstance(settings, dict) else {},
            "presets": presets if isinstance(presets, list) else [],
        }

    def save(self, settings, presets):
        """Atomically overwrite the store with `settings` (a JSON-able
        dict) and `presets` (a JSON-able list). Writes to a temp file in
        the same directory first, then renames it over the real path —
        same crash-safe atomic-replace pattern as StyleStore.save()."""
        if not isinstance(settings, dict) or not isinstance(presets, list):
            return False
        payload = {"version": 1, "settings": settings, "presets": presets}
        with self._lock:
            tmp_path = None
            try:
                fd, tmp_path = tempfile.mkstemp(
                    prefix=".canvas-settings-", suffix=".tmp", dir=self._dir
                )
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
                os.replace(tmp_path, self._path)
                tmp_path = None
                return True
            except Exception as e:
                if self._logger:
                    self._logger.warning(
                        f"CanvasSettingsStore.save: failed to write {self._path}: {e}"
                    )
                return False
            finally:
                if tmp_path is not None:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
