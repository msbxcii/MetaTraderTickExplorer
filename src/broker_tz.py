# -*- coding: utf-8 -*-
"""v116: broker server-clock model and automatic detection.

MT5 stamps every bar/tick with the broker's wall clock written as if it were
UTC. Brokers build that clock in only a few ways, all captured by one rule

    broker_offset(utc) = ref_offset(ref, utc) + shift_min * 60

    ref "ny"  - New York with US DST  (UTC-5 / UTC-4)        "US rule": NY+7
    ref "eu"  - Europe with EU DST    (UTC+0 / UTC+1)        EET brokers: +2h
    ref "utc" - no DST                                       fixed-UTC brokers

so "NY+7" gives UTC+2 in winter and UTC+3 in summer, a European broker is
EU+2h, a fixed broker is UTC+N. DST dates are computed arithmetically (no
tz database needed; US rule valid since 2007, EU rule since 1996), so the
same rule is mirrored 1:1 in web/js/tz.js.

detect() measures the real weekly close (Fri 17:00 New York) and open (Sun
17:00 New York) of one forex symbol on several DST-sensitive weekends via
copy_rates_range and decides which rule the broker follows.
"""
import calendar
import datetime as _dt
import time
from collections import Counter

H = 3600
TOL = 20 * 60               # a measurement "matches" a rule within 20 min
MAX_OBS = 14 * H            # plausible broker offsets: UTC-12 .. UTC+14
MIN_OBS = -12 * H
MIN_VALID = 8               # measurements needed before deciding anything
DECIDE_CONF = 0.85          # best rule must explain >= 85 % of measurements
DECIDE_MARGIN = 0.10        # ... and beat the runner-up by >= 10 % points (closes are tolerant, opens discriminate)
_REFS = ("ny", "eu", "utc")


# --------------------------------------------------------------------- DST
def _nth_sunday(year, month, n):
    """n >= 1: n-th Sunday of the month; n == -1: last Sunday."""
    if n > 0:
        first = _dt.date(year, month, 1)
        return first + _dt.timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))
    last = _dt.date(year, month, calendar.monthrange(year, month)[1])
    return last - _dt.timedelta(days=(last.weekday() + 1) % 7)


def _epoch(d, hour=0):
    return calendar.timegm((d.year, d.month, d.day, hour, 0, 0))


_bounds_cache = {}


def _bounds(ref, year):
    key = (ref, year)
    b = _bounds_cache.get(key)
    if b is None:
        if ref == "ny":     # 2nd Sun Mar 02:00 EST (07:00 UTC) -> 1st Sun Nov 02:00 EDT (06:00 UTC)
            b = (_epoch(_nth_sunday(year, 3, 2), 7), _epoch(_nth_sunday(year, 11, 1), 6))
        else:               # last Sun Mar 01:00 UTC -> last Sun Oct 01:00 UTC
            b = (_epoch(_nth_sunday(year, 3, -1), 1), _epoch(_nth_sunday(year, 10, -1), 1))
        _bounds_cache[key] = b
    return b


def ref_offset(ref, utc):
    """Seconds the reference zone is ahead of UTC at the UTC instant ``utc``."""
    if ref == "utc":
        return 0
    year = _dt.datetime.fromtimestamp(utc, _dt.timezone.utc).year
    start, end = _bounds(ref, year)
    dst = start <= utc < end
    if ref == "ny":
        return -4 * H if dst else -5 * H
    return H if dst else 0


# --------------------------------------------------------------------- rule
def make_rule(ref, shift_min):
    return {"ref": ref if ref in _REFS else "utc", "shift_min": int(round(float(shift_min)))}


def valid_rule(rule):
    return (isinstance(rule, dict) and rule.get("ref") in _REFS
            and isinstance(rule.get("shift_min"), (int, float)) and -24 * 60 <= rule["shift_min"] <= 24 * 60)


def rule_offset_at_utc(rule, utc):
    return ref_offset(rule["ref"], utc) + int(rule["shift_min"]) * 60


def rule_offset_at_broker(rule, broker_ts):
    """Offset for a time given on the broker clock itself (what bars carry)."""
    shift = int(rule["shift_min"]) * 60
    ref = rule["ref"]
    if ref == "utc":
        return shift
    std, dst = (-5 * H, -4 * H) if ref == "ny" else (0, H)
    for base in (std, dst):
        cand = base + shift
        if rule_offset_at_utc(rule, broker_ts - cand) == cand:
            return cand
    return std + shift


def _fmt_h(minutes):
    h = minutes / 60.0
    return f"{h:+g}"


def rule_label(rule):
    if not valid_rule(rule):
        return "Unknown"
    ref, sh = rule["ref"], rule["shift_min"]
    if ref == "ny":
        return f"US rule (NY{_fmt_h(sh)})"
    if ref == "eu":
        return f"Europe DST (UTC{_fmt_h(sh)} / UTC{_fmt_h(sh + 60)})"
    return f"Fixed UTC{_fmt_h(sh)}"


# ------------------------------------------------------------------ sampling
def _ny_wall_to_utc(d, hour=17):
    wall = _epoch(d, hour)
    for off in (-4 * H, -5 * H):
        if ref_offset("ny", wall - off) == off:
            return wall - off
    return wall + 5 * H


def sample_anchors(now_ts, max_years=3):
    """Sunday anchors (newest first) around the DST-sensitive weekends.

    Each anchor Sunday S yields up to four measurements: close of Fri S-2,
    open of Sun S, close of Fri S+5, open of Sun S+7.
    """
    today = _dt.datetime.fromtimestamp(now_ts, _dt.timezone.utc).date()
    out = []
    for y in range(today.year, today.year - max_years, -1):
        mar_us = _nth_sunday(y, 3, 2)
        specs = [
            ("US DST starts", mar_us),
            ("US-only window", mar_us + _dt.timedelta(days=7)),
            ("EU DST starts", _nth_sunday(y, 3, -1)),
            ("Summer", _nth_sunday(y, 6, 3)),
            ("Summer", _nth_sunday(y, 8, 3)),
            ("EU DST ends", _nth_sunday(y, 10, -1)),
            ("US DST ends", _nth_sunday(y, 11, 1)),
            ("Winter", _nth_sunday(y, 1, 3)),
            ("Winter", _nth_sunday(y, 2, 3)),
        ]
        for label, d in specs:
            if d + _dt.timedelta(days=9) <= today:
                out.append({"label": label, "date": d})
    out.sort(key=lambda a: a["date"], reverse=True)
    return out


def measurements_from_bars(bar_times, anchor_date):
    """Weekly close/open observations from H1 bar-open times of one anchor.

    ``obs`` = broker clock minus the true UTC instant of the event, seconds.
    """
    t = sorted(set(int(x) for x in bar_times))
    out = []
    fridays = (anchor_date - _dt.timedelta(days=2), anchor_date + _dt.timedelta(days=5))
    for i in range(len(t) - 1):
        if t[i + 1] - t[i] <= 30 * H:
            continue
        end = t[i] + H
        best = None
        for f in fridays:
            obs = end - _ny_wall_to_utc(f, 17)
            if best is None or abs(obs) < abs(best[0]):
                best = (obs, f)
        f = best[1]
        out.append({"kind": "close", "day": f, "utc": _ny_wall_to_utc(f, 17), "obs": best[0]})
        sun = f + _dt.timedelta(days=2)
        u_open = _ny_wall_to_utc(sun, 17)
        out.append({"kind": "open", "day": sun, "utc": u_open, "obs": t[i + 1] - u_open})
    return out


def _clean(m):
    """15-minute grid + plausibility; None for outliers (holidays, odd opens)."""
    obs = m["obs"]
    if not (MIN_OBS <= obs <= MAX_OBS):
        return None
    grid = int(round(obs / 900.0)) * 900
    if abs(obs - grid) > 600:
        return None
    c = dict(m)
    c["obs"] = grid
    return c


# ------------------------------------------------------------------ decision
def _match(rule, kind, obs, utc):
    """v116.1: many brokers publish a last stub tick exactly at the Friday close
    (e.g. 00:00 broker time), which makes the last H1 bar end one hour late.
    So a *close* may read the rule's offset or the rule's offset + 1 h."""
    d = obs - rule_offset_at_utc(rule, utc)
    return abs(d) <= TOL or (kind == "close" and abs(d - H) <= TOL)


def evaluate(measures):
    """Fit each reference zone to the measurements; returns ranked candidates."""
    cands = []
    opens = [m for m in measures if m["kind"] == "open"]
    base = opens if len(opens) >= 4 else measures     # opens are the cleaner signal
    for order, ref in enumerate(_REFS):
        shifts = [m["obs"] - ref_offset(ref, m["utc"]) for m in base]
        shift = Counter(shifts).most_common(1)[0][0] if shifts else 0
        rule = make_rule(ref, shift // 60)
        miss = sum(1 for m in measures if not _match(rule, m["kind"], m["obs"], m["utc"]))
        cands.append({"rule": rule, "mismatches": miss, "order": order})
    cands.sort(key=lambda c: (c["mismatches"], c["order"]))
    return cands


def decide(measures):
    n = len(measures)
    if n < MIN_VALID:
        return {"decided": False, "reason": "few", "n": n, "candidates": evaluate(measures) if n else []}
    cands = evaluate(measures)
    best, second = cands[0], cands[1]
    conf = 1.0 - best["mismatches"] / n
    margin = (second["mismatches"] - best["mismatches"]) / n
    decided = conf >= DECIDE_CONF and margin >= DECIDE_MARGIN
    reason = "ok" if decided else ("poor_fit" if conf < DECIDE_CONF else "ambiguous")
    return {"decided": decided, "reason": reason, "n": n, "confidence": round(conf, 3),
            "margin": round(margin, 3), "rule": best["rule"], "candidates": cands}


def _fetch_h1(mt5, symbol, t0, t1, tries=3):
    for k in range(tries):
        rates = mt5.copy_rates_range(symbol, mt5.TIMEFRAME_H1, int(t0), int(t1))
        if rates is not None and len(rates) > 24:
            return [int(x) for x in rates["time"]]
        time.sleep(0.5)
    return None


def detect(mt5, symbol, now_ts=None, logger=None, progress=None, budget_sec=90.0):
    """Run inside the process that owns the MT5 connection. Returns a report
    dict (JSON-safe). Never raises."""
    now_ts = float(now_ts or time.time())
    report = {"ok": False, "decided": False, "symbol": symbol, "at": int(now_ts),
              "weeks": [], "message": ""}
    t_start = time.monotonic()

    def say(done, total, text):
        if progress:
            try:
                progress({"state": "running", "done": done, "total": total, "text": text})
            except Exception:
                pass

    try:
        if not symbol:
            report["message"] = "No symbol given."
            return report
        if mt5.symbol_info(symbol) is None:
            report["message"] = f"Symbol '{symbol}' was not found at this broker."
            return report
        mt5.symbol_select(symbol, True)

        anchors = sample_anchors(now_ts)
        total = min(len(anchors), 18)
        seen = set()
        measures, weeks, got = [], [], 0
        for idx, a in enumerate(anchors[:total]):
            if time.monotonic() - t_start > budget_sec:
                break
            say(idx, total, f"Sampling week of {a['date'].isoformat()} ({a['label']})")
            s0 = _epoch(a["date"])
            times = _fetch_h1(mt5, symbol, s0 - 3 * 86400, s0 + 8 * 86400)
            if not times:
                weeks.append({"date": a["date"].isoformat(), "label": a["label"], "items": [], "note": "no history"})
                continue
            got += 1
            items = []
            for m in measurements_from_bars(times, a["date"]):
                key = (m["kind"], m["utc"])
                if key in seen:
                    continue
                seen.add(key)
                c = _clean(m)
                items.append({"kind": m["kind"], "day": m["day"].isoformat(), "utc": m["utc"],
                              "obs_min": int(round(m["obs"] / 60.0)), "valid": c is not None})
                if c is not None:
                    measures.append(c)
            weeks.append({"date": a["date"].isoformat(), "label": a["label"], "items": items})

        dec = decide(measures)
        rule = dec.get("rule")
        for w in weeks:
            for it in w["items"]:
                if rule and it["valid"]:
                    it["pred_min"] = int(rule_offset_at_utc(rule, it["utc"]) // 60)
                    it["ok"] = _match(rule, it["kind"], it["obs_min"] * 60, it["utc"])
                it.pop("utc", None)
        report.update({
            "ok": True, "weeks": weeks, "n_valid": dec["n"], "weeks_with_data": got,
            "decided": bool(dec["decided"]), "reason": dec["reason"],
            "confidence": dec.get("confidence"), "margin": dec.get("margin"),
            "candidates": [{"label": rule_label(c["rule"]), "rule": c["rule"], "mismatches": c["mismatches"]}
                           for c in dec.get("candidates", [])],
        })
        if dec["decided"]:
            report["rule"] = rule
            report["label"] = rule_label(rule)
            report["message"] = f"Detected: {rule_label(rule)} ({int(dec['confidence'] * 100)}% of {dec['n']} measurements agree)."
        elif dec["reason"] == "few":
            report["message"] = ("Not enough history for this symbol (" + str(dec["n"]) +
                                 " usable measurements). Try a major pair such as EURUSD, or choose the rule manually.")
        elif dec["reason"] == "poor_fit":
            report["message"] = ("The weekly open/close times of this symbol do not follow a known broker clock. "
                                 "Try a major forex pair (e.g. EURUSD), or choose the rule manually.")
        else:
            report["message"] = ("Result is ambiguous - the sampled history does not cover both DST seasons well. "
                                 "Try another forex symbol, or choose the rule manually.")
    except Exception as e:  # never break the sync loop
        report["ok"] = False
        report["message"] = f"Detection failed: {e}"
        if logger:
            logger.warning(f"tz detect failed: {e}")
    return report
