@echo off
REM =============================================================================
REM run_chart.cmd - V68
REM
REM The launcher keeps a visible Cmd window for source launches. V66.2 removes
REM ALL automatic package installation. Before the chart starts, a small
REM read-only checker reports whether every entry in requirements.txt is
REM installed and importable. Missing requirements are only logged; the script
REM never runs pip install automatically. The user is given the exact manual
REM command instead.
REM =============================================================================
chcp 65001 >nul
title MetaTrader Tick Explorer V68 (live chart)
cd /d "%~dp0"

echo ============================================================
echo   MetaTrader Tick Explorer V68 (live chart)
echo   Checking runtime requirements (read-only) ...
echo   No package installation will be performed automatically.
echo ============================================================
echo.
echo Current directory: %cd%
echo.

REM Check that Python is installed
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found on this system, or is not on PATH.
    echo [ACTION] Install Python from python.org and ensure it is available on PATH.
    echo.
    pause
    exit /b 1
)

python "src\requirements_check.py"
if errorlevel 1 (
    echo.
    echo [ERROR] The chart will not start until the missing requirements are installed.
    echo [ACTION] From this folder, run manually:
    echo          python -m pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)

echo.
echo [Step 1] Opening the live chart window ...
echo ------------------------------------------------------------
echo.

python "src\app.py"

echo.
echo ------------------------------------------------------------
echo run_chart.cmd finished.
pause
