@echo off
REM =====================================================================
REM  Iwakura Memoria - one-shot distribution build
REM
REM  Produces a Windows installer .exe (electron-builder NSIS) that bundles:
REM    - the Electron shell
REM    - the FastAPI server frozen with PyInstaller
REM    - LanguageTool + a bundled JRE (grammar works with no Java install)
REM    - the static frontend (inside the server exe)
REM
REM  Single entry point:  scripts\build\build.bat
REM
REM  On failure the window PAUSES so the error stays readable (and a copy of
REM  the last output is in scripts\build\build-run.log). Pass --nopause to
REM  skip the pause (for CI / scripting).
REM =====================================================================
setlocal
cd /d "%~dp0..\.."

set "LOG=%~dp0build-run.log"
if exist "%LOG%" del "%LOG%"
echo [build] log: %LOG%

echo [build] - Installing Python build deps (PyInstaller)...
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt > "%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [build] - Building the frontend bundle (static/dist/editor.bundle.js)...
call npm run build > "%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [build] - Freezing the Python server with PyInstaller...
if exist "scripts\build\_bundle" rmdir /s /q "scripts\build\_bundle"
.venv\Scripts\python.exe -m PyInstaller --noconfirm --distpath "scripts\build\_bundle\server" --workpath "scripts\build\_pyinstaller-work" scripts\build\app.spec > "%LOG%" 2>&1
if errorlevel 1 goto :fail
if not exist "scripts\build\_bundle\server\Iwakura-Memoria-server.exe" (
  echo [build] PyInstaller finished without producing the server exe.
  goto :fail
)

echo [build] - Building the installer with electron-builder...
pushd electron
if not exist "node_modules\electron-builder" (
  echo [build] Installing electron-builder (one-time)...
  call npm install >> "%LOG%" 2>&1
)
call npm run dist > "%LOG%" 2>&1
set RESULT=%ERRORLEVEL%
popd
if not %RESULT% equ 0 goto :fail

echo.
echo [build] SUCCESS - installer written to dist\electron\*.exe
echo.
if not /I "%~1"=="--nopause" pause
exit /b 0

:fail
echo.
echo ****************** BUILD FAILED ******************
echo.
if exist "%LOG%" (
  echo --- last 40 lines of %LOG% ---
  setlocal EnableDelayedExpansion
  set "LOGQ=!LOG:'=''!"
  endlocal & powershell -NoProfile -Command "Get-Content -LiteralPath '%LOGQ%' -Tail 40"
  echo ---------------------------------------------
) else (
  echo (no log file was produced)
)
echo.
if /I not "%~1"=="--nopause" pause
exit /b 1