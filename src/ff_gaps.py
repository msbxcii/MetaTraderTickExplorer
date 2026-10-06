# -*- coding: utf-8 -*-
"""
Gap manager for ff_news.db  (run in parallel / separately from ff_history.py)

Shows
  * EMPTY   weeks: downloaded, but no event was found in them
  * MISSING weeks: inside the stored range but never saved (e.g. download failed)
and lets you request a new extraction for chosen weeks. If data is found it is
added to the database; otherwise the week stays listed as empty.

Usage:
    python ff_gaps.py            (interactive)
    python ff_gaps.py list       (just print the gaps)
    python ff_gaps.py all        (retry every gap without asking)
"""
import sys
import time
import random
from datetime import date

import ff_core as core


def find_gaps(con):
    done = dict(con.execute("SELECT week, n FROM weeks_done"))
    if not done:
        return []
    first = date.fromisoformat(min(done))
    last = date.fromisoformat(max(done))
    gaps = []
    for d in core.weeks_between(first, last):
        n = done.get(d.isoformat())
        if n is None:
            gaps.append((d, "MISSING"))
        elif n == 0:
            gaps.append((d, "EMPTY"))
    return gaps


def show(gaps):
    if not gaps:
        print("No gaps found. Every week in the stored range has data.")
        return
    print(f"\n{len(gaps)} gap week(s):")
    for i, (d, kind) in enumerate(gaps, 1):
        print(f"  {i:>3}) {d}  {kind}")


def parse_selection(s, gaps):
    """'all', '1,3,5-8' or dates like 2024-03-10 (any day of that week)."""
    s = s.strip().lower()
    if s == "all":
        return [d for d, _ in gaps]
    out = []
    for tok in s.replace(" ", "").split(","):
        if not tok:
            continue
        try:
            if "-" in tok and tok.count("-") == 1 and tok.replace("-", "").isdigit():
                a, b = map(int, tok.split("-"))
                out += [gaps[i - 1][0] for i in range(a, b + 1)]
            elif tok.isdigit():
                out.append(gaps[int(tok) - 1][0])
            else:
                out.append(core.sunday_of(date.fromisoformat(tok)))
        except (ValueError, IndexError):
            print(f"Ignored: {tok}")
    return sorted(set(out))


def retry(con, weeks):
    found = 0
    total = len(weeks)
    try:
        for i, d in enumerate(weeks, 1):
            tag = f"[{i}/{total}]"
            rows = core.get_week_rows(d, tag)
            if rows is None:
                print(f"{tag} {d}: download failed")
            else:
                n = core.save_week(con, d, rows)
                found += n > 0
                print(f"{tag} {d}: {n} events" + ("" if n else "  (still empty)"))
            if i < total:
                time.sleep(random.uniform(core.DELAY_MIN, core.DELAY_MAX))
    except KeyboardInterrupt:
        print("\nStopped by user. Finished weeks are saved.")
    print(f"\nWeeks that now have data: {found}")
    core.print_error_summary()


def main():
    if not core.db_exists():
        print("ff_news.db not found. Run ff_history.py first.")
        return
    con = core.connect()
    mode = sys.argv[1].lower() if len(sys.argv) > 1 else ""
    gaps = find_gaps(con)
    show(gaps)
    if mode == "list" or not gaps:
        return
    if mode == "all":
        retry(con, [d for d, _ in gaps])
        return
    while True:
        s = input("\nWeeks to re-extract (e.g. 1,3,5-8 | all | a date | Enter = quit): ")
        if not s.strip():
            break
        weeks = parse_selection(s, gaps)
        if weeks:
            retry(con, weeks)
            gaps = find_gaps(con)
            show(gaps)
            if not gaps:
                break
    con.close()


if __name__ == "__main__":
    main()
