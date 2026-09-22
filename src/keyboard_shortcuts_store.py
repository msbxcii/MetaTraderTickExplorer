# -*- coding: utf-8 -*-
"""v51: persists the Setting panel's Keyboard Shortcuts tab — the user's
current key-binding for every shortcut action (see
web/js/keyboard-shortcuts.js) — to a JSON file on disk, so custom/changed
shortcuts survive closing and reopening the app instead of only living in
the browser's localStorage.

Mirrors canvas_settings_store.py's CanvasSettingsStore exactly (single
file, not per-symbol, since key bindings are a tool/app setting, not
chart data), just under its own `output/keyboard_shortcuts/` folder (see
config.KEYBOARD_SHORTCUTS_DIR) and its own top-level key (`bindings`
instead of `settings` + `presets`, since this tab has no presets).

Kept intentionally dumb, same as CanvasSettingsStore/StyleStore/
DrawingStore: this module has no idea what "Jump Time" or "objHLine"
mean, or what a valid binding looks like. It just stores/returns
whatever JSON-able dict the frontend hands it, exactly as-is — all
interpretation of the shortcut shape stays in JS (keyboard-shortcuts.js),
so this file stays stable even if the action list grows later.
"""
import json
import os
import tempfile
import threading

_FILENAME = "keyboard_shortcuts.json"


class KeyboardShortcutsStore:
    def __init__(self, settings_dir, logger=None):
        self._dir = settings_dir
        self._path = os.path.join(settings_dir, _FILENAME)
        self._logger = logger
        self._lock = threading.Lock()
        os.makedirs(self._dir, exist_ok=True)

    def load(self):
        """Return the previously-saved key bindings: a dict with
        ``bindings`` (actionId -> {ctrl, shift, alt, code} or None).
        Returns empty if nothing has been saved yet (first run) or the
        file can't be read (never raises — a corrupt/missing file just
        means "start empty", same policy as CanvasSettingsStore.load())."""
        with self._lock:
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except FileNotFoundError:
                return {"bindings": {}}
            except Exception as e:
                if self._logger:
                    self._logger.warning(
                        f"KeyboardShortcutsStore.load: failed to read {self._path}: {e}"
                    )
                return {"bindings": {}}
        if not isinstance(data, dict):
            return {"bindings": {}}
        bindings = data.get("bindings")
        return {"bindings": bindings if isinstance(bindings, dict) else {}}

    def save(self, bindings):
        """Atomically overwrite the store with `bindings` (a JSON-able
        dict). Writes to a temp file in the same directory first, then
        renames it over the real path — same crash-safe atomic-replace
        pattern as CanvasSettingsStore.save()."""
        if not isinstance(bindings, dict):
            return False
        payload = {"version": 1, "bindings": bindings}
        with self._lock:
            tmp_path = None
            try:
                fd, tmp_path = tempfile.mkstemp(
                    prefix=".keyboard-shortcuts-", suffix=".tmp", dir=self._dir
                )
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
                os.replace(tmp_path, self._path)
                tmp_path = None
                return True
            except Exception as e:
                if self._logger:
                    self._logger.warning(
                        f"KeyboardShortcutsStore.save: failed to write {self._path}: {e}"
                    )
                return False
            finally:
                if tmp_path is not None:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
