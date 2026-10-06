# -*- coding: utf-8 -*-
"""v92/v117: broker clock rule store.

All app logic keeps using broker time. The user's local clock is only used
once a broker clock rule is known (Auto-detected, or chosen in Sessions &
Timezone); the rule is saved per broker server in broker_tz.json and the
offset is computed per candle (see broker_tz.py). A cheap live-tick sanity
check flags the rule as stale if the broker changes its clock policy.

v117: the old constant "daily live-tick offset" (time_offset.json) is gone.
With no rule the app simply shows broker time.
"""
import json
import os
import tempfile
import threading
import time

import broker_tz

_RULE_FILENAME = "broker_tz.json"   # v116: per-server rule {server: {...}}


class TimeOffsetStore:
    def __init__(self, settings_dir, logger=None):
        self._dir = settings_dir
        self._logger = logger
        self._lock = threading.Lock()
        # v116: rule state, keyed by broker server name
        self._rule_path = os.path.join(settings_dir, _RULE_FILENAME)
        self._servers = {}
        self._bad = 0
        self._bad_since = 0.0
        self._next_validate = 0.0
        try:
            os.makedirs(self._dir, exist_ok=True)
        except Exception as e:
            if logger:
                logger.warning(f"TimeOffsetStore: cannot create {self._dir}: {e}")
        try:
            with open(self._rule_path, "r", encoding="utf-8") as f:
                self._servers = (json.load(f) or {}).get("servers", {}) or {}
        except FileNotFoundError:
            pass
        except Exception as e:
            if logger:
                logger.warning(f"TimeOffsetStore: unreadable {self._rule_path}: {e}")

    # ------------------------------------------------------------------ v116
    def _entry(self, server):
        e = self._servers.get(server or "")
        return e if isinstance(e, dict) else {}

    def effective_rule(self, server):
        """The rule in force for ``server`` or None (-> plain broker time)."""
        e = self._entry(server)
        mode = e.get("mode", "auto")
        man = e.get("manual") or {}
        if mode == "us":
            return broker_tz.make_rule("ny", 420)
        if mode == "eu":
            return broker_tz.make_rule("eu", 120)
        if mode == "fixed":
            return broker_tz.make_rule("utc", float(man.get("fixed_hours", 0)) * 60)
        if mode == "custom":
            return broker_tz.make_rule(man.get("ref", "ny"), float(man.get("shift_hours", 0)) * 60)
        det = e.get("detected") or {}
        r = det.get("rule")
        return r if broker_tz.valid_rule(r) else None

    def get_state(self, server):
        """Everything the Sessions & Timezone tab and tz.js need."""
        e = self._entry(server)
        rule = self.effective_rule(server)
        det = e.get("detected") or None
        if det and ("weeks" in det or "candidates" in det):   # v123: legacy saved reports carry no table
            det = {k: v for k, v in det.items() if k not in ("weeks", "candidates")}
        return {
            "mode": e.get("mode", "auto"),
            "rule": rule,
            "label": broker_tz.rule_label(rule) if rule else None,
            "manual": e.get("manual") or {},
            "detected": det,
            "stale": bool(e.get("stale")),
        }

    def set_mode(self, server, mode, params=None):
        if mode not in ("auto", "us", "eu", "fixed", "custom"):
            mode = "auto"
        with self._lock:
            e = dict(self._entry(server))
            e["mode"] = mode
            man = dict(e.get("manual") or {})
            p = params if isinstance(params, dict) else {}
            try:
                if "fixed_hours" in p:
                    man["fixed_hours"] = max(-12.0, min(14.0, float(p["fixed_hours"])))
                if "shift_hours" in p:
                    man["shift_hours"] = max(-24.0, min(24.0, float(p["shift_hours"])))
                if p.get("ref") in ("ny", "eu", "utc"):
                    man["ref"] = p["ref"]
            except (TypeError, ValueError):
                pass
            e["manual"] = man
            e["stale"] = False
            self._servers[server or ""] = e
            self._bad = 0
            self._save_rules()
        return self.get_state(server)

    def apply_detection(self, server, report):
        """Store a finished detection. A confident result becomes the rule;
        an undecided one is kept only as a report (rule/mode untouched)."""
        if not isinstance(report, dict):
            return self.get_state(server)
        with self._lock:
            e = dict(self._entry(server))
            # v123: only the rule + short summary is saved (the per-week table stays in RAM in the UI)
            det = {k: report.get(k) for k in ("symbol", "at", "decided", "label", "confidence", "margin",
                                               "n_valid", "weeks_with_data", "message", "reason")}
            if report.get("decided") and broker_tz.valid_rule(report.get("rule")):
                det["rule"] = report["rule"]
                e["mode"] = "auto"
                e["stale"] = False
                self._bad = 0
            else:
                old = (e.get("detected") or {})
                if old.get("rule"):          # keep the previous good rule, report is informational
                    det["rule"] = old["rule"]
                    det["previous_rule_kept"] = True
            e["detected"] = det
            self._servers[server or ""] = e
            self._save_rules()
        if self._logger and report.get("decided"):
            self._logger.info("v116 broker clock rule detected: %s" % report.get("label"))
        return self.get_state(server)

    def validate(self, server, server_msc):
        """Cheap sanity check of the saved rule against a live tick. Returns
        True once when it keeps disagreeing (broker changed its clock policy)."""
        now_mono = time.monotonic()
        if server_msc is None or now_mono < self._next_validate:
            return False
        self._next_validate = now_mono + 300.0   # v118: every 5 min (was 30 s)
        rule = self.effective_rule(server)
        e = self._entry(server)
        if rule is None or e.get("stale"):
            return False
        now = time.time()
        obs = float(server_msc) / 1000.0 - now
        grid = int(round(obs / 900.0)) * 900
        if abs(obs - grid) > 120:            # stale tick / skewed clock: inconclusive
            return False
        if abs(grid - broker_tz.rule_offset_at_utc(rule, now)) < 900:
            self._bad = 0
            return False
        if self._bad == 0:
            self._bad_since = now_mono
        self._bad += 1
        if self._bad >= 4 and now_mono - self._bad_since >= 150:   # v118: 4 consecutive misses
            with self._lock:
                e = dict(self._entry(server))
                e["stale"] = True
                self._servers[server or ""] = e
                self._save_rules()
            self._bad = 0
            if self._logger:
                self._logger.warning("v116 broker clock no longer matches the saved rule (live tick check)")
            return True
        return False

    def can_redetect(self, server, min_gap_sec=86400):
        det = (self._entry(server).get("detected") or {})
        return time.time() - float(det.get("at") or 0) >= min_gap_sec

    def _save_rules(self):
        try:
            fd, tmp = tempfile.mkstemp(prefix=".tzr-", dir=self._dir)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"version": 1, "servers": self._servers}, f)
            os.replace(tmp, self._rule_path)
        except Exception as e:
            if self._logger:
                self._logger.warning(f"TimeOffsetStore: rule save failed: {e}")
