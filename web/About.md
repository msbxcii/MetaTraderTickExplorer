# MetaTrader Tick Explorer

MetaTrader Tick Explorer is a Windows application that extracts tick data from a local MetaTrader terminal on your machine and uses it to build second-level (and higher) candles. The data is stored directly on disk, allowing you to work with second-resolution charts on the live market as well as for any date in the past. The resulting data is rendered using the official open-source [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) project.

## Features

- Replay Mode: view charts at real live-market speed (1 tick per second), giving you a realistic simulation environment for practice.
- Multi-Chart Mode: view the chart across several different timeframes at once, in both Live and Replay modes.
- Offline Operation: practice on historical data using only the stored database, with no connection required.
- Trading Panel: place and manage real trades directly from the chart. You are solely responsible for your trades, so always test on a Demo account first.

## Security & Privacy

- Local terminal only: market data and trading go only through your local MetaTrader terminal. No external server is required.
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
