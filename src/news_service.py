# -*- coding: utf-8 -*-
"""v110: backend of Setting > Market Data Overview > Economic News.

Overview reads (pure SQLite, no scraping packages needed) and the download
jobs (Backfill of selected weeks / Extend back to a date) that run on ONE
background thread of the window process, using the Scrabber code
(ff_core.py). Data lives in <data dir>/ff_news.db next to the symbol databases.
"""
import json
import os
import random
import sqlite3
import threading
from datetime import date, datetime, timedelta, timezone

from config import LOG_DIR

DB_NAME = "ff_news.db"
_DAY = timedelta(days=1)


def _sunday_of(d):
    return d - timedelta(days=(d.weekday() + 1) % 7)


def _today():
    return datetime.now(timezone.utc).date()


class NewsService:
    def __init__(self, data_dir, logger, push):
        self._db = os.path.join(os.path.abspath(data_dir), DB_NAME)
        self._logger = logger
        self._push = push                      # push(js_source) -> evaluate_js on the page
        self._busy = threading.Lock()
        self._stop = threading.Event()

    # ------------------------------------------------------------ logging
    def _log(self, msg):
        for line in str(msg).splitlines():
            if line.strip():
                self._logger.info("[NEWS] " + line.strip(), extra={"category": "DATABASE"})

    def _emit(self, kind, state, info):
        try:
            fn = {"refresh": "onNewsRefresh", "auto": "onNewsAutoSync"}.get(kind, "onNewsStatus")   # v111 / v126
            self._push("window.%s && window.%s(%s, %s, %s)" % (
                fn, fn, json.dumps(kind), json.dumps(state), json.dumps(info)))
        except Exception:
            pass

    # ----------------------------------------------------------- overview
    def overview(self, year):
        """Everything the page needs for one year: oldest event date, the stored
        range, and which weeks of that year are complete (solid squares)."""
        today = _today()
        cur = _sunday_of(today)
        out = {"ok": True, "oldest": None, "range_start": None, "current_week": cur.isoformat(),
               "years": [today.year], "solid": {}, "partial": {}}
        if not os.path.exists(self._db):
            return out
        try:
            year = int(year) or today.year
        except (TypeError, ValueError):
            year = today.year
        con = None
        try:
            con = sqlite3.connect(self._db, timeout=5)
            con.execute("PRAGMA query_only=1")
            out["oldest"] = con.execute("SELECT MIN(date) FROM news").fetchone()[0]
            starts = [r[0] for r in (
                con.execute("SELECT MIN(week) FROM weeks_done").fetchone(),) if r[0]]
            try:
                m = con.execute("SELECT value FROM ui_meta WHERE key='range_start'").fetchone()
                if m and m[0]:
                    starts.append(m[0])
            except sqlite3.OperationalError:
                pass
            if not starts:
                return out
            start = min(starts)
            out["range_start"] = start
            out["years"] = list(range(today.year, int(start[:4]) - 1, -1))
            lo = _sunday_of(date(year, 1, 1)).isoformat()
            hi = _sunday_of(date(year, 12, 31)).isoformat()
            try:
                rows = con.execute("SELECT week, n, checked_at FROM weeks_done "
                                   "WHERE week BETWEEN ? AND ?", (lo, hi)).fetchall()
            except sqlite3.OperationalError:       # database of the oldest Scrabber version
                rows = [(w, n, None) for w, n in con.execute(
                    "SELECT week, n FROM weeks_done WHERE week BETWEEN ? AND ?", (lo, hi))]
            for week, n, checked in rows:
                end = date.fromisoformat(week) + timedelta(days=7)
                try:
                    saved_day = datetime.fromisoformat(checked).date() if checked else today
                except ValueError:
                    saved_day = today
                # solid = has events AND was saved after that week had ended.
                # The running week is never complete (new Actual values keep
                # arriving), so it gets its own "partial" state instead: it has
                # data but stays selectable so BackFill can refresh it any time.
                if n and week == cur.isoformat():
                    out["partial"][week] = n
                elif n and saved_day >= end:
                    out["solid"][week] = n
        except Exception as e:
            self._logger.warning(f"news overview failed: {e}")
        finally:
            if con is not None:
                con.close()
        return out

    # ------------------------------------------------- v111: chart / News tab reads
    _IMP = {"High": 4, "Medium": 3, "Low": 2}          # v111: anything else = 1 (Non-economic)
    _COLS = "id,ts_utc,impact,currency,title,actual,forecast,previous,time_txt,date"

    def _ro(self):
        if not os.path.exists(self._db):
            return None
        con = sqlite3.connect(self._db, timeout=5)
        con.execute("PRAGMA query_only=1")
        return con

    def _pack(self, r):
        # v111: compact row -> [id, ts|None, impact 1-4, cur, title, actual, forecast, previous, time_txt, date]
        return [r[0], r[1], self._IMP.get(r[2], 1), r[3], r[4], r[5], r[6], r[7], r[8], r[9]]

    @staticmethod
    def _filter_sql(imp, cur):
        """v111: WHERE fragment for the News-tab filters (None/[] imp = no filter handled by caller)."""
        sql, args = "", []
        if imp is not None and len(imp) < 4:
            names = [n for n, c in (("High", 4), ("Medium", 3), ("Low", 2)) if c in imp]
            parts = []
            if names:
                parts.append("impact IN (%s)" % ",".join("?" * len(names)))
                args += names
            if 1 in imp:
                parts.append("impact NOT IN ('High','Medium','Low')")
            sql += " AND (%s)" % (" OR ".join(parts) if parts else "0")
        if cur is not None:
            sql += " AND currency IN (%s)" % (",".join("?" * len(cur)) if cur else "''")
            args += list(cur)
        return sql, args

    def _pack_chart(self, r, untimed=False):
        # v115: chart row = _pack + flag [10] (1 = All Day: ts = 00:00 UTC of its date)
        p = self._pack(r)
        if untimed:
            try:
                p[1] = int(datetime.strptime(r[9], "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
            except (TypeError, ValueError):
                return None
        p.append(1 if untimed else 0)
        return p

    def chart_rows(self, ts0, ts1, limit=6000):
        """v111: timed events inside [ts0, ts1] (UTC seconds) for the chart lines.
        v115: All Day events (ts_utc NULL) are included at 00:00 UTC of their date.
        A huge window (zoomed far out) drops the least important events first."""
        con = None
        try:
            con = self._ro()
            if con is None:
                return {"ok": True, "rows": []}
            ts0, ts1 = int(ts0), int(ts1)
            d0 = datetime.fromtimestamp(max(ts0, 0), timezone.utc).date().isoformat()
            d1 = datetime.fromtimestamp(max(ts1, 0), timezone.utc).date().isoformat()
            where = "ts_utc BETWEEN ? AND ?"
            for floor_imp in (None, ("Medium", "High"), ("High",)):
                extra = "" if floor_imp is None else " AND impact IN (%s)" % ",".join("?" * len(floor_imp))
                fa = list(floor_imp or ())
                args = [ts0, ts1] + fa
                n = con.execute("SELECT COUNT(*) FROM news WHERE " + where + extra, args).fetchone()[0]
                un = [p for p in (self._pack_chart(r, True) for r in con.execute(
                    "SELECT " + self._COLS + " FROM news WHERE ts_utc IS NULL AND date BETWEEN ? AND ?" + extra,
                    [d0, d1] + fa).fetchall()) if p and ts0 <= p[1] <= ts1]
                if n + len(un) <= limit or floor_imp == ("High",):
                    rows = con.execute("SELECT " + self._COLS + " FROM news WHERE " + where + extra +
                                       " ORDER BY ts_utc LIMIT ?", args + [limit]).fetchall()
                    out = [self._pack_chart(r) for r in rows] + un
                    out.sort(key=lambda p: p[1])
                    return {"ok": True, "rows": out[:limit]}
        except Exception as e:
            self._logger.warning(f"news chart_rows failed: {e}")
        finally:
            if con is not None:
                con.close()
        return {"ok": False, "rows": []}

    def list_rows(self, ts0, ts1, d0, d1, imp, cur):
        """v111: News-tab rows of a display-day window: timed events in [ts0, ts1) plus
        untimed (All Day / Tentative) events whose date is within [d0, d1]."""
        con = None
        try:
            con = self._ro()
            if con is None:
                return {"ok": True, "rows": []}
            fs, fa = self._filter_sql(imp, cur)
            q1 = "SELECT %s FROM news WHERE ts_utc>=? AND ts_utc<?%s" % (self._COLS, fs)
            q2 = "SELECT %s FROM news WHERE ts_utc IS NULL AND date BETWEEN ? AND ?%s" % (self._COLS, fs)
            rows = con.execute(q1, [int(ts0), int(ts1)] + fa).fetchall()
            rows += con.execute(q2, [str(d0), str(d1)] + fa).fetchall()
            return {"ok": True, "rows": [self._pack(r) for r in rows]}
        except Exception as e:
            self._logger.warning(f"news list_rows failed: {e}")
        finally:
            if con is not None:
                con.close()
        return {"ok": False, "rows": []}

    def meta(self):
        """v111: stored date bounds + currency list (cheap, indexed)."""
        con = None
        out = {"ok": True, "min": None, "max": None, "cur": []}
        try:
            con = self._ro()
            if con is None:
                return out
            r = con.execute("SELECT MIN(date), MAX(date) FROM news").fetchone()
            out["min"], out["max"] = r[0], r[1]
            out["cur"] = [x[0] for x in con.execute(
                "SELECT DISTINCT currency FROM news WHERE currency<>'' ORDER BY currency")]
        except Exception as e:
            self._logger.warning(f"news meta failed: {e}")
            out["ok"] = False
        finally:
            if con is not None:
                con.close()
        return out

    def days_with_news(self, d0, d1, imp, cur):
        """v111: distinct event dates in [d0, d1] (calendar dots / previous-next day)."""
        con = None
        try:
            con = self._ro()
            if con is None:
                return {"ok": True, "days": []}
            fs, fa = self._filter_sql(imp, cur)
            rows = con.execute("SELECT DISTINCT date FROM news WHERE date BETWEEN ? AND ?%s ORDER BY date" % fs,
                               [str(d0), str(d1)] + fa).fetchall()
            return {"ok": True, "days": [r[0] for r in rows]}
        except Exception as e:
            self._logger.warning(f"news days failed: {e}")
        finally:
            if con is not None:
                con.close()
        return {"ok": False, "days": []}

    # v111: Refresh = re-download ONE week (same Scrabber code) so Actual values arrive.
    def refresh_week(self, day_iso, proxy):
        try:
            week = _sunday_of(date.fromisoformat(str(day_iso)[:10]))
            proxy_value = self._proxy_value(proxy)
            core = self._core()
        except ImportError:
            return {"ok": False, "error": "packages"}
        except (TypeError, ValueError):
            return {"ok": False, "error": "proxy"}
        if week > _sunday_of(_today()) or not self._busy.acquire(blocking=False):
            return {"ok": False, "busy": True}
        self._stop.clear()
        delay = self._delay_range(proxy)
        threading.Thread(target=self._run_refresh, args=(core, week, proxy_value), daemon=True,
                         name="news-refresh").start()
        return {"ok": True}

    def _run_refresh(self, core, week, proxy_value):
        con, n, ok = None, 0, False
        try:
            core.configure(db_path=self._db, err_log=os.path.join(LOG_DIR, "ff_errors.log"),
                           log_fn=self._log, proxy=proxy_value, stop_event=self._stop)
            con = core.connect()
            rows = core.get_week_rows(week, "[refresh]")
            if rows:
                n = core.save_week(con, week, rows)
                ok = n > 0
            self._log(f"Refresh {week}: " + (f"{n} events" if ok else "unreachable"))
        except Exception as e:
            self._logger.warning(f"news refresh failed: {e}")
        finally:
            if con is not None:
                try:
                    con.close()
                except Exception:
                    pass
            self._busy.release()
            self._emit("refresh", "done", {"week": week.isoformat(), "ok": ok, "n": n})


    # ------------------------------------------------ v126: weekly auto-sync
    def _auto_plan(self):
        """v126: (weeks to download, current week) or (None, reason). One cheap read-only query set."""
        if not os.path.exists(self._db):
            return None, "nodb"
        cur = _sunday_of(_today())
        con = None
        try:
            con = sqlite3.connect(self._db, timeout=5)
            con.execute("PRAGMA query_only=1")
            row = con.execute("SELECT week, n, checked_at FROM weeks_done ORDER BY week DESC LIMIT 1").fetchone()
            if not row:
                return None, "nodb"                       # news never set up -> nothing to continue
            try:
                m = con.execute("SELECT value FROM ui_meta WHERE key='auto_week'").fetchone()
            except sqlite3.OperationalError:
                m = None
            if m and m[0] == cur.isoformat():
                return None, "uptodate"                   # already checked in this week
            last = date.fromisoformat(row[0])
            start = last
            try:                                          # saved after that week ended -> it is final
                if row[2] and datetime.fromisoformat(row[2]).date() >= last + timedelta(days=7):
                    start = last + timedelta(days=7)
            except ValueError:
                pass
            weeks, d = [], start
            while d <= cur:
                weeks.append(d)
                d += timedelta(days=7)
            # current week already stored: its Actual values are the Refresh button's job
            if weeks and weeks[-1] == cur and row[0] == cur.isoformat() and row[1]:
                weeks.pop()
            return weeks, cur
        except Exception as e:
            self._logger.warning(f"news auto_plan failed: {e}")
            return None, "error"
        finally:
            if con is not None:
                con.close()

    def auto_sync(self, proxy):
        """v126: once per week, download the missed weeks up to the end of the current week
        (never future weeks) on the background thread. Returns {ok, started, reason}."""
        weeks, cur = self._auto_plan()
        if weeks is None:
            return {"ok": cur in ("nodb", "uptodate"), "started": False, "reason": cur}
        if not weeks:                                     # current week already stored: just remember the check
            self._set_auto_week(cur)
            return {"ok": True, "started": False, "reason": "uptodate"}
        try:
            proxy_value = self._proxy_value(proxy)
            core = self._core()
        except ImportError:
            return {"ok": False, "started": False, "reason": "packages"}
        except (TypeError, ValueError):
            return {"ok": False, "started": False, "reason": "proxy"}
        if not self._busy.acquire(blocking=False):
            return {"ok": False, "started": False, "reason": "busy"}
        self._stop.clear()
        threading.Thread(target=self._run_auto, args=(core, weeks, cur, proxy_value, self._delay_range(proxy)),
                         daemon=True, name="news-auto").start()
        return {"ok": True, "started": True, "reason": "started", "total": len(weeks)}

    def _set_auto_week(self, cur):
        con = None
        try:
            con = sqlite3.connect(self._db, timeout=5)
            con.execute("CREATE TABLE IF NOT EXISTS ui_meta(key TEXT PRIMARY KEY, value TEXT)")
            con.execute("INSERT OR REPLACE INTO ui_meta VALUES('auto_week', ?)", (cur.isoformat(),))
            con.commit()
        except Exception as e:
            self._logger.warning(f"news auto_week save failed: {e}")
        finally:
            if con is not None:
                con.close()

    def _run_auto(self, core, weeks, cur, proxy_value, delay):
        total, added, failed, con = len(weeks), 0, 0, None
        try:
            core.configure(db_path=self._db, err_log=os.path.join(LOG_DIR, "ff_errors.log"),
                           log_fn=self._log, proxy=proxy_value, stop_event=self._stop)
            con = core.connect()
            self._log(f"Weekly sync started: {total} week(s) ({weeks[0]} -> {weeks[-1]})")
            self._emit("auto", "start", {"total": total})
            for i, d in enumerate(weeks):
                if self._stop.is_set():
                    break
                rows = core.get_week_rows(d, f"[auto {i + 1}/{total}]")
                if self._stop.is_set():
                    break
                if rows is None:
                    failed += 1                           # unreachable: not written, retried next launch
                    if i == 0:
                        break                             # offline / blocked: don't hammer the site
                else:
                    core.save_week(con, d, rows)
                    added += 1
                if i < total - 1 and self._stop.wait(random.uniform(delay[0], delay[1])):
                    break
            ok = (failed == 0 and not self._stop.is_set())
            if ok:
                self._set_auto_week(cur)                  # once-per-week mark only after full success
            self._log(f"Weekly sync finished: {added}/{total} week(s)" + ("" if ok else ", incomplete"))
            core.print_error_summary()
        except Exception as e:
            ok = False
            self._logger.warning(f"news auto sync failed: {e}")
        finally:
            if con is not None:
                try:
                    con.close()
                except Exception:
                    pass
            self._busy.release()
            self._emit("auto", "done", {"total": total, "added": added, "failed": failed, "ok": bool(ok)})

    # ---------------------------------------------------------------- jobs
    @staticmethod
    def _proxy_value(proxy):
        proxy = proxy or {}
        if proxy.get("mode") != "manual":
            return "auto"
        port = int(proxy.get("port"))
        if not 1 <= port <= 65535:
            raise ValueError("port")
        scheme = "http" if proxy.get("type") == "http" else "socks5"
        return f"{scheme}://127.0.0.1:{port}"

    @staticmethod
    def _delay_range(proxy):
        """(min, max) seconds to wait between two weeks. The page sends the live
        Configuration values with the request; config.py's values are the fallback."""
        proxy = proxy or {}
        try:
            lo, hi = float(proxy.get("delay_min")), float(proxy.get("delay_max"))
        except (TypeError, ValueError):
            try:
                from config import NEWS_DELAY_MIN, NEWS_DELAY_MAX
                lo, hi = float(NEWS_DELAY_MIN), float(NEWS_DELAY_MAX)
            except Exception:
                lo, hi = 1.0, 3.0
        if not (lo >= 0 and hi >= 0):               # NaN / negative
            lo, hi = 1.0, 3.0
        lo, hi = min(lo, 120.0), min(hi, 120.0)
        return (lo, hi) if lo <= hi else (hi, lo)

    def _core(self):
        import ff_core                          # needs curl_cffi + beautifulsoup4
        return ff_core

    def _start(self, kind, weeks, proxy, target=None):
        try:
            proxy_value = self._proxy_value(proxy)
            core = self._core()
        except ImportError:
            return {"ok": False, "error": "packages"}
        except (TypeError, ValueError):
            return {"ok": False, "error": "proxy"}
        if not weeks or not self._busy.acquire(blocking=False):
            return {"ok": False}
        self._stop.clear()
        delay = self._delay_range(proxy)
        threading.Thread(target=self._run, args=(core, kind, weeks, proxy_value, delay),
                         daemon=True, name="news-" + kind).start()
        return {"ok": True}

    def start_backfill(self, week_keys, proxy):
        try:
            weeks = sorted({date.fromisoformat(k) for k in (week_keys or [])})
            weeks = [w for w in weeks if w == _sunday_of(w) and w <= _sunday_of(_today())]
        except (TypeError, ValueError):
            return {"ok": False}
        return self._start("backfill", weeks, proxy)

    def start_extend(self, target_date, proxy):
        try:
            target = _sunday_of(date.fromisoformat(str(target_date).strip()))
        except ValueError:
            return {"ok": False}
        if target_date > _today().isoformat():
            return {"ok": False}
        info = self.overview(0)
        first = (date.fromisoformat(info["range_start"]) - timedelta(days=7)
                 if info["range_start"] else _sunday_of(_today()))
        weeks, d = [], first
        while d >= target:                      # newest -> oldest
            weeks.append(d)
            d -= timedelta(days=7)
        return self._start("extend", weeks, proxy)

    def stop(self):
        self._stop.set()

    def _run(self, core, kind, weeks, proxy_value, delay=(1.0, 3.0)):
        total = len(weeks)
        done = added = failed = 0
        con = None
        try:
            core.configure(db_path=self._db, err_log=os.path.join(LOG_DIR, "ff_errors.log"),
                           log_fn=self._log, proxy=proxy_value, stop_event=self._stop)
            con = core.connect()
            try:
                import tick_store
                tick_store.hide_wal_sidecars(self._db)
            except Exception:
                pass
            self._log(f"{kind.capitalize()} started: {total} week(s), "
                      f"{delay[0]:g}-{delay[1]:g}s between weeks")
            self._emit(kind, "processing", {"total": total})
            for i, d in enumerate(weeks):
                if self._stop.is_set():
                    break
                if kind == "extend":
                    core.set_range_start(con, d)    # the square appears now, solid or missing
                rows = core.get_week_rows(d, f"[{i + 1}/{total}]")
                if self._stop.is_set():             # stopped mid-download: drop this week
                    break
                n = core.save_week(con, d, rows) if rows is not None else 0
                if n > 0:
                    added += 1
                else:
                    failed += 1
                done += 1
                self._log(f"[{i + 1}/{total}] {d}: " + (f"{n} events" if n else "missing"))
                self._emit(kind, "progress", {"total": total, "processed": done,
                                              "added": added, "unreachable": failed})
                if i < total - 1 and self._stop.wait(random.uniform(delay[0], delay[1])):
                    break
            if self._stop.is_set():
                self._log(f"{kind.capitalize()} stopped by user")
            core.print_error_summary()
        except Exception as e:
            self._logger.warning(f"news {kind} failed: {e}")
        finally:
            if con is not None:
                try:
                    con.close()
                except Exception:
                    pass
            stopped = self._stop.is_set()
            self._busy.release()
            self._emit(kind, "done", {"total": total, "processed": done, "added": added,
                                      "unreachable": failed, "stopped": stopped})
