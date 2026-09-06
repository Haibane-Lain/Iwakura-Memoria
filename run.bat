@echo off
REM =====================================================================
REM  Iwakura Memoria - launcher
REM
REM  Default: the Electron shell (electron/main.js) spawns the Python
REM  server headlessly (main.py --server-only on a free port 8000-8009)
REM  and renders the same frontend in a native window.
REM
REM  Legacy pywebview window:  run.bat --pywebview
REM =====================================================================
cd /d "%~dp0"

if /I "%~1"=="--pywebview" goto pywebview

REM --- Electron shell (default) ----------------------------------------
if not exist "electron\node_modules" (
  echo Electron shell dependencies are missing, installing...
  call npm --prefix electron install
  if errorlevel 1 (
    echo.
    echo Failed to install Electron dependencies. Is Node.js installed?
    echo   https://nodejs.org/
    pause
    exit /b 1
  )
)

echo Starting Iwakura Memoria (Electron shell)...
call npm --prefix electron start
if errorlevel 1 (
  echo.
  echo The app failed to start. Check that Python dependencies are installed:
  echo   .venv\Scripts\python.exe -m pip install -r requirements.txt
  pause
)
exit /b 0

:pywebview
REM --- Legacy pywebview window -----------------------------------------
.venv\Scripts\python.exe main.py
if errorlevel 1 (
  echo.
  echo The app failed to start. Check that dependencies are installed:
  echo   .venv\Scripts\python.exe -m pip install -r requirements.txt
  pause
)