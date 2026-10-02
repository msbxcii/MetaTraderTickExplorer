// =============================================================================
// trade-panel.js — V83: Trade panel (History / Trade tabs), a sibling of the
// Object Tree panel toggled from the header's Trade icon.
//   Trade tab: risk settings UI (placeholders, logic comes later) + live open
//     positions pushed by the sync process (window.onTradePositions).
//   History tab: closed trades for a chosen window (window.onTradeHistory).
// The live feed only runs while the panel is open (set_trade_feed), so a
// closed panel costs nothing on the MT5 side.
// V88: pending orders (Shift+middle-click) pinned on top, Cancel only.
// V84: risk settings are live (saved locally), lot sizing follows Position
// Sizer (floor to volume step, commission x2), buttons trade for real, and a
// light "lines" feed keeps chart SL/TP lines alive while the panel is closed.
// =============================================================================
(function () {
  "use strict";

  var App = window.App || {};
  var $ = function (id) { return document.getElementById(id); };
  var toggleBtn = $("trade-panel-toggle");
  var panel = $("trade-panel");
  if (!toggleBtn || !panel) return;

  var openList = $("tp-open-list");
  var histList = $("tp-hist-list");
  var selectAll = $("tp-select-all");
  var openBox = $("tp-open-box"), openNet = $("tp-open-net"); // V90
  var isOpen = false;
  var activeTab = "trade";
  var histPeriod = "week";
  var histData = null, histRendered = 0, HIST_CHUNK = 120;
  var lastFeedMsg = 0;
  var watchdog = null;
  var rows = {};          // ticket -> {el, refs}
  var selected = {};      // ticket -> true

  function api() { return window.pywebview && window.pywebview.api; }
  function call(name, arg) {
    var a = api();
    if (a && typeof a[name] === "function") { try { a[name](arg); } catch (e) {} }
  }

  function money(v) {
    var n = Number(v) || 0;
    return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2);
  }
  function px(v, d) {
    var n = Number(v);
    if (!n) return "—";
    return n.toFixed(d == null ? 5 : d);
  }
  function lots(v) { return (Number(v) || 0).toFixed(2); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---- V84: settings, symbol specs, lot math, toasts -----------------------
  var SKEY = "ct.trade.settings.v84";
  var settings = { riskMode: "pct", risk: 1, commission: "", commMode: "lot", comm: {}, rr: 2, maxMode: "pct", maxRisk: 5, maxBasis: "open" };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SKEY) || "{}")); } catch (e) {}
  // V85: settings also saved to disk; commission is remembered PER SYMBOL
  // (settings.comm = {SYMBOL: {v, mode}}), round trip, $/lot or % of value.
  var saveTimer = null;
  function saveSettings() {
    try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch (e) {}
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var a = api(); if (a && a.save_trade_settings) { try { a.save_trade_settings(settings); } catch (e) {} }
    }, 400);
  }
  function curSym() { return (App.symbol || (specs && specs.symbol) || "").toString(); }
  function loadComm() {
    var c = (settings.comm || {})[curSym()];
    settings.commission = c && c.v !== "" && c.v != null ? c.v : "";
    settings.commMode = c && c.mode === "pct" ? "pct" : "lot";
  }
  function storeComm() {
    var sym = curSym(); if (!sym) return;
    settings.comm = settings.comm || {};
    if (settings.commission === "") delete settings.comm[sym];
    else settings.comm[sym] = { v: settings.commission, mode: settings.commMode };
  }
  var specs = null;
  var previewSL = null, previewEntry = null;

  function num(v) { var n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? n : NaN; }
  function stepDigits(step) { var s = String(step); return s.indexOf(".") < 0 ? 0 : s.split(".")[1].length; }
  // V85: round-trip commission for 1 lot at `price`.
  function commissionPerLot(price) {
    var c = num(settings.commission), cs = specs ? Number(specs.contract_size) || 0 : 0;
    price = Number(price) || Number(App.livePrice) || 0;
    if (isFinite(c) && c >= 0) return settings.commMode === "pct" ? c / 100 * cs * price : c;
    var m = specs && specs.comm_model;
    if (!m) return 0;
    return m.mode === "pct" ? (m.in_pct + m.out_pct) * cs * price : (m.in_lot + m.out_lot);
  }
  function riskMoney() {
    if (!specs) return NaN;
    var r = Number(settings.risk) || 0;
    return settings.riskMode === "money" ? r : specs.balance * r / 100;
  }
  // Estimate only (UI preview); the sync process recomputes with MT5's own
  // order_calc_profit at the real fill price before sending.
  function calcLots(entry, sl) {
    if (!specs || !specs.ok || !(entry > 0) || !(sl > 0) || entry === sl) return null;
    var lossPerLot = Math.abs(entry - sl) / specs.tick_size * specs.tick_value_loss;
    var perLot = lossPerLot + commissionPerLot(entry);
    var rm = riskMoney();
    if (!(perLot > 0) || !(rm > 0)) return null;
    var step = specs.vol_step || 0.01;
    var lots = Math.floor(rm / perLot / step + 1e-9) * step;
    lots = Math.min(lots, specs.vol_max);
    lots = Number(lots.toFixed(stepDigits(step)));
    return { lots: lots, risk: lots * perLot, tooSmall: lots < specs.vol_min - 1e-9, minRisk: specs.vol_min * perLot };
  }
  function maxRiskLimit() {
    if (!specs) return 0;
    var m = Number(settings.maxRisk) || 0;
    return settings.maxMode === "money" ? m : specs.balance * m / 100;
  }
  function refreshSummary() {
    var lotEl = $("tp-calc-lot"), amtEl = $("tp-risk-amount"), hint = $("tp-lot-hint");
    var rm = riskMoney();
    var cur = specs && specs.currency ? " " + specs.currency : "";
    var c = previewSL != null ? calcLots(previewEntry, previewSL) : null;
    if (c) {
      lotEl.textContent = c.tooSmall ? "< min " + specs.vol_min : c.lots.toFixed(stepDigits(specs.vol_step));
      // V90: warn about free margin before the order is sent
      var mg = (Number(specs.margin_1lot) || 0) * c.lots, noMg = !c.tooSmall && mg > 0 && mg > (Number(specs.margin_free) || 0);
      if (noMg) lotEl.textContent += " · no margin";
      lotEl.title = mg > 0 ? "Margin " + mg.toFixed(2) + " / free " + (Number(specs.margin_free) || 0).toFixed(2) : "";
      lotEl.style.color = noMg ? "var(--down)" : "";
      amtEl.textContent = (c.tooSmall ? c.minRisk : c.risk).toFixed(2) + cur;
    } else {
      lotEl.textContent = "—"; lotEl.title = ""; lotEl.style.color = "";
      amtEl.textContent = isFinite(rm) ? rm.toFixed(2) + cur : "—";
    }
    if (hint && specs && specs.ok) {
      var ca = num(settings.commission);
      var m = specs.comm_model || {};
      var auto = isFinite(ca) ? "" : (m.n ? " (auto" + (m.mode === "pct" ? " %" : "") + (m.out_lot || m.out_pct ? (m.in_lot || m.in_pct ? ", both sides" : ", exit only") : ", entry only") + ")" : " (auto: no history)");
      hint.textContent = "Min " + specs.vol_min + " · step " + specs.vol_step + " · commission " +
        commissionPerLot().toFixed(2) + "/lot round trip" + auto;
    }
    // Max-risk gauge
    // V90: Open risk / Remaining in the Max-risk unit; Daily DD mode also counts today's realized loss.
    var lim = maxRiskLimit(), open = specs ? Number(specs.open_risk) || 0 : 0, dl = specs && settings.maxBasis === "day" ? Number(specs.day_loss) || 0 : 0;
    var used = open + dl, inPct = settings.maxMode !== "money", bal = specs ? Number(specs.balance) || 0 : 0;
    var fmt = function (v) { return inPct ? (bal > 0 ? v * 100 / bal : 0).toFixed(2) + "%" : "$" + v.toFixed(2); };
    $("tp-risk-limit").textContent = lim > 0 ? "Remaining " + fmt(Math.max(0, lim - used)) : "Off";
    $("tp-open-risk").textContent = specs ? "Open risk " + fmt(open) + (dl > 0 ? " · day loss " + fmt(dl) : "") + (specs.unbounded && specs.unbounded.length ? " + no-SL!" : "") : "Open risk —";
    var pct = lim > 0 ? Math.min(100, used * 100 / lim) : 0;
    var g = $("tp-gauge-fill");
    g.style.width = pct + "%";
    g.style.background = pct >= 100 || (specs && specs.unbounded && specs.unbounded.length) ? "var(--down)" : pct > 70 ? "var(--tp-accent)" : "var(--up)";
  }

  window.onTradeSpecs = function (d) {
    if (!d || !d.ok) return;
    if (App.symbol && d.symbol && d.symbol !== App.symbol) return; // stale (symbol switch)
    specs = d;
    lastFeedMsg = Date.now();
    refreshSummary();
    if (App.TradeLines && App.TradeLines.onSpecs) App.TradeLines.onSpecs(d);
  };

  // V99: notification stack (bottom-left). Newest toast enters at the bottom and
  // older ones slide up; identical consecutive messages merge into one with a
  // x2/x3 badge. The progress bar IS the timer, but it only starts running once
  // the user moves the mouse after the alert appeared (so alerts shown while the
  // user is away stay on screen until they are back). Hover also pauses it.
  // Duration and max count come from Setting > Configuration (App.AppConfig).
  var toastBox = null;
  var TOAST_ICONS = {
    ok: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.4l2.3 2.3 4.7-5"/></svg>',
    err: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 2.5v4.2M6 9.2v.1"/></svg>',
    info: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 5.4v3.6M6 2.9v.1"/></svg>'
  };
  var TOAST_CLOSE = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 2l6 6M8 2L2 8"/></svg>';

  function alertSettings() {
    return (App.AppConfig && App.AppConfig.getAlertSettings) ? App.AppConfig.getAlertSettings() : { seconds: 5, max: 12 };
  }

  // Real mouse movement (not a layout-triggered synthetic event: position must
  // actually change) arms every alert that is still waiting for the user.
  var lastMX = null, lastMY = null;
  document.addEventListener("mousemove", function (e) {
    var dx = lastMX === null ? 0 : e.clientX - lastMX;
    var dy = lastMY === null ? 0 : e.clientY - lastMY;
    lastMX = e.clientX; lastMY = e.clientY;
    if (!toastBox || Math.abs(dx) + Math.abs(dy) < 3) return;
    var waiting = toastBox.querySelectorAll(".tl-toast:not(.armed)");
    for (var i = 0; i < waiting.length; i++) waiting[i].classList.add("armed");
  }, true);

  function toastDismiss(wrap) {
    if (!wrap || wrap._leaving) return;
    wrap._leaving = true;
    wrap.classList.remove("in");
    wrap.classList.add("out");
    setTimeout(function () { if (wrap.parentNode) wrap.remove(); }, 260);
  }
  function toastRestartBar(el, ms) {
    var old = el.querySelector(".tl-toast-bar");
    if (old) old.remove();
    el.classList.remove("armed");   // waits for the next real mouse movement
    var bar = document.createElement("div");
    bar.className = "tl-toast-bar";
    bar.style.animationDuration = ms + "ms";
    bar.addEventListener("animationend", function () { toastDismiss(el.parentNode.parentNode); });
    el.appendChild(bar);
  }
  function toast(msg, kind) {
    var k = kind === "err" ? "err" : (kind === "info" ? "info" : "ok");
    if (!toastBox) { toastBox = document.createElement("div"); toastBox.id = "tl-toasts"; document.body.appendChild(toastBox); }
    var cfg = alertSettings();
    var ms = Math.round(cfg.seconds * 1000);
    var last = toastBox.lastElementChild;
    if (last && !last._leaving && last._msg === msg && last._kind === k) {
      last._count++;
      var badge = last.querySelector(".tl-toast-count");
      badge.textContent = "\u00d7" + last._count; badge.hidden = false;
      badge.classList.remove("bump"); void badge.offsetWidth; badge.classList.add("bump");
      toastRestartBar(last.querySelector(".tl-toast"), ms);
      return;
    }
    var wrap = document.createElement("div");
    wrap.className = "tl-toast-wrap";
    wrap._msg = msg; wrap._kind = k; wrap._count = 1;
    var clip = document.createElement("div"); clip.className = "tl-toast-clip";
    var el = document.createElement("div");
    el.className = "tl-toast " + k;
    el.setAttribute("role", k === "err" ? "alert" : "status");
    el.innerHTML = '<span class="tl-toast-icon">' + TOAST_ICONS[k] + '</span><span class="tl-toast-msg"></span>' +
      '<span class="tl-toast-count" hidden></span><button type="button" class="tl-toast-close" aria-label="Dismiss">' + TOAST_CLOSE + '</button>';
    el.querySelector(".tl-toast-msg").textContent = msg;
    el.querySelector(".tl-toast-close").addEventListener("click", function () { toastDismiss(wrap); });
    clip.appendChild(el); wrap.appendChild(clip);
    toastBox.appendChild(wrap);
    toastRestartBar(el, ms);
    requestAnimationFrame(function () { requestAnimationFrame(function () { wrap.classList.add("in"); }); });
    var live = [].filter.call(toastBox.children, function (c) { return !c._leaving; });
    while (live.length > cfg.max) toastDismiss(live.shift());
  }

  // Request tracking: every action gets an id; no answer in 10 s = warn.
  var pending = {}, reqSeq = 0;
  function send(apiName, params, label) {
    if (App.backendStatus === "offline") { toast("MT5 offline: " + label + " not sent", "err"); return null; }
    var a = api();
    if (!a || typeof a[apiName] !== "function") { toast("Backend not ready", "err"); return null; }
    var id = Date.now().toString(36) + (++reqSeq);
    params.req_id = id;
    pending[id] = { label: label, timer: setTimeout(function () {
      delete pending[id];
      toast(label + ": no answer from MT5 yet, check the terminal", "err");
      if (App.TradeLines) App.TradeLines.onResult({ req_id: id, ok: false, msg: "timeout", silent: true });
    }, 10000) };
    try {
      var pr = a[apiName](params);
      if (pr && pr.then) pr.then(function (r) { if (r && r.ok === false) failLocal(id, "Could not queue " + label); });
    } catch (e) { failLocal(id, "Could not queue " + label); }
    return id;
  }
  function failLocal(id, msg) {
    var p = pending[id]; if (!p) return;
    clearTimeout(p.timer); delete pending[id];
    toast(msg, "err");
    if (App.TradeLines) App.TradeLines.onResult({ req_id: id, ok: false, msg: msg, silent: true });
  }
  window.onTradeResult = function (r) {
    r = r || {};
    var p = pending[r.req_id];
    if (p) { clearTimeout(p.timer); delete pending[r.req_id]; }
    if (r.msg !== "No change") toast(r.msg || (r.ok ? "Done" : "Failed"), r.ok ? "" : "err");
    if (App.TradeLines && App.TradeLines.onResult) App.TradeLines.onResult(r);
  };

  function selectedTickets() { return Object.keys(selected).map(Number); }
  function doClose(tickets, fraction) {
    if (!tickets.length) { toast("Select a trade first", "info"); return; }
    send("trade_close", { tickets: tickets, fraction: fraction }, fraction >= 1 ? "Close" : "Partial close");
  }
  // V90: bulk actions only touch eligible trades (RF: past BE; partial: in profit).
  function bulkPick(test, what) {
    var all = selectedTickets();
    if (!all.length) { toast("Select a trade first", "info"); return null; }
    var ok = all.filter(function (t) { var r = rows["p" + t]; return r && r.p && test(r.p); });
    if (!ok.length) { toast("No selected trade " + what, "info"); return null; }
    if (ok.length < all.length) toast((all.length - ok.length) + " skipped (not " + what + ")", "info");
    return ok;
  }
  function pastBE(p) {
    var be = Number(p.be) || Number(p.price_open), pr = Number(p.price);
    return (Number(p.profit) || 0) > 0 && pr > 0 && (p.type === 0 ? pr > be : pr < be);
  }
  function inProfit(p) { return (Number(p.profit) || 0) > 0; }
  function doRiskFree(tickets) {
    if (!tickets.length) { toast("Select a trade first", "info"); return; }
    send("trade_riskfree", { tickets: tickets, comm: settings.comm || {} }, "Risk-free");
  }

  // ---- Trade tab: live positions (keyed DOM update, no full rebuild) -------
  var PT = { 2: "BUY LIMIT", 3: "SELL LIMIT", 4: "BUY STOP", 5: "SELL STOP" }; // V88
  function pkey(p) { return (p.kind === "pending" ? "o" : "p") + p.ticket; }
  function doCancel(tickets) { send("trade_cancel", { tickets: tickets }, "Cancel"); }
  // V88: pending row = side tag + "lot @ entry" + Cancel only.
  function buildPendingRow(p) {
    var el = document.createElement("div");
    el.className = "tp-item tp-pending";
    el.innerHTML =
      '<div class="tp-row1"><span><span class="tp-sym"></span><span class="tp-side"></span></span><span class="tp-pl tp-muted"></span></div>' +
      '<div class="tp-row2"><span class="tp-entry"></span></div>' +
      '<div class="tp-item-actions"><button type="button" class="close">Cancel</button></div>';
    el.querySelector("button").addEventListener("click", function () { doCancel([p.ticket]); });
    var k = pkey(p);
    el.addEventListener("mouseenter", function () { focusTicket(k, el); });
    return { el: el, pending: true, sym: el.querySelector(".tp-sym"), side: el.querySelector(".tp-side"),
      pl: el.querySelector(".tp-pl"), entry: el.querySelector(".tp-entry"), key: "" };
  }
  function updatePendingRow(r, p) {
    var key = [p.symbol, p.type, p.volume, p.price_open, p.sl, p.tp].join("|");
    if (key === r.key) return;
    r.key = key;
    var isBuy = p.type % 2 === 0;
    r.sym.textContent = p.symbol;
    r.side.textContent = PT[p.type] || "PENDING";
    r.side.className = "tp-side " + (isBuy ? "buy" : "sell");
    r.entry.textContent = lots(p.volume) + " lot @ " + px(p.price_open, p.digits);
    r.pl.textContent = "SL " + px(p.sl, p.digits);
  }

  function buildRow(p) {
    var el = document.createElement("div");
    el.className = "tp-item";
    el.innerHTML =
      '<div class="tp-row1"><span><input type="checkbox" class="tp-cb"><span class="tp-sym"></span><span class="tp-side"></span></span><span><span class="tp-fee-tag" hidden></span><span class="tp-pl"></span></span></div>' +
      '<div class="tp-row2"><span><span class="tp-entry"></span><span class="tp-be"></span></span></div>' +
      '<div class="tp-item-actions"><button type="button" class="rf">Risk-free</button><button type="button">Close 25%</button><button type="button">Close 50%</button><button type="button" class="close">Close</button></div>';
    var btns = el.querySelectorAll(".tp-item-actions button");
    btns[0].addEventListener("click", function () { doRiskFree([p.ticket]); });
    btns[1].addEventListener("click", function () { doClose([p.ticket], 0.25); });
    btns[2].addEventListener("click", function () { doClose([p.ticket], 0.5); });
    btns[3].addEventListener("click", function () { doClose([p.ticket], 1); });
    // V87: hover a trade = focus it in the list and on the chart
    el.addEventListener("mouseenter", function () { focusTicket(pkey(p), el); }); // V90: gaps keep focus
    var cb = el.querySelector(".tp-cb");
    cb.addEventListener("change", function () {
      if (cb.checked) selected[p.ticket] = true; else delete selected[p.ticket];
      syncSelectAll();
    });
    return { el: el, cb: cb, sym: el.querySelector(".tp-sym"), side: el.querySelector(".tp-side"),
      pl: el.querySelector(".tp-pl"), fee: el.querySelector(".tp-fee-tag"), be: el.querySelector(".tp-be"), entry: el.querySelector(".tp-entry"), key: "" };
  }

  var focusEl = null;
  function focusTicket(t, el) {
    if (t == null && focusEl !== el) return;
    if (focusEl) focusEl.classList.remove("tp-focused");
    focusEl = t == null ? null : el;
    if (focusEl) focusEl.classList.add("tp-focused");
    openList.classList.toggle("tp-focus", !!focusEl);
    if (App.TradeLines && App.TradeLines.focus) App.TradeLines.focus(t);
  }

  // V90: focus clears only when the mouse leaves the whole Open Positions box.
  openBox.addEventListener("mouseleave", function () { if (focusEl) focusTicket(null, focusEl); });
  var fadeF = -1;
  openList.addEventListener("scroll", function () {
    var f = Math.min(openList.scrollTop, 56);
    if (f !== fadeF) { fadeF = f; openList.style.setProperty("--f", f + "px"); }
  }, { passive: true });

  function updateRow(r, p) {
    r.p = p;
    var d = p.digits;
    var isBuy = p.type === 0;
    var key = [p.symbol, p.type, p.volume, p.price_open, p.sl, p.tp, p.fee, p.be].join("|");
    if (key !== r.key) {
      r.key = key;
      r.sym.textContent = p.symbol;
      r.side.textContent = isBuy ? "BUY" : "SELL";
      r.side.className = "tp-side " + (isBuy ? "buy" : "sell");
      r.entry.textContent = lots(p.volume) + " lot @ " + px(p.price_open, d);
      // V85: estimated commission tag + break-even price
      var fee = Number(p.fee) || 0;
      r.fee.hidden = !(fee > 0);
      r.fee.textContent = "fee $" + fee.toFixed(2);
      var be = Number(p.be) || 0;
      r.be.textContent = "BE " + px(be > 0 ? be : p.price_open, d); // V86: row = lot @ entry | BE
    }
    // V90: after a partial close, P/L = open part + already-banked part (whole trade)
    var rz = Number(p.realized) || 0, tot = (Number(p.profit) || 0) + rz, pl = money(tot);
    if (r.pl.textContent !== pl) {
      r.pl.textContent = pl;
      r.pl.className = "tp-pl " + (tot >= 0 ? "tp-pos" : "tp-neg");
      r.pl.title = rz ? "Open " + money(p.profit) + " · banked by partial close " + money(rz) : "";
    }
    r.cb.checked = !!selected[p.ticket];
  }

  // V88: pending orders pinned on top under their own group label.
  var grpPend = document.createElement("div"); grpPend.className = "tp-day-label"; grpPend.textContent = "PENDING";
  var grpLive = document.createElement("div"); grpLive.className = "tp-day-label"; grpLive.textContent = "OPEN";
  function renderPositions(list) {
    list = Array.isArray(list) ? list : [];
    var seen = {}, order = [], nPend = 0;
    list.forEach(function (p) { if (p.kind === "pending") nPend++; });
    if (nPend) order.push(grpPend);
    list.forEach(function (p, i) {
      if (nPend && i === nPend && nPend < list.length) order.push(grpLive);
      var k = pkey(p);
      seen[k] = true;
      var r = rows[k];
      if (!r) { r = rows[k] = p.kind === "pending" ? buildPendingRow(p) : buildRow(p); }
      r.ticket = p.ticket;
      if (r.pending) updatePendingRow(r, p); else updateRow(r, p);
      order.push(r.el);
    });
    if (!nPend) grpPend.remove();
    if (!nPend || nPend === list.length) grpLive.remove();
    order.forEach(function (el, i) { if (openList.children[i] !== el) openList.insertBefore(el, openList.children[i] || null); });
    Object.keys(rows).forEach(function (t) {
      if (!seen[t]) { if (focusEl === rows[t].el) focusTicket(null, focusEl); rows[t].el.remove(); delete selected[rows[t].ticket]; delete rows[t]; }
    });
    var net = 0, nLive = 0;
    list.forEach(function (p) { if (p.kind !== "pending") { nLive++; net += (Number(p.profit) || 0) + (Number(p.realized) || 0) + (Number(p.swap) || 0) - (Number(p.fee) || 0); } });
    var nt = nLive ? money(net) : "—";
    if (openNet.textContent !== nt) { openNet.textContent = nt; openNet.className = "num " + (nLive ? (net >= 0 ? "tp-pos" : "tp-neg") : ""); }
    openBox.classList.toggle("tp-none", !list.length);
    var empty = openList.querySelector(".tp-empty");
    if (!list.length && !empty) {
      empty = document.createElement("div"); empty.className = "tp-empty"; empty.textContent = "No open trades";
      openList.appendChild(empty);
    } else if (list.length && empty) empty.remove();
    syncSelectAll();
  }

  function syncSelectAll() {
    var total = Object.keys(rows).filter(function (t) { return !rows[t].pending; }).length;
    var sel = Object.keys(selected).length;
    selectAll.checked = total > 0 && sel === total;
    selectAll.indeterminate = sel > 0 && sel < total;
  }
  selectAll.addEventListener("change", function () {
    selected = {};
    Object.keys(rows).forEach(function (t) {
      if (rows[t].pending) return;
      if (selectAll.checked) selected[rows[t].ticket] = true;
      rows[t].cb.checked = selectAll.checked;
    });
  });

  window.onTradePositions = function (list) {
    lastFeedMsg = Date.now();
    if (App.TradeLines && App.TradeLines.onPositions) App.TradeLines.onPositions(list || []);
    if (isOpen) renderPositions(list);
  };
  $("tp-bulk-close").addEventListener("click", function () { doClose(selectedTickets(), 1); });
  $("tp-bulk-rf").addEventListener("click", function () { var t = bulkPick(pastBE, "past break-even"); if (t) doRiskFree(t); });
  $("tp-bulk-25").addEventListener("click", function () { var t = bulkPick(inProfit, "in profit"); if (t) doClose(t, 0.25); });
  $("tp-bulk-50").addEventListener("click", function () { var t = bulkPick(inProfit, "in profit"); if (t) doClose(t, 0.5); });

  // ---- History tab ---------------------------------------------------------
  // V83 fix: timestamps are broker server time, so format them with UTC
  // getters (no local-timezone shift) and compare days against broker "now".
  var brokerNow = 0;
  function dayLabel(ts) {
    var o = App.Tz ? App.Tz.offset() : 0;  // v92: system-time display
    ts += o;
    var day = Math.floor(ts / 86400), today = Math.floor((brokerNow ? brokerNow + o : ts) / 86400);
    if (day === today) return "TODAY";
    if (day === today - 1) return "YESTERDAY";
    return new Date(ts * 1000).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).toUpperCase();
  }
  function hhmm(ts) {
    var d = new Date((App.Tz ? App.Tz.toUser(ts) : ts) * 1000);
    return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  }

  // V83: render history in chunks (more on scroll) instead of thousands of
  // rows at once; stats are computed once per fetch.
  // V84: history P/L = net (profit + commission + swap + fee); the fee sits
  // in a small tag on its left. Open trades (Trade tab) stay gross, like MT5.
  function histNet(t) { return (Number(t.profit) || 0) + (Number(t.costs) || 0); }
  function histItemHtml(t, i) {
    var isBuy = t.type === 0, p = histNet(t), fee = -(Number(t.costs) || 0);
    var feeTag = fee ? '<span class="tp-fee-tag">fee ' + (fee > 0 ? "$" : "+$") + Math.abs(fee).toFixed(2) + "</span>" : "";
    return '<div class="tp-item ' + (p >= 0 ? "tp-h-win" : "tp-h-loss") + '" data-i="' + i + '" title="Gross: ' + money(t.profit) + '  ·  Fees: ' + money(t.costs) + '"><div class="tp-row1"><span><span class="tp-sym">' + esc(t.symbol) +
      '</span><span class="tp-side ' + (isBuy ? "buy" : "sell") + '">' + (isBuy ? "BUY" : "SELL") +
      '</span></span><span>' + feeTag + '<span class="tp-pl ' + (p >= 0 ? "tp-pos" : "tp-neg") + '">' + money(p) + "</span></span></div>" +
      '<div class="tp-row2"><span>' + lots(t.volume) + " lot · " + px(t.price_open, t.digits) + " → " + px(t.price_close, t.digits) +
      "</span><span>" + (t.time_open ? hhmm(t.time_open) + " → " : "") + hhmm(t.time_close) + "</span></div></div>";
  }
  var lastDay = "";
  function renderHistChunk() {
    if (!histData || histRendered >= histData.length) return;
    var end = Math.min(histData.length, histRendered + HIST_CHUNK), html = [];
    for (var i = histRendered; i < end; i++) {
      var t = histData[i], lbl = dayLabel(t.time_close);
      if (lbl !== lastDay) { html.push('<div class="tp-day-label">' + esc(lbl) + "</div>"); lastDay = lbl; }
      html.push(histItemHtml(t, i)); // V91: index -> histData[i]
    }
    histRendered = end;
    histList.insertAdjacentHTML("beforeend", html.join(""));
  }
  histList.addEventListener("scroll", function () {
    if (histList.scrollTop + histList.clientHeight > histList.scrollHeight - 300) renderHistChunk();
  }, { passive: true });

  // V91: hover a history card = draw that trade on every chart panel; click = jump
  // to its mid-time. Gaps/day labels keep the current one; only leaving the list clears.
  var histOn = null;
  function histTrade(el) { return el && histData ? histData[+el.getAttribute("data-i")] : null; }
  function histSet(el) {
    if (el === histOn) return;
    if (histOn) histOn.classList.remove("tp-h-on");
    histOn = el;
    var t = histTrade(el);
    if (el) el.classList.add("tp-h-on");
    if (App.TradeHover) { if (t) App.TradeHover.show(t, histNet(t)); else App.TradeHover.hide(); }
  }
  histList.addEventListener("mouseover", function (e) {
    var el = e.target.closest ? e.target.closest(".tp-item") : null;
    if (el && histList.contains(el)) histSet(el);
  });
  histList.addEventListener("mouseleave", function () { histSet(null); });
  histList.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest(".tp-item") : null, t = histTrade(el);
    if (t && App.TradeHover) App.TradeHover.jump(t);
  });

  // V90: minimal cumulative net P/L chart (one SVG path per fetch, hover = one point).
  var pnlBox = $("tp-pnl-box"), pnlSvg = $("tp-pnl-svg"), pnlTip = $("tp-pnl-tip"), pnlPts = [];
  var pnlDot = pnlSvg.querySelector("circle");
  function drawPnl(trades) {
    var n = trades.length, cum = 0, vals = [0], i;
    for (i = n - 1; i >= 0; i--) { cum += histNet(trades[i]); vals.push(cum); }
    pnlBox.classList.toggle("empty", !n);
    if (!n) { pnlPts = []; return; }
    var step = Math.max(1, Math.ceil(vals.length / 300)), sv = [];
    for (i = 0; i < vals.length; i += step) sv.push(vals[i]);
    if (sv[sv.length - 1] !== cum) sv.push(cum);
    var lo = Math.min(0, Math.min.apply(null, sv)), hi = Math.max(0, Math.max.apply(null, sv)); // V90: min range so small wins are visible
    var rg = Math.max(hi - lo || 1, 2);
    var W = 300, H = 90, P = 4, xs = sv.length > 1 ? W / (sv.length - 1) : 0;
    var y = function (v) { return P + (hi - v) / rg * (H - 2 * P); };
    pnlPts = sv.map(function (v, k) { return [k * xs, y(v), v]; });
    var d = pnlPts.map(function (p, k) { return (k ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join("");
    var z = y(0).toFixed(1);
    pnlSvg.querySelector(".l").setAttribute("d", d);
    pnlSvg.querySelector(".a").setAttribute("d", d + "L" + W + " " + z + "L0 " + z + "Z");
    var zl = pnlSvg.querySelector(".z"); zl.setAttribute("y1", z); zl.setAttribute("y2", z);
    pnlBox.classList.toggle("neg", cum < 0);
    pnlTip.textContent = money(cum); pnlDot.style.display = "none";
  }
  pnlSvg.addEventListener("mousemove", function (e) {
    if (!pnlPts.length) return;
    var r = pnlSvg.getBoundingClientRect(), k = Math.round((e.clientX - r.left) / r.width * (pnlPts.length - 1));
    var p = pnlPts[Math.max(0, Math.min(pnlPts.length - 1, k))];
    pnlDot.setAttribute("cx", p[0]); pnlDot.setAttribute("cy", p[1]); pnlDot.style.display = "block";
    pnlTip.textContent = money(p[2]);
  });
  pnlSvg.addEventListener("mouseleave", function () {
    pnlDot.style.display = "none";
    if (pnlPts.length) pnlTip.textContent = money(pnlPts[pnlPts.length - 1][2]);
  });

  window.onTradeHistory = function (data) {
    data = data || {};
    histSet(null); // V91: rows are rebuilt
    brokerNow = Number(data.broker_now) || 0;
    var trades = Array.isArray(data.trades) ? data.trades : [];
    trades.sort(function (a, b) { return b.time_close - a.time_close; });
    var net = 0, wins = 0, fees = 0;
    for (var i = 0; i < trades.length; i++) { var p = histNet(trades[i]); net += p; fees -= Number(trades[i].costs) || 0; if (p > 0) wins++; }
    $("tp-hist-fees").textContent = trades.length ? (fees >= 0 ? "$" : "+$") + Math.abs(fees).toFixed(2) : "—";
    var netEl = $("tp-hist-net");
    netEl.textContent = trades.length ? money(net) : "—";
    netEl.className = "num " + (trades.length ? (net >= 0 ? "tp-pos" : "tp-neg") : "");
    $("tp-hist-count").textContent = String(trades.length);
    $("tp-hist-win").textContent = trades.length ? Math.round(wins * 100 / trades.length) + "%" : "—";
    drawPnl(trades);
    histData = trades; histRendered = 0; lastDay = ""; histList.scrollTop = 0;
    if (!trades.length) {
      drawPnl([]);
      histList.innerHTML = '<div class="tp-empty">' + (data.error ? esc(data.error) : "No closed trades in this period") + "</div>";
      return;
    }
    histList.innerHTML = "";
    renderHistChunk();
  };

  function loadHistory() {
    if (!histData) histList.innerHTML = '<div class="tp-empty">Loading…</div>';
    call("request_trade_history", histPeriod);
  }

  $("tp-hist-filters").addEventListener("click", function (e) {
    var chip = e.target.closest(".tp-chip");
    if (!chip) return;
    this.querySelectorAll(".tp-chip").forEach(function (c) { c.classList.toggle("selected", c === chip); });
    histPeriod = chip.getAttribute("data-period") || "week";
    histData = null;
    loadHistory();
  });

  // ---- Tabs + small UI-only controls (risk logic comes later) -------------
  panel.querySelectorAll(".tp-tab").forEach(function (tab) {
    tab.addEventListener("click", function () { showTab(tab.getAttribute("data-tab")); });
  });
  function showTab(name) {
    activeTab = name;
    histSet(null); // V91
    panel.querySelectorAll(".tp-tab").forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === name); });
    $("tp-tab-trade").style.display = name === "trade" ? "" : "none";
    $("tp-tab-history").style.display = name === "history" ? "" : "none";
    if (name === "history") loadHistory();
  }
  // V84: live risk controls (saved locally, used by the fast market order).
  function bindUnit(id, key) {
    var g = $(id);
    g.querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x.getAttribute("data-u") === settings[key]); });
    g.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      settings[key] = b.getAttribute("data-u");
      g.querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x === b); });
      saveSettings(); refreshSummary();
    });
  }
  bindUnit("tp-risk-unit", "riskMode");
  bindUnit("tp-maxrisk-unit", "maxMode");
  bindUnit("tp-comm-unit", "commMode");
  $("tp-comm-unit").addEventListener("click", function () { storeComm(); saveSettings(); setFeed(); });
  // V85: show the saved commission of the current symbol (also after a symbol switch / disk load).
  function syncCommUI() {
    if (settings.commission !== "" && !Object.keys(settings.comm || {}).length) storeComm(); // V84 -> V85 migration
    loadComm();
    var el = $("tp-comm-input");
    if (el && document.activeElement !== el) el.value = settings.commission === "" ? "" : String(settings.commission);
    $("tp-comm-unit").querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x.getAttribute("data-u") === settings.commMode); });
    refreshSummary();
  }
  var lastSym = null;
  setInterval(function () { var s2 = curSym(); if (s2 && s2 !== lastSym) { lastSym = s2; syncCommUI(); } }, 1000);
  function loadDisk() {
    var a = api(); if (!a || !a.get_trade_settings) return;
    try {
      Promise.resolve(a.get_trade_settings()).then(function (d) {
        if (!d || typeof d !== "object" || !Object.keys(d).length) return;
        Object.assign(settings, d);
        ["tp-risk-input", "tp-maxrisk-input"].forEach(function (id, i) { var k = i ? "maxRisk" : "risk"; $(id).value = String(settings[k]); });
        [["tp-risk-unit", "riskMode"], ["tp-maxrisk-unit", "maxMode"]].forEach(function (u) {
          $(u[0]).querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x.getAttribute("data-u") === settings[u[1]]); });
        });
        syncBasis(); syncCommUI(); setFeed();
      });
    } catch (e) {}
  }
  if (api()) loadDisk(); else window.addEventListener("pywebviewready", loadDisk);
  function bindNum(id, key, allowEmpty) {
    var el = $(id);
    el.value = settings[key] === "" || settings[key] == null ? "" : String(settings[key]);
    el.addEventListener("input", function () {
      var v = el.value.trim();
      if (allowEmpty && v === "") settings[key] = "";
      else { var n = num(v); if (!isFinite(n) || n < 0) { el.style.color = "var(--down)"; return; } settings[key] = n; }
      el.style.color = "";
      if (key === "commission") { storeComm(); setFeed(); }
      saveSettings(); refreshSummary();
    });
    el.addEventListener("keydown", function (e) { e.stopPropagation(); }); // no chart shortcuts while typing
  }
  bindNum("tp-risk-input", "risk");
  bindNum("tp-comm-input", "commission", true);
  bindNum("tp-maxrisk-input", "maxRisk");
  // V90: Max-risk basis switch (open trades = default, Daily DD = + today's loss)
  var basisRow = $("tp-maxrisk-basis");
  function syncBasis() { basisRow.querySelectorAll(".tp-chip").forEach(function (x) { x.classList.toggle("selected", x.getAttribute("data-b") === (settings.maxBasis || "open")); }); }
  syncBasis();
  basisRow.addEventListener("click", function (e) {
    var c = e.target.closest(".tp-chip"); if (!c) return;
    settings.maxBasis = c.getAttribute("data-b"); syncBasis(); saveSettings(); refreshSummary();
  });
  var chipRow = $("tp-chip-row");
  chipRow.querySelectorAll(".tp-chip").forEach(function (x) { x.classList.toggle("selected", Number(x.getAttribute("data-rr")) === Number(settings.rr)); });
  chipRow.addEventListener("click", function (e) {
    var c = e.target.closest(".tp-chip"); if (!c) return;
    this.querySelectorAll(".tp-chip").forEach(function (x) { x.classList.toggle("selected", x === c); });
    settings.rr = Number(c.getAttribute("data-rr")) || 0;
    saveSettings();
  });

  // ---- Open / close --------------------------------------------------------
  function open() {
    isOpen = true;
    panel.classList.add("open");
    toggleBtn.classList.add("active");
    setFeed();
    showTab("trade"); // V87: always opens on the Trade tab
  }
  function close() {
    isOpen = false;
    panel.classList.remove("open");
    toggleBtn.classList.remove("active");
    if (focusEl) focusTicket(null, focusEl);
    histSet(null); // V91
    setFeed();
  }

  toggleBtn.innerHTML = App.Icons && App.Icons.trade ? App.Icons.trade() : "T";
  toggleBtn.addEventListener("click", function () { if (isOpen) close(); else open(); });
  renderPositions([]);

  // V84: the feed always runs in light "lines" mode (chart SL/TP lines);
  // full mode (live P/L) only while the panel is open. The watchdog re-arms
  // it if it goes quiet (sync process restarted on a symbol switch / MT5
  // reconnect lost the flag).
  function setFeed() {
    var a = api();
    if (a && typeof a.set_trade_feed === "function") { try { a.set_trade_feed(isOpen, true, settings.comm || {}); } catch (e) {} }
    lastFeedMsg = Date.now();
  }
  watchdog = setInterval(function () {
    if (Date.now() - lastFeedMsg > 8000) setFeed();
  }, 4000);
  if (api()) setFeed(); else window.addEventListener("pywebviewready", setFeed);
  document.addEventListener("App:symbolChanged", function () { specs = null; refreshSummary(); });
  refreshSummary();

  App.Trade = {
    settings: function () { return settings; },
    specs: function () { return specs; },
    calcLots: calcLots,
    commissionPerLot: commissionPerLot,
    maxRiskLimit: maxRiskLimit,
    setPreview: function (entry, sl) { previewEntry = entry; previewSL = sl; refreshSummary(); },
    send: send,
    toast: toast,
  };

  App.TradePanel = { open: open, close: close, toggle: function () { if (isOpen) close(); else open(); } };
})();
