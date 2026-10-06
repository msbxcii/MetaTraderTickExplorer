// =============================================================================
// replay-trading.js — v119: Replay Trading (practice trading inside Bar Replay).
// A small in-memory broker fed by the replay 1-second candle stream
// (App:replayCandle). BID = replay price, ASK = BID + fixed spread.
// It answers the same commands and pushes the same feeds (specs / positions /
// history) as the MT5 sync process, so trade-panel.js and trade-lines.js work
// unchanged. Session lives until Bar Replay is exited; settings are saved.
// Cost: only works when a position or order exists; UI pushes are throttled.
// =============================================================================
(function () {
  "use strict";

  var App = window.App || (window.App = {});
  var $ = function (id) { return document.getElementById(id); };
  var panel = $("trade-panel");
  if (!panel) return;
  function T() { return App.Trade; }

  var PT = { 2: "BUY LIMIT", 3: "SELL LIMIT", 4: "BUY STOP", 5: "SELL STOP" };
  var DAY = 86400;

  // ---- saved settings (inside the trade settings, so they reach disk) ------
  function cfg() {
    var st = T() ? T().settings() : {};
    if (!st.replay || typeof st.replay !== "object") st.replay = {};
    var r = st.replay;
    if (r.balance == null) r.balance = 10000;
    if (r.lev == null) r.lev = 50;          // "" = Auto
    if (r.comm == null) r.comm = "";        // "" = Auto
    if (r.commMode !== "pct") r.commMode = "lot"; // v120
    if (r.spread == null) r.spread = "";    // "" = Auto (points)
    if (!r.base) r.base = {};               // per-symbol cached broker specs
    return r;
  }

  // ---- state ---------------------------------------------------------------
  var live = null;            // latest live MT5 specs (base)
  var ready = false;          // a replay date is applied
  var bid = NaN, now = 0;     // replay BID + playhead (broker time)
  var balance = 0, seq = 0;
  var positions = [], orders = [], trades = [], closes = [];
  var traded = false;         // any trade in this session (balance edit = reset)
  var pushTimer = 0;

  function sym() { return String(App.symbol || (live && live.symbol) || ""); }
  function base() {
    var b = live && live.ok && live.symbol === sym() ? live : (cfg().base[sym()] || null);
    if (b) return b;
    var d = digitsOf(bid), ts = Math.pow(10, -d);
    return { digits: d, point: ts, tick_size: ts, tick_value_loss: ts * 100000, vol_min: 0.01, vol_max: 100, vol_step: 0.01, contract_size: 100000, currency: "USD", spread: 0, leverage: 0 };
  }
  function digitsOf(v) { var s = String(v); return s.indexOf(".") < 0 ? 2 : Math.min(8, s.split(".")[1].length); }
  function tsz() { return Number(base().tick_size) || 0.00001; }
  function tv() { return Number(base().tick_value_loss) || 1; }
  function dg() { return Number(base().digits) || 5; }
  function rnd(p) { var t = tsz(); return Number((Math.round(p / t) * t).toFixed(dg())); }
  function stepD(s) { var x = String(s); return x.indexOf(".") < 0 ? 0 : x.split(".")[1].length; }

  function spread() {
    var c = cfg(), b = base(), pt = Number(b.point) || tsz();
    var v = parseFloat(c.spread);
    if (isFinite(v) && v >= 0) return v * pt;
    return Number(b.spread) > 0 ? Number(b.spread) : 0;
  }
  function leverage() {
    var v = parseFloat(cfg().lev);
    if (isFinite(v) && v > 0) return v;
    return Number(base().leverage) > 0 ? Number(base().leverage) : 50;
  }
  // v120: commission unit ($/lot or % of position value) is selectable; Auto
  // (empty value) follows what the history / live setting used.
  function autoCommMode() {
    var u = ((T().settings().comm) || {})[sym()];
    if (u && u.v !== "" && u.v != null) return u.mode === "pct" ? "pct" : "lot";
    var m = base().comm_model;
    return m && m.n && m.mode === "pct" ? "pct" : "lot";
  }
  function commMode() {
    var c = cfg();
    return c.comm === "" ? autoCommMode() : (c.commMode === "pct" ? "pct" : "lot");
  }
  function commPerLot(price) {
    var c = parseFloat(cfg().comm), b = base(), cs = Number(b.contract_size) || 0; price = Number(price) || bid || 0;
    if (isFinite(c) && c >= 0) return cfg().commMode === "pct" ? c / 100 * cs * price : c;
    // Auto: the live Commission setting of this symbol, else learned from real deals
    var u = ((T().settings().comm) || {})[sym()];
    if (u && u.v !== "" && u.v != null) return u.mode === "pct" ? Number(u.v) / 100 * cs * price : Number(u.v);
    var m = b.comm_model;
    if (!m || !m.n) return 0;
    return m.mode === "pct" ? (m.in_pct + m.out_pct) * cs * price : (m.in_lot + m.out_lot);
  }
  function askP() { return bid + spread(); }
  function dir(p) { return p.type % 2 === 0 ? 1 : -1; }
  function exitPx(p) { return dir(p) > 0 ? bid : askP(); }
  function plOf(p, px, vol) { return dir(p) * (px - p.price_open) / tsz() * tv() * vol; }
  function marginOf(vol, px) { return vol * px * tv() / tsz() / leverage(); }

  // ---- account numbers ------------------------------------------------------
  function equity() { var e = balance; positions.forEach(function (p) { e += plOf(p, exitPx(p), p.volume); }); return e; }
  function marginUsed() { var m = 0; positions.forEach(function (p) { m += marginOf(p.volume, p.price_open); }); return m; }
  function openRisk() {
    var t = 0, ub = [];
    positions.forEach(function (p) { if (!p.sl) ub.push(p.ticket); else t += Math.max(0, -plOf(p, p.sl, p.volume)); });
    orders.forEach(function (o) { if (!o.sl) ub.push(o.ticket); else t += Math.abs(o.price_open - o.sl) / tsz() * tv() * o.volume; });
    return { v: Math.round(t * 100) / 100, ub: ub };
  }
  function dayStart(t) { return t - (t % DAY); }
  function dayLoss() {
    var ds = dayStart(now), n = 0;
    closes.forEach(function (c) { if (c.t >= ds) n += c.net; });
    return Math.max(0, -Math.round(n * 100) / 100);
  }
  function specs() {
    var b = base(), r = openRisk(), eq = equity();
    return Object.assign({}, b, {
      ok: true, replay: true, symbol: sym(), balance: balance, equity: eq,
      currency: b.currency || "USD", open_risk: r.v, unbounded: r.ub, day_loss: dayLoss(),
      margin_free: eq - marginUsed(), margin_1lot: isFinite(bid) ? marginOf(1, askP()) : 0,
      stops_level: 0, connected: true, trade_allowed: true,
    });
  }

  // ---- feeds to the panel / chart lines (throttled) -------------------------
  function beOf(p) {
    var fee = p.cpl * p.volume, cost = fee - p.realized, ppt = tv() * p.volume;
    if ((p.realized === 0 && cost <= 1e-6) || !(ppt > 0)) return p.price_open;
    return rnd(p.price_open + dir(p) * Math.ceil(cost / ppt - 1e-9) * tsz());
  }
  function list() {
    var d = dg(), out = [];
    orders.slice().sort(function (a, b) { return b.ticket - a.ticket; }).forEach(function (o) {
      out.push({ kind: "pending", ticket: o.ticket, symbol: o.symbol, type: o.type, volume: o.volume, price_open: o.price_open, sl: o.sl, tp: o.tp, r0: o.sl ? Math.abs(o.price_open - o.sl) : 0, digits: d });
    });
    positions.slice().sort(function (a, b) { return b.ticket - a.ticket; }).forEach(function (p) {
      var px = exitPx(p);
      out.push({ ticket: p.ticket, symbol: p.symbol, type: p.type, volume: p.volume, price_open: p.price_open, sl: p.sl, tp: p.tp,
        profit: Math.round(plOf(p, px, p.volume) * 100) / 100, swap: 0, price: px, fee: Math.round(p.cpl * p.volume * 100) / 100,
        be: beOf(p), realized: Math.round(p.realized * 100) / 100, r0: p.r0, digits: d });
    });
    return out;
  }
  // v120: replay ASK line (same style as live) follows BID + spread.
  function askLine() { if (App.ChartCore && App.ChartCore.scheduleAsk) App.ChartCore.scheduleAsk(); }
  function pushNow() {
    pushTimer = 0;
    if (!App.replayActive || !T()) return;
    askLine();
    T().feed.specs(specs());
    T().feed.positions(list());
    acctUI();
    if (App.TradeLines && App.TradeLines.onPrice) App.TradeLines.onPrice();
  }
  function push(now_) { if (now_) { clearTimeout(pushTimer); pushNow(); } else if (!pushTimer) pushTimer = setTimeout(pushNow, 200); }
  function money(v) { return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function acctUI() {
    var b = $("tp-rp-bal"), e = $("tp-rp-eq");
    if (b) b.textContent = money(balance);
    if (e) { var q = equity(); e.textContent = money(q); e.className = "num " + (q > balance + 0.005 ? "tp-pos" : q < balance - 0.005 ? "tp-neg" : ""); }
  }
  function note(msg, kind) { if (T()) T().toast(msg, kind || "info"); }

  // ---- order lifecycle ------------------------------------------------------
  function riskMoney(cmd) { var v = Math.max(0, Number(cmd.risk) || 0); return cmd.risk_mode === "money" ? v : balance * v / 100; }
  function sizeLots(entry, sl, cmd) {
    var b = base(), per = Math.abs(entry - sl) / tsz() * tv() + commPerLot(entry), rm = riskMoney(cmd), step = Number(b.vol_step) || 0.01;
    if (!(rm > 0)) return { err: "Risk must be greater than 0" };
    var lots = Math.min(Math.floor(rm / per / step + 1e-9) * step, Number(b.vol_max) || 100);
    lots = Number(lots.toFixed(stepD(step)));
    if (lots < (Number(b.vol_min) || 0.01) - 1e-9) return { err: "Risk too small: min lot " + b.vol_min + " would risk " + ((Number(b.vol_min) || 0.01) * per).toFixed(2) };
    return { lots: lots, risk: lots * per };
  }
  function maxRiskErr(cmd, add) {
    var mv = Number(cmd.max_risk) || 0;
    if (!(mv > 0)) return null;
    var lim = cmd.max_risk_mode === "money" ? mv : balance * mv / 100, r = openRisk();
    if (r.ub.length) return "Max risk: #" + r.ub[0] + " has no stop loss";
    var dl = cmd.max_risk_basis === "day" ? dayLoss() : 0;
    if (r.v + dl + add > lim + 1e-6) return "Limit reached: open " + r.v.toFixed(2) + " + day loss " + dl.toFixed(2) + " + new " + add.toFixed(2) + " > limit " + lim.toFixed(2);
    return null;
  }
  function marginErr(lots, px) {
    var need = marginOf(lots, px), free = equity() - marginUsed();
    return need > free ? "Not enough free margin: " + lots + " lot needs " + need.toFixed(2) + ", free " + free.toFixed(2) : null;
  }
  function fmtL(v) { return v.toFixed(stepD(base().vol_step || 0.01)); }
  function addPosition(type, lots, entry, sl, tp) {
    var cpl = commPerLot(entry);
    var p = { ticket: ++seq, symbol: sym(), type: type, volume: lots, price_open: entry, sl: sl, tp: tp, time_open: now,
      cpl: cpl, realized: 0, r0: sl ? Math.abs(entry - sl) : 0, outVol: 0, outPV: 0, outProfit: 0, outCosts: 0 };
    balance -= cpl * lots / 2;                     // entry half of the round trip
    positions.push(p); traded = true;
    return p;
  }
  function closePart(p, px, vol, why) {
    var pr = plOf(p, px, vol), cost = p.cpl * vol;   // entry half (already paid) + exit half
    balance += pr - cost / 2;
    p.volume = Number((p.volume - vol).toFixed(8));
    p.outVol += vol; p.outPV += px * vol; p.outProfit += pr; p.outCosts -= cost; p.realized += pr - cost;
    closes.push({ t: now, net: pr - cost });
    if (p.volume <= 1e-9) {
      positions.splice(positions.indexOf(p), 1);
      trades.push({ position_id: p.ticket, symbol: p.symbol, type: p.type, volume: Number(p.outVol.toFixed(8)), price_open: p.price_open,
        price_close: Number((p.outPV / p.outVol).toFixed(dg())), profit: Math.round(p.outProfit * 100) / 100, costs: Math.round(p.outCosts * 100) / 100,
        time_open: p.time_open, time_close: now, digits: dg() });
      if (why) note(why + " #" + p.ticket + " " + money(Math.round((p.outProfit + p.outCosts) * 100) / 100), p.outProfit + p.outCosts >= 0 ? "ok" : "err");
      if (T()) T().refreshHistory();
    }
    traded = true;
  }

  function openMarket(cmd) {
    var sl = rnd(Number(cmd.sl) || 0), a = askP(), type, entry;
    if (!(sl > 0)) return err("Invalid stop loss");
    if (sl < bid) { type = 0; entry = a; } else if (sl > a) { type = 1; entry = bid; } else return err("Stop loss is inside the spread");
    var z = sizeLots(entry, sl, cmd); if (z.err) return err(z.err);
    var m = maxRiskErr(cmd, z.risk) || marginErr(z.lots, entry); if (m) return err(m);
    var rr = Math.max(0, Number(cmd.tp_rr) || 0), tp = rr > 0 ? rnd(entry + (entry - sl) * rr) : 0;
    addPosition(type, z.lots, entry, sl, tp);
    push(true);
    return { ok: true, msg: (type ? "SELL " : "BUY ") + fmtL(z.lots) + " lot @ " + entry.toFixed(dg()), lots: z.lots, risk: Math.round(z.risk * 100) / 100 };
  }
  function pendType(isBuy, entry) { return isBuy ? (entry < askP() ? 2 : 4) : (entry > bid ? 3 : 5); }
  function pendingErr(type, entry, sl, tp) {
    var isBuy = type % 2 === 0;
    if (isBuy ? sl >= entry : sl <= entry) return "SL on the wrong side of entry";
    if (tp && (isBuy ? tp <= entry : tp >= entry)) return "TP on the wrong side of entry";
    return null;
  }
  function openPending(cmd) {
    var entry = rnd(Number(cmd.entry) || 0), sl = rnd(Number(cmd.sl) || 0);
    if (!(entry > 0) || !(sl > 0) || entry === sl) return err("Invalid entry / stop loss");
    var isBuy = sl < entry, type = pendType(isBuy, entry), rr = Math.max(0, Number(cmd.tp_rr) || 0);
    var tp = rr > 0 ? rnd(entry + (entry - sl) * rr) : 0, bad = pendingErr(type, entry, sl, tp); if (bad) return err(bad);
    var z = sizeLots(entry, sl, cmd); if (z.err) return err(z.err);
    var m = maxRiskErr(cmd, z.risk); if (m) return err(m);
    orders.push({ ticket: ++seq, symbol: sym(), type: type, volume: z.lots, price_open: entry, sl: sl, tp: tp });
    traded = true; push(true);
    return { ok: true, msg: PT[type] + " " + fmtL(z.lots) + " lot @ " + entry.toFixed(dg()), lots: z.lots, risk: Math.round(z.risk * 100) / 100 };
  }
  function findPos(t) { t = Number(t); for (var i = 0; i < positions.length; i++) if (positions[i].ticket === t) return positions[i]; return null; }
  function findOrd(t) { t = Number(t); for (var i = 0; i < orders.length; i++) if (orders[i].ticket === t) return orders[i]; return null; }
  function modify(cmd) {
    if (cmd.pending) {
      var o = findOrd(cmd.ticket); if (!o) return err("Order no longer pending");
      var en = cmd.price == null ? o.price_open : rnd(+cmd.price), sl = cmd.sl == null ? o.sl : rnd(+cmd.sl), tp = cmd.tp == null ? o.tp : rnd(+cmd.tp);
      var type = pendType(o.type % 2 === 0, en), bad = pendingErr(type, en, sl, tp); if (bad) return err(bad);
      var lots = o.volume;
      if (cmd.resize) { var z = sizeLots(en, sl, cmd); if (z.err) return err("Risk too small for this SL"); lots = z.lots; }
      o.type = type; o.price_open = en; o.sl = sl; o.tp = tp; o.volume = lots;
      push(true);
      return { ok: true, msg: PT[type] + " " + fmtL(lots) + " lot @ " + en.toFixed(dg()) };
    }
    var p = findPos(cmd.ticket); if (!p) return err("Position is closed");
    var s2 = cmd.sl == null ? p.sl : rnd(+cmd.sl), t2 = cmd.tp == null ? p.tp : rnd(+cmd.tp), cur = exitPx(p), up = dir(p) > 0;
    if (s2 && (up ? s2 >= cur : s2 <= cur)) return err("SL on wrong side of price");
    if (t2 && (up ? t2 <= cur : t2 >= cur)) return err("TP on wrong side of price");
    if (s2 === p.sl && t2 === p.tp) return { ok: true, msg: "No change" };
    p.sl = s2; p.tp = t2; push(true);
    return { ok: true, msg: "#" + p.ticket + " SL " + s2.toFixed(dg()) + " / TP " + t2.toFixed(dg()) };
  }
  function close(cmd) {
    var f = Math.min(1, Math.max(0, Number(cmd.fraction) || 1)), b = base(), step = Number(b.vol_step) || 0.01, vmin = Number(b.vol_min) || 0.01, bad = [];
    (cmd.tickets || []).forEach(function (t) {
      var p = findPos(t); if (!p) return;
      var v = p.volume;
      if (f < 1) {
        v = Number((Math.floor(p.volume * f / step + 1e-9) * step).toFixed(stepD(step)));
        if (v < vmin - 1e-9) { bad.push("#" + p.ticket + " too small for partial close"); return; }
        if (p.volume - v < vmin - 1e-9) v = p.volume;
      }
      closePart(p, exitPx(p), v, "");
    });
    push(true);
    return bad.length ? err(bad.join("; ")) : { ok: true, msg: f >= 1 ? "Closed" : "Partially closed " + Math.round(f * 100) + "%" };
  }
  function riskFree(cmd) {
    var bad = [];
    (cmd.tickets || []).forEach(function (t) {
      var p = findPos(t); if (!p) return;
      var r = modify({ ticket: p.ticket, sl: beOf(p) });
      if (!r.ok) bad.push("#" + p.ticket + ": " + r.msg);
    });
    return bad.length ? err(bad.join("; ")) : { ok: true, msg: "Risk-free set" };
  }
  function cancel(cmd) {
    var n = 0;
    (cmd.tickets || []).forEach(function (t) { var o = findOrd(t); if (o) { orders.splice(orders.indexOf(o), 1); n++; } });
    push(true);
    return { ok: true, msg: "Cancelled " + n + " order" + (n === 1 ? "" : "s") };
  }
  function err(m) { return { ok: false, msg: m }; }

  function handle(kind, cmd) {
    if (!ready || !isFinite(bid)) return err("Select a replay date first");
    try {
      if (kind === "trade_open") return openMarket(cmd);
      if (kind === "trade_pending") return openPending(cmd);
      if (kind === "trade_modify") return modify(cmd);
      if (kind === "trade_close") return close(cmd);
      if (kind === "trade_riskfree") return riskFree(cmd);
      if (kind === "trade_cancel") return cancel(cmd);
    } catch (e) { return err("Replay trade error: " + e); }
    return err("Unknown trade command");
  }

  // ---- price engine: walk each 1s candle O -> L/H -> C ----------------------
  // BID path; ASK-side levels are compared as level - spread. A level already
  // passed at the segment start (gap) fills at that start price.
  function hit(a, b, lvl, up) {
    if (up) { if (a >= lvl) return a; if (b >= lvl) return lvl; }
    else { if (a <= lvl) return a; if (b <= lvl) return lvl; }
    return null;
  }
  function segment(a, b) {
    var S = spread(), i, x;
    for (i = orders.length - 1; i >= 0; i--) {
      var o = orders[i], askSide = o.type === 2 || o.type === 4, up = o.type === 4 || o.type === 3;
      x = hit(a, b, askSide ? o.price_open - S : o.price_open, up);
      if (x === null) continue;
      var fill = rnd(askSide ? x + S : x);
      if (marginErr(o.volume, fill)) { orders.splice(i, 1); note("#" + o.ticket + " cancelled: not enough margin", "err"); continue; }
      orders.splice(i, 1);
      var p = addPosition(o.type % 2 === 0 ? 0 : 1, o.volume, fill, o.sl, o.tp);
      p.ticket = o.ticket; p.fresh = true; seq = Math.max(seq, o.ticket);
      note(PT[o.type] + " filled #" + o.ticket + " @ " + fill.toFixed(dg()));
    }
    for (i = positions.length - 1; i >= 0; i--) {
      var q = positions[i], buy = q.type === 0, off = buy ? 0 : S, s = null, t = null;
      if (q.fresh) { q.fresh = false; continue; }   // filled inside this segment: checked from the next one
      if (q.sl) s = hit(a, b, q.sl - off, !buy);
      if (q.tp) t = hit(a, b, q.tp - off, buy);
      if (s === null && t === null) continue;
      var isSL = s !== null && (t === null || Math.abs(s - a) <= Math.abs(t - a));
      var px = (isSL ? s : t) + off;
      closePart(q, rnd(px), q.volume, isSL ? "SL hit" : "TP hit");
    }
  }
  function stopOut() {
    if (!positions.length) return;
    var m = marginUsed(), e = equity();
    if (e <= 0 || (m > 0 && e / m < 0.5)) {
      positions.slice().forEach(function (p) { closePart(p, exitPx(p), p.volume, ""); });
      note("Stop out: margin level below 50%, all trades closed", "err");
    }
  }
  function onCandle(c) {
    if (!App.replayActive || !c) return;
    var o = +c.open, h = +c.high, l = +c.low, cl = +c.close;
    now = Number(c.time) || now;
    if (orders.length || positions.length) {
      var path = cl >= o ? [o, l, h, cl] : [o, h, l, cl];
      if (isFinite(bid) && bid !== o) segment(o, o);       // gap from the previous close
      for (var i = 0; i < 3 && (orders.length || positions.length); i++) segment(path[i], path[i + 1]);
      bid = cl;
      stopOut();
      push(false);
    } else bid = cl;
    askLine();
  }

  // ---- history (same periods as live, relative to the replay playhead) -----
  function history(period) {
    var ds = dayStart(now), d = new Date(now * 1000), cut;
    if (period === "today") cut = ds;
    else if (period === "month") cut = ds - (d.getUTCDate() - 1) * DAY;
    else cut = ds - ((d.getUTCDay() + 1) % 7) * DAY;   // since Saturday
    var out = trades.filter(function (t) { return t.time_close >= cut; }).map(function (t) { return Object.assign({ broker_now: now }, t); });
    return { trades: out, broker_now: now };
  }

  // ---- session / mode -------------------------------------------------------
  function resetSession() {
    positions = []; orders = []; trades = []; closes = []; traded = false; seq = 0;
    balance = Math.max(0, Number(cfg().balance) || 0);
  }
  // v120: in Replay the Risk and Take-profit-lock rows live inside the account box.
  function placeRows(on) {
    var slot = $("tp-rp-slot"), risk = $("tp-row-risk"), tp = $("tp-row-tp"), comm = $("tp-live-comm"), calc = $("tp-calc-box");
    if (!slot || !risk || !tp || !comm || !calc) return;
    if (on && risk.parentNode !== slot) { slot.appendChild(risk); slot.appendChild(tp); }
    else if (!on && risk.parentNode === slot) { comm.parentNode.insertBefore(risk, comm); calc.parentNode.insertBefore(tp, calc); /* v121: TP lock above Calculated lot */ }
  }
  function setMode(on) {
    placeRows(on);
    panel.classList.toggle("tp-replay", on);
    var tab = panel.querySelector('.tp-tab[data-tab="trade"]');
    if (tab) tab.textContent = on ? "Replay Trade" : "Trade";
  }
  function fillUI() {
    var c = cfg();
    var set = function (id, v) { var el = $(id); if (el && document.activeElement !== el) el.value = v === "" || v == null ? "" : String(v); };
    set("tp-rp-balance", c.balance); set("tp-rp-lev", c.lev); set("tp-rp-comm", c.comm); set("tp-rp-spread", c.spread);
    commUnitUI();
    acctUI();
  }
  function commUnitUI() {
    var g = $("tp-rp-comm-unit"); if (!g) return;
    var m = commMode(), auto = cfg().comm === "";
    g.classList.toggle("tp-auto", auto);
    g.querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x.getAttribute("data-u") === m); });
  }
  function summary() {
    if (!trades.length) return;
    var n = 0; trades.forEach(function (t) { n += t.profit + t.costs; });
    note("Replay session ended: " + trades.length + " trade" + (trades.length === 1 ? "" : "s") + ", net " + money(Math.round(n * 100) / 100), n >= 0 ? "ok" : "err");
  }

  document.addEventListener("App:replayStarted", function (e) {
    var d = e.detail || {}, tf = Number(d.tf) || 1;
    if (ready && (positions.length || orders.length)) {
      positions.slice().forEach(function (p) { closePart(p, exitPx(p), p.volume, ""); });
      orders = [];
      note("Replay date changed: open trades closed", "info");
    }
    now = Number(d.at) || (Number(d.ts) || 0) + tf - 1; // v120: exact second
    var arr = App.candlesByTf && App.candlesByTf[tf];
    bid = isFinite(Number(d.price)) ? Number(d.price) : arr && arr.length ? Number(arr[arr.length - 1].close) : Number(App.livePrice);
    if (!ready && !traded) balance = Math.max(0, Number(cfg().balance) || 0);
    ready = true; saveSpread();
    setMode(true); fillUI(); push(true);
    if (T()) T().refreshHistory();
    askLine();
  });
  document.addEventListener("App:replayCandle", function (e) { onCandle(e.detail); });
  document.addEventListener("App:replayExited", function () {
    summary();
    ready = false; bid = NaN; resetSession();
    setMode(false);
    if (T()) T().reset();
  });
  document.addEventListener("App:symbolChanged", function () {
    if (!App.replayActive || !positions.length && !orders.length) return;
    positions.slice().forEach(function (p) { closePart(p, exitPx(p), p.volume, ""); }); orders = [];
    note("Symbol changed: replay trades closed", "info"); push(true);
  });

  // Replay mode entered (waiting for a date): switch the panel right away.
  var rbt = $("replay-bar-toggle") || (App.dom && App.dom.replayBarToggle);
  if (rbt) rbt.addEventListener("click", function () {
    setTimeout(function () {
      if (!App.replayActive || ready) return;
      resetSession(); setMode(true); fillUI();
      if (T()) { T().feed.positions([]); T().feed.specs(specs()); }
    }, 0);
  });

  // ---- settings inputs ------------------------------------------------------
  function bind(id, key, allowEmpty) {
    var el = $(id); if (!el) return;
    el.addEventListener("keydown", function (e) { e.stopPropagation(); });
    el.addEventListener("input", function () {
      var v = el.value.trim(), c = cfg();
      if (allowEmpty && v === "") c[key] = "";
      else { var n = parseFloat(v.replace(",", ".")); if (!isFinite(n) || n < 0) { el.style.color = "var(--down)"; return; } c[key] = n; }
      el.style.color = "";
      if (key === "balance" && !traded && App.replayActive) balance = Number(c.balance) || 0;
      T().save();
      if (App.replayActive) push(true);
    });
  }
  bind("tp-rp-balance", "balance", false);
  bind("tp-rp-lev", "lev", true);
  bind("tp-rp-comm", "comm", true);
  bind("tp-rp-spread", "spread", true);
  var cu = $("tp-rp-comm-unit");
  if (cu) cu.addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    cfg().commMode = b.getAttribute("data-u") === "pct" ? "pct" : "lot";
    commUnitUI(); T().save();
    if (App.replayActive) push(true);
  });
  document.getElementById("tp-rp-comm") && $("tp-rp-comm").addEventListener("input", commUnitUI);
  var rb = $("tp-rp-reset");
  if (rb) rb.addEventListener("click", function () {
    resetSession(); push(true);
    if (T()) T().refreshHistory();
    note("Practice account reset to " + money(balance));
  });

  // live specs: keep the newest + a small per-symbol copy (offline replay)
  var lastBaseKey = "";
  function setBase(d) {
    if (!d || !d.ok || d.replay) return;
    live = d;
    if (!d.symbol) return;
    var b = { digits: d.digits, point: d.point, tick_size: d.tick_size, tick_value_loss: d.tick_value_loss, vol_min: d.vol_min, vol_max: d.vol_max,
      vol_step: d.vol_step, contract_size: d.contract_size, currency: d.currency, leverage: d.leverage, comm_model: d.comm_model };
    var k = d.symbol + JSON.stringify(b);
    if (k === lastBaseKey) return;
    lastBaseKey = k;
    b.spread = d.spread;
    cfg().base[d.symbol] = b; T().save();   // spread alone is re-saved only when a replay starts
  }
  function saveSpread() {
    var s0 = sym(), b = cfg().base[s0];
    if (live && live.ok && live.symbol === s0 && b && live.spread > 0 && b.spread !== live.spread) { b.spread = live.spread; T().save(); }
  }

  function hint() {
    var b = base(), pt = Number(b.point) || tsz();
    var auto = function (k) { return cfg()[k] === "" ? " (auto)" : ""; };
    return "Replay · min " + b.vol_min + " · step " + b.vol_step + " · commission " + commPerLot().toFixed(2) + "/lot" + (commMode() === "pct" ? " (%)" : "") + auto("comm") +
      " · spread " + Math.round(spread() / pt) + " pts" + auto("spread") + " · 1:" + leverage() + auto("lev");
  }

  // v120: last replay playhead (broker time), saved with the trade settings (disk).
  function saveLast(ts, now) { cfg().last = Number(ts) || 0; if (T()) { if (now && T().saveNow) T().saveNow(); else T().save(); } } // v126: now = immediate
  function getLast() { var v = Number(cfg().last); return isFinite(v) && v > 0 ? v : null; }

  App.ReplayTrade = {
    saveLast: saveLast,
    getLast: getLast,
    ready: function () { return App.replayActive && ready && isFinite(bid); },
    bid: function () { return bid; },
    ask: function () { return askP(); },
    commPerLot: commPerLot,
    handle: handle,
    history: history,
    setBase: setBase,
    refresh: function () { if (App.replayActive) { setMode(true); fillUI(); push(true); } },
    hint: hint,
  };
  resetSession();
})();
