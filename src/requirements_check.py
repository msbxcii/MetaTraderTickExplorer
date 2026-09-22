# -*- coding: utf-8 -*-
"""V66.2 - read-only runtime requirement check.

This module deliberately NEVER installs or upgrades anything.
The launcher calls it before starting the application so the visible Cmd
window can report missing requirements and give the exact manual command:

    python -m pip install -r requirements.txt

The Get Started window does not use this module.
"""
from __future__ import annotations

import importlib
import importlib.metadata as md
from pathlib import Path
import re
import sys
from typing import Dict, List, Tuple


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_REQUIREMENTS_FILE = _PROJECT_ROOT / "requirements.txt"

# requirements.txt is intentionally small and plain today. Keep the parser
# conservative: preserve each requirement exactly as written, extract the
# distribution name, and check that distribution is present. For common
# version operators we also verify the installed version when possible.
_REQ_NAME_RE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)")
_IMPORT_NAMES = {
    "pywebview": "webview",
}
_VERSION_RE = re.compile(r"^\s*([A-Za-z0-9_.-]+)\s*(==|>=|<=|~=|>|<)\s*([^\s;]+)")


def _parse_requirements(path: Path = _REQUIREMENTS_FILE) -> List[Tuple[str, str]]:
    """Return [(distribution_name, original_requirement), ...]."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []

    rows: List[Tuple[str, str]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = line.split(" #", 1)[0].strip()
        if not line:
            continue
        match = _REQ_NAME_RE.match(line)
        if not match:
            continue
        rows.append((match.group(1), line))
    return rows


def _version_tuple(version: str) -> Tuple:
    """Small comparison helper for ordinary numeric/dotted versions.

    A non-numeric suffix is kept lexically. This is sufficient for the
    requirements used by this project and avoids importing an extra package
    just to perform the check.
    """
    parts = re.findall(r"\d+|[A-Za-z]+", version or "")
    out = []
    for part in parts:
        out.append(int(part) if part.isdigit() else part.lower())
    return tuple(out)


def _satisfies(version: str, requirement: str) -> bool:
    match = _VERSION_RE.match(requirement)
    if not match:
        return True
    _, op, wanted = match.groups()
    actual = _version_tuple(version)
    target = _version_tuple(wanted)
    if op == "==":
        return actual == target
    if op == ">=":
        return actual >= target
    if op == "<=":
        return actual <= target
    if op == ">":
        return actual > target
    if op == "<":
        return actual < target
    if op == "~=":
        return actual >= target
    return True


def _check_one(name: str, requirement: str) -> Dict[str, object]:
    try:
        version = md.version(name)
        installed = _satisfies(version, requirement)
    except md.PackageNotFoundError:
        version = ""
        installed = False
    except Exception:
        version = ""
        installed = False

    # Distribution name matching is authoritative for requirements.txt, but
    # importability catches a broken/incomplete install such as a missing
    # package module even when metadata remains on disk.
    import_name = _IMPORT_NAMES.get(name.lower(), name.replace("-", "_"))
    import_ok = True
    try:
        importlib.import_module(import_name)
    except Exception:
        import_ok = False

    ok = bool(version) and installed and import_ok
    detail = ""
    if ok:
        detail = f"installed ({version})"
    elif not version:
        detail = "missing"
    elif not installed:
        detail = f"version {version} does not satisfy {requirement}"
    elif not import_ok:
        detail = f"metadata exists ({version}) but the Python module could not be imported"

    return {
        "name": name,
        "requirement": requirement,
        "version": version,
        "ok": ok,
        "detail": detail,
    }


def check_all() -> Dict[str, object]:
    """Return a read-only status for every entry in requirements.txt."""
    rows = [_check_one(name, requirement) for name, requirement in _parse_requirements()]
    missing = [row for row in rows if not row["ok"]]
    return {
        "requirements_file": str(_REQUIREMENTS_FILE),
        "items": rows,
        "ok": not missing and bool(rows),
        "missing": missing,
    }


def main() -> int:
    print("[Requirements] Read-only check; no packages will be installed automatically.")
    print(f"[Requirements] File: {_REQUIREMENTS_FILE}")
    status = check_all()

    if not status["items"]:
        print("[ERROR] requirements.txt is missing or contains no readable requirements.")
        print("[ERROR] The application will not be started.")
        return 1

    for row in status["items"]:
        label = row["requirement"]
        if row["ok"]:
            print(f"[OK] {label} -> {row['detail']}")
        else:
            print(f"[ERROR] {label} -> {row['detail']}")

    if status["ok"]:
        print("[Requirements] All requirements are installed and importable.")
        return 0

    print()
    print("[ERROR] One or more required packages are missing or unusable.")
    print("[ACTION] Install them manually from this folder with:")
    print("         python -m pip install -r requirements.txt")
    print("[ACTION] No automatic pip install was performed.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
