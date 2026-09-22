# -*- coding: utf-8 -*-
"""Downloads a newer release's .exe (found by update_checker.py) and swaps
it in for the currently running EXE.

Why this needs a helper script at all: Windows will not let a running
process overwrite (or even rename over) its own .exe file's *contents*
while it's executing - the file is memory-mapped and locked for writing.
So "replace yourself" always takes two processes: this one downloads the
new file under a *different* name, then hands off to a tiny, separate
script that (a) waits for this process to actually exit, (b) copies the
new file over the old one, (c) starts the new EXE, and (d) deletes
itself. That handoff script is generated fresh each time in
_write_helper_script() below - nothing about it ships as a separate file
in the repo.

Two ways this gets used (both end up calling apply_pending_update_and_
restart, just at different times):
  - "Update" button clicked right after a download finishes -> apply
    immediately, app closes itself, the helper swaps the file within a
    second or two and reopens the (now-updated) app.
  - User downloads but closes the app without clicking "Update" -> the
    download stays on disk as a "pending update". The *next* time the
    (still-old) EXE is launched, check_and_apply_pending_update_at_startup()
    (called once, very early in app.py, before any UI is created) finds
    it and does the exact same swap+restart before the old UI ever shows -
    so what the user experiences is: double-click the old EXE, a
    heartbeat's delay, and the new version opens instead.

Everything here is local filesystem + one detached subprocess - no
network calls (those already happened in update_checker.py /
download_update() below).
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

from runtime_paths import PROJECT_ROOT
from update_checker import EXPECTED_EXE_NAME

# v69: everything this module writes lives under PROJECT_ROOT (see
# runtime_paths.py - %LOCALAPPDATA%\MT-TickExplorer for the frozen build),
# in its own "update" subfolder alongside the existing "output"/"logs"
# ones, so a downloaded update never appears next to the portable EXE
# either.
_UPDATE_DIR = os.path.join(PROJECT_ROOT, "update")
_PENDING_EXE_PATH = os.path.join(_UPDATE_DIR, "pending_update.exe")
_PENDING_INFO_PATH = os.path.join(_UPDATE_DIR, "pending_update.json")
_DOWNLOAD_TMP_PATH = os.path.join(_UPDATE_DIR, "pending_update.download")

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

    Downloads to a temporary ".download" file first and only renames it
    to the real pending-update filename once the transfer is complete and
    its size matches what was expected - so a half-finished download can
    never be mistaken for a valid pending update (see
    get_pending_update_info() below).

    Raises DownloadCancelled if cancel_event gets set mid-transfer, or
    any exception urllib/the filesystem raises (caller wraps this in
    try/except - see ChartBridge.start_update_download()).
    """
    os.makedirs(_UPDATE_DIR, exist_ok=True)
    _clear_pending_files()

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

    os.replace(_DOWNLOAD_TMP_PATH, _PENDING_EXE_PATH)
    with open(_PENDING_INFO_PATH, "w", encoding="utf-8") as f:
        json.dump({"version": latest_version, "size": downloaded}, f)

    return _PENDING_EXE_PATH


def _clear_pending_files():
    for path in (_DOWNLOAD_TMP_PATH, _PENDING_EXE_PATH, _PENDING_INFO_PATH):
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass


def get_pending_update_info():
    """Returns {"version", "size", "exe_path"} if a fully-downloaded,
    not-yet-applied update is sitting on disk (its recorded size matches
    the actual file - guards against a previous run being killed mid-
    write), else None."""
    try:
        with open(_PENDING_INFO_PATH, "r", encoding="utf-8") as f:
            info = json.load(f)
        actual_size = os.path.getsize(_PENDING_EXE_PATH)
        if actual_size != info.get("size"):
            return None
        info["exe_path"] = _PENDING_EXE_PATH
        return info
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def _write_helper_script(pid, new_exe_path, target_exe_path):
    """Writes a small PowerShell script (not shipped in the repo - built
    fresh each time so it always embeds the exact paths/PID for this
    single handoff) that waits for this process to exit, then swaps the
    file and restarts the app. PowerShell (with Wait-Process) is used
    instead of a batch-file polling loop because it can wait on the exact
    PID without a fixed-length retry loop, keeping the handoff to well
    under a second in the common case."""
    script_path = os.path.join(_UPDATE_DIR, "apply_update.ps1")
    script = f"""
$ErrorActionPreference = 'SilentlyContinue'
try {{ Wait-Process -Id {pid} -Timeout 30 }} catch {{}}
Start-Sleep -Milliseconds 300
Copy-Item -LiteralPath "{new_exe_path}" -Destination "{target_exe_path}" -Force
Remove-Item -LiteralPath "{new_exe_path}" -Force
Remove-Item -LiteralPath "{_PENDING_INFO_PATH}" -Force
Start-Process -FilePath "{target_exe_path}"
Remove-Item -LiteralPath "$PSCommandPath" -Force
""".strip()
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(script)
    return script_path


def apply_pending_update_and_restart(pending_info, wait_pid=None):
    """Launches the detached helper script that will (once wait_pid, if
    given, has exited) copy pending_info["exe_path"] over this build's own
    EXE and relaunch it. Does NOT exit the current process itself - the
    caller does that right after calling this (see
    ChartBridge.apply_update_now(), which calls window_close() next, and
    check_and_apply_pending_update_at_startup() below, which exits before
    any window is even created)."""
    target_exe_path = os.path.abspath(sys.executable)
    pid = wait_pid if wait_pid is not None else os.getpid()
    script_path = _write_helper_script(pid, pending_info["exe_path"], target_exe_path)

    # CREATE_NO_WINDOW: this is release/windowed mode already (no console
    # exists to inherit), but PowerShell would otherwise briefly flash its
    # own window without this flag. DETACHED_PROCESS: survive this
    # process exiting, since that's the whole point - it's waiting for it.
    creationflags = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
    subprocess.Popen(
        ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
         "-ExecutionPolicy", "Bypass", "-File", script_path],
        creationflags=creationflags,
        close_fds=True,
    )


def check_and_apply_pending_update_at_startup(logger=None):
    """Called once, at the very top of the frozen EXE's startup (see
    app.py's ``if __name__ == "__main__":`` block) - before webview or
    any subsystem is touched. If a validated pending update is sitting on
    disk (from a previous session where the user downloaded an update but
    closed the app instead of clicking "Update"), this hands off to the
    same swap-and-restart helper used by the in-app button, then exits
    this (old) process immediately so the helper's Copy-Item is never
    fighting a running EXE. Returns True in that case (caller should stop
    - nothing after this point in app.py will ever run). Returns False
    immediately (the overwhelmingly common case - no pending update) after
    two cheap filesystem checks, so this adds no meaningful startup cost."""
    info = get_pending_update_info()
    if not info:
        return False
    if logger:
        logger.info(f"Pending update {info.get('version')} found at startup - applying now.")
    apply_pending_update_and_restart(info, wait_pid=os.getpid())
    os._exit(0)
    return True  # pragma: no cover - unreachable, os._exit() above never returns
