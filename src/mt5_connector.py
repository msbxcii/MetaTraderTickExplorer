# -*- coding: utf-8 -*-


import platform
import struct
import sys

from config import MT5_TERMINAL_PATH
from logger_setup import register_sensitive_values


def _log_diagnostics(logger):

    python_bitness = struct.calcsize("P") * 8
    logger.debug(f"Python executable path: {sys.executable}")
    logger.debug(f"Python version: {platform.python_version()} ({python_bitness}-bit)")
    logger.debug(f"OS: {platform.platform()}")


def connect(logger):

    logger.info("Attempting to import the MetaTrader5 library ...")
    try:
        import MetaTrader5 as mt5
    except ImportError as e:
        logger.error("The MetaTrader5 library is not installed or not available.")
        logger.error(f"Error details: {e}")
        logger.error("Fix: run the following command in Cmd:  pip install MetaTrader5")
        return None

    # --- Diagnostics printed BEFORE attempting initialize() ---
    logger.debug(f"MetaTrader5 package version: {mt5.__version__}")
    logger.debug(f"MetaTrader5 package __author__: {getattr(mt5, '__author__', 'n/a')}")
    _log_diagnostics(logger)

    logger.info("Connecting to the MetaTrader 5 terminal (it must already be open and logged in) ...")

    if MT5_TERMINAL_PATH:
        logger.info(f"MT5_TERMINAL_PATH is set in config.py, using explicit path: {MT5_TERMINAL_PATH}")
        initialized = mt5.initialize(path=MT5_TERMINAL_PATH)
    else:
        initialized = mt5.initialize()

    # --- Diagnostics printed AFTER attempting initialize(), success or fail ---
    logger.debug(f"mt5.initialize() returned: {initialized}")
    logger.debug(f"mt5.last_error() -> {mt5.last_error()}")

    if not initialized:
        error_code = mt5.last_error()
        logger.error("Connecting to MT5 failed (mt5.initialize() returned False).")
        logger.error(f"MT5 error code and message: {error_code}")
        logger.error(
            "Troubleshooting checklist:\n"
            "  1) The MetaTrader 5 terminal must be open on this same machine.\n"
            "  2) You must be fully logged in to an account (demo or real) in the terminal,\n"
            "     not just sitting on the login screen.\n"
            "  3) In MT5 settings: Tools > Options > Expert Advisors, make sure\n"
            "     'Allow algorithmic trading' (or similar) is enabled.\n"
            "  4) If you have multiple Python installations, make sure the MetaTrader5\n"
            "     package is installed on the same Python that is currently running.\n"
            "  5) Python and the MT5 terminal must match in bitness (both 64-bit is standard;\n"
            "     this Python is "
            f"{struct.calcsize('P') * 8}-bit).\n"
            "  6) If MT5 is running as Administrator, Python should be run as Administrator too\n"
            "     (or neither should be) — a mismatch can block the local IPC pipe.\n"
            "  7) Normally leave MT5_TERMINAL_PATH empty so MetaTrader5 can auto-detect\n"
            "     the default terminal. Only set it in src/config.py when you need a\n"
            "     specific MT5 installation (for example, when several terminals exist).\n"
            "  8) Antivirus/firewall software can sometimes block the local pipe between\n"
            "     Python and the terminal — try temporarily disabling it as a test.\n"
            "  Note: this is a local IPC (named pipe) connection between Python and the\n"
            "  terminal process on this machine — it does not go through the internet,\n"
            "  so network filtering/proxies do not affect this step."
        )
        return None

    logger.info("Successfully connected to MT5.")

    account_info = mt5.account_info()
    terminal_info = mt5.terminal_info()

    if account_info is not None:
        register_sensitive_values(
            logger,
            getattr(account_info, "login", None),
            getattr(account_info, "server", None),
            getattr(account_info, "company", None),
        )
        logger.info(
            f"Account info: login={account_info.login}, "
            f"server={account_info.server}, "
            f"broker={account_info.company}, "
            f"currency={account_info.currency}"
        )
    else:
        logger.warning("account_info() returned empty. Login may not be fully complete yet.")

    if terminal_info is not None:
        logger.debug(
            f"Terminal info: data_path={terminal_info.data_path}, "
            f"build={terminal_info.build}, "
            f"connected={terminal_info.connected}"
        )
        if not terminal_info.connected:
            logger.warning(
                "terminal_info.connected is False: the terminal itself is not connected "
                "to the broker's trade server (this IS the point where broker-side network "
                "filtering could matter). The local Python<->terminal IPC link is fine though."
            )

    return mt5


def get_server_name(mt5):
    """The broker server of the logged-in account, or None if not available."""
    try:
        info = mt5.account_info()
        server = getattr(info, "server", None) if info is not None else None
        return str(server).strip() if server else None
    except Exception:
        return None


def check_symbol(mt5, symbol, logger):

    logger.info(f"Checking symbol '{symbol}' ...")
    symbol_info = mt5.symbol_info(symbol)

    if symbol_info is None:
        logger.error(f"Symbol '{symbol}' was not found in the broker's symbol list at all.")
        logger.error(
            "The symbol name is probably different at your broker (e.g. XAUUSD.m or "
            "GOLD or XAUUSDm). Right-click Market Watch in MT5 and open 'Symbols' to "
            "see the exact name, then update src/config.py with that name."
        )
        return False

    if not symbol_info.visible:
        logger.warning(f"Symbol '{symbol}' is hidden in Market Watch; attempting to enable it ...")
        if not mt5.symbol_select(symbol, True):
            logger.error(f"Failed to automatically enable symbol '{symbol}'.")
            return False
        logger.info(f"Symbol '{symbol}' was successfully enabled.")
    else:
        logger.info(f"Symbol '{symbol}' is already visible and enabled in Market Watch.")

    return True


def shutdown(mt5, logger):
    logger.info("Shutting down the MT5 connection ...")
    mt5.shutdown()
    logger.info("Connection closed successfully.")
