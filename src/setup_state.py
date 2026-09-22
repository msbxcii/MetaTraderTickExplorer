# -*- coding: utf-8 -*-
"""V66.2 - Get Started wizard persistence and "is this a first run?" detection.

The wizard (see src/get_started.py + web/get-started.html) must:
  * appear on the very first launch,
  * appear again later if the user deletes every symbol database,
  * remember which step the user reached if it is closed half-way,
  * never appear again once the initial setup completed successfully.

Everything needed for that is one tiny JSON file plus one cheap directory
listing - no extra state anywhere else in the app.
"""
import json
import os
import tempfile

# Sidecar files SQLite keeps next to a database; they are not data by
# themselves, so they never make the app look "already set up".
_SIDECAR_SUFFIXES = ("-wal", "-shm", ".tmp")

_STATE_FILENAME = "setup_state.json"
_STATE_VERSION = 2

# Wizard steps (1-based, matching the sidebar in web/get-started.html).
STEP_WELCOME = 1
STEP_PREPARATION = 2
STEP_SYMBOL = 3
STEP_FINISH = 4

# V66.1 stored five steps. Its old step numbers are migrated in load_state
# so an interrupted V66.1 setup resumes at the corresponding V66.2 stage.
_OLD_STEP_TO_NEW = {1: 1, 2: 1, 3: 2, 4: 3, 5: 4}


def state_path(setup_dir):
    return os.path.join(setup_dir, _STATE_FILENAME)


def load_state(setup_dir):
    """Return the saved wizard state, migrating the V66.1 five-step layout."""
    default = {"completed": False, "step": STEP_WELCOME,
               "server": "", "symbol": "", "state_version": _STATE_VERSION}
    try:
        with open(state_path(setup_dir), "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return default

        version = int(data.get("state_version") or 1)
        old_step = int(data.get("step") or STEP_WELCOME)
        if version < _STATE_VERSION:
            old_step = _OLD_STEP_TO_NEW.get(old_step, STEP_WELCOME)

        default.update({k: v for k, v in data.items() if k in {"completed", "server", "symbol"}})
        default["step"] = max(STEP_WELCOME, min(STEP_FINISH, old_step))
        default["completed"] = bool(default["completed"])
        default["state_version"] = _STATE_VERSION

        # Drop the obsolete V66/V66.1 requirements flag when the state is
        # saved again. It is intentionally ignored; requirements are owned
        # by the launcher now, not by the wizard.
        return default
    except Exception:
        return default


def save_state(setup_dir, **changes):
    """Merge `changes` into the saved state and write it atomically."""
    state = load_state(setup_dir)
    state.update(changes)
    try:
        os.makedirs(setup_dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".setup-", dir=setup_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
                f.write("\n")
            os.replace(tmp, state_path(setup_dir))
        finally:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
    except Exception:
        pass  # a wizard that cannot remember its step is still usable
    return state


def has_market_data(output_dir):
    """True when at least one symbol database exists on disk.

    One os.listdir() only: no file is opened, so this stays cheap enough to
    run on every launch. Subfolders (session/, symbol-list/) and SQLite
    sidecars are ignored, so "the user deleted all their symbol databases"
    is detected correctly even though those helper files remain.
    """
    try:
        names = os.listdir(output_dir)
    except OSError:
        return False
    for name in names:
        if any(name.endswith(suffix) for suffix in _SIDECAR_SUFFIXES):
            continue
        full = os.path.join(output_dir, name)
        try:
            if os.path.isfile(full) and os.path.getsize(full) > 0:
                return True
        except OSError:
            continue
    return False


def needs_setup(setup_dir, output_dir):
    """The Get Started window is shown when the initial setup never
    completed, or when every symbol database has since been deleted."""
    state = load_state(setup_dir)
    if not state.get("completed"):
        return True
    return not has_market_data(output_dir)
