# -*- coding: utf-8 -*-
"""V66.1 - native-speed dragging for the frameless Get Started window.

Why this module exists
----------------------
``easy_drag`` / ``.pywebview-drag-region`` never moved the wizard, and the
first replacement (re-using ``ctypes.windll.user32`` the way chart_bridge.py
does) failed with ``expected LP__RECT instance instead of pointer to RECT``.
``ctypes.windll.user32`` is ONE cached object per process: pywebview and
pythonnet assign their own ``argtypes`` to the very same function objects
(``GetWindowRect`` ...), so whichever library declares last silently wins and
our RECT no longer matches.

The fix is a *private* library handle: ``ctypes.WinDLL("user32")`` returns a
new object whose functions are not shared with anybody, so the prototypes
declared here can never be overwritten (and we can never break theirs).

Why it is also the cheapest way to drag
---------------------------------------
The old chart-window model costs one JS -> Python round-trip per mouse-move.
Here JS makes exactly TWO calls per drag (begin / end); in between a tiny
Python thread reads the cursor with GetCursorPos and moves the window with
SetWindowPos (position only, no resize, no repaint request, no z-order or
activation change) roughly every 8 ms. It stops on its own as soon as the
left mouse button is released (GetAsyncKeyState), so a lost ``mouseup`` can
never leave the window glued to the cursor. Idle cost when nobody is dragging
is zero: no thread exists.
"""
import ctypes
import sys
import threading
import time

_IS_WINDOWS = sys.platform == "win32"

if _IS_WINDOWS:
    import ctypes.wintypes as _wt

    _u32 = ctypes.WinDLL("user32", use_last_error=True)  # private copy

    class _POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    class _RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    _u32.FindWindowW.restype = _wt.HWND
    _u32.FindWindowW.argtypes = [_wt.LPCWSTR, _wt.LPCWSTR]
    _u32.GetCursorPos.restype = _wt.BOOL
    _u32.GetCursorPos.argtypes = [ctypes.POINTER(_POINT)]
    _u32.GetWindowRect.restype = _wt.BOOL
    _u32.GetWindowRect.argtypes = [_wt.HWND, ctypes.POINTER(_RECT)]
    _u32.SetWindowPos.restype = _wt.BOOL
    _u32.SetWindowPos.argtypes = [
        _wt.HWND, _wt.HWND, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.c_int, ctypes.c_uint,
    ]
    _u32.GetAsyncKeyState.restype = ctypes.c_short
    _u32.GetAsyncKeyState.argtypes = [ctypes.c_int]

    _VK_LBUTTON = 0x01
    # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER
    _MOVE_ONLY = 0x0001 | 0x0004 | 0x0010 | 0x0200
    _TICK = 0.008


class WindowDragger:
    """Moves the top-level window titled ``title`` while the left button is down."""

    def __init__(self, title, logger=None):
        self._title = title
        self._logger = logger
        self._hwnd = None
        self._thread = None
        self._stop = threading.Event()

    @property
    def available(self):
        return _IS_WINDOWS

    def _find_hwnd(self):
        if not self._hwnd:
            self._hwnd = _u32.FindWindowW(None, self._title) or None
        return self._hwnd

    def begin(self):
        """Start following the cursor. Returns False when unsupported."""
        if not _IS_WINDOWS:
            return False
        if self._thread is not None and self._thread.is_alive():
            return True
        try:
            hwnd = self._find_hwnd()
            if not hwnd:
                return False
            pt, rc = _POINT(), _RECT()
            _u32.GetCursorPos(ctypes.byref(pt))
            _u32.GetWindowRect(hwnd, ctypes.byref(rc))
        except Exception as e:
            if self._logger:
                self._logger.debug(f"Get Started drag begin failed: {e}")
            return False
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._follow, args=(hwnd, pt.x, pt.y, rc.left, rc.top),
            daemon=True, name="setup-window-drag")
        self._thread.start()
        return True

    def end(self):
        self._stop.set()

    def _follow(self, hwnd, cx0, cy0, wx0, wy0):
        pt = _POINT()
        last = (wx0, wy0)
        try:
            while not self._stop.is_set() and (_u32.GetAsyncKeyState(_VK_LBUTTON) & 0x8000):
                _u32.GetCursorPos(ctypes.byref(pt))
                target = (wx0 + pt.x - cx0, wy0 + pt.y - cy0)
                if target != last:
                    _u32.SetWindowPos(hwnd, None, target[0], target[1], 0, 0, _MOVE_ONLY)
                    last = target
                time.sleep(_TICK)
        except Exception as e:
            if self._logger:
                self._logger.debug(f"Get Started drag loop stopped: {e}")
