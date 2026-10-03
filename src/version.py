# -*- coding: utf-8 -*-
"""Single source of truth for the app's display name and version tag.

Every place in this project that shows or logs the app's name/version -
both windows' titles (this file's ``app_title()``), the startup log lines
in ``main.py``/``app.py``, ``run_chart.cmd``'s console title/banner, and the
frontend (the custom title bar and the Setting panel's About tab, via
``ChartBridge.get_app_info()`` below, which just returns these two
constants) - reads them from here instead of holding its own copy. Bump
``VERSION`` in exactly this one place for a release; nothing else needs
editing.

Versioning
----------
Tags follow this project's existing "V<major>[.<minor>]" convention (e.g.
"V68" or "V67.4"), but nothing about how VERSION is read assumes that shape - a
future release can switch to plain SemVer ("1.0.0") by changing the string
below alone; every window title, log line, and UI label picks it up
automatically. As with any git-tracked project, each release commit should
be tagged with the exact same string set here (``git tag V68``, or
``git tag 1.0.0`` once/if the project moves to SemVer) so the code at that
tag and the version it reports always match.
"""

APP_NAME = "mt-tick.explorer"
VERSION = "v4.0.2"


# Official distribution notice. Shown in the startup log, the Get Started
# wizard and the About tab. MetaTrader Tick Explorer is free software; any
# build sold for money did not come from the official project.
OFFICIAL_REPO_URL = "https://github.com/msbxcii/MetaTraderTickExplorer"
FREE_NOTICE = (
    "MetaTrader Tick Explorer is free and open-source software. "
    "Official builds are distributed only at " + OFFICIAL_REPO_URL + "/releases. "
    "If you paid for this software, you have been scammed."
)


def exe_name():
    """Release executable filename, e.g. ``"mt-tick.explorer-v3.0.0.exe"``.
    Used by the PyInstaller spec, build.cmd and the update checker."""
    return f"{APP_NAME}-{VERSION}.exe"


def app_title(suffix=None):
    """``"<APP_NAME> <VERSION>"``, with an optional ``" - <suffix>"``
    appended - e.g. ``app_title("Get Started")`` or ``app_title(symbol)``.
    The one place window titles (main chart + Get Started) and startup log
    lines are assembled, so they can never drift out of sync with each
    other or with VERSION above."""
    title = f"{APP_NAME} {VERSION}"
    if suffix:
        title = f"{title} - {suffix}"
    return title
