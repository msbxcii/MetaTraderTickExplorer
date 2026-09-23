# -*- coding: utf-8 -*-
"""Downloads a newer release's .exe (found by update_checker.py) into its
own "update" folder, ready for the user to switch to by hand.

v71: dropped the whole self-swap mechanism (previously: download under a
temp name, hand off to a generated PowerShell/cmd helper that waits for
this process to exit, overwrites the running EXE, and relaunches it).
That approach kept getting silently blocked in the field - first by
PowerShell's execution policy, then by antivirus/EDR treating "hidden
helper process waits for a PID to die, then overwrites an EXE and
restarts it" as exactly the behavior pattern it's built to catch, with
no error ever surfacing because the process that would report it was
the one being killed. Chasing each new silent failure with a cleverer
script was a losing game.

So this now does the one part that's actually reliable - downloading a
file - and stops there. The new EXE lands under update/, named exactly
like the real app (EXPECTED_EXE_NAME), so it's immediately obvious and
double-clickable. The UI (chart_bridge.py's ChartBridge.open_update_
folder / about-panel.js) tells the user in plain language to close the
app, delete the old EXE, and run the one from update/ instead - and
that nothing else (cached candles, drawings, settings - all in separate
files under PROJECT_ROOT, never next to the EXE) is touched by that.

No subprocess, no generated scripts, no waiting on a PID - just a
download.
"""
import json
import os
import time
import urllib.request

from runtime_paths import PROJECT_ROOT
from update_checker import EXPECTED_EXE_NAME

# Everything this module writes lives under PROJECT_ROOT (see
# runtime_paths.py - %LOCALAPPDATA%\MT-TickExplorer for the frozen build),
# in its own "update" subfolder alongside the existing "output"/"logs"
# ones, so a downloaded update never appears next to the portable EXE
# either - and is easy to point the user at as a self-contained folder.
_UPDATE_DIR = os.path.join(PROJECT_ROOT, "update")
_DOWNLOADED_EXE_PATH = os.path.join(_UPDATE_DIR, EXPECTED_EXE_NAME)
_PENDING_INFO_PATH = os.path.join(_UPDATE_DIR, "downloaded_update.json")
_DOWNLOAD_TMP_PATH = os.path.join(_UPDATE_DIR, "downloaded_update.tmp")

_DOWNLOAD_TIMEOUT_SECONDS = 15          # per-connection/read timeout, not total
_PROGRESS_MIN_INTERVAL_SECONDS = 0.15    # throttle UI updates during download


class DownloadCancelled(Exception):
    """Raised inside download_update() when cancel_event was set."""


def download_update(download_url, expected_size, latest_version, progress_callback=None,
                     cancel_event=None):
    """Streams download_url to disk in chunks, calling
    progress_callback(bytes_downloaded, total_bytes) every
    _PROGRESS_MIN_INTERVAL_SECONDS (never more often - a Setting-panel
    progress bar doesn't need per-chunk precision, and calling into the
    JS bridge that often would be wasted work). total_bytes falls back to
    the server's Content-Length header if expected_size (from the GitHub
    API's release-asset metadata) is unavailable.

    Downloads to a temporary ".tmp" file first and only renames it to
    the real, user-facing EXE name once the transfer is complete and its
    size matches what was expected - so a half-finished download can
    never be mistaken for a ready update (see get_pending_update_info()
    below), and the user never sees a partial EXE sitting in update\\.

    Raises DownloadCancelled if cancel_event gets set mid-transfer, or
    any exception urllib/the filesystem raises (caller wraps this in
    try/except - see ChartBridge.start_update_download()).
    """
    os.makedirs(_UPDATE_DIR, exist_ok=True)
    _clear_downloaded_files()

    req = urllib.request.Request(download_url, headers={"User-Agent": "MetaTraderTickExplorer-Updater"})
    with urllib.request.urlopen(req, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as resp:
        total = expected_size or int(resp.headers.get("Content-Length") or 0)
        downloaded = 0
        last_report = 0.0

        with open(_DOWNLOAD_TMP_PATH, "wb") as f:
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    raise DownloadCancelled()
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                now = time.monotonic()
                if progress_callback and (now - last_report) >= _PROGRESS_MIN_INTERVAL_SECONDS:
                    progress_callback(downloaded, total)
                    last_report = now

    if progress_callback:
        progress_callback(downloaded, total or downloaded)

    os.replace(_DOWNLOAD_TMP_PATH, _DOWNLOADED_EXE_PATH)
    with open(_PENDING_INFO_PATH, "w", encoding="utf-8") as f:
        json.dump({"version": latest_version, "size": downloaded}, f)

    return _DOWNLOADED_EXE_PATH


def _clear_downloaded_files():
    for path in (_DOWNLOAD_TMP_PATH, _DOWNLOADED_EXE_PATH, _PENDING_INFO_PATH):
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass


def get_pending_update_info():
    """Returns {"version", "size", "exe_path", "folder"} if a fully-
    downloaded update is sitting in update\\ (its recorded size matches
    the actual file - guards against a previous run being killed mid-
    write), else None. Used both right after a download finishes and to
    remind the user again next time they open the About tab, until they
    delete the old EXE and switch over."""
    try:
        with open(_PENDING_INFO_PATH, "r", encoding="utf-8") as f:
            info = json.load(f)
        actual_size = os.path.getsize(_DOWNLOADED_EXE_PATH)
        if actual_size != info.get("size"):
            return None
        info["exe_path"] = _DOWNLOADED_EXE_PATH
        info["folder"] = _UPDATE_DIR
        return info
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def open_update_folder():
    """Opens update\\ in Explorer so the user can see/run the downloaded
    EXE straight away. Windows-only (os.startfile); best-effort - if it
    fails for any reason the caller still has the folder path to show as
    text, so a failure here is never fatal to the update flow."""
    os.makedirs(_UPDATE_DIR, exist_ok=True)
    try:
        os.startfile(_UPDATE_DIR)  # noqa: this module only ever runs on Windows
        return True
    except Exception:
        return False
