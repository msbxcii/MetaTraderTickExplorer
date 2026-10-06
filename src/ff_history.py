# -*- coding: utf-8 -*-
"""
Forex Factory economic calendar history -> SQLite (ff_news.db)

  * No database yet  -> asks for a start date, downloads start week .. current week.
  * Database exists  -> continues from the last saved week up to the current week
                        (whole current week, Sunday..Saturday, even if today is Monday).
  * Already contains the current week -> nothing to do.
  * Every week is saved atomically. Stopping the program at any moment is safe:
    the unfinished week is just not written and is downloaded on the next run.

Usage:
    python ff_history.py                 (asks for a start date only if needed)
    python ff_history.py 2024-10-04      (start date, used only if DB is empty/new)

Requires:  pip install curl_cffi beautifulsoup4
"""
import sys
import time
import random
from datetime import datetime, timedelta, date

import ff_core as core


def find_resume_week(con):
    """Return the week to start from, or None if the DB has no weeks yet."""
    row = con.execute("SELECT week, checked_at FROM weeks_done "
                      "ORDER BY week DESC LIMIT 1").fetchone()
    if not row:
        return None
    last = date.fromisoformat(row[0])
    # If that week was saved after it had already ended, it is final -> next week.
    # Otherwise (saved mid-week, or legacy row) download it again from its start.
    if row[1] and datetime.fromisoformat(row[1]).date() >= last + timedelta(days=7):
        return last + timedelta(days=7)
    return last


def run(cli_start=None):
    existed = core.db_exists()
    con = core.connect()
    cur = core.current_week()

    start = find_resume_week(con)
    if start is None:
        if existed:
            print("Database exists but has no finished weeks.")
        start = core.sunday_of(cli_start or core.ask_date("Start date (YYYY-MM-DD): "))
        if start > cur:
            start = cur
    else:
        print(f"Resuming from week {start}")

    if start > cur:
        print(f"Database is up to date (current week {cur} already stored). Nothing to do.")
        core.connect().close()
        con.close()
        return

    weeks = list(core.weeks_between(start, cur))
    total = len(weeks)
    done = failed = 0
    t0 = time.time()
    print(f"Weeks to process: {total}  ({start} -> {cur})  |  DB: {core.DB}\n")

    try:
        for i, d in enumerate(weeks, 1):
            tag = f"[{i}/{total}]"
            rows = core.get_week_rows(d, tag)
            if rows is None:
                failed += 1
                print(f"{tag} {d}: FAILED (use ff_gaps.py or run again later)")
                continue
            n = core.save_week(con, d, rows)
            done += 1
            print(f"{tag} {d}: {n} events")
            if i < total:
                time.sleep(random.uniform(core.DELAY_MIN, core.DELAY_MAX))
    except KeyboardInterrupt:
        print("\nStopped by user. Finished weeks are saved; the current week was not written.")

    print(f"\nTime {int(time.time() - t0)}s  |  saved weeks: {done}  failed: {failed}")
    core.print_error_summary()
    report(con)
    con.close()


def report(con):
    print("\n--- Quality check ---")
    print("Total / first / last :",
          con.execute("SELECT COUNT(*), MIN(date), MAX(date) FROM news").fetchone())
    print("By impact            :",
          con.execute("SELECT impact, COUNT(*) FROM news GROUP BY impact").fetchall())
    print("Without ts_utc       :",
          con.execute("SELECT COUNT(*) FROM news WHERE ts_utc IS NULL").fetchone()[0])
    print("Empty weeks          :",
          con.execute("SELECT COUNT(*) FROM weeks_done WHERE n=0").fetchone()[0],
          "(see ff_gaps.py)")


if __name__ == "__main__":
    arg = None
    if len(sys.argv) >= 2:
        arg = datetime.strptime(sys.argv[1], "%Y-%m-%d").date()
    run(arg)
