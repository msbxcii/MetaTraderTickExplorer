# -*- coding: utf-8 -*-

"""Central logging for MetaTrader Tick Explorer.

V67.3 logging goals
--------------------
* One integrated daily log file for the whole application when disk logging is
  enabled.
* DATABASE-category records are kept out of the disk file because they can be
  very numerous, while remaining visible in the console and in-app log views.
* In-app logs are backed by a bounded in-memory session buffer, so the UI never
  needs to read previous executions from disk and remains functional when disk
  logging is disabled.
* Sync-process logs cross the process boundary through a lightweight log queue
  and are appended to the same in-memory session buffer in the main process.
* Redaction of account identity and Windows user/MetaTrader paths before a
  record reaches any output.

The optional ``prefix`` argument is retained only for source compatibility
with older callers; V67.3 deliberately ignores it so no secondary log file can
be created accidentally.
"""

import getpass
import logging
import os
import re
import sys
import threading
from collections import deque
from datetime import datetime

from config import LOG_DIR, LOG_FILE_PREFIX, LOG_TO_DISK

# ---------------------------------------------------------------------------
# Log categories (v62.6+)
CATEGORY_GENERAL = "GENERAL"
CATEGORY_DATABASE = "DATABASE"
CATEGORY_WARNING = "WARNING"
CATEGORY_ERROR = "ERROR"
CATEGORY_DEBUG = "DEBUG"

LOG_CATEGORIES = [
    CATEGORY_GENERAL,
    CATEGORY_DATABASE,
    CATEGORY_WARNING,
    CATEGORY_ERROR,
    CATEGORY_DEBUG,
]

_DEFAULT_CATEGORY_BY_LEVEL = {
    logging.DEBUG: CATEGORY_DEBUG,
    logging.INFO: CATEGORY_GENERAL,
    logging.WARNING: CATEGORY_WARNING,
    logging.ERROR: CATEGORY_ERROR,
    logging.CRITICAL: CATEGORY_ERROR,
}


_SESSION_BUFFER_MAX_BYTES = 1_000_000


class SessionLogBuffer:
    """Bounded in-memory log stream for the currently running application."""

    def __init__(self, max_bytes=_SESSION_BUFFER_MAX_BYTES):
        self._max_bytes = max(64_000, int(max_bytes))
        self._items = deque()
        self._bytes = 0
        self._next_seq = 0
        self._lock = threading.RLock()

    @staticmethod
    def _as_record_text(text):
        text = str(text or "")
        return text if text.endswith("\n") else text + "\n"

    @staticmethod
    def _tail_chars(text, max_bytes):
        if len(text.encode("utf-8")) <= max_bytes:
            return text
        end = len(text)
        while end > 0:
            tail = text[end:]
            if len(tail.encode("utf-8")) <= max_bytes:
                return tail
            end = max(0, end - max(1, len(tail) // 2))
        return ""

    def append(self, text):
        text = self._as_record_text(text)
        size = len(text.encode("utf-8"))
        if size > self._max_bytes:
            text = self._tail_chars(text, self._max_bytes)
            size = len(text.encode("utf-8"))
        with self._lock:
            self._next_seq += 1
            self._items.append((self._next_seq, text))
            self._bytes += size
            while len(self._items) > 1 and self._bytes > self._max_bytes:
                _, old = self._items.popleft()
                self._bytes -= len(old.encode("utf-8"))

    def read_since(self, cursor=None, initial_bytes=20_000):
        with self._lock:
            latest = self._next_seq
            if not self._items:
                return "", latest, False

            earliest = self._items[0][0]
            reset = False
            if cursor is not None:
                try:
                    cursor = int(cursor)
                except (TypeError, ValueError):
                    cursor = None
                    reset = True
                else:
                    reset = cursor < earliest - 1

            if cursor is None or reset:
                text = "".join(item[1] for item in self._items)
                return self._tail_chars(text, max(1, int(initial_bytes))), latest, reset

            text = "".join(item[1] for item in self._items if item[0] > cursor)
            return text, latest, False


class _SessionMemoryHandler(logging.Handler):
    """Copy formatted records into the current process's session buffer."""

    def __init__(self, session_buffer):
        super().__init__()
        self._session_buffer = session_buffer

    def emit(self, record):
        try:
            self._session_buffer.append(self.format(record))
        except Exception:
            self.handleError(record)


class _SessionLogQueueHandler(logging.Handler):
    """Forward formatted child-process records to the main process."""

    def __init__(self, session_log_queue):
        super().__init__()
        self._queue = session_log_queue

    def emit(self, record):
        try:
            self._queue.put_nowait({
                "type": "session_log",
                "text": self.format(record),
            })
        except Exception:
            # Logging must never become the reason the sync process stalls.
            pass


class _NoDatabaseFileFilter(logging.Filter):
    """Keep DATABASE-category records in RAM/console but out of disk logs."""

    def filter(self, record):
        return getattr(record, "category", CATEGORY_GENERAL) != CATEGORY_DATABASE


class _CategoryFilter(logging.Filter):
    """Stamp every record with a topical category."""

    def filter(self, record):
        if not getattr(record, "category", None):
            record.category = _DEFAULT_CATEGORY_BY_LEVEL.get(
                record.levelno, CATEGORY_GENERAL
            )
        return True



def _mask_value(value, prefix_len=2):
    """Return a short stable display form that never reveals the full value."""
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) <= prefix_len:
        return "****"
    return f"{text[:prefix_len]}****"


class _SensitiveDataFilter(logging.Filter):
    """Redact sensitive identity/path data from every log record.

    Dynamic values (server, company, account login) are registered as soon as
    the connected MT5 account is known. Static regexes additionally catch
    Windows profile/MetaTrader data paths even when they arrive inside an
    exception string or a raw object representation.
    """

    _MT5_DATA_PATH_RE = re.compile(
        r"(?i)[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+[\\/]+AppData[\\/]+Roaming"
        r"[\\/]+MetaQuotes[\\/]+Terminal"
    )
    _USER_PROFILE_RE = re.compile(
        r"(?i)([A-Za-z]:[\\/]+Users[\\/]+)[^\\/<>:\"|?*\r\n]+"
    )

    def __init__(self):
        super().__init__()
        self._lock = threading.RLock()
        self._values = []
        self._dynamic_pattern = None
        self._dynamic_masks = {}

    def add_values(self, *values):
        with self._lock:
            for value in values:
                text = str(value or "").strip()
                if not text:
                    continue
                # Do not register generic placeholders; masking these would
                # make otherwise useful diagnostics unreadable.
                if text.casefold() in {"unknown-server", "n/a", "none"}:
                    continue
                key = text.casefold()
                if key not in self._dynamic_masks:
                    self._values.append(text)
                    self._dynamic_masks[key] = _mask_value(text)
            # Compile once when identity changes. The logger can emit many
            # DEBUG records, so compiling a regex on every line is avoidable
            # CPU overhead. Longest first prevents partial-value matches.
            self._values.sort(key=len, reverse=True)
            if self._values:
                self._dynamic_pattern = re.compile(
                    "|".join(
                        rf"(?<!\w){re.escape(v)}(?!\w)" for v in self._values
                    ),
                    re.IGNORECASE,
                )

    def _redact(self, text):
        # The full MT5 data root is never useful in an end-user log and can
        # contain the Windows username. Replace the complete known path.
        text = self._MT5_DATA_PATH_RE.sub("<MT5_DATA_PATH>", text)

        # Any remaining Windows profile path gets its username replaced while
        # keeping the rest of the path useful for diagnostics.
        text = self._USER_PROFILE_RE.sub(r"\1<USER_PROFILE>", text)

        with self._lock:
            pattern = self._dynamic_pattern
            masks = dict(self._dynamic_masks)
        if pattern is not None:
            def replace_dynamic(match):
                return masks.get(match.group(0).casefold(), "****")

            text = pattern.sub(replace_dynamic, text)
        return text

    def filter(self, record):
        # Both console and file handlers see the same LogRecord instance. The
        # marker prevents the second handler from masking an already-masked
        # value again.
        if getattr(record, "_sensitive_redacted", False):
            return True
        try:
            text = record.getMessage()
            redacted = self._redact(text)
            record.msg = redacted
            record.args = ()
            record._sensitive_redacted = True
        except Exception:
            # Never let privacy filtering break application logging.
            record._sensitive_redacted = True
        return True


class _DailyProcessSafeFileHandler(logging.Handler):
    """Append to one YYYYMMDD log and serialize writes across processes."""

    def __init__(self, log_dir, file_prefix, process_lock=None, encoding="utf-8"):
        super().__init__()
        self._log_dir = log_dir
        self._file_prefix = file_prefix or LOG_FILE_PREFIX
        # The main application passes one multiprocessing lock shared by the
        # parent + all sync/setup children. For standalone callers that do not
        # spawn children, a thread lock avoids allocating an OS semaphore.
        self._process_lock = process_lock if process_lock is not None else threading.RLock()
        self._encoding = encoding
        self._stream = None
        self._path = None
        self._closed = False
        self.terminator = "\n"

    def _current_path(self):
        stamp = datetime.now().strftime("%Y%m%d")
        return os.path.join(self._log_dir, f"{self._file_prefix}_{stamp}.log")

    def _ensure_stream(self, path):
        if self._stream is not None and self._path == path:
            return
        if self._stream is not None:
            try:
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        os.makedirs(self._log_dir, exist_ok=True)
        self._stream = open(path, "a", encoding=self._encoding, newline="")
        self._path = path

    @property
    def current_path(self):
        """Current system-day log path used by the Log panel and diagnostics."""
        with self._process_lock:
            path = self._current_path()
            self._ensure_stream(path)
            return path

    def emit(self, record):
        try:
            message = self.format(record)
            with self._process_lock:
                path = self._current_path()
                self._ensure_stream(path)
                self._stream.write(message)
                if not message.endswith(self.terminator):
                    self._stream.write(self.terminator)
                self._stream.flush()
        except Exception:
            self.handleError(record)

    def close(self):
        if self._closed:
            return
        try:
            with self._process_lock:
                if self._stream is not None:
                    try:
                        self._stream.flush()
                    except Exception:
                        pass
                    try:
                        self._stream.close()
                    except Exception:
                        pass
                    self._stream = None
                    self._path = None
        finally:
            self._closed = True
            super().close()


def current_log_path(prefix=None):
    """Return the active YYYYMMDD log path based on the system local date."""
    file_prefix = LOG_FILE_PREFIX
    # V67.3 intentionally ignores historical custom prefixes so all logs share
    # one daily file. Keep the argument solely for call-site compatibility.
    return os.path.join(
        LOG_DIR,
        f"{file_prefix}_{datetime.now().strftime('%Y%m%d')}.log",
    )


def _find_sensitive_filter(logger):
    flt = getattr(logger, "_tick_sensitive_filter", None)
    if isinstance(flt, _SensitiveDataFilter):
        return flt
    for item in logger.filters:
        if isinstance(item, _SensitiveDataFilter):
            logger._tick_sensitive_filter = item
            return item
    return None


def register_sensitive_values(logger, *values):
    """Register account identity values that must never be logged in full."""
    flt = _find_sensitive_filter(logger)
    if flt is not None:
        flt.add_values(*values)


def append_session_log(logger, text):
    """Append an already-formatted record received from a child process."""
    buffer = getattr(logger, "_tick_session_log_buffer", None)
    if isinstance(buffer, SessionLogBuffer):
        buffer.append(text)


def setup_logger(prefix=None, file_lock=None, session_log_queue=None):
    """Configure the application logger and return ``(logger, log_path)``.

    ``prefix`` is kept for compatibility with older callers but is no longer
    used to create separate log files. When ``LOG_TO_DISK`` is true, the file
    is the current day's ``tick_explorer_YYYYMMDD.log``.
    ``session_log_queue`` is used by the sync child so the main-process UI can
    keep a complete in-memory session stream even when disk logging is off.
    """
    if LOG_TO_DISK:
        os.makedirs(LOG_DIR, exist_ok=True)

    logger = logging.getLogger("tick_explorer")
    logger.setLevel(logging.DEBUG)
    for handler in logger.handlers[:]:
        logger.removeHandler(handler)
        try:
            handler.close()
        except Exception:
            pass
    logger.filters.clear()
    logger.propagate = False

    session_buffer = SessionLogBuffer()
    logger._tick_session_log_buffer = session_buffer

    category_filter = _CategoryFilter()
    sensitive_filter = _SensitiveDataFilter()
    logger.addFilter(category_filter)
    logger.addFilter(sensitive_filter)
    logger._tick_sensitive_filter = sensitive_filter

    log_format = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(category)-8s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(log_format)

    session_handler = _SessionMemoryHandler(session_buffer)
    session_handler.setLevel(logging.DEBUG)
    session_handler.setFormatter(log_format)

    logger.addHandler(console_handler)
    logger.addHandler(session_handler)

    if session_log_queue is not None:
        queue_handler = _SessionLogQueueHandler(session_log_queue)
        queue_handler.setLevel(logging.DEBUG)
        queue_handler.setFormatter(log_format)
        logger.addHandler(queue_handler)

    if LOG_TO_DISK:
        file_handler = _DailyProcessSafeFileHandler(
            LOG_DIR,
            LOG_FILE_PREFIX,
            process_lock=file_lock,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(log_format)
        file_handler.addFilter(_NoDatabaseFileFilter())
        logger.addHandler(file_handler)

    logger._tick_file_log_enabled = bool(LOG_TO_DISK)

    # Proactively register the local OS username too. This covers any future
    # diagnostic that logs the username outside a Windows profile path; the
    # registered value is still shown only as a short masked prefix.
    try:
        register_sensitive_values(
            logger,
            os.environ.get("USERNAME"),
            os.environ.get("USER"),
            getpass.getuser(),
        )
    except Exception:
        pass

    log_filename = current_log_path()
    if LOG_TO_DISK:
        logger.info(f"Daily log: {log_filename}")
    else:
        logger.info("Disk logging disabled; console and in-app session logs remain active.")
    return logger, log_filename
