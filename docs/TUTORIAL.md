# MetaTrader Tick Explorer: Tutorial

English | [فارسی](TUTORIAL-fa.md)

A step-by-step guide from first launch to trading from the chart. Takes about 10 minutes to read.

> ⚠️ **Test the Trading Panel on a Demo account first.** Orders sent from the app are real orders on the account your terminal is logged into.

---

## 1. Before you start

You need:

1. **Windows 10 or 11**
2. **MetaTrader 5**, open and **logged in** to an account (demo or real).
3. **Python Integration enabled** in MT5: `Tools › Options › Community` → tick **Python integration**.

![Python integration](../assets/prepare.png)

Then download `mt-tick.explorer-<version>.exe` from the official [Releases](https://github.com/msbxcii/MetaTraderTickExplorer/releases) page. No installation is needed; just run it.

---

## 2. First launch (Get Started)

The wizard runs once:

| Step | What to do |
|---|---|
| **MetaTrader Preparation** | Confirm MT5 is open, logged in, and Python Integration is on. Choose the **Root Project Folder** where data and settings will be stored. Press **Next**. |
| **Choose Symbol** | The app reads your broker's symbol list. Search and pick a symbol (e.g. `EURUSD`). |
| **Download** | The last **3 days** of tick data are downloaded and turned into candles. |
| **All set** | The chart opens. |

> If the connection fails, re-check: MT5 open, logged in, Python Integration enabled.

---

## 3. The chart

**Timeframes:** `1s`, `5s`, `15s`, `1m`, `5m`, `15m`, `1h`, `4h`, `1D`. Pick one from the toolbar.

| Action | How |
|---|---|
| Scroll through time | Drag the chart, or use the mouse wheel |
| Zoom the price scale | Drag the price axis. **Auto Fit** resets it |
| Jump to any date/time | **Space** → Jump Time dialog |
| Jump to latest / oldest candle | **End** / **Home** |
| Ruler (time, points, %) | **Shift + Left Click** for the start, **Left Click** to finish |

The live price label shows a **countdown to candle close**, based on your broker's clock.

---

## 4. Getting more history

The first load only has 3 days. To get more:

1. Open **Setting** (gear icon) → **Market Data Overview**.
2. Check the oldest available date and the per-day candle histogram.
3. **Extend**: pick a target date; the app downloads older data in the background until it reaches it.
   **Backfill**: fills the default range.

You can keep using the chart while it downloads. Data is saved on disk, so it only has to be downloaded once.

---

## 5. Drawing tools

Trend line, horizontal/vertical line, rectangle, Fib retracement, Fib expansion.

| Action | How |
|---|---|
| Horizontal line at mouse | **Ctrl + H** |
| Vertical line at mouse | **Ctrl + V** |
| Other tools | Pick from the toolbar, then click on the chart |
| Edit style | Click the object → context menu (color, width, fill, middle line…) |
| Undo last object | **Backspace** |
| Delete selected | **Delete** |
| Delete all | **Shift + Delete** (Backspace right after restores them) |
| Cancel / deselect | **Esc** |

**Object Tree** (layers icon) lists all drawings: rename (double-click), hide, lock, delete, group into folders, **Ctrl/Shift + click** to multi-select.

---

## 6. Multi-Chart

Open 2 or 3 panels of the **same symbol** with different timeframes (e.g. 1m + 15s + 1h). Each panel has its own timeframe, drawings and crosshair. **Maximize** a panel to focus on it; **Esc** restores it. Works in both Live and Replay.

---

## 7. Replay (practice on history)

1. Open **Replay** and **Select Date** for the starting point. Every candle after that point is hidden.
2. Press **Play**. By default candles form at real market speed.
3. Change **Replay Speed**: `1x`, `5x`, `10x`, `30x`, `60x`.
4. **Close Replay** to go back to live.

> Trading and **End** (jump to latest) are disabled during Replay, so live data can't leak into your practice session.

---

## 8. Trading from the chart

### 8.1 Set your risk (Trade panel)

Open the **Trade** panel (header icon) → **Trade** tab:

- **Risk per trade**: percent of balance or a fixed amount. The lot size is calculated automatically.
- **Commission**: per lot. It is included in the lot size calculation.
- **R:R**: the take profit distance as a multiple of the stop loss distance.
- **Max risk**: a limit on the total open risk. New orders beyond it are blocked.

### 8.2 Market order

1. **Middle Mouse** click on the chart → the stop loss line follows your mouse, and the take profit line follows at your R:R.
   - Stop loss **below** price = **Buy**, **above** price = **Sell**.
2. **Left Click** → the order is sent.
3. To cancel: **Right Click**, **Esc**, or **Middle Mouse** again.

### 8.3 Pending order

1. **Shift + Middle Mouse** click.
2. First **Left Click** fixes the entry price. The second **Left Click** sets the stop loss and places the order. The order type (Limit/Stop) is picked automatically.

### 8.4 Managing positions

- **Drag** the SL/TP lines of an open position on the chart. The change is sent to MT5 when you release the mouse.
- In the Trade panel, each position has **Risk-free**, **Close 25%**, **Close 50%** and **Close** buttons. Pending orders have **Cancel**.
- The **History** tab shows closed trades with net result, win rate and fees.

Orders are tagged `mt-tick.explorer` in your MT5 history.

> Always double-check your positions in the MT5 terminal.

---

## 9. Customizing

**Setting** (gear icon):

| Tab | What it does |
|---|---|
| **Market Data Overview** | History, Extend, Backfill |
| **Canvas** | Chart colors and theme, saved as presets |
| **Keyboard Shortcuts** | Change any shortcut, including **Middle Mouse** / **Shift + Middle Mouse** for trading (keys or Middle/Back/Forward mouse buttons) |
| **Configuration** | App options |
| **About** | Version and **Check for Update** |

To change a shortcut: click ✎, press the new key or mouse button, then click ✓. Shortcuts use the physical key position, so they work with both English and Persian keyboard layouts.

---

## 10. Shortcut cheat sheet

| Shortcut | Action |
|---|---|
| Space | Jump Time |
| End / Home | Latest / oldest candle |
| Ctrl + H / Ctrl + V | Horizontal / vertical line |
| Backspace | Undo last object |
| Delete / Shift + Delete | Delete selected / all |
| Shift + Left Click | Ruler |
| Middle Mouse | Market order |
| Shift + Middle Mouse | Pending order |
| Right Click / Esc | Cancel |

---

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot connect" / no symbols | Open MT5, log in, and enable Python Integration |
| No live price | Market closed, or MT5 lost its connection to the broker |
| Chart has only a few days | Use **Extend** (section 4) |
| Trade buttons do nothing | Check that trading is allowed on the account and that Replay is closed |
| Something else | Open **Log** (header). Share the log in an [issue](https://github.com/msbxcii/MetaTraderTickExplorer/issues) |

Data and logs are stored in `%LOCALAPPDATA%\MT-TickExplorer\`.

---

*MetaTrader Tick Explorer is free. If you paid for it, you were scammed. Official source: [github.com/msbxcii/MetaTraderTickExplorer](https://github.com/msbxcii/MetaTraderTickExplorer). Not affiliated with or endorsed by MetaQuotes.*
