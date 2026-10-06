# -*- coding: utf-8 -*-
"""
Shared core for the Forex Factory tools (database + scraping).
Used by ff_history.py (main updater) and ff_gaps.py (gap manager).

Fast weekly access for later use:
    con = connect()
    rows = week_events(con, date(2026, 10, 4))            # one week, via index
    rows = week_events(con, date(2026, 10, 4), "High")    # only High impact
    rows = range_events(con, d1, d2)                      # several weeks
"""
import os
import re
import sys
import time
import sqlite3
import urllib.request
from datetime import datetime, timedelta, timezone, date

# v110: used inside the chart app too -> a missing package raises instead of exiting.
try:
    from curl_cffi import requests
    from bs4 import BeautifulSoup
except ImportError as _e:
    raise ImportError("Missing packages. Run:  python -m pip install curl_cffi beautifulsoup4") from _e

# ----------------------------------------------------------------- settings
DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ff_news.db")
MAX_RETRIES = 5
DELAY_MIN, DELAY_MAX = 1.0, 3.0          # seconds between weeks (overridden by the app's Configuration tab)
PROXY = "auto"      # "auto"   = follow Windows "System Proxy" (V2Ray/Nekoray "Set System Proxy"),
                    #            and connect directly when no system proxy is set   [default]
                    # "direct" = never use a proxy (also None / "")
                    # manual   = e.g. "http://127.0.0.1:4090"  "socks5://127.0.0.1:4090"

MONTHS = ["jan", "feb", "mar", "apr", "may", "jun",
          "jul", "aug", "sep", "oct", "nov", "dec"]

LOG_FN = None       # v110: the chart app routes messages to its own log (None = print)


def say(msg):
    (LOG_FN or print)(msg)


STOP = None   # threading.Event set by the chart app to abort a running job


def _stopped():
    return STOP is not None and STOP.is_set()


def _sleep(sec):
    """Sleep that wakes up immediately when the job is stopped."""
    if STOP is not None:
        STOP.wait(sec)
    else:
        time.sleep(sec)


def configure(db_path=None, err_log=None, log_fn=None, proxy=None, stop_event=None):
    """v110: let the chart app choose the database/log locations, the log sink and the proxy."""
    global DB, ERR_LOG, LOG_FN, PROXY, _announced, STOP
    STOP = stop_event
    if db_path:
        DB = db_path
    if err_log:
        ERR_LOG = err_log
    LOG_FN = log_fn
    if proxy is not None:
        PROXY = proxy
    _announced = None
    ERR_STATS.clear()


# ----------------------------------------------------------------- dates
def sunday_of(d):
    """Forex Factory weeks start on Sunday."""
    return d - timedelta(days=(d.weekday() + 1) % 7)


def today_utc():
    return datetime.now(timezone.utc).date()


def current_week():
    return sunday_of(today_utc())


def weeks_between(first, last):
    d = first
    while d <= last:
        yield d
        d += timedelta(days=7)


# ----------------------------------------------------------------- database
def db_exists():
    return os.path.exists(DB) and os.path.getsize(DB) > 0


def connect():
    # isolation_level=None -> we control transactions explicitly (one per week)
    os.makedirs(os.path.dirname(DB) or ".", exist_ok=True)
    con = sqlite3.connect(DB, timeout=30, isolation_level=None)
    con.execute("PRAGMA journal_mode=WAL")      # crash-safe + two programs can coexist
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=30000")
    con.execute("""CREATE TABLE IF NOT EXISTS news(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_utc INTEGER,            -- epoch seconds (NULL if no clock time)
        date TEXT, time_txt TEXT,
        currency TEXT, impact TEXT, title TEXT,
        actual TEXT, forecast TEXT, previous TEXT,
        week TEXT,                 -- Sunday of the event's week (YYYY-MM-DD)
        UNIQUE(date, time_txt, currency, title))""")
    con.execute("CREATE TABLE IF NOT EXISTS weeks_done("
                "week TEXT PRIMARY KEY, n INTEGER, checked_at TEXT)")
    # v110: oldest week the user asked for (shown in the chart app even if that week failed)
    con.execute("CREATE TABLE IF NOT EXISTS ui_meta(key TEXT PRIMARY KEY, value TEXT)")
    # ---- migration of databases created by the older version
    cols = {r[1] for r in con.execute("PRAGMA table_info(news)")}
    if "week" not in cols:
        con.execute("ALTER TABLE news ADD COLUMN week TEXT")
    cols = {r[1] for r in con.execute("PRAGMA table_info(weeks_done)")}
    if "checked_at" not in cols:
        con.execute("ALTER TABLE weeks_done ADD COLUMN checked_at TEXT")
    missing = [r[0] for r in con.execute(
        "SELECT DISTINCT date FROM news WHERE week IS NULL")]
    if missing:
        con.execute("BEGIN")
        con.executemany("UPDATE news SET week=? WHERE date=?",
                        [(sunday_of(date.fromisoformat(s)).isoformat(), s)
                         for s in missing])
        con.execute("COMMIT")
    con.execute("CREATE INDEX IF NOT EXISTS ix_ts ON news(ts_utc)")
    con.execute("CREATE INDEX IF NOT EXISTS ix_week ON news(week, ts_utc)")
    return con


def set_range_start(con, week):
    """v110: remember the oldest requested week (only ever moves back in time)."""
    key = week.isoformat()
    row = con.execute("SELECT value FROM ui_meta WHERE key='range_start'").fetchone()
    if row is None or key < row[0]:
        con.execute("INSERT OR REPLACE INTO ui_meta VALUES('range_start', ?)", (key,))


def save_week(con, week, rows):
    """Atomically store one week. All-or-nothing: if the program is killed
    anywhere inside, SQLite rolls back and the week is simply not recorded."""
    key = week.isoformat()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    con.execute("BEGIN IMMEDIATE")
    try:
        if rows:
            con.execute("DELETE FROM news WHERE week=?", (key,))   # replace stale data
            con.executemany(
                "INSERT OR IGNORE INTO news(date,time_txt,currency,impact,title,"
                "actual,forecast,previous,ts_utc,week) VALUES(?,?,?,?,?,?,?,?,?,?)",
                [(*r, to_ts(r[0], r[1]), key) for r in rows])
        n = con.execute("SELECT COUNT(*) FROM news WHERE week=?", (key,)).fetchone()[0]
        con.execute("INSERT OR REPLACE INTO weeks_done VALUES(?,?,?)", (key, n, now))
        con.execute("COMMIT")
        return n
    except BaseException:
        con.execute("ROLLBACK")
        raise


def week_events(con, week, impact=None):
    q = ("SELECT ts_utc,date,time_txt,currency,impact,title,actual,forecast,previous "
         "FROM news WHERE week=?")
    args = [sunday_of(week).isoformat()]
    if impact:
        q += " AND impact=?"
        args.append(impact)
    return con.execute(q + " ORDER BY date, ts_utc IS NULL, ts_utc, id", args).fetchall()


def range_events(con, d1, d2, impact=None):
    q = ("SELECT ts_utc,date,time_txt,currency,impact,title,actual,forecast,previous "
         "FROM news WHERE week BETWEEN ? AND ?")
    args = [sunday_of(d1).isoformat(), sunday_of(d2).isoformat()]
    if impact:
        q += " AND impact=?"
        args.append(impact)
    return con.execute(q + " ORDER BY week, date, ts_utc IS NULL, ts_utc, id", args).fetchall()


# ----------------------------------------------------------------- scraping
def week_url(d):
    return ("https://www.forexfactory.com/calendar?week="
            f"{MONTHS[d.month - 1]}{d.day}.{d.year}")


def parse(html, week_start):
    soup = BeautifulSoup(html, "html.parser")
    rows, cur_date, cur_time = [], None, ""
    for tr in soup.select("tr.calendar__row"):
        dcell = tr.select_one("td.calendar__date")
        if dcell and dcell.get_text(strip=True):
            txt = dcell.get_text(" ", strip=True)[3:]       # drop weekday name
            m = re.search(r"([A-Za-z]{3})\s*(\d{1,2})", txt)
            if m and m.group(1).lower() in MONTHS:
                mon = MONTHS.index(m.group(1).lower()) + 1
                year = week_start.year + (1 if mon < week_start.month - 6 else 0)
                cur_date = datetime(year, mon, int(m.group(2))).date()
        t = tr.select_one("td.calendar__time")
        if t and t.get_text(strip=True):
            cur_time = t.get_text(strip=True)
        cur = tr.select_one("td.calendar__currency")
        title = tr.select_one("td.calendar__event")
        if not (cur and title and cur_date):
            continue
        impact = ""
        imp = tr.select_one("td.calendar__impact span")
        if imp:
            c = " ".join(imp.get("class", []))
            impact = ("High" if "red" in c else "Medium" if "ora" in c
                      else "Low" if "yel" in c else "Holiday" if "gra" in c else "")

        def cell(name):
            el = tr.select_one(f"td.calendar__{name}")
            return el.get_text(strip=True) if el else ""

        rows.append((cur_date.isoformat(), cur_time, cur.get_text(strip=True),
                     impact, title.get_text(strip=True),
                     cell("actual"), cell("forecast"), cell("previous")))
    return rows


def to_ts(date_s, time_s):
    m = re.match(r"(\d{1,2}):(\d{2})(am|pm)", time_s.lower())
    if not m:
        return None                       # All Day / Tentative / empty
    h = int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0)
    dt = datetime.fromisoformat(date_s).replace(
        hour=h, minute=int(m.group(2)), tzinfo=timezone.utc)
    return int(dt.timestamp())            # assumes site timezone = UTC


def system_proxy(host="www.forexfactory.com"):
    """Proxy currently set in the OS (Windows registry 'Set System Proxy', or
    HTTP(S)_PROXY env vars). Read on every call, so turning the VPN/proxy on or
    off while the program runs is noticed. Returns URL or None. (PAC scripts are not supported.)"""
    try:
        if urllib.request.proxy_bypass(host):
            return None
        p = urllib.request.getproxies()
    except Exception:
        return None
    for key in ("https", "http"):
        if p.get(key):
            u = p[key]
            return u if "://" in u else "http://" + u
    for key in ("socks", "socks5"):
        if p.get(key):
            return "socks5://" + p[key].split("://")[-1]
    return None


def effective_proxy(force_direct=False):
    """-> (proxy_url or None, mode_text)"""
    if force_direct or PROXY in (None, "", "direct"):
        return None, "direct"
    if PROXY == "auto":
        sp = system_proxy()
        return sp, ("system proxy " + sp) if sp else "direct (no system proxy)"
    return PROXY, "manual proxy " + PROXY


def fetch_week(d, force_direct=False):
    kwargs = dict(impersonate="chrome", timeout=30, cookies={"fftimezone": "UTC"})
    proxy, _ = effective_proxy(force_direct)
    if proxy:
        kwargs["proxies"] = {"http": proxy, "https": proxy}
    return requests.get(week_url(d), **kwargs)


ERR_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ff_errors.log")
_announced = None
ERR_STATS = {}          # kind -> count (printed at the end of a run)

# (kind, meaning, substrings searched in the lower-cased error text)
ERR_KINDS = [
    ("CERT",      "certificate rejected -> wrong system clock / antivirus HTTPS scan / MITM proxy",
                  ["certificate verify", "(60)", "self signed", "unable to get local issuer"]),
    ("PROXY",     "proxy/VPN problem -> proxy down, wrong address or protocol",
                  ["proxy", "connect tunnel", "(5)"]),
    ("DNS",       "domain could not be resolved -> DNS issue",
                  ["could not resolve", "(6)", "name resolution"]),
    ("TIMEOUT",   "no answer in time -> slow or unstable route",
                  ["timed out", "timeout", "(28)"]),
    ("CONN_REFUSED", "connection refused/unreachable -> blocked IP/port or no internet",
                  ["refused", "(7)", "failed to connect", "unreachable"]),
    ("TLS_CUT",   "TLS handshake/connection cut in the middle -> filtering, unstable VPN node or CDN rejecting the IP",
                  ["unexpected eof", "ssl connect error", "(35)", "(55)", "(56)", "(52)",
                   "reset by peer", "connection reset", "tls", "ssl", "alert", "handshake",
                   "eof occurred"]),
]


def classify(err):
    low = str(err).lower()
    for kind, meaning, keys in ERR_KINDS:
        if any(k in low for k in keys):
            return kind, meaning
    return "OTHER", "unclassified -> see ff_errors.log for the full text"


def log_error(week, attempt, kind, e, elapsed):
    ERR_STATS[kind] = ERR_STATS.get(kind, 0) + 1
    try:
        os.makedirs(os.path.dirname(ERR_LOG) or ".", exist_ok=True)
        with open(ERR_LOG, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat(timespec='seconds')} | week={week} | "
                    f"attempt={attempt} | kind={kind} | elapsed={elapsed:.1f}s | "
                    f"proxy={effective_proxy()[1]} | curl_code={getattr(e, 'code', None)} | "
                    f"{type(e).__module__}.{type(e).__name__}: {e}\n")
    except Exception:
        pass


def print_error_summary():
    if ERR_STATS:
        say("Network errors this run: "
            + ", ".join(f"{k}={v}" for k, v in sorted(ERR_STATS.items(), key=lambda x: -x[1]))
            + f" | details: {ERR_LOG}")


def get_week_rows(d, tag=""):
    """Download + parse one week with retries.
    Returns list of rows (possibly empty = genuinely empty week) or None on failure."""
    global _announced
    force_direct = False
    for attempt in range(1, MAX_RETRIES + 1):
        if _stopped():
            return None
        t0 = time.time()
        wait = 10 * attempt
        mode = effective_proxy(force_direct)[1]
        if mode != _announced:
            _announced = mode
            say(f"Connection mode: {mode}")
        try:
            r = fetch_week(d, force_direct)
            if r.status_code == 200:
                if "calendar__table" in r.text:      # real calendar page, not a block page
                    return parse(r.text, d)
                ERR_STATS["BLOCK_PAGE"] = ERR_STATS.get("BLOCK_PAGE", 0) + 1
                say(f"{tag} {d}: 200 but no calendar table (Cloudflare/block page?), "
                      f"attempt {attempt}/{MAX_RETRIES}")
            else:
                kind = f"HTTP_{r.status_code}"
                ERR_STATS[kind] = ERR_STATS.get(kind, 0) + 1
                hint = {403: "blocked by Cloudflare/IP", 429: "rate limited -> slow down",
                        503: "site busy or challenge page"}.get(r.status_code, "")
                say(f"{tag} {d}: HTTP {r.status_code} {hint}, attempt {attempt}/{MAX_RETRIES}")
        except Exception as e:
            kind, meaning = classify(e)
            log_error(d, attempt, kind, e, time.time() - t0)
            msg = " ".join(str(e).split())
            say(f"{tag} {d}: {type(e).__name__} [{kind}] after {time.time() - t0:.1f}s, "
                  f"attempt {attempt}/{MAX_RETRIES}\n      {msg[:300]}\n      => {meaning}")
            if PROXY == "auto" and kind in ("PROXY", "CONN_REFUSED") and effective_proxy()[0]:
                force_direct = True             # system proxy is dead -> try direct
                say("      system proxy not reachable -> trying direct connection")
            if kind in ("TLS_CUT", "TIMEOUT", "CONN_REFUSED"):
                wait = 2 + 2 * attempt          # transient network faults: retry quickly
        if attempt < MAX_RETRIES:
            _sleep(wait)
    return None


def ask_date(prompt, default=None):
    while True:
        s = input(prompt).strip()
        if not s and default:
            return default
        try:
            return datetime.strptime(s, "%Y-%m-%d").date()
        except ValueError:
            print("Format must be YYYY-MM-DD, e.g. 2024-10-04")
