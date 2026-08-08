
@echo off
cd /d "%~dp0"
.venv\Scripts\python.exe main.py --browser
if errorlevel 1 (
  echo.
  echo The app failed to start. Check that dependencies are installed:
  echo   .venv\Scripts\python.exe -m pip install -r requirements.txt
  pause


)
