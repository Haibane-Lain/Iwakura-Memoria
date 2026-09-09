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
REM  Notes:
REM   - Avoids multi-line parenthesized IF blocks on purpose: cmd.exe's parser
REM     mishandles them in LF-only batch files ("was unexpected at this time").
REM   - On success OR failure the window pauses so the outcome stays readable
REM     (pass --nopause to skip the pause, for CI/scripting).
REM   - Every step's output goes to scripts\build\build-run.log; on failure the
REM     last 40 lines are printed.
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
if not exist "scripts\build\_bundle\server\Iwakura-Memoria-server.exe" goto :no_exe

echo [build] - Building the installer with electron-builder...
pushd electron
if exist "node_modules\electron-builder" goto :builder_ready
echo [build] Installing electron-builder (one-time)...
call npm install >> "%LOG%" 2>&1
:builder_ready
call npm run dist > "%LOG%" 2>&1
set RESULT=%ERRORLEVEL%
popd
if not %RESULT% equ 0 goto :fail

echo.
echo [build] SUCCESS - installer written to dist\electron\*.exe
echo.
if /I not "%~1"=="--nopause" pause
exit /b 0

:no_exe
echo [build] PyInstaller finished without producing the server exe.
goto :fail

:fail
echo.
echo ****************** BUILD FAILED ******************
echo.
if not exist "%LOG%" goto :no_log
echo --- last 40 lines of %LOG% ---
setlocal EnableDelayedExpansion
set "LOGQ=!LOG:'=''!"
endlocal & powershell -NoProfile -Command "Get-Content -LiteralPath '%LOGQ%' -Tail 40"
echo ---------------------------------------------
goto :fail_end
:no_log
echo (no log file was produced)
:fail_end
echo.
if /I not "%~1"=="--nopause" pause
exit /b 1