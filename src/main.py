# -*- coding: utf-8 -*-


import os
import sys
import traceback

from logger_setup import setup_logger, current_log_path
import mt5_connector
import tick_explorer
import tick_store
import symbol_manager
import version as app_version
from config import OUTPUT_DIR, SYMBOL_LIST_DIR


def main():
    logger, log_filename = setup_logger()

    logger.info("#" * 60)
    logger.info(f"Starting {app_version.app_title()}")
    logger.info(f"Target symbol selected in Get Started")
    logger.info("#" * 60)

    mt5 = None
    conn = None
    exit_code = 0

    try:
        mt5 = mt5_connector.connect(logger)
        if mt5 is None:
            logger.error("Connection failed. Stopping the program.")
            exit_code = 1
            return exit_code

        account_info = mt5.account_info()
        broker_server = account_info.server if account_info is not None else "unknown-server"
        symbols = symbol_manager.discover_and_save_symbol_list(mt5, SYMBOL_LIST_DIR, broker_server, logger)
        saved_symbol = symbol_manager.load_selected_symbol(OUTPUT_DIR, broker_server)
        active_symbol = symbol_manager.choose_startup_symbol(None, symbols, saved_symbol)
        if not saved_symbol:
            symbol_manager.save_selected_symbol(OUTPUT_DIR, broker_server, active_symbol, logger)
        logger.info(f"Selected symbol: {active_symbol}")

        symbol_ok = mt5_connector.check_symbol(mt5, active_symbol, logger)
        if not symbol_ok:
            logger.error("Selected symbol is not usable. Stopping the program.")
            exit_code = 1
            return exit_code

        # v53: the active symbol is config.py SYMBOL only on first use;
        # afterwards the per-server selected-symbol file wins.
        # MT5 broker server currently logged in (not a fixed config.py
        # setting anymore), so each symbol/server pair gets its own file.
        account_info = mt5.account_info()
        broker_server = account_info.server if account_info is not None else None
        if not broker_server:
            logger.warning(
                "Could not read the MT5 broker server name from account_info(); "
                "using 'unknown-server' as a placeholder in the data filename."
            )
            broker_server = "unknown-server"
        logger.info(f"Broker server: {broker_server}")

        os.makedirs(OUTPUT_DIR, exist_ok=True)
        tick_store.hide_unknown_server_artifacts(OUTPUT_DIR)
        db_filename = tick_store.resolve_db_basename(active_symbol, broker_server)
        db_path = os.path.join(OUTPUT_DIR, db_filename)
        conn = tick_store.open_database(db_path, logger)

        tick_explorer.sync_ticks_forward(mt5, conn, logger, symbol=active_symbol)

        logger.info("Program finished successfully.")

    except Exception as e:
        logger.error("An unexpected error occurred!")
        logger.error(f"Error type: {type(e).__name__} | Message: {e}")
        logger.error("Full details (traceback):")
        for line in traceback.format_exc().splitlines():
            logger.error(f"  {line}")
        exit_code = 1

    finally:
        if conn is not None:
            tick_store.close_database(conn, logger)
        if mt5 is not None:
            mt5_connector.shutdown(mt5, logger)
        if getattr(logger, "_tick_file_log_enabled", False):
            logger.info(f"The full daily log is: {current_log_path()}")
        else:
            logger.info("Disk logging disabled; no log file was written.")
        logger.info("Program end.")

    return exit_code


if __name__ == "__main__":
    result_code = main()
    print("\n" + "=" * 60)
    if result_code == 0:
        print("The program ran successfully.")
    else:
        print("The program encountered an error. Please check the log above.")
    print("=" * 60)
    input("\nPress Enter to close this window ...")
    sys.exit(result_code)
