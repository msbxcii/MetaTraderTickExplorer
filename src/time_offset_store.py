# -*- coding: utf-8 -*-
"""v92: broker -> system display clock offset.

All app logic keeps using broker time. Only what the user sees/types is
shifted by ``offset`` = system wall clock - broker wall clock, rounded to a
multiple of 15 minutes. Checked at most once per system day (from a live
tick) and persisted as ``{"date": "18Sep2026", "offset_minutes": 30}``.
"""
import json
import os
import tempfile
import threading
import time

_FILENAME = "time_offset.json"
_STEP_SEC = 900          # 15 minutes
_RECHECK_SEC = 30.0      # cheap gate between date-string checks


def _today():
    return time.strftime("%d%b%Y", time.localtime())


class TimeOffsetStore:
    def __init__(self, settings_dir, logger=None):
        self._dir = settings_dir
        self._path = os.path.join(settings_dir, _FILENAME)
        self._logger = logger
        self._lock = threading.Lock()
        self._offset = 0
        self._date = None
        self._next_check = 0.0
        try:
            os.makedirs(self._dir, exist_ok=True)
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
            self._offset = int(data.get("offset_minutes", 0)) * 60
            self._date = str(data.get("date") or "") or None
        except FileNotFoundError:
            pass
        except Exception as e:
            if logger:
                logger.warning(f"TimeOffsetStore: unreadable {self._path}: {e}")

    @property
    def offset_seconds(self):
        return self._offset

    def observe(self, server_msc):
        """Feed a live broker tick time. Returns the new offset (seconds) when
        it changed, else None. O(1) and mostly a monotonic compare."""
        now_mono = time.monotonic()
        if server_msc is None or now_mono < self._next_check:
            return None
        self._next_check = now_mono + _RECHECK_SEC
        today = _today()
        if self._date == today:
            return None
        with self._lock:
            if self._date == today:
                return None
            lt = time.localtime()
            system_wall = time.time() + lt.tm_gmtoff
            diff = system_wall - float(server_msc) / 1000.0
            offset = int(round(diff / _STEP_SEC)) * _STEP_SEC
            changed = offset != self._offset
            self._offset = offset
            self._date = today
            self._save()
        if self._logger:
            self._logger.info(f"v92 display time offset for {today}: {offset // 60} min")
        return offset if changed else None

    def _save(self):
        try:
            fd, tmp = tempfile.mkstemp(prefix=".tz-", dir=self._dir)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"date": self._date, "offset_minutes": self._offset // 60}, f)
            os.replace(tmp, self._path)
        except Exception as e:
            if self._logger:
                self._logger.warning(f"TimeOffsetStore: save failed: {e}")
