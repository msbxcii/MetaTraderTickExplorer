# -*- coding: utf-8 -*-
"""V84: trade execution + position sizing (runs inside the sync process,
the only MT5 owner, so every MT5 call stays strictly sequential).

Lot sizing follows the open-source Position Sizer (EarnForex) formula:
    lots = RiskMoney / (loss_per_lot + 2 * commission_per_lot)
rounded DOWN to SYMBOL_VOLUME_STEP and checked against VOLUME_MIN/MAX, so the
loss at the SL never exceeds the chosen risk. loss_per_lot comes from
mt5.order_calc_profit() (exact for every calc mode / currency conversion),
with a tick-value fallback.

Safety rules:
  * a command older than STALE_SECONDS is refused (a queued click must never
    fire late after a freeze / reconnect / symbol switch),
  * terminal + account "connected / trading allowed" are checked first,
  * every order carries a unique comment; after an unknown outcome (timeout,
    None result, lost connection) positions are searched for that comment
    before anything is retried, so a trade is never duplicated,
  * only requote / price-changed / off-quotes are retried (fresh price).
"""
import math
import time

# Tag written into every order comment (visible in the MT5/broker history).
# MT5 limits comments to 31 chars: 16 for the tag + space + ~10-char req_id.
ORDER_TAG = "mt-tick.explorer"

STALE_SECONDS = 5.0
MAGIC = 840084
DEVIATION_POINTS = 30
_RETRY_CODES = (10004, 10020, 10021)       # requote, price changed, off quotes
_OK_CODES = (10008, 10009, 10010)          # placed, done, done partially
_UNKNOWN_CODES = (10012, 10031)            # timeout, no connection

_COMMISSION_CACHE = {}                     # symbol -> (monotonic_ts, per_lot_side)


def _floor_step(v, step):
    if step <= 0:
        return v
    return math.floor(v / step + 1e-9) * step


def _round_tick(price, tick, digits):
    if tick > 0:
        price = round(price / tick) * tick
    return round(price, digits)


def _step_digits(step):
    s = ("%.8f" % step).rstrip("0")
    return len(s.split(".")[1]) if "." in s else 0


def _err(msg, **kw):
    d = {"ok": False, "msg": msg}
    d.update(kw)
    return d


def _retcode_text(mt5, res):
    if res is None:
        try:
            return "MT5 returned no result (%s)" % (mt5.last_error(),)
        except Exception:
            return "MT5 returned no result"
    return "%s (%s)" % (getattr(res, "comment", "") or "rejected", res.retcode)


def _filling(mt5, info):
    fm = int(getattr(info, "filling_mode", 0) or 0)
    if fm & 1:
        return mt5.ORDER_FILLING_FOK
    if fm & 2:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN


def _notional(info, volume, price):
    return float(volume) * float(getattr(info, "trade_contract_size", 0.0) or 0.0) * float(price)


def learn_commission(mt5, symbol):
    """V85: broker commission model learned from recent CLOSED positions.
    Measures entry and exit sides SEPARATELY, both per lot and as a fraction
    of trade value, so entry-only / exit-only / both-sides brokers and
    fixed-per-lot / percent-of-value brokers are all handled.
    Returns {"n", "mode" ('lot'|'pct'), "in_lot", "out_lot", "in_pct", "out_pct"}
    (pct = fraction, e.g. 0.0005). n = 0 when nothing learned. Cached 60 s."""
    now = time.monotonic()
    c = _COMMISSION_CACHE.get(symbol)
    if c and now - c[0] < 60:
        return c[1]
    res = {"n": 0, "mode": "lot", "in_lot": 0.0, "out_lot": 0.0, "in_pct": 0.0, "out_pct": 0.0}
    try:
        from datetime import datetime, timedelta, timezone
        info = mt5.symbol_info(symbol)
        t = datetime.now(timezone.utc)
        deals = mt5.history_deals_get(t - timedelta(days=60), t + timedelta(days=2), group=symbol) or ()
        by = {}
        for d in deals:
            if int(d.type) not in (0, 1) or not d.position_id:
                continue
            g = by.setdefault(int(d.position_id), {"c": [0.0, 0.0], "v": [0.0, 0.0], "n": [0.0, 0.0], "t": 0})
            k = 0 if int(d.entry) == 0 else 1
            g["c"][k] += abs(float(d.commission) + float(getattr(d, "fee", 0.0)))
            g["v"][k] += float(d.volume)
            g["n"][k] += _notional(info, d.volume, d.price) if info is not None else 0.0
            g["t"] = max(g["t"], int(d.time_msc))
        done = [g for g in by.values() if g["v"][0] > 0 and g["v"][1] > 0]
        done.sort(key=lambda g: g["t"], reverse=True)
        done = done[:10]
        if done:
            def rates(k, base):
                return [g["c"][k] / g[base][k] for g in done if g[base][k] > 0]
            def med(xs):
                xs = sorted(xs)
                return xs[len(xs) // 2] if xs else 0.0
            def spread(xs):  # relative variation: smaller = model fits better
                m = sum(xs) / len(xs) if xs else 0.0
                return (max(xs) - min(xs)) / m if m > 0 else 0.0
            il, ol, ip, op = rates(0, "v"), rates(1, "v"), rates(0, "n"), rates(1, "n")
            res.update(n=len(done), in_lot=med(il), out_lot=med(ol), in_pct=med(ip), out_pct=med(op))
            # Percent-of-value brokers show a stable % but a lot rate that drifts with price.
            if ip and len(done) >= 2 and spread(ip + op if op and op[0] else ip) < spread(il + ol if ol and ol[0] else il):
                res["mode"] = "pct"
    except Exception:
        pass
    _COMMISSION_CACHE[symbol] = (now, res)
    return res


def round_trip_per_lot(mt5, symbol, price, user=None, user_mode="lot"):
    """Round-trip commission for 1 lot at `price` (used for lot sizing).
    user: the value the user typed (round trip, $/lot or % of value) - wins."""
    info = mt5.symbol_info(symbol)
    if user not in (None, ""):
        u = max(0.0, float(user))
        return u * _notional(info, 1.0, price) / 100.0 if user_mode == "pct" and info is not None else u
    m = learn_commission(mt5, symbol)
    if m["mode"] == "pct" and info is not None:
        return (m["in_pct"] + m["out_pct"]) * _notional(info, 1.0, price)
    return m["in_lot"] + m["out_lot"]


def auto_commission(mt5, symbol):
    """Back-compat: learned per-lot commission per SIDE (round trip / 2)."""
    m = learn_commission(mt5, symbol)
    return round((m["in_lot"] + m["out_lot"]) / 2.0, 4)


def _position_risk(mt5, p):
    """Money lost if this position hits its SL (0 when SL is at/over break-even).
    None when the position has no SL (unbounded)."""
    if not p.sl:
        return None
    t = mt5.ORDER_TYPE_BUY if int(p.type) == 0 else mt5.ORDER_TYPE_SELL
    try:
        pr = mt5.order_calc_profit(t, p.symbol, float(p.volume), float(p.price_open), float(p.sl))
    except Exception:
        pr = None
    if pr is None:
        return 0.0
    return max(0.0, -float(pr))


PENDING_TYPES = (2, 3, 4, 5)  # V88: buy/sell limit, buy/sell stop


def _order_risk(mt5, o):
    """V88: loss if a pending order fills and then hits its SL."""
    if not o.sl:
        return None
    t = mt5.ORDER_TYPE_BUY if int(o.type) % 2 == 0 else mt5.ORDER_TYPE_SELL
    try:
        pr = mt5.order_calc_profit(t, o.symbol, float(o.volume_current), float(o.price_open), float(o.sl))
    except Exception:
        pr = None
    return 0.0 if pr is None else max(0.0, -float(pr))


def open_risk(mt5):
    total, unbounded = 0.0, []
    for p in (mt5.positions_get() or ()):
        r = _position_risk(mt5, p)
        if r is None:
            unbounded.append(int(p.ticket))
        else:
            total += r
    for o in (mt5.orders_get() or ()):  # V88: pending orders count too
        if int(o.type) not in PENDING_TYPES:
            continue
        r = _order_risk(mt5, o)
        if r is None:
            unbounded.append(int(o.ticket))
        else:
            total += r
    return round(total, 2), unbounded


_DAY = {"t": 0.0, "v": 0.0}


def day_loss(mt5, symbol=None):
    """V90: today's realized net loss (broker day), 0 when the day is net positive. Cached 5 s."""
    now = time.monotonic()
    if now - _DAY["t"] < 5.0:
        return _DAY["v"]
    v = 0.0
    try:
        from datetime import datetime, timedelta, timezone
        t = mt5.symbol_info_tick(symbol) if symbol else None
        bn = int(t.time) if t is not None and t.time else 0
        n = datetime.now(timezone.utc)
        net, last = 0.0, 0
        deals = mt5.history_deals_get(n - timedelta(days=2), n + timedelta(days=2)) or ()
        if not bn:
            bn = max([int(d.time) for d in deals] or [0])
        ds = bn - bn % 86400
        for d in deals:
            if int(d.type) in (0, 1) and int(d.time) >= ds:
                net += float(d.profit) + float(d.commission) + float(d.swap) + float(getattr(d, "fee", 0.0))
        v = round(max(0.0, -net), 2)
    except Exception:
        v = _DAY["v"]
    _DAY["t"], _DAY["v"] = now, v
    return v


def _margin_1lot(mt5, info, tick):
    """V90: margin for 1 lot (buy side) so the UI can warn before sending."""
    try:
        return float(mt5.order_calc_margin(mt5.ORDER_TYPE_BUY, info.name, 1.0, float(tick.ask)) or 0.0)
    except Exception:
        return 0.0


def specs(mt5, symbol):
    info = mt5.symbol_info(symbol)
    acc = mt5.account_info()
    term = mt5.terminal_info()
    if info is None or acc is None:
        return {"symbol": symbol, "ok": False}
    risk, unbounded = open_risk(mt5)
    tick = mt5.symbol_info_tick(symbol)
    return {
        "ok": True, "symbol": symbol, "digits": int(info.digits), "point": float(info.point),
        "tick_size": float(info.trade_tick_size), "tick_value_loss": float(info.trade_tick_value_loss or info.trade_tick_value),
        "vol_min": float(info.volume_min), "vol_max": float(info.volume_max), "vol_step": float(info.volume_step),
        "stops_level": int(info.trade_stops_level), "balance": float(acc.balance), "equity": float(acc.equity),
        "currency": acc.currency, "commission_auto": auto_commission(mt5, symbol),
        "contract_size": float(getattr(info, "trade_contract_size", 0.0) or 0.0),
        "comm_model": learn_commission(mt5, symbol),
        "open_risk": risk, "unbounded": unbounded,
        "day_loss": day_loss(mt5, symbol),  # V90
        "margin_free": float(acc.margin_free), "margin_1lot": _margin_1lot(mt5, info, tick) if tick is not None else 0.0,
        "connected": bool(term.connected) if term is not None else False,
        "trade_allowed": bool(term is not None and term.trade_allowed and acc.trade_allowed and acc.trade_expert),
    }


def _check_can_trade(mt5):
    term = mt5.terminal_info()
    acc = mt5.account_info()
    if term is None or acc is None:
        return "MT5 terminal not reachable"
    if not term.connected:
        return "MT5 is not connected to the broker"
    if not term.trade_allowed:
        return "Algo Trading is disabled in MT5 (enable the 'Algo Trading' button)"
    if not acc.trade_allowed or not acc.trade_expert:
        return "Trading is not allowed on this account"
    return None


def _find_by_comment(mt5, symbol, comment):
    for _ in range(6):  # ~0.6 s: the position may appear a moment later
        for p in (mt5.positions_get(symbol=symbol) or ()):
            if p.comment == comment or (p.comment and comment.startswith(p.comment)):
                return p
        time.sleep(0.1)
    return None


def calc_lots(mt5, info, order_type, entry, sl, risk_money, commission):
    pr = None
    try:
        pr = mt5.order_calc_profit(order_type, info.name, 1.0, entry, sl)
    except Exception:
        pr = None
    if pr is not None and pr < 0:
        loss_per_lot = -float(pr)
    else:
        tv = float(info.trade_tick_value_loss or info.trade_tick_value)
        loss_per_lot = abs(entry - sl) / float(info.trade_tick_size) * tv
    per_lot = loss_per_lot + commission  # V85: commission = round trip per lot
    if per_lot <= 0:
        return 0.0, per_lot
    step = float(info.volume_step)
    lots = round(_floor_step(risk_money / per_lot, step), _step_digits(step))
    return min(lots, float(info.volume_max)), per_lot


def open_market(mt5, cmd, symbol):
    """cmd: sl, risk_mode ('pct'|'money'), risk, commission (None=auto),
    tp_rr (0=no TP), max_risk_mode, max_risk (0=off), req_id."""
    if time.time() - float(cmd.get("ts") or 0) > STALE_SECONDS:
        return _err("Order expired before reaching MT5 (not sent)")
    sym = cmd.get("symbol") or symbol
    why = _check_can_trade(mt5)
    if why:
        return _err(why)
    if not mt5.symbol_select(sym, True):
        return _err("Symbol %s unavailable" % sym)
    info = mt5.symbol_info(sym)
    acc = mt5.account_info()
    tick = mt5.symbol_info_tick(sym)
    if info is None or tick is None or not tick.bid or not tick.ask:
        return _err("No live price for %s" % sym)
    if int(info.trade_mode) in (0, 3):  # disabled / close-only
        return _err("Trading on %s is disabled or close-only" % sym)
    digits, tsz, pt = int(info.digits), float(info.trade_tick_size), float(info.point)
    sl = _round_tick(float(cmd.get("sl") or 0), tsz, digits)
    if sl <= 0:
        return _err("Invalid stop loss")
    if sl < tick.bid:
        otype, entry, is_buy = mt5.ORDER_TYPE_BUY, float(tick.ask), True
    elif sl > tick.ask:
        otype, entry, is_buy = mt5.ORDER_TYPE_SELL, float(tick.bid), False
    else:
        return _err("Stop loss is inside the spread")
    min_dist = int(info.trade_stops_level) * pt
    if (is_buy and tick.bid - sl < min_dist) or (not is_buy and sl - tick.ask < min_dist):
        return _err("Stop loss too close (broker min %d points)" % int(info.trade_stops_level))

    commission = round_trip_per_lot(mt5, sym, entry, cmd.get("commission"), cmd.get("commission_mode") or "lot")
    bal = float(acc.balance)
    risk_val = max(0.0, float(cmd.get("risk") or 0))
    risk_money = bal * risk_val / 100.0 if cmd.get("risk_mode") != "money" else risk_val
    if risk_money <= 0:
        return _err("Risk must be greater than 0")
    lots, per_lot = calc_lots(mt5, info, otype, entry, sl, risk_money, commission)
    if lots < float(info.volume_min) - 1e-9:
        return _err("Risk too small: min lot %.2f would risk %.2f %s" % (info.volume_min, info.volume_min * per_lot, acc.currency))
    real_risk = lots * per_lot

    max_val = float(cmd.get("max_risk") or 0)
    if max_val > 0:
        limit = bal * max_val / 100.0 if cmd.get("max_risk_mode") != "money" else max_val
        cur, unbounded = open_risk(mt5)
        if unbounded:
            return _err("Max risk: position #%d has no stop loss" % unbounded[0])
        dl = day_loss(mt5, sym) if cmd.get("max_risk_basis") == "day" else 0.0  # V90: Daily DD mode only
        if cur + dl + real_risk > limit + 1e-6:
            return _err("Limit reached: open %.2f + day loss %.2f + new %.2f > limit %.2f" % (cur, dl, real_risk, limit))

    try:
        margin = mt5.order_calc_margin(otype, sym, lots, entry)
    except Exception:
        margin = None
    if margin is not None and margin > float(acc.margin_free):
        return _err("Not enough free margin: %.2f lot needs %.2f, free %.2f (lower risk or widen SL)" % (lots, margin, float(acc.margin_free)))

    rr = max(0.0, float(cmd.get("tp_rr") or 0))
    comment = ("%s %s" % (ORDER_TAG, cmd.get("req_id", "")))[:31]
    last = None
    for attempt in range(3):
        if attempt:
            tick = mt5.symbol_info_tick(sym) or tick
            entry = float(tick.ask if is_buy else tick.bid)
        tp = 0.0
        if rr > 0:
            tp = _round_tick(entry + (entry - sl) * rr, tsz, digits)
        req = {
            "action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": lots, "type": otype,
            "price": entry, "sl": sl, "tp": tp, "deviation": DEVIATION_POINTS, "magic": MAGIC,
            "comment": comment, "type_time": mt5.ORDER_TIME_GTC, "type_filling": _filling(mt5, info),
        }
        res = mt5.order_send(req)
        last = res
        if res is not None and res.retcode in _OK_CODES:
            return {"ok": True, "msg": "%s %.*f lot @ %.*f" % ("BUY" if is_buy else "SELL", _step_digits(info.volume_step), lots, digits, float(res.price or entry)),
                    "ticket": int(res.order), "lots": lots, "risk": round(real_risk, 2)}
        if res is None or res.retcode in _UNKNOWN_CODES:
            p = _find_by_comment(mt5, sym, comment)
            if p is not None:
                return {"ok": True, "msg": "Opened (confirmed after delay) #%d" % p.ticket, "ticket": int(p.ticket), "lots": lots}
            return _err("Outcome unknown: %s. Check MT5 before retrying" % _retcode_text(mt5, res))
        if res.retcode == 10030:  # unsupported filling -> try the other modes
            req_f = [f for f in (mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN) if f != req["type_filling"]]
            for f in req_f:
                req["type_filling"] = f
                res = mt5.order_send(req)
                if res is not None and res.retcode in _OK_CODES:
                    return {"ok": True, "msg": "Opened #%d" % res.order, "ticket": int(res.order), "lots": lots}
            last = res
            break
        if res.retcode not in _RETRY_CODES:
            break
    return _err("Order rejected: %s" % _retcode_text(mt5, last))


# ---- V88: pending orders ----------------------------------------------------
def _risk_money(acc, cmd):
    v = max(0.0, float(cmd.get("risk") or 0))
    return float(acc.balance) * v / 100.0 if cmd.get("risk_mode") != "money" else v


def _pending_type(mt5, is_buy, entry, tick):
    if is_buy:
        return mt5.ORDER_TYPE_BUY_LIMIT if entry < tick.ask else mt5.ORDER_TYPE_BUY_STOP
    return mt5.ORDER_TYPE_SELL_LIMIT if entry > tick.bid else mt5.ORDER_TYPE_SELL_STOP


_PT_NAMES = {2: "BUY LIMIT", 3: "SELL LIMIT", 4: "BUY STOP", 5: "SELL STOP"}


def _send_pending(mt5, info, sym, otype, lots, entry, sl, tp, comment):
    req = {"action": mt5.TRADE_ACTION_PENDING, "symbol": sym, "volume": lots, "type": otype,
           "price": entry, "sl": sl, "tp": tp, "magic": MAGIC, "comment": comment,
           "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_RETURN}
    res = mt5.order_send(req)
    if res is not None and res.retcode == 10030:
        for f in (mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_IOC):
            req["type_filling"] = f
            res = mt5.order_send(req)
            if res is not None and res.retcode != 10030:
                break
    return res


def _find_order_by_comment(mt5, symbol, comment):
    for _ in range(6):
        for o in (mt5.orders_get(symbol=symbol) or ()):
            if o.comment == comment or (o.comment and comment.startswith(o.comment)):
                return o
        time.sleep(0.1)
    return None


def _check_pending(mt5, info, tick, otype, entry, sl, tp):
    md = int(info.trade_stops_level) * float(info.point)
    is_buy = otype % 2 == 0
    ref = tick.ask if is_buy else tick.bid
    if abs(entry - ref) < md:
        return "Entry too close to price (broker min %d points)" % int(info.trade_stops_level)
    if (is_buy and sl >= entry) or (not is_buy and sl <= entry):
        return "SL on wrong side of entry"
    if abs(entry - sl) < md:
        return "SL too close to entry"
    if tp and ((is_buy and tp <= entry) or (not is_buy and tp >= entry)):
        return "TP on wrong side of entry"
    return None


def open_pending(mt5, cmd, symbol):
    """cmd: entry, sl, + the same risk fields as open_market."""
    if time.time() - float(cmd.get("ts") or 0) > STALE_SECONDS:
        return _err("Order expired before reaching MT5 (not sent)")
    sym = cmd.get("symbol") or symbol
    why = _check_can_trade(mt5)
    if why:
        return _err(why)
    if not mt5.symbol_select(sym, True):
        return _err("Symbol %s unavailable" % sym)
    info, acc, tick = mt5.symbol_info(sym), mt5.account_info(), mt5.symbol_info_tick(sym)
    if info is None or tick is None or not tick.bid or not tick.ask:
        return _err("No live price for %s" % sym)
    if int(info.trade_mode) in (0, 3):
        return _err("Trading on %s is disabled or close-only" % sym)
    digits, tsz = int(info.digits), float(info.trade_tick_size)
    entry = _round_tick(float(cmd.get("entry") or 0), tsz, digits)
    sl = _round_tick(float(cmd.get("sl") or 0), tsz, digits)
    if entry <= 0 or sl <= 0 or entry == sl:
        return _err("Invalid entry / stop loss")
    is_buy = sl < entry
    otype = _pending_type(mt5, is_buy, entry, tick)
    rr = max(0.0, float(cmd.get("tp_rr") or 0))
    tp = _round_tick(entry + (entry - sl) * rr, tsz, digits) if rr > 0 else 0.0
    bad = _check_pending(mt5, info, tick, otype, entry, sl, tp)
    if bad:
        return _err(bad)
    commission = round_trip_per_lot(mt5, sym, entry, cmd.get("commission"), cmd.get("commission_mode") or "lot")
    risk_money = _risk_money(acc, cmd)
    if risk_money <= 0:
        return _err("Risk must be greater than 0")
    mtype = mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL
    lots, per_lot = calc_lots(mt5, info, mtype, entry, sl, risk_money, commission)
    if lots < float(info.volume_min) - 1e-9:
        return _err("Risk too small: min lot %.2f would risk %.2f %s" % (info.volume_min, info.volume_min * per_lot, acc.currency))
    real_risk = lots * per_lot
    max_val = float(cmd.get("max_risk") or 0)
    if max_val > 0:
        limit = float(acc.balance) * max_val / 100.0 if cmd.get("max_risk_mode") != "money" else max_val
        cur, unbounded = open_risk(mt5)
        if unbounded:
            return _err("Max risk: #%d has no stop loss" % unbounded[0])
        dl = day_loss(mt5, sym) if cmd.get("max_risk_basis") == "day" else 0.0  # V90: Daily DD mode only
        if cur + dl + real_risk > limit + 1e-6:
            return _err("Limit reached: open %.2f + day loss %.2f + new %.2f > limit %.2f" % (cur, dl, real_risk, limit))
    comment = ("CT88 %s" % cmd.get("req_id", ""))[:31]
    res = _send_pending(mt5, info, sym, otype, lots, entry, sl, tp, comment)
    if res is not None and res.retcode in _OK_CODES:
        return {"ok": True, "msg": "%s %.*f lot @ %.*f" % (_PT_NAMES.get(otype, "PENDING"), _step_digits(info.volume_step), lots, digits, entry),
                "ticket": int(res.order), "lots": lots, "risk": round(real_risk, 2)}
    if res is None or res.retcode in _UNKNOWN_CODES:
        o = _find_order_by_comment(mt5, sym, comment)
        if o is not None:
            return {"ok": True, "msg": "Pending placed (confirmed after delay) #%d" % o.ticket, "ticket": int(o.ticket)}
        return _err("Outcome unknown: %s. Check MT5 before retrying" % _retcode_text(mt5, res))
    return _err("Pending rejected: %s" % _retcode_text(mt5, res))


def _get_order(mt5, ticket):
    os_ = mt5.orders_get(ticket=int(ticket))
    return os_[0] if os_ else None


def modify_pending(mt5, cmd):
    """Entry move keeps lots (frontend shifts SL/TP by the same distance).
    SL move vs entry (resize=True) re-sizes lots: MT5 cannot change the
    volume of a pending order, so it is replaced (new order first, then the
    old one is removed, so there is never a moment without the order...
    unless the new one is rejected, then the old one stays)."""
    if time.time() - float(cmd.get("ts") or 0) > STALE_SECONDS * 2:
        return _err("Modify expired (not sent)")
    why = _check_can_trade(mt5)
    if why:
        return _err(why)
    o = _get_order(mt5, cmd.get("ticket"))
    if o is None:
        return _err("Order no longer pending")
    info, tick = mt5.symbol_info(o.symbol), mt5.symbol_info_tick(o.symbol)
    digits, tsz = int(info.digits), float(info.trade_tick_size)
    rt = lambda k, d: float(d) if cmd.get(k) is None else _round_tick(float(cmd[k]), tsz, digits)
    entry, sl, tp = rt("price", o.price_open), rt("sl", o.sl), rt("tp", o.tp)
    is_buy = int(o.type) % 2 == 0
    otype = _pending_type(mt5, is_buy, entry, tick)
    bad = _check_pending(mt5, info, tick, otype, entry, sl, tp)
    if bad:
        return _err(bad)
    lots = float(o.volume_current)
    if cmd.get("resize"):
        acc = mt5.account_info()
        commission = round_trip_per_lot(mt5, o.symbol, entry, cmd.get("commission"), cmd.get("commission_mode") or "lot")
        mtype = mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL
        nl, per_lot = calc_lots(mt5, info, mtype, entry, sl, _risk_money(acc, cmd), commission)
        if nl < float(info.volume_min) - 1e-9:
            return _err("Risk too small for this SL (min lot %.2f)" % info.volume_min)
        lots = nl
    if otype != int(o.type) or abs(lots - float(o.volume_current)) > 1e-9:
        res = _send_pending(mt5, info, o.symbol, otype, lots, entry, sl, tp, o.comment or ("CT88 #%d" % o.ticket))
        if res is None or res.retcode not in _OK_CODES:
            return _err("Replace rejected: %s" % _retcode_text(mt5, res))
        mt5.order_send({"action": mt5.TRADE_ACTION_REMOVE, "order": int(o.ticket)})
        return {"ok": True, "msg": "%s %.*f lot @ %.*f" % (_PT_NAMES.get(otype, "PENDING"), _step_digits(info.volume_step), lots, digits, entry)}
    if abs(entry - o.price_open) < tsz / 2 and abs(sl - o.sl) < tsz / 2 and abs(tp - o.tp) < tsz / 2:
        return {"ok": True, "msg": "No change"}
    res = mt5.order_send({"action": mt5.TRADE_ACTION_MODIFY, "order": int(o.ticket), "symbol": o.symbol,
                          "price": entry, "sl": sl, "tp": tp, "type_time": mt5.ORDER_TIME_GTC})
    if res is not None and res.retcode in _OK_CODES:
        return {"ok": True, "msg": "#%d @ %.*f  SL %.*f / TP %.*f" % (o.ticket, digits, entry, digits, sl, digits, tp)}
    return _err("Modify rejected: %s" % _retcode_text(mt5, res))


def cancel(mt5, cmd):
    out, n = [], 0
    for t in cmd.get("tickets") or ():
        res = mt5.order_send({"action": mt5.TRADE_ACTION_REMOVE, "order": int(t)})
        if res is not None and res.retcode in _OK_CODES:
            n += 1
        else:
            out.append("#%s: %s" % (t, _retcode_text(mt5, res)))
    if out:
        return _err("; ".join(out))
    return {"ok": True, "msg": "Cancelled %d order%s" % (n, "" if n == 1 else "s")}


def _get_position(mt5, ticket):
    ps = mt5.positions_get(ticket=int(ticket))
    return ps[0] if ps else None


def modify(mt5, cmd):
    if time.time() - float(cmd.get("ts") or 0) > STALE_SECONDS * 2:
        return _err("Modify expired (not sent)")
    why = _check_can_trade(mt5)
    if why:
        return _err(why)
    p = _get_position(mt5, cmd.get("ticket"))
    if p is None:
        return _err("Position is closed")
    info = mt5.symbol_info(p.symbol)
    tick = mt5.symbol_info_tick(p.symbol)
    digits, tsz = int(info.digits), float(info.trade_tick_size)
    sl = float(p.sl) if cmd.get("sl") is None else _round_tick(float(cmd["sl"]), tsz, digits)
    tp = float(p.tp) if cmd.get("tp") is None else _round_tick(float(cmd["tp"]), tsz, digits)
    is_buy = int(p.type) == 0
    md = int(info.trade_stops_level) * float(info.point)
    cur = float(tick.bid if is_buy else tick.ask)
    if sl and ((is_buy and sl > cur - md) or (not is_buy and sl < cur + md)):
        return _err("SL on wrong side of price / too close")
    if tp and ((is_buy and tp < cur + md) or (not is_buy and tp > cur - md)):
        return _err("TP on wrong side of price / too close")
    if abs(sl - p.sl) < tsz / 2 and abs(tp - p.tp) < tsz / 2:
        return {"ok": True, "msg": "No change"}
    res = None
    for _ in range(3):
        res = mt5.order_send({"action": mt5.TRADE_ACTION_SLTP, "position": int(p.ticket), "symbol": p.symbol,
                              "sl": sl, "tp": tp, "magic": int(p.magic)})
        if res is not None and res.retcode in _OK_CODES:
            return {"ok": True, "msg": "#%d SL %.*f / TP %.*f" % (p.ticket, digits, sl, digits, tp)}
        if res is None or res.retcode not in _RETRY_CODES + _UNKNOWN_CODES:
            break
        time.sleep(0.05)
    return _err("Modify rejected: %s" % _retcode_text(mt5, res))


def close(mt5, cmd):
    why = _check_can_trade(mt5)
    if why:
        return _err(why)
    frac = min(1.0, max(0.0, float(cmd.get("fraction") or 1.0)))
    out = []
    for t in cmd.get("tickets") or []:
        p = _get_position(mt5, t)
        if p is None:
            continue
        info = mt5.symbol_info(p.symbol)
        step, vmin = float(info.volume_step), float(info.volume_min)
        vol = float(p.volume)
        if frac < 1.0:
            v = round(_floor_step(vol * frac, step), _step_digits(step))
            if v < vmin - 1e-9:
                out.append("#%d too small for partial close" % p.ticket)
                continue
            if vol - v < vmin - 1e-9:
                v = vol
            vol = v
        is_buy = int(p.type) == 0
        res = None
        for _ in range(3):
            tick = mt5.symbol_info_tick(p.symbol)
            req = {"action": mt5.TRADE_ACTION_DEAL, "position": int(p.ticket), "symbol": p.symbol, "volume": vol,
                   "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
                   "price": float(tick.bid if is_buy else tick.ask), "deviation": DEVIATION_POINTS,
                   "magic": int(p.magic), "comment": ORDER_TAG + " close", "type_time": mt5.ORDER_TIME_GTC,
                   "type_filling": _filling(mt5, info)}
            res = mt5.order_send(req)
            if res is not None and res.retcode in _OK_CODES:
                break
            if res is None or res.retcode in _UNKNOWN_CODES:
                time.sleep(0.2)
                q = _get_position(mt5, p.ticket)
                if q is None or float(q.volume) < float(p.volume) - 1e-9:
                    res = None
                    break
                continue
            if res.retcode not in _RETRY_CODES:
                break
        if res is not None and res.retcode not in _OK_CODES:
            out.append("#%d: %s" % (p.ticket, _retcode_text(mt5, res)))
    return _err("; ".join(out)) if out else {"ok": True, "msg": "Closed" if frac >= 1 else "Partially closed %d%%" % round(frac * 100)}


# V85: per-position cost + break-even (shared by the Trade tab feed and Risk-free).
_ENTRY_PAID = {}   # ticket -> (commission paid on entry deals, entry volume) - never changes
_PPT = {}          # (symbol, type, volume, price_open) -> money per tick


def _entry_paid(mt5, ticket):
    r = _ENTRY_PAID.get(ticket)
    if r is None:
        c = v = 0.0
        try:
            for d in (mt5.history_deals_get(position=int(ticket)) or ()):
                if int(d.entry) == 0:
                    c += abs(float(d.commission) + float(getattr(d, "fee", 0.0)))
                    v += float(d.volume)
        except Exception:
            pass
        r = (c, v)
        if len(_ENTRY_PAID) > 2000:
            _ENTRY_PAID.clear()
        _ENTRY_PAID[ticket] = r
    return r


_REALIZED = {}     # (ticket, volume) -> net result of partial closes (V90)


def _realized_out(mt5, ticket, vol):
    k = (int(ticket), vol)
    r = _REALIZED.get(k)
    if r is None:
        r = 0.0
        try:
            for d in (mt5.history_deals_get(position=int(ticket)) or ()):
                if int(d.entry) != 0:
                    r += float(d.profit) + float(d.commission) + float(d.swap) + float(getattr(d, "fee", 0.0))
        except Exception:
            pass
        if len(_REALIZED) > 2000:
            _REALIZED.clear()
        _REALIZED[k] = r
    return r


def realized_partial(mt5, p):
    """V90: net result already banked by partial closes of this position (0 if none)."""
    paid, ev = _entry_paid(mt5, int(p.ticket))
    vol = float(p.volume)
    if ev <= vol + 1e-9:
        return 0.0
    return round(_realized_out(mt5, p.ticket, vol) - paid * (ev - vol) / ev, 2)


def position_cost(mt5, p, commission=None, commission_mode="lot"):
    """(estimated round-trip commission, break-even price) for an open position.
    User value (round trip, $/lot or % of value) wins. Otherwise:
    entry side = what the broker ACTUALLY charged on the entry deal,
    exit side = learned exit rate (0 for entry-only brokers); with no history
    the exit side is assumed equal to the entry side (safe side).
    BE also absorbs a negative swap. BE = entry when the cost is 0."""
    vol, op = float(p.volume), float(p.price_open)
    info = mt5.symbol_info(p.symbol)
    if commission not in (None, ""):
        u = max(0.0, float(commission))
        fee = u * _notional(info, vol, op) / 100.0 if commission_mode == "pct" and info is not None else u * vol
    else:
        paid, ev = _entry_paid(mt5, int(p.ticket))
        entry_side = paid * vol / ev if ev > 0 else 0.0   # scaled after partial closes
        m = learn_commission(mt5, p.symbol)
        if m["n"]:
            if m["mode"] == "pct" and info is not None:
                exit_side = m["out_pct"] * _notional(info, vol, op)
                if entry_side <= 0:
                    entry_side = m["in_pct"] * _notional(info, vol, op)
            else:
                exit_side = m["out_lot"] * vol
                if entry_side <= 0:
                    entry_side = m["in_lot"] * vol
        else:
            exit_side = entry_side
        fee = entry_side + exit_side
    fee = round(fee, 2)
    cost = fee + max(0.0, -float(p.swap))
    # V90: after a partial close, BE = price where the WHOLE position nets 0
    # (entry commission of the closed part + realized result of the closed part).
    paid, ev = _entry_paid(mt5, int(p.ticket))
    partial = ev > vol + 1e-9
    if partial:
        cost += paid * (ev - vol) / ev - _realized_out(mt5, p.ticket, vol)
    if (not partial and cost <= 1e-6) or info is None:
        return fee, op
    tsz, digits, is_buy = float(info.trade_tick_size), int(info.digits), int(p.type) == 0
    k = (p.symbol, int(p.type), vol, op)
    ppt = _PPT.get(k)
    if ppt is None:
        try:
            t_ = mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL
            ppt = abs(float(mt5.order_calc_profit(t_, p.symbol, vol, op, op + (tsz if is_buy else -tsz)) or 0.0))
        except Exception:
            ppt = 0.0
        if ppt <= 0:
            ppt = float(info.trade_tick_value or 0.0) * vol
        if len(_PPT) > 500:
            _PPT.clear()
        _PPT[k] = ppt
    ticks = math.ceil(cost / ppt - 1e-9) if ppt > 0 else 2  # V90: may be <0 after a profitable partial
    be = _round_tick(op + (ticks * tsz if is_buy else -ticks * tsz), tsz, digits)
    return fee, be


def risk_free(mt5, cmd):
    """V85: move SL to the break-even price (entry + round-trip commission +
    negative swap), not to the bare entry."""
    why = _check_can_trade(mt5)
    if why:
        return _err(why)
    out, unknown = [], 0
    for t in cmd.get("tickets") or []:
        p = _get_position(mt5, t)
        if p is None:
            continue
        u = (cmd.get("comm") or {}).get(p.symbol) or {}
        fee, sl = position_cost(mt5, p, u.get("v"), u.get("mode") or "lot")
        if fee <= 0:
            unknown += 1
        r = modify(mt5, {"ticket": p.ticket, "sl": sl, "ts": time.time()})
        if not r.get("ok"):
            out.append("#%d: %s" % (p.ticket, r.get("msg")))
    if out:
        return _err("; ".join(out))
    return {"ok": True, "msg": "Risk-free set" + (" (commission unknown: set it in the Commission field)" if unknown else "")}


def handle(mt5, cmd, symbol):
    kind = cmd.get("type")
    try:
        if kind == "trade_open":
            return open_market(mt5, cmd, symbol)
        if kind == "trade_modify":
            return modify_pending(mt5, cmd) if cmd.get("pending") else modify(mt5, cmd)
        if kind == "trade_pending":
            return open_pending(mt5, cmd, symbol)
        if kind == "trade_cancel":
            return cancel(mt5, cmd)
        if kind == "trade_close":
            return close(mt5, cmd)
        if kind == "trade_riskfree":
            return risk_free(mt5, cmd)
    except Exception as e:
        return _err("Trade error: %s" % e)
    return _err("Unknown trade command")
