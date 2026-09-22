// =============================================================================
// log-panel.js — v67.3: the Log panel opened from the header's Log button
// (next to Setting). Shows the current execution's bounded in-memory log
// stream — including records from the background sync process — as a
// draggable-height panel docked under the chart, following the same
// flex-sibling-of-#chart-container pattern the Bar Replay strip already
// uses (see index.html/replay-bar.js), so opening/closing it shrinks/grows
// the chart instead of overlapping it.
//
// v67.3: the UI reads a bounded in-memory session stream instead of the
// shared daily disk file, so previous executions never appear here. `offset`
// remains opaque to this file.
//
// v62.6: every log line now carries a topical category (GENERAL / DATABASE
// / WARNING / ERROR / DEBUG — see logger_setup.py), printed as a fixed
// third column. This file parses that column per line and keeps a capped
// in-memory buffer of parsed lines so the filter chips above the panel body
// can switch which categories are shown instantly, with no extra backend
// round trip - only the currently active filter is ever rendered into the
// (potentially large) <pre>, so memory/DOM cost stays bounded regardless of
// how long the panel has been open.
//
// v63: the polling, the offset and the parsed-line buffer moved out of the
// panel into one shared feed, App.LogFeed, that any number of views can
// attach to. Two views use it today: this header panel (all categories, chip
// filter) and the Log view of Setting > Market Data Overview (DATABASE only,
// see market-data-overview.js). One poller and one buffer serve both, so a
// second view costs no extra backend call and no second copy of the log, and
// polling runs only while at least one view is actually visible. Views render
// through App.LogFeed.createView(), which appends to a single text node
// (no re-parse of the whole text per poll) and rebuilds from the buffer only
// when the filter changes or the DOM has outgrown the buffer.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;
  var dom = App.dom;

  var POLL_INTERVAL_MS = 1000;

  // Caps how many parsed lines are kept for client-side re-filtering. Old
  // lines beyond this are dropped from the buffer (the underlying log
  // files on disk are untouched) - this is a display-memory bound, not a
  // data-retention feature.
  var MAX_BUFFERED_LINES = 4000;

  // v63: a view whose DOM text has grown this many entries past the buffer
  // cap is rebuilt from the (already trimmed) buffer, so the visible text
  // can't grow without bound while a panel stays open for days.
  var REBUILD_SLACK = 1000;

  // v63: if a poll returns more than this many characters at once (a view
  // was closed for a long time, so the whole gap arrives in one go), only
  // the newest part is parsed - the rest would be trimmed by the buffer cap
  // right away anyway, so parsing it would be wasted work.
  var MAX_CHUNK_CHARS = 600000;

  // Matches this project's log line format (see logger_setup.py):
  // "<date> <time> | <LEVEL>   | <CATEGORY> | <message>". Only the category
  // column is needed here.
  var LINE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| \S+\s*\| (\S+)\s*\|/;

  // ---- Shared feed ---------------------------------------------------------
  // null = "nothing fetched yet" - read_log_tail(null) returns the newest
  // portion of the current application's in-memory session buffer; every call
  // after that passes the previous opaque cursor so only new records come back.
  var offset = null;
  var pollTimer = null;
  var polling = false; // a read_log_tail call is in flight

  // Ring buffer of {category, text} entries, oldest first. `text` includes
  // its own trailing newline (and any continuation lines, e.g. a
  // traceback, folded into the entry that started them) so re-rendering a
  // filtered view is just a join of the matching entries' text.
  var buffer = [];

  // Attached views: {onAppend(entries), onSnapshot(buffer), onReset()}.
  var consumers = [];

  // Splits raw appended text into line-entries, folding any line with no
  // recognizable "date | level | category |" header into the entry above
  // it (a multi-line record, e.g. a traceback, must never be split apart
  // or partially filtered).
  function parseIntoEntries(text) {
    var entries = [];
    var lines = text.match(/[^\n]*\n?/g) || [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var m = LINE_RE.exec(line);
      if (m) {
        entries.push({ category: m[1], text: line });
      } else if (entries.length) {
        entries[entries.length - 1].text += line;
      } else {
        entries.push({ category: "GENERAL", text: line });
      }
    }
    return entries;
  }

  function poll() {
    if (polling) return; // never stack calls if the backend is slow
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.read_log_tail) return;
    polling = true;
    window.pywebview.api.read_log_tail(offset).then(function (result) {
      polling = false;
      if (!result || !consumers.length) return;
      if (result.reset) {
        // The system day changed or the active daily file was reset - start
        // the visible tail over instead of mixing two days.
        buffer = [];
        consumers.slice().forEach(function (c) { if (c.onReset) c.onReset(); });
      }
      offset = result.offset;

      var text = result.text || "";
      if (text.length > MAX_CHUNK_CHARS) {
        text = text.slice(text.length - MAX_CHUNK_CHARS);
        var nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1); // drop the cut, partial first line
      }
      var entries = parseIntoEntries(text);
      if (!entries.length) return;

      for (var i = 0; i < entries.length; i++) buffer.push(entries[i]);
      if (buffer.length > MAX_BUFFERED_LINES) {
        buffer.splice(0, buffer.length - MAX_BUFFERED_LINES);
      }
      consumers.slice().forEach(function (c) { if (c.onAppend) c.onAppend(entries); });
    }).catch(function () { polling = false; });
  }

  function startPolling() {
    if (pollTimer) return;
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Polling runs only while at least one view is attached - no point
  // spending a timer + a pywebview round trip on text nobody can see.
  function attach(consumer) {
    if (consumers.indexOf(consumer) !== -1) return;
    consumers.push(consumer);
    if (consumer.onSnapshot) consumer.onSnapshot(buffer);
    startPolling();
  }

  function detach(consumer) {
    var i = consumers.indexOf(consumer);
    if (i === -1) return;
    consumers.splice(i, 1);
    if (!consumers.length) stopPolling();
  }

  // ---- View helper ---------------------------------------------------------
  // Renders the buffer into a <pre>, keeping only entries whose category
  // passes `category` ("ALL" or a single category name). Text is appended to
  // ONE text node with appendData(), so a poll that brings a few lines
  // touches only those lines, instead of re-serializing the whole text the
  // way `el.textContent += ...` does.
  function createView(el, initialCategory) {
    var category = initialCategory || "ALL";
    var node = document.createTextNode("");
    var domEntries = 0;
    el.textContent = "";
    el.appendChild(node);

    function matches(entry) {
      return category === "ALL" || entry.category === category;
    }

    function isPinnedToBottom() {
      // A small tolerance (a couple of lines' worth of pixels) so a user
      // who is essentially at the bottom, but not pixel-perfect, still
      // counts as "following the tail".
      return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    }

    function rebuild(entries) {
      var text = "";
      var n = 0;
      for (var i = 0; i < entries.length; i++) {
        if (matches(entries[i])) { text += entries[i].text; n++; }
      }
      node.nodeValue = text;
      domEntries = n;
      el.scrollTop = el.scrollHeight;
    }

    return {
      onSnapshot: rebuild,
      onReset: function () { node.nodeValue = ""; domEntries = 0; },
      onAppend: function (entries) {
        var stick = isPinnedToBottom();
        var addition = "";
        var n = 0;
        for (var i = 0; i < entries.length; i++) {
          if (matches(entries[i])) { addition += entries[i].text; n++; }
        }
        if (!n) return;
        domEntries += n;
        if (domEntries > MAX_BUFFERED_LINES + REBUILD_SLACK) {
          rebuild(buffer); // buffer already contains `entries` and is trimmed
          return;
        }
        node.appendData(addition);
        if (stick) el.scrollTop = el.scrollHeight;
      },
      setCategory: function (next) {
        if (next === category) return;
        category = next;
        rebuild(buffer);
      },
      // Re-pins to the newest line, e.g. right after the view becomes
      // visible (a hidden element has no scroll height to stick to).
      scrollToEnd: function () { el.scrollTop = el.scrollHeight; },
    };
  }

  App.LogFeed = { attach: attach, detach: detach, createView: createView };

  if (!dom.logToggle || !dom.logPanel) return;

  // ---- Header Log panel (view of the shared feed) ---------------------------
  var isOpen = false;
  var activeFilter = "ALL";
  var panelView = createView(dom.logPanelBody, activeFilter);

  function setFilter(category) {
    if (category === activeFilter) return;
    activeFilter = category;
    if (dom.logPanelFilters) {
      var btns = dom.logPanelFilters.querySelectorAll(".log-filter-btn");
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle("active", btns[i].getAttribute("data-category") === category);
      }
    }
    panelView.setCategory(category);
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    dom.logPanel.classList.add("open");
    dom.logToggle.classList.add("active");
    App.LogFeed.attach(panelView);
    panelView.scrollToEnd();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    dom.logPanel.classList.remove("open");
    dom.logToggle.classList.remove("active");
    App.LogFeed.detach(panelView);
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  dom.logToggle.innerHTML = App.Icons.log ? App.Icons.log() : "";
  dom.logToggle.addEventListener("click", toggle);
  if (dom.logPanelClose) dom.logPanelClose.addEventListener("click", close);
  if (dom.logPanelFilters) {
    dom.logPanelFilters.addEventListener("click", function (evt) {
      var btn = evt.target.closest(".log-filter-btn");
      if (!btn) return;
      setFilter(btn.getAttribute("data-category") || "ALL");
    });
  }
  document.addEventListener("keydown", function (evt) {
    if (evt.key === "Escape" && isOpen) close();
  });

  // ---- Resize: drag the handle along the panel's top edge -----------------
  // Same manual mousedown/mousemove/mouseup pattern window-controls.js uses
  // for the main window's own resize grips (see initResizeGrips there) -
  // no pointer capture or library needed, a document-level listener pair
  // added on mousedown and removed on mouseup.
  if (dom.logPanelHandle) {
    dom.logPanelHandle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      var startY = e.screenY;
      var startHeight = dom.logPanel.getBoundingClientRect().height;
      var minHeight = parseFloat(getComputedStyle(dom.logPanel).minHeight) || 80;
      var maxHeight = parseFloat(getComputedStyle(dom.logPanel).maxHeight) || (window.innerHeight * 0.7);
      dom.logPanelHandle.classList.add("dragging");

      function onMove(moveEvt) {
        // The handle sits on the panel's TOP edge and the panel is docked
        // to the bottom of the window, so dragging up (negative deltaY)
        // must grow it and dragging down must shrink it - the sign is
        // inverted relative to a plain top-left resize grip.
        var delta = moveEvt.screenY - startY;
        var next = startHeight - delta;
        if (next < minHeight) next = minHeight;
        if (next > maxHeight) next = maxHeight;
        dom.logPanel.style.height = next + "px";
      }

      function onUp() {
        dom.logPanelHandle.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  App.LogPanel = { open: open, close: close, toggle: toggle };
})();
