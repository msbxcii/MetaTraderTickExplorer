# MetaTrader Tick Explorer

MetaTrader Tick Explorer is a Windows application that extracts tick data from a local MetaTrader terminal on your machine and uses it to build second-level (and higher) candles. The data is stored directly on disk, allowing users to work with second-resolution charts on the live market as well as for any date in the past. The resulting data is rendered using the official open-source [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) project.

### Features

1) View charts in **Replay Mode** at real live-market speed (1 tick per second), giving users a realistic simulation environment for practice.
2) Use **Multi-Chart mode** to view the chart across several different timeframes at once, in both Live and Replay modes.
3) Fully **offline** operation based on the stored database, for practicing on historical data.
4) (Planned) Execute trades directly inside the application.

### Security and How the Application Communicates

To receive tick data, this application **does not connect to any external server or third-party service**. It communicates exclusively with the **MetaTrader terminal**. Data is retrieved and processed through the **official MetaTrader API for Python**.

The application **does not need to receive, store, or transmit your trading account username and password**. Login credentials remain solely with the MetaTrader terminal.

Therefore, tick data is received directly from the MetaTrader terminal, and **no external server or intermediary is required** to obtain or process it.