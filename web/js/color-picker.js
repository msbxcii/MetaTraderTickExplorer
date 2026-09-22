// =============================================================================
// color-picker.js — v38 Fix 1: a themed dark color+opacity popover that
// replaces every native <input type="color"> in the style editor (Border /
// Fill / Middle Line). A native color input opens the OS/browser's own
// popup, which a page can't restyle, can't add an opacity slider to, and
// can't theme to match the panel — so each one here is now a plain button
// ("swatch") that opens this shared popover instead: a hue/saturation
// square, a hue slider, an opacity slider and one small pasteable hex box.
//
// App.ColorField.attach(buttonEl, {opacity, value, initialOpacity}) turns a
// <button> into such a swatch. Callers keep reading/writing `.value` (hex
// string) and `.opacity` (0-100) on that element exactly like they used to
// read/write a native color input's `.value` — and still get an "input"
// event on every live change plus a "change" event once the user commits
// (mirrors native <input type="color"> input/change semantics), so the
// rest of the app (drawing-context-menu.js) barely has to know this isn't
// a native control.
// =============================================================================
(function () {
  "use strict";

  var App = window.App;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function normalizeHex(hex) {
    var m = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
    return "#" + h.toLowerCase();
  }

  function hexToRgb(hex) {
    var n = normalizeHex(hex) || "#c9a227";
    return { r: parseInt(n.slice(1, 3), 16), g: parseInt(n.slice(3, 5), 16), b: parseInt(n.slice(5, 7), 16) };
  }

  function rgbToHex(r, g, b) {
    function h(n) { var s = clamp(Math.round(n), 0, 255).toString(16); return s.length < 2 ? "0" + s : s; }
    return "#" + h(r) + h(g) + h(b);
  }

  function rgbaStr(rgb, pct) {
    return "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + "," + (clamp(pct, 0, 100) / 100) + ")";
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var d = max - min, h = 0, s = max === 0 ? 0 : d / max, v = max;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: h, s: s, v: v };
  }

  function hsvToRgb(h, s, v) {
    var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    var r, g, b;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }

  // ---- one shared popover instance, reused/repositioned for whichever
  // swatch is currently open --------------------------------------------
  var pop = null, els = null;
  var activeCommit = null;
  var hsv = { h: 0, s: 0, v: 0 };
  var opacity = 100;
  var showOpacity = true;

  function currentHex() {
    var rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  function syncFromHsv(skipHex) {
    var hex = currentHex();
    els.sv.style.background = "hsl(" + hsv.h + ",100%,50%)";
    els.svThumb.style.left = (hsv.s * 100) + "%";
    els.svThumb.style.top = ((1 - hsv.v) * 100) + "%";
    els.hueThumb.style.left = (hsv.h / 360 * 100) + "%";
    els.swatch.style.setProperty("--sw-color", hex);
    els.alphaFill.style.background = "linear-gradient(to right, rgba(0,0,0,0), " + hex + ")";
    els.alphaThumb.style.left = opacity + "%";
    if (!skipHex) els.hex.value = hex.slice(1).toUpperCase();
  }

  function commit(isFinal) {
    if (activeCommit) activeCommit(currentHex(), showOpacity ? opacity : 100, isFinal);
  }

  function buildPopover() {
    if (pop) return;
    pop = document.createElement("div");
    pop.className = "dcm-cp-pop";
    pop.innerHTML =
      '<div class="dcm-cp-sv" id="dcmCpSv"><div class="dcm-cp-sv-white"></div><div class="dcm-cp-sv-black"></div><div class="dcm-cp-sv-thumb" id="dcmCpSvThumb"></div></div>' +
      '<div class="dcm-cp-hue" id="dcmCpHue"><div class="dcm-cp-thumb" id="dcmCpHueThumb"></div></div>' +
      '<div class="dcm-cp-alpha" id="dcmCpAlpha"><div class="dcm-cp-alpha-fill" id="dcmCpAlphaFill"></div><div class="dcm-cp-thumb" id="dcmCpAlphaThumb"></div></div>' +
      '<div class="dcm-cp-bottom">' +
        '<button type="button" class="dcm-cp-eyedrop" id="dcmCpEyedrop" title="Pick from screen"></button>' +
        '<span class="dcm-cp-swatch" id="dcmCpSwatch"></span>' +
        '<input type="text" class="dcm-cp-hex" id="dcmCpHex" maxlength="7" spellcheck="false" autocomplete="off" title="Hex color \u2014 paste supported" />' +
      "</div>";
    document.body.appendChild(pop);

    els = {
      sv: pop.querySelector("#dcmCpSv"),
      svThumb: pop.querySelector("#dcmCpSvThumb"),
      hue: pop.querySelector("#dcmCpHue"),
      hueThumb: pop.querySelector("#dcmCpHueThumb"),
      alpha: pop.querySelector("#dcmCpAlpha"),
      alphaFill: pop.querySelector("#dcmCpAlphaFill"),
      alphaThumb: pop.querySelector("#dcmCpAlphaThumb"),
      eyedrop: pop.querySelector("#dcmCpEyedrop"),
      swatch: pop.querySelector("#dcmCpSwatch"),
      hex: pop.querySelector("#dcmCpHex"),
    };

    if (App.Icons && App.Icons.eyedropper) els.eyedrop.innerHTML = App.Icons.eyedropper();
    if (!window.EyeDropper) els.eyedrop.style.display = "none";

    function ratio(evt, rect, axis) {
      var v = axis === "x" ? (evt.clientX - rect.left) / rect.width : (evt.clientY - rect.top) / rect.height;
      return clamp(v, 0, 1);
    }
    function bindDrag(el, onMove) {
      el.addEventListener("pointerdown", function (evt) {
        evt.preventDefault();
        el.setPointerCapture(evt.pointerId);
        onMove(evt);
        function move(e) { onMove(e); }
        function up() {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          commit(true);
        }
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      });
    }

    bindDrag(els.sv, function (evt) {
      var r = els.sv.getBoundingClientRect();
      hsv.s = ratio(evt, r, "x");
      hsv.v = 1 - ratio(evt, r, "y");
      syncFromHsv();
      commit(false);
    });
    bindDrag(els.hue, function (evt) {
      var r = els.hue.getBoundingClientRect();
      hsv.h = ratio(evt, r, "x") * 360;
      syncFromHsv();
      commit(false);
    });
    bindDrag(els.alpha, function (evt) {
      var r = els.alpha.getBoundingClientRect();
      opacity = Math.round(ratio(evt, r, "x") * 100);
      syncFromHsv();
      commit(false);
    });

    function applyHexInput(finalize) {
      var n = normalizeHex(els.hex.value);
      if (!n) return;
      var rgb = hexToRgb(n);
      hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      syncFromHsv(true);
      commit(!!finalize);
    }
    els.hex.addEventListener("input", function () { applyHexInput(false); });
    els.hex.addEventListener("change", function () { applyHexInput(true); });
    els.hex.addEventListener("keydown", function (evt) {
      evt.stopPropagation();
      if (evt.key === "Enter") { evt.preventDefault(); applyHexInput(true); }
    });
    els.hex.addEventListener("paste", function () {
      setTimeout(function () { applyHexInput(true); }, 0);
    });

    els.eyedrop.addEventListener("click", function () {
      if (!window.EyeDropper) return;
      new window.EyeDropper().open().then(function (res) {
        var rgb = hexToRgb(res.sRGBHex);
        hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        syncFromHsv(true);
        commit(true);
      }).catch(function () {});
    });

    pop.addEventListener("pointerdown", function (evt) { evt.stopPropagation(); });
    pop.addEventListener("click", function (evt) { evt.stopPropagation(); });
    document.addEventListener("pointerdown", function (evt) {
      if (pop.classList.contains("open") && !pop.contains(evt.target)) close();
    });
    document.addEventListener("keydown", function (evt) {
      if (evt.key === "Escape" && pop.classList.contains("open")) close();
    });
    window.addEventListener("resize", function () { if (pop.classList.contains("open")) close(); });
    window.addEventListener("scroll", function () { if (pop.classList.contains("open")) close(); }, true);
  }

  function positionPopover(anchorEl) {
    pop.style.visibility = "hidden";
    pop.classList.add("open");
    var r = anchorEl.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = clamp(r.left, 8, window.innerWidth - pw - 8);
    var top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    pop.style.visibility = "";
  }

  function close() {
    if (!pop) return;
    pop.classList.remove("open");
    commit(true);
    activeCommit = null;
  }

  function openPicker(anchorEl, initialHex, initialOpacity, hasOpacity, onChange) {
    buildPopover();
    if (pop.classList.contains("open") && activeCommit) commit(true); // close any other open swatch first
    showOpacity = hasOpacity !== false;
    els.alpha.style.display = showOpacity ? "" : "none";
    var rgb = hexToRgb(initialHex);
    hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    opacity = showOpacity ? clamp(Math.round(initialOpacity == null ? 100 : initialOpacity), 0, 100) : 100;
    activeCommit = onChange;
    syncFromHsv();
    positionPopover(anchorEl);
    setTimeout(function () { els.hex.focus(); els.hex.select(); }, 0);
  }

  // ---- public: turn a <button> into a themed color(+opacity) swatch ----
  function attach(el, options) {
    options = options || {};
    var hasOpacity = options.opacity !== false;
    el.type = "button";
    el.classList.add("dcm-color-swatch");
    var fill = document.createElement("span");
    fill.className = "dcm-color-swatch-fill";
    el.appendChild(fill);

    var state = {
      value: normalizeHex(options.value) || "#c9a227",
      opacity: hasOpacity ? clamp(options.initialOpacity == null ? 100 : Number(options.initialOpacity), 0, 100) : 100,
    };

    function paint() {
      var rgb = hexToRgb(state.value);
      fill.style.setProperty("--sw-color", rgbaStr(rgb, hasOpacity ? state.opacity : 100));
    }

    Object.defineProperty(el, "value", {
      get: function () { return state.value; },
      set: function (v) { var n = normalizeHex(v); if (n) state.value = n; paint(); },
    });
    Object.defineProperty(el, "opacity", {
      get: function () { return state.opacity; },
      set: function (v) { state.opacity = clamp(Number(v), 0, 100); paint(); },
    });

    el.addEventListener("click", function (evt) {
      evt.stopPropagation();
      openPicker(el, state.value, state.opacity, hasOpacity, function (hex, pct, isFinal) {
        state.value = hex;
        if (hasOpacity) state.opacity = pct;
        paint();
        el.dispatchEvent(new Event("input"));
        if (isFinal) el.dispatchEvent(new Event("change"));
      });
    });

    paint();
    return el;
  }

  App.ColorField = { attach: attach };
})();
