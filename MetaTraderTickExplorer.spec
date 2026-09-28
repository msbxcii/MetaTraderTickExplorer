# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build definition for MetaTrader Tick Explorer.

This spec deliberately uses a one-file, windowed Windows executable. The
application's local ``web/`` tree is included in the temporary PyInstaller
bundle because the Python side loads the HTML/Markdown files directly.
"""
from pathlib import Path

from PyInstaller.building.build_main import Analysis, PYZ, EXE
import sys


ROOT = Path(SPECPATH).resolve()
SRC = ROOT / "src"
WEB = ROOT / "web"
ICON = ROOT / "assets" / "Icon.ico"

# Name + version come from src/version.py (single source of truth), so the
# output is e.g. dist\mt-tick.explorer-v3.0.0.exe
sys.path.insert(0, str(SRC))
import version as app_version  # noqa: E402

APP_NAME = f"{app_version.APP_NAME}-{app_version.VERSION}"
ENTRY_POINT = SRC / "app.py"

if not ENTRY_POINT.is_file():
    raise SystemExit(f"Build error: entry point not found: {ENTRY_POINT}")
if not WEB.is_dir():
    raise SystemExit(f"Build error: web resource directory not found: {WEB}")
if not ICON.is_file():
    raise SystemExit(
        f"Build error: Windows icon not found: {ICON}\n"
        "Place your Icon.ico file in the assets directory and run build.cmd again."
    )

# src is intentionally a search path rather than a package. The existing
# application imports its modules as top-level modules (e.g. ``import app``).
a = Analysis(
    [str(ENTRY_POINT)],
    pathex=[str(SRC)],
    binaries=[],
    datas=[(str(WEB), "web")],
    # update_checker/update_installer (v69) are only ever imported from
    # inside functions in app.py/chart_bridge.py, not at module top-level -
    # listed explicitly so PyInstaller's static analysis can't miss them.
    hiddenimports=["update_checker", "update_installer"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ICON),
)

