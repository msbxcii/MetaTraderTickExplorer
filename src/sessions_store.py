# -*- coding: utf-8 -*-
"""v93: Sessions & Timezone tab storage ({settings, presets}), same atomic
JSON policy as CanvasSettingsStore, just its own file."""
import os

from canvas_settings_store import CanvasSettingsStore


class SessionsStore(CanvasSettingsStore):
    def __init__(self, settings_dir, logger=None):
        super().__init__(settings_dir, logger)
        self._path = os.path.join(settings_dir, "sessions_settings.json")
