# Contributing

Thanks for your interest in MetaTrader Tick Explorer!

## Reporting bugs / requesting features
Open an [issue](https://github.com/msbxcii/MetaTraderTickExplorer/issues) with: app version (Settings > About), Windows version, steps to reproduce, and the relevant log file from the `logs` folder.

## Pull requests
1. Fork the repo and create a branch from `main`.
2. Set up: `pip install -r requirements.txt`, run with `run_chart.cmd`.
3. Keep changes focused; one feature/fix per PR.
4. Test with a **Demo** account, never a real one, especially for anything touching `trade_engine.py`.
5. Make sure `python -m compileall -q src` passes and `build.cmd` still builds.
6. Describe what you changed and why.

By contributing, you agree your contributions are licensed under the [Apache License 2.0](LICENSE).
