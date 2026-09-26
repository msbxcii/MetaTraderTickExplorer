# -*- coding: utf-8 -*-
"""Runtime paths shared by source and PyInstaller builds.

The source tree treats the repository root as both its resource root and its
user-data root. A PyInstaller one-file executable is different: bundled
resources are unpacked into a temporary directory, while persistent user data
(the ``output/`` and ``logs/`` trees - see config.py's OUTPUT_DIR/LOG_DIR and
everything under ``output/settings``) lives in the current Windows user's
per-user app-data folder instead, so a portable copy of the EXE (e.g. one the
user drops on the Desktop) never spills extra folders next to itself. Keeping
the distinction here prevents the frozen build from losing access to ``web/``
files or writing settings into the one-file extraction directory.

v72: the Get Started wizard's "Root Project Folder" field lets the user park
all of this (databases, logs, settings) somewhere other than the default
location described above. That choice is remembered in a tiny pointer file -
see ROOT_POINTER_FILENAME / read_root_override() / write_root_override()
below - which always lives at the DEFAULT location itself (never inside the
custom root), so it can be found again on every future launch no matter
where the user last pointed the app at. PROJECT_ROOT below is simply
"whatever read_root_override() says, else the default" - resolved once per
process, the same way it always was.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile


_SOURCE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# v69: folder name used both under %LOCALAPPDATA% for the frozen build and
# as this app's own identity - keep in sync with version.py's APP_NAME if
# that's ever renamed. Deliberately short/ASCII (no spaces) since it becomes
# a filesystem path component.
_APP_DATA_FOLDER_NAME = "MT-TickExplorer"

# v72: name of the small JSON pointer file that records a user-chosen custom
# Root Project Folder. Always written next to DEFAULT_PROJECT_ROOT (see
# module docstring above) - never inside the custom root itself, since the
# whole point is to be discoverable before the custom root is even known.
ROOT_POINTER_FILENAME = "root_location.json"


def _compute_default_root():
    """The root the app would use if the user never picks a custom one -
    exactly the logic this module always had, split out into a function so
    it can also serve as the fixed, well-known home for the pointer file."""
    if getattr(sys, "frozen", False):
        # v69: persistent application files (output/, logs/) live under the
        # current user's %LOCALAPPDATA%\MT-TickExplorer\ instead of beside
        # the distributed EXE. This is what makes the EXE genuinely
        # relocatable - a copy on the Desktop, on a USB stick, or in Program
        # Files all share the same data instead of each spawning their own
        # output/logs folders next to themselves. Falls back to the EXE's
        # own folder only in the unlikely case %LOCALAPPDATA% isn't set
        # (e.g. some restricted/service accounts).
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return os.path.join(local_app_data, _APP_DATA_FOLDER_NAME)
        return os.path.dirname(os.path.abspath(sys.executable))
    return _SOURCE_ROOT


if getattr(sys, "frozen", False):
    # PyInstaller exposes the extracted bundle through sys._MEIPASS.
    RESOURCE_ROOT = os.path.abspath(
        getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
    )
else:
    RESOURCE_ROOT = _SOURCE_ROOT

DEFAULT_PROJECT_ROOT = _compute_default_root()


def root_pointer_path():
    """Fixed, well-known location of the v72 custom-root pointer file -
    always under DEFAULT_PROJECT_ROOT, regardless of any override in effect."""
    return os.path.join(DEFAULT_PROJECT_ROOT, ROOT_POINTER_FILENAME)


def read_root_override():
    """Return the user's saved custom Root Project Folder, or None when no
    override is saved (the common case: everything stays at the default)."""
    try:
        with open(root_pointer_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        custom_root = str((data or {}).get("root") or "").strip()
        return custom_root or None
    except Exception:
        return None


def write_root_override(path):
    """Persist `path` as the Root Project Folder for every future launch.
    Pass None (or DEFAULT_PROJECT_ROOT) to clear the override and go back
    to the default location. Best-effort, like every other settings file in
    this app: a failure here just means the choice isn't remembered, it
    never raises into the caller."""
    try:
        os.makedirs(DEFAULT_PROJECT_ROOT, exist_ok=True)
        normalized = os.path.abspath(path) if path else None
        data = {} if (not normalized or normalized == DEFAULT_PROJECT_ROOT) else {"root": normalized}
        fd, tmp = tempfile.mkstemp(prefix=".root-", dir=DEFAULT_PROJECT_ROOT)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return False
        os.replace(tmp, root_pointer_path())
        return True
    except OSError:
        return False


def _resolve_project_root():
    override = read_root_override()
    if override:
        try:
            os.makedirs(override, exist_ok=True)
            return override
        except OSError:
            pass  # unreachable/removable drive, permissions, ... - fall back
    os.makedirs(DEFAULT_PROJECT_ROOT, exist_ok=True)
    return DEFAULT_PROJECT_ROOT


PROJECT_ROOT = _resolve_project_root()


__all__ = [
    "PROJECT_ROOT",
    "RESOURCE_ROOT",
    "DEFAULT_PROJECT_ROOT",
    "root_pointer_path",
    "read_root_override",
    "write_root_override",
]
