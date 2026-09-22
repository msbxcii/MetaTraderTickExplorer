// =============================================================================
// about-panel.js — v66.4: the Setting panel's "About" tab. Was an empty
// shell holding only a static Version row since v50. Now the tab's whole
// body is read from web/About.md (via ChartBridge.get_about_text(), see
// chart_bridge.py) and rendered as Markdown into #about-text-content, so
// the text can be edited without touching index.html or any JS.
//
// Rendering is a small hand-rolled Markdown -> HTML pass (headings, bold/
// italic, inline code, links, unordered/ordered lists, paragraphs, hr) —
// no external Markdown library ships in web/vendor, and About.md only ever
// needs this common subset. Text is HTML-escaped first, so nothing in
// About.md (or a broken bridge response) can inject markup.
//
// The text box itself only ever scrolls vertically (see .about-text-box in
// index.html) — long lines wrap instead of producing a horizontal
// scrollbar, and the vertical scrollbar (a themed thin one, same as every
// other scroll area in the app) only appears once content actually
// overflows the box.
// =============================================================================

(function () {
  "use strict";

  var App = window.App;

  var contentEl = document.getElementById("about-text-content");
  if (!contentEl) return;

  // Version card icon reuses the same static sidebar glyph as the About
  // tab itself (App.Icons.tabAbout), so the card visually echoes the tab
  // that hosts it instead of introducing a one-off icon.
  var versionIconEl = document.getElementById("about-version-icon");
  if (versionIconEl && App.Icons && App.Icons.tabAbout) {
    versionIconEl.innerHTML = App.Icons.tabAbout();
  }

  // v67.2: version value comes from the same single source (src/version.py,
  // via App.AppVersion) as the title bar, instead of a hardcoded string in
  // index.html — see app-version.js. Painted from activate() (below), NOT
  // here at script-parse time: this file runs long before "pywebviewready"
  // fires, so calling App.AppVersion.load() this early would only ever see
  // a not-yet-ready bridge and fail.
  var versionValueEl = document.getElementById("about-version-value");
  function paintVersion() {
    if (!versionValueEl) return;
    var info = App.AppVersion && App.AppVersion.getInfo && App.AppVersion.getInfo();
    if (info && info.version) versionValueEl.textContent = info.version;
  }

  var loaded = false;     // fetched (or attempted) once already this session
  var loading = false;

  function hasBridge() {
    return !!(window.pywebview && window.pywebview.api && window.pywebview.api.get_about_text);
  }

  // ---- Minimal Markdown -> HTML ---------------------------------------------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Inline spans: `code`, **bold**, *italic*, [text](url). Applied after
  // the text is already HTML-escaped, so the only markup these introduce
  // is the tags they themselves add.
  function renderInline(text) {
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return text;
  }

  function renderMarkdown(md) {
    var lines = escapeHtml(md || "").replace(/\r\n/g, "\n").split("\n");
    var html = [];
    var listType = null; // "ul" | "ol" | null — which list we're currently inside

    function closeList() {
      if (listType) { html.push("</" + listType + ">"); listType = null; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();

      if (trimmed === "") { closeList(); continue; }
      if (/^-{3,}$/.test(trimmed)) { closeList(); html.push("<hr>"); continue; }

      var heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        closeList();
        var level = heading[1].length;
        html.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
        continue;
      }

      var quote = /^&gt;\s?(.*)$/.exec(trimmed);
      if (quote) {
        closeList();
        html.push("<blockquote>" + renderInline(quote[1]) + "</blockquote>");
        continue;
      }

      var ul = /^[-*]\s+(.*)$/.exec(trimmed);
      if (ul) {
        if (listType !== "ul") { closeList(); html.push("<ul>"); listType = "ul"; }
        html.push("<li>" + renderInline(ul[1]) + "</li>");
        continue;
      }

      var ol = /^\d+\.\s+(.*)$/.exec(trimmed);
      if (ol) {
        if (listType !== "ol") { closeList(); html.push("<ol>"); listType = "ol"; }
        html.push("<li>" + renderInline(ol[1]) + "</li>");
        continue;
      }

      closeList();
      html.push("<p>" + renderInline(trimmed) + "</p>");
    }
    closeList();
    return html.join("\n");
  }

  function renderText(md) {
    contentEl.innerHTML = renderMarkdown(md);
  }

  function load() {
    if (loaded || loading) return;
    loading = true;

    if (!hasBridge()) {
      // Dev-mode fallback (no pywebview bridge available): fetch straight
      // off disk. In the packaged app this branch never runs — About.md
      // is always read through get_about_text() instead.
      fetch("About.md").then(function (r) { return r.text(); })
        .then(function (text) { loaded = true; loading = false; renderText(text); })
        .catch(function () { loading = false; contentEl.textContent = ""; });
      return;
    }

    window.pywebview.api.get_about_text().then(function (text) {
      loaded = true;
      loading = false;
      renderText(text || "");
    }).catch(function (err) {
      loading = false;
      console.warn("get_about_text failed:", err);
    });
  }

  function activate() {
    load();
    // By the time the About tab is actually opened, App.AppVersion has
    // long since resolved (main.js's boot() fetches it once at startup) —
    // but paint from the live cache either way, and again if a fetch is
    // still in flight for some reason.
    paintVersion();
    if (App.AppVersion && App.AppVersion.load) App.AppVersion.load().then(paintVersion);
  }

  // ---- v68/v69: the whole "Check for Updates" -> download -> apply flow -
  // Talks to ChartBridge.check_for_updates() / start_update_download() /
  // apply_update_now() (see chart_bridge.py + update_checker.py +
  // update_installer.py). Nothing here ever runs unless the user clicks
  // the button - no background polling, no network call the user didn't
  // ask for.
  //
  // The single button cycles through five states as one flow:
  //   idle -> "Check for Updates"      (checkForUpdates)
  //   checking -> "Checking…"          (disabled)
  //   available -> "Download Update"   (startDownload)
  //   downloading -> "Downloading…"    (disabled; progress bar shown)
  //   downloaded -> "Update Now"       (applyUpdate)
  var updateBtnEl = document.getElementById("about-update-btn");
  var updateStatusEl = document.getElementById("about-update-status");
  var updateProgressEl = document.getElementById("about-update-progress");
  var updateProgressFillEl = document.getElementById("about-update-progress-fill");
  var updateProgressLabelEl = document.getElementById("about-update-progress-label");

  // "idle" | "checking" | "available" | "downloading" | "downloaded"
  var updateState = "idle";
  var pendingUpdateInfo = null; // {latest_version, download_url, download_size, url}

  function setUpdateStatus(html, kind) {
    if (!updateStatusEl) return;
    updateStatusEl.innerHTML = html || "";
    updateStatusEl.classList.toggle("is-available", kind === "available");
    updateStatusEl.classList.toggle("is-error", kind === "error");
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 MB";
    var mb = bytes / (1024 * 1024);
    return (mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)) + " MB";
  }

  function renderUpdateButton() {
    if (!updateBtnEl) return;
    switch (updateState) {
      case "checking":
        updateBtnEl.disabled = true; updateBtnEl.textContent = "Checking…"; break;
      case "available":
        updateBtnEl.disabled = false; updateBtnEl.textContent = "Download Update"; break;
      case "downloading":
        updateBtnEl.disabled = true; updateBtnEl.textContent = "Downloading…"; break;
      case "downloaded":
        updateBtnEl.disabled = false; updateBtnEl.textContent = "Update Now"; break;
      default:
        updateBtnEl.disabled = false; updateBtnEl.textContent = "Check for Updates"; break;
    }
  }

  function setProgress(downloaded, total) {
    if (!updateProgressEl) return;
    updateProgressEl.hidden = false;
    var pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
    if (updateProgressFillEl) updateProgressFillEl.style.width = pct + "%";
    if (updateProgressLabelEl) {
      updateProgressLabelEl.textContent =
        formatBytes(downloaded) + " / " + formatBytes(total) + " (" + pct + "%)";
    }
  }

  function hideProgress() {
    if (updateProgressEl) updateProgressEl.hidden = true;
  }

  // ---- Step 1: check --------------------------------------------------
  function checkForUpdates() {
    if (!hasBridge() || !window.pywebview.api.check_for_updates) {
      setUpdateStatus("Update check isn't available right now.", "error");
      return;
    }
    updateState = "checking";
    renderUpdateButton();
    setUpdateStatus("");
    hideProgress();

    window.pywebview.api.check_for_updates().then(function (result) {
      result = result || {};
      if (result.status === "update_available") {
        pendingUpdateInfo = result;
        updateState = "available";
        setUpdateStatus(
          "A newer version is available: <strong>" + escapeHtml(result.latest_version || "") + "</strong>" +
          (result.download_size ? " (" + formatBytes(result.download_size) + ")" : ""),
          "available"
        );
      } else if (result.status === "up_to_date") {
        updateState = "idle";
        setUpdateStatus("You're on the latest version.");
      } else if (result.status === "unconfigured") {
        updateState = "idle";
        setUpdateStatus("Update checking isn't configured yet.");
      } else {
        updateState = "idle";
        setUpdateStatus("Couldn't check for updates right now.", "error");
      }
      renderUpdateButton();
    }).catch(function (err) {
      updateState = "idle";
      renderUpdateButton();
      setUpdateStatus("Couldn't check for updates right now.", "error");
      console.warn("check_for_updates failed:", err);
    });
  }

  // ---- Step 2: download -------------------------------------------------
  function startDownload() {
    if (!pendingUpdateInfo) return;

    if (!pendingUpdateInfo.download_url) {
      // Release has no attached .exe asset (or GITHUB_REPO points at a
      // release built before this flow existed) - fall back to just
      // opening the release page, same as the original v68 behavior.
      if (pendingUpdateInfo.url) window.open(pendingUpdateInfo.url, "_blank");
      return;
    }

    updateState = "downloading";
    renderUpdateButton();
    setProgress(0, pendingUpdateInfo.download_size || 0);

    window.pywebview.api.start_update_download(
      pendingUpdateInfo.download_url, pendingUpdateInfo.download_size, pendingUpdateInfo.latest_version
    ).catch(function (err) {
      updateState = "available";
      renderUpdateButton();
      hideProgress();
      setUpdateStatus("Couldn't start the download.", "error");
      console.warn("start_update_download failed:", err);
    });
  }

  // ---- Step 3: apply (closes + restarts the app - see chart_bridge.py) --
  function applyUpdate() {
    if (!hasBridge() || !window.pywebview.api.apply_update_now) return;
    updateBtnEl.disabled = true;
    updateBtnEl.textContent = "Restarting…";
    window.pywebview.api.apply_update_now().then(function (result) {
      if (result && result.status === "no_pending_update") {
        updateState = "idle";
        renderUpdateButton();
        setUpdateStatus("The downloaded update couldn't be found — try again.", "error");
      }
      // "applying": the window is closing right about now; nothing else to do.
    }).catch(function (err) {
      console.warn("apply_update_now failed:", err);
    });
  }

  // ---- Push events from the download thread (see chart_bridge.py's
  // _push_update_event / ChartBridge.start_update_download) ---------------
  window.onUpdateDownloadEvent = function (data) {
    data = data || {};
    if (data.event === "progress") {
      setProgress(data.downloaded || 0, data.total || (pendingUpdateInfo && pendingUpdateInfo.download_size) || 0);
    } else if (data.event === "done") {
      updateState = "downloaded";
      renderUpdateButton();
      setProgress(pendingUpdateInfo ? pendingUpdateInfo.download_size : 1, pendingUpdateInfo ? pendingUpdateInfo.download_size : 1);
      setUpdateStatus(
        "Version <strong>" + escapeHtml(data.version || "") + "</strong> is ready. " +
        "Click Update Now to install and restart — or just keep working; it installs automatically next time you open the app.",
        "available"
      );
    } else if (data.event === "cancelled") {
      updateState = "available";
      renderUpdateButton();
      hideProgress();
      setUpdateStatus("Download cancelled.");
    } else if (data.event === "error") {
      updateState = "available";
      renderUpdateButton();
      hideProgress();
      setUpdateStatus("Download failed — check your connection and try again.", "error");
    }
  };

  function onUpdateButtonClick() {
    if (updateState === "idle") checkForUpdates();
    else if (updateState === "available") startDownload();
    else if (updateState === "downloaded") applyUpdate();
    // "checking"/"downloading": button is disabled, nothing to do.
  }

  if (updateBtnEl) updateBtnEl.addEventListener("click", onUpdateButtonClick);

  App.AboutPanel = {
    activate: activate,
  };
})();
