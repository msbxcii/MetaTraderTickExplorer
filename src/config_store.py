# -*- coding: utf-8 -*-
"""v52: persists the Setting panel's Software & Data tab — the user's current
override for every variable defined in config.py (see web/js/app-config.js)
— to a JSON file on disk, so changed variables survive closing and
reopening the app and are applied on every later launch, instead of only
living in the browser's localStorage.

Mirrors keyboard_shortcuts_store.py's KeyboardShortcutsStore exactly
(single file, not per-symbol, since these are tool/app settings, not
chart data), just under its own `output/app_config/` folder (see
config.APP_CONFIG_DIR) and its own top-level key (`overrides` instead of
`bindings`).

Kept intentionally dumb, same as KeyboardShortcutsStore/CanvasSettingsStore
/StyleStore/DrawingStore: this module has no idea what "TICKS_BATCH_SIZE"
or "MT5_TERMINAL_PATH" mean, what type they should be, or what a valid
value looks like. It just stores/returns whatever JSON-able dict the
caller hands it, exactly as-is — all interpretation of which keys exist,
their types, and their titles/descriptions stays in config.py (for
loading/coercion) and app-config.js (for the UI), so this file stays
stable even if the variable list grows later.
"""
import json
import os
import tempfile
import threading

_FILENAME = "app_config.json"


class ConfigStore:
    def __init__(self, settings_dir, logger=None):
        self._dir = settings_dir
        self._path = os.path.join(settings_dir, _FILENAME)
        self._logger = logger
        self._lock = threading.Lock()
        os.makedirs(self._dir, exist_ok=True)

    def load(self):
        """Return the previously-saved Software & Data tab state: a dict
        with ``overrides`` (configKey -> user-set value). Returns empty
        if nothing has been saved yet (first run) or the file can't be
        read (never raises — a corrupt/missing file just means "start
        empty", same policy as KeyboardShortcutsStore.load())."""
        with self._lock:
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except FileNotFoundError:
                return {"overrides": {}}
            except Exception as e:
                if self._logger:
                    self._logger.warning(
                        f"ConfigStore.load: failed to read {self._path}: {e}"
                    )
                return {"overrides": {}}
        if not isinstance(data, dict):
            return {"overrides": {}}
        overrides = data.get("overrides")
        return {"overrides": overrides if isinstance(overrides, dict) else {}}

    def save(self, overrides):
        """Atomically overwrite the store with `overrides` (a JSON-able
        dict). Writes to a temp file in the same directory first, then
        renames it over the real path — same crash-safe atomic-replace
        pattern as KeyboardShortcutsStore.save()."""
        if not isinstance(overrides, dict):
            return False
        payload = {"version": 1, "overrides": overrides}
        with self._lock:
            tmp_path = None
            try:
                fd, tmp_path = tempfile.mkstemp(
                    prefix=".app-config-", suffix=".tmp", dir=self._dir
                )
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
                os.replace(tmp_path, self._path)
                tmp_path = None
                return True
            except Exception as e:
                if self._logger:
                    self._logger.warning(
                        f"ConfigStore.save: failed to write {self._path}: {e}"
                    )
                return False
            finally:
                if tmp_path is not None:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
