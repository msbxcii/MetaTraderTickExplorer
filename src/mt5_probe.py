# -*- coding: utf-8 -*-
"""V66 - Get Started step 3: a one-shot "can we talk to MetaTrader 5?" probe.

Runs in its OWN short-lived process for the same reason sync_process.py
does: the compiled MetaTrader5 extension holds the GIL while
mt5.initialize() waits, and that call takes up to ~65 s to fail when the
terminal is closed or not logged in. Doing it on a thread of the wizard
window would freeze the wizard for exactly as long; a separate process
cannot affect it at all, and a probe that hangs can simply be terminated.

The probe answers three questions in one round trip: is the terminal
reachable, which broker server is the account logged in to, and what is
the complete symbol list. That is everything steps 3 and 4 need.
"""
import multiprocessing as mp


def _probe_worker(out_queue):
    """Child process body. Only plain, picklable data crosses back."""
    result = {"ok": False, "error": "", "server": "", "company": "", "login": "", "symbols": []}
    mt5 = None
    try:
        import MetaTrader5 as mt5_module
        from config import MT5_TERMINAL_PATH

        initialized = mt5_module.initialize(path=MT5_TERMINAL_PATH) if MT5_TERMINAL_PATH else mt5_module.initialize()
        mt5 = mt5_module
        if not initialized:
            result["error"] = (
                "MetaTrader 5 did not accept the connection "
                f"(error {mt5_module.last_error()}). Make sure the terminal is open, "
                "you are logged in to an account, and Python integration is enabled."
            )
            return
        account = mt5_module.account_info()
        if account is None:
            result["error"] = (
                "Connected to the terminal, but no account is logged in. "
                "Log in to your account in MetaTrader 5 and try again."
            )
            return
        result["server"] = str(getattr(account, "server", "") or "").strip()
        result["company"] = str(getattr(account, "company", "") or "").strip()
        result["login"] = str(getattr(account, "login", "") or "").strip()

        symbols = mt5_module.symbols_get()
        items, seen = [], set()
        for item in symbols or []:
            name = str(getattr(item, "name", "") or "").strip()
            if not name or name in seen:
                continue
            seen.add(name)
            items.append({"symbol": name, "description": str(getattr(item, "description", "") or "").strip()})
        items.sort(key=lambda x: x["symbol"].casefold())
        result["symbols"] = items
        if not items:
            result["error"] = (
                "Connected, but the broker returned no symbols. Open Market Watch in "
                "MetaTrader 5, make sure symbols are visible, then try again."
            )
            return
        if not result["server"]:
            result["error"] = "Connected, but the broker server name could not be read. Try again in a moment."
            return
        result["ok"] = True
    except ImportError as e:
        result["error"] = f"The MetaTrader5 Python package is not available: {e}"
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
    finally:
        try:
            if mt5 is not None:
                mt5.shutdown()
        except Exception:
            pass
        try:
            out_queue.put(result)
        except Exception:
            pass


def probe(timeout=120.0):
    """Blocking, but safe to call from a UI worker thread: the blocking
    MT5 work happens in the child process, not here."""
    out_queue = mp.Queue()
    proc = mp.Process(target=_probe_worker, args=(out_queue,), daemon=True, name="mt5-probe")
    proc.start()
    try:
        try:
            result = out_queue.get(timeout=timeout)
        except Exception:
            result = {
                "ok": False, "symbols": [], "server": "", "company": "", "login": "",
                "error": ("MetaTrader 5 did not respond in time. Check that the terminal is "
                          "running and logged in, then try again."),
            }
        return result
    finally:
        proc.join(timeout=3)
        if proc.is_alive():
            proc.terminate()
            proc.join(timeout=3)
        try:
            out_queue.close()
        except Exception:
            pass
