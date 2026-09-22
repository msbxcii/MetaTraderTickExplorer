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
"""
from __future__ import annotations

import os
import sys


_SOURCE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# v69: folder name used both under %LOCALAPPDATA% for the frozen build and
# as this app's own identity - keep in sync with version.py's APP_NAME if
# that's ever renamed. Deliberately short/ASCII (no spaces) since it becomes
# a filesystem path component.
_APP_DATA_FOLDER_NAME = "MT-TickExplorer"

if getattr(sys, "frozen", False):
    # PyInstaller exposes the extracted bundle through sys._MEIPASS.
    RESOURCE_ROOT = os.path.abspath(
        getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
    )
    # v69: persistent application files (output/, logs/) now live under the
    # current user's %LOCALAPPDATA%\MT-TickExplorer\ instead of beside the
    # distributed EXE. This is what makes the EXE genuinely relocatable - a
    # copy on the Desktop, on a USB stick, or in Program Files all share the
    # same data instead of each spawning their own output/logs folders next
    # to themselves. Falls back to the EXE's own folder only in the unlikely
    # case %LOCALAPPDATA% isn't set (e.g. some restricted/service accounts).
    _local_app_data = os.environ.get("LOCALAPPDATA")
    if _local_app_data:
        PROJECT_ROOT = os.path.join(_local_app_data, _APP_DATA_FOLDER_NAME)
    else:
        PROJECT_ROOT = os.path.dirname(os.path.abspath(sys.executable))
    os.makedirs(PROJECT_ROOT, exist_ok=True)
else:
    RESOURCE_ROOT = _SOURCE_ROOT
    PROJECT_ROOT = _SOURCE_ROOT


__all__ = ["PROJECT_ROOT", "RESOURCE_ROOT"]
