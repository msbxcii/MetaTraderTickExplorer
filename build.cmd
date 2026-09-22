@echo off
setlocal EnableExtensions DisableDelayedExpansion

REM =============================================================================
REM MetaTrader Tick Explorer - Release Build (V68)
REM
REM Builds the Windows release executable with:
REM   * exact application name: "MetaTrader Tick Explorer"
REM   * embedded icon from assets\Icon.ico
REM   * one-file executable
REM   * no console/CMD window (PyInstaller windowed mode)
REM   * bundled web/ resources required by pywebview
REM
REM Prerequisites:
REM   - Windows + Python on PATH
REM   - PyInstaller installed in the active Python environment
REM   - assets\Icon.ico supplied by the project owner
REM =============================================================================

cd /d "%~dp0"
if errorlevel 1 goto :error

echo ============================================================
echo   MetaTrader Tick Explorer - Release Build
echo ============================================================
echo.

echo [1/6] Checking Python ...
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found on PATH.
    goto :error
)
python --version
if errorlevel 1 goto :error

echo.
echo [2/6] Checking PyInstaller ...
python -m PyInstaller --version
if errorlevel 1 (
    echo [ERROR] PyInstaller is not available in this Python environment.
    echo [ACTION] Install it with: python -m pip install pyinstaller
    goto :error
)

echo.
echo [3/6] Checking build inputs ...
if not exist "src\app.py" (
    echo [ERROR] src\app.py was not found.
    goto :error
)
if not exist "web\index.html" (
    echo [ERROR] web\index.html was not found.
    goto :error
)
if not exist "web\get-started.html" (
    echo [ERROR] web\get-started.html was not found.
    goto :error
)
if not exist "web\About.md" (
    echo [ERROR] web\About.md was not found.
    goto :error
)
if not exist "assets\Icon.ico" (
    echo [ERROR] assets\Icon.ico was not found.
    echo [ACTION] Put your Windows ICO file at: assets\Icon.ico
    goto :error
)

echo [OK] Build inputs are present.

echo.
echo [4/6] Checking Python source syntax ...
python -m compileall -q src
if errorlevel 1 (
    echo [ERROR] Python source compilation failed.
    goto :error
)
echo [OK] Python source syntax is valid.

echo.
echo [5/6] Building release executable ...
if exist "build" rmdir /s /q "build"
if exist "dist" rmdir /s /q "dist"
mkdir "build" >nul 2>nul
mkdir "dist" >nul 2>nul

python -m PyInstaller --noconfirm --clean --workpath "build" --distpath "dist" "MetaTraderTickExplorer.spec"
if errorlevel 1 (
    echo [ERROR] PyInstaller build failed.
    goto :error
)

echo.
echo [6/6] Verifying final executable ...
if not exist "dist\MetaTrader Tick Explorer.exe" (
    echo [ERROR] Build completed without the expected executable:
    echo         dist\MetaTrader Tick Explorer.exe
    goto :error
)

for %%F in ("dist\MetaTrader Tick Explorer.exe") do echo [OK] %%~fF

echo.
echo ============================================================
echo   BUILD SUCCESSFUL
 echo   Output: dist\MetaTrader Tick Explorer.exe
echo ============================================================
echo.
echo This executable is built in windowed mode; no CMD window is
echo displayed when the release EXE is launched.
echo.
exit /b 0

:error
echo.
echo ============================================================
echo   BUILD FAILED
echo ============================================================
echo.
exit /b 1
