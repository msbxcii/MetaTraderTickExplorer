# -*- coding: utf-8 -*-
"""Rebuild all derived timeframe tables from the compact 1-second cache.

V61 has no permanent raw-tick table, so this utility deliberately does not
read ticks. The one-time V60 -> V61 startup migration is responsible for
rebuilding candles_1s from legacy ticks (when such a table exists) before
removing that legacy storage. After migration, this utility is useful only
for rebuilding candles_5s/15s/1m/5m/15m/1h from candles_1s.

Usage
-----
    python rebuild_continuous_candles.py path/to/database.db
"""
import sys
import sqlite3
import time

from candle_aggregator import merge_candles
from candle_cache import ensure_schema, _TF_TABLES, _TABLE_COLUMNS


def rebuild(conn, logger=None):
    ensure_schema(conn)

    t0 = time.monotonic()
    cur = conn.execute(
        "SELECT bucket_start_ms, open, high, low, close, tick_count "
        "FROM candles_1s ORDER BY bucket_start_ms ASC"
    )
    base_candles = []
    for row in cur:
        from candle_aggregator import Candle
        base_candles.append(Candle(*row))

    if not base_candles:
        if logger is not None:
            logger.info("No candles_1s rows exist; nothing to rebuild.")
        else:
            print("No candles_1s rows exist; nothing to rebuild.")
        return 0

    conn.execute("BEGIN")
    try:
        for tf, table_name in _TF_TABLES.items():
            if tf == 1:
                continue
            derived = merge_candles(base_candles, base_bucket_ms=1000, factor=tf)
            conn.execute(f"DELETE FROM {table_name}")
            conn.executemany(
                f"INSERT INTO {table_name} ({_TABLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    (c.bucket_start_ms, c.open, c.high, c.low, c.close, c.tick_count)
                    for c in derived
                ),
            )

        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    elapsed = time.monotonic() - t0
    msg = (
        f"Rebuilt {sum(1 for _ in _TF_TABLES if _ != 1):,} derived timeframe table(s) "
        f"from {len(base_candles):,} persisted one-second candle(s) in {elapsed:.2f}s."
    )
    if logger is not None:
        logger.info(msg)
    else:
        print(msg)

    return len(base_candles)


def main():
    if len(sys.argv) != 2:
        print("Usage: python rebuild_continuous_candles.py path/to/database.db")
        sys.exit(1)

    db_path = sys.argv[1]
    conn = sqlite3.connect(db_path)
    try:
        rebuild(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
