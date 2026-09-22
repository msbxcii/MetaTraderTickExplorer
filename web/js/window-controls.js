// v55.4: custom frameless title bar controller with explicit dragging.
//
// The native OS window frame is gone (webview.create_window(frameless=True)
// in app.py); this file wires up its replacement, #custom-titlebar in
// index.html: minimize/maximize/close buttons, double-click-to-maximize on
// the drag strip, and the .resize-grip edge/corner hit-areas that stand in
// for the OS's native resize-by-edge (which frameless windows lose).
//
// Moving the window itself is NOT handled here - the ".pywebview-drag-region"
// class on .titlebar-drag is picked up natively by pywebview (see the
// DRAG_REGION_SELECTOR default and app.py's easy_drag=False comment), so no
// JS/py round-trip is needed just to drag the window around.
(function () {
  function api() {
    return window.pywebview && window.pywebview.api;
  }

  function callApi(method, ...args) {
    const a = api();
    if (!a || typeof a[method] !== "function") return Promise.resolve(undefined);
    return a[method](...args).catch(() => undefined);
  }

  function setMaximizeIcon(isMaximized) {
    const icon = document.getElementById("titlebar-maximize-icon");
    const btn = document.getElementById("titlebar-maximize");
    if (!icon || !btn) return;
    if (isMaximized) {
      // "Restore" glyph: two overlapping squares.
      icon.innerHTML =
        '<rect x="2.25" y="0.75" width="7" height="7" rx="0.4"/>' +
        '<rect x="0.75" y="2.25" width="7" height="7" rx="0.4" fill="var(--panel)"/>' +
        '<rect x="0.75" y="2.25" width="7" height="7" rx="0.4"/>';
      btn.title = "Restore";
    } else {
      icon.innerHTML = '<rect x="0.75" y="0.75" width="8.5" height="8.5" rx="0.4"/>';
      btn.title = "Maximize";
    }
  }

  function toggleMaximize() {
    callApi("window_toggle_maximize").then((isMaximized) => {
      if (typeof isMaximized === "boolean") setMaximizeIcon(isMaximized);
    });
  }

  function initButtons() {
    const min = document.getElementById("titlebar-minimize");
    const max = document.getElementById("titlebar-maximize");
    const close = document.getElementById("titlebar-close");
    const drag = document.getElementById("titlebar-drag");
    if (min) min.addEventListener("click", () => callApi("window_minimize"));
    if (max) max.addEventListener("click", toggleMaximize);
    if (close) close.addEventListener("click", () => callApi("window_close"));
    if (drag) drag.addEventListener("dblclick", toggleMaximize);
  }

  // --- Window drag ----------------------------------------------------
  function initWindowDrag() {
    const drag = document.getElementById("titlebar-drag");
    if (!drag) return;

    drag.addEventListener("mousedown", (e) => {
      // Left button only; the titlebar controls live outside this element.
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.screenX;
      const startY = e.screenY;
      let pending = null;
      let rafId = null;

      callApi("window_drag_begin");

      function flush() {
        rafId = null;
        if (!pending) return;
        const { dx, dy } = pending;
        callApi("window_drag_move", dx, dy);
      }

      function onMove(ev) {
        pending = { dx: ev.screenX - startX, dy: ev.screenY - startY };
        if (rafId === null) rafId = requestAnimationFrame(flush);
      }

      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (pending) {
          callApi("window_drag_move", pending.dx, pending.dy);
        }
        callApi("window_drag_end");
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // --- Resize grips ---------------------------------------------------
  // Frameless windows lose native edge/corner resizing, so each
  // .resize-grip strip drives it manually: on mousedown we snapshot the
  // window's geometry (window_resize_begin), then on every throttled
  // mousemove we send the cumulative screen-pixel delta plus which edge is
  // being dragged (window_resize_move) - chart_bridge.py computes the new
  // absolute geometry from that fixed baseline so the drag never drifts.
  function initResizeGrips() {
    const grips = document.querySelectorAll(".resize-grip");
    grips.forEach((grip) => {
      grip.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const edge = grip.getAttribute("data-edge");
        const startX = e.screenX;
        const startY = e.screenY;
        let pending = null;
        let rafId = null;

        callApi("window_resize_begin");

        function flush() {
          rafId = null;
          if (!pending) return;
          const { dx, dy } = pending;
          callApi("window_resize_move", edge, dx, dy);
        }

        function onMove(ev) {
          pending = { dx: ev.screenX - startX, dy: ev.screenY - startY };
          if (rafId === null) rafId = requestAnimationFrame(flush);
        }

        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          if (rafId !== null) cancelAnimationFrame(rafId);
          callApi("window_resize_end");
        }

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

  function init() {
    initButtons();
    initWindowDrag();
    initResizeGrips();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
