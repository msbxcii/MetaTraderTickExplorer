# -*- coding: utf-8 -*-
"""Checks GitHub Releases for a version newer than this build's own
VERSION (src/version.py). Used by ChartBridge.check_for_updates() -> the
About tab's "Check for Updates" button (see web/js/about-panel.js), and
by update_installer.py once a newer release is confirmed and the user
wants to actually download+install it.

Only ever talks to GitHub's public REST API (no auth, no credentials, no
third-party server) - consistent with the "no external server except
MetaTrader" claim in web/About.md. This one exception (checking releases)
is explicitly a user-triggered action, not a background/automatic call.
"""
import json
import re
import urllib.request

# v68: set this once you create the GitHub repo - e.g. "yourname/MetaTraderTickExplorer".
# Until this is filled in, check_for_update() returns an "unconfigured" status
# instead of guessing a URL.
GITHUB_REPO = "USERNAME/REPO-NAME"

_API_URL = "https://api.github.com/repos/{repo}/releases/latest"
_TIMEOUT_SECONDS = 6

# v69: the released .exe asset's filename must match this (case-insensitive)
# for check_for_update() to treat it as the downloadable update. Matches the
# name build.cmd/the .spec file produce - see EXPECTED_EXE_NAME in
# update_installer.py, which imports this same value so the two can never
# drift apart.
EXPECTED_EXE_NAME = "MetaTrader Tick Explorer.exe"


def _parse_version(tag):
    """'V68' / 'v67.4' / '1.2.0' -> a tuple of ints, e.g. (68,) or (67, 4),
    for a numeric comparison. Falls back to (0,) if nothing numeric is
    found, so a weird tag never crashes the comparison - it just never
    counts as "newer"."""
    numbers = re.findall(r"\d+", tag or "")
    return tuple(int(n) for n in numbers) if numbers else (0,)


def _find_exe_asset(assets):
    """Pick the release asset to offer as the update download: an exact
    (case-insensitive) filename match first, falling back to "the only
    .exe attached" so a release still works if the file was renamed for a
    given tag. Returns None if neither is found - the caller then reports
    "update_available" without a download (About tab just links to the
    release page instead, same as before this download feature existed)."""
    exe_assets = [a for a in (assets or []) if str(a.get("name", "")).lower().endswith(".exe")]
    for a in exe_assets:
        if a.get("name", "").lower() == EXPECTED_EXE_NAME.lower():
            return a
    return exe_assets[0] if len(exe_assets) == 1 else None


def check_for_update(current_version):
    """Hits the GitHub "latest release" endpoint once and compares it to
    current_version (e.g. version.VERSION). Returns a dict with a
    "status" key, always without raising:
      - "unconfigured": GITHUB_REPO above hasn't been set yet
      - "up_to_date":   no newer release found
      - "update_available": {"latest_version", "url", "download_url",
                              "download_size", "asset_name"}. download_url
                              is None (frontend falls back to opening "url")
                              when the release has no matching .exe asset.
      - "error":        {"message"} - network/parsing problem; caller
                         should treat this like "couldn't check right now"
    """
    if not GITHUB_REPO or "/" not in GITHUB_REPO or GITHUB_REPO.startswith("USERNAME"):
        return {"status": "unconfigured"}

    url = _API_URL.format(repo=GITHUB_REPO)
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        latest_tag = data.get("tag_name") or ""
        latest_url = data.get("html_url") or f"https://github.com/{GITHUB_REPO}/releases"

        if _parse_version(latest_tag) <= _parse_version(current_version):
            return {"status": "up_to_date"}

        asset = _find_exe_asset(data.get("assets"))
        return {
            "status": "update_available",
            "latest_version": latest_tag,
            "url": latest_url,
            "download_url": asset.get("browser_download_url") if asset else None,
            "download_size": asset.get("size") if asset else None,
            "asset_name": asset.get("name") if asset else None,
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
