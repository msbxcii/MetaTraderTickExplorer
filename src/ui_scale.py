# -*- coding: utf-8 -*-
"""v104: interface scale - pure math and prefs rules (no Windows/WebView code).

The whole UI is drawn in fixed CSS px. Instead of rewriting every size, the
window is zoomed natively (WebView2 ZoomFactor, same as browser zoom), so
panels, icons, fonts and chart text scale together.

    zoom = percent / 100      (percent is one of PERCENTS, default 100)

No automatic screen-based fitting: only the user's chosen percent is used.
"""

PERCENTS = (50, 75, 100, 125, 150)
PERCENT_DEFAULT = 100

DEFAULT_PREFS = {"percent": PERCENT_DEFAULT}


def sanitize_prefs(raw):
    """Return a clean ``{"percent": int}`` from any input (old keys such as
    "auto" in a saved file are ignored)."""
    out = dict(DEFAULT_PREFS)
    if isinstance(raw, dict):
        try:
            pct = int(round(float(raw.get("percent", PERCENT_DEFAULT))))
            if pct in PERCENTS:
                out["percent"] = pct
        except (TypeError, ValueError):
            pass
    return out


def target_zoom(prefs):
    """Final zoom factor for the given prefs."""
    return round(sanitize_prefs(prefs)["percent"] / 100.0, 3)


# v106: candles needed for gap-free navigation at each scale (measured at
# 125% = 4339, the config.py base). A smaller scale shows more candles per
# screen, so the window/chunk grows by candle_factor(percent).
_BASE_CANDLES = 4339
CANDLES_AT_PERCENT = {50: 11000, 75: 8000, 100: 6000, 125: 4339, 150: 4339}


def candle_factor(percent):
    """Multiplier for CHART_INITIAL_CANDLES / CHART_LAZY_LOAD_CHUNK."""
    n = CANDLES_AT_PERCENT.get(sanitize_prefs({"percent": percent})["percent"], _BASE_CANDLES)
    return n / float(_BASE_CANDLES)
