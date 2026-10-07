# MetaTrader Tick Explorer

MetaTrader Tick Explorer is a Windows application that extracts tick data from a local MetaTrader terminal on your machine and uses it to build second-level (and higher) candles. The data is stored directly on disk, allowing you to work with second-resolution charts on the live market as well as for any date in the past. The resulting data is rendered using the official open-source [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) project.

## Features

- Second Timeframes: build candles on 1-second, 5-second and 15-second timeframes, on the live market as well as on any date in the past.
- Replay Mode: replay historical data at real live-market speed (1 tick per second), giving you a realistic simulation environment for practice.
- Demo Trading in Replay Mode: practice trades on historical data inside Replay Mode with a simulated account; no broker account needed.
- Live Trading Inside the App: place and manage live trades directly in the app and send them to MetaTrader.
- Economic News: economic calendar events are downloaded automatically from Forex Factory, archived locally, and shown on the chart.
- Forex Sessions: forex trading sessions are displayed on the chart, with no need to adjust for daylight saving time changes.
- Multi-Chart Mode: view the same symbol across several timeframes in parallel, in both Live and Replay modes.
- Offline Local Database: a local, fully offline database with no intermediary server, so you can practice on stored historical data at any time.

## Security & Privacy

- Local terminal only: market data and trading go only through your local MetaTrader terminal. No external server is required.
- Economic News download: the news calendar is downloaded from a public website; no personal or account data is sent.
- Update check: "Check for Updates" makes a single read-only request to GitHub to see whether a newer version exists. Nothing else is sent.
- No access to account credentials: no username, password, or other login information is ever needed; it stays with the MetaTrader terminal itself.
- Data stays local: all tick/candle data and settings are stored only on your own machine.

## Attribution

Charts are powered by [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/), Copyright 2023 TradingView, Inc., licensed under the Apache License 2.0. Visit [tradingview.com](https://www.tradingview.com/).

## Trademarks

MetaTrader and MetaQuotes are registered trademarks of MetaQuotes Ltd. This application is not affiliated with or endorsed by MetaQuotes.

## License

Licensed under the Apache License 2.0. Copyright 2026 Msbxcii.

Source code: [github.com/msbxcii/MetaTraderTickExplorer](https://github.com/msbxcii/MetaTraderTickExplorer)
