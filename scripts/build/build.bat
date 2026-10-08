@echo off
REM =====================================================================
REM  Iwakura Memoria - one-shot distribution build
REM
REM  Produces a Windows installer .exe (electron-builder NSIS) that bundles:
REM    - the Electron shell
REM    - the FastAPI server frozen with PyInstaller
REM    - LanguageTool + a bundled JRE (grammar works with no Java install)
REM    - WordNet 3.0 (offline Lookup works with no extra install)
REM    - the static frontend (inside the server exe)
REM
REM  Single entry point:  scripts\build\build.bat
REM
REM  Everything the build needs is detected and, when missing, fetched
REM  automatically by scripts\build\prepare.ps1:
REM    - the .venv and its pip requirements, npm deps (root + electron)
REM    - LanguageTool, WordNet and a Temurin JRE (pinned in toolchain.json)
REM  Downloads are cached under scripts\build\_cache\ and checksum-verified.
REM  Missing Python / Node are NOT installed; the build stops with a link.
REM
REM  Flags:
REM    --force         re-download and re-extract every artifact
REM    --no-download   never touch the network (fail if something is missing)
REM    --only a,b      limit prep to a subset: python,node,languagetool,wordnet,jre
REM    --nopause       skip the final pause (for CI / scripting)
REM
REM  Notes:
REM   - Avoids multi-line parenthesized IF blocks on purpose: cmd.exe's parser
REM     mishandles them in LF-only batch files ("was unexpected at this time").
REM   - Every step's output goes to scripts\build\build-run.log; on failure the
REM     last 40 lines are printed.
REM =====================================================================
setlocal
REM %~dp0 is only valid for %0; the argument parser below calls shift, which
REM reassigns %0 and would corrupt %~dp0. Capture it once, up front.
set "HERE=%~dp0"
cd /d "%HERE%..\.."

set "LOG=%HERE%build-run.log"
set "PAUSE=1"
set "PREPARE_ARGS="

:parse
if "%~1"=="" goto :parsed
if /I "%~1"=="--nopause" goto :arg_nopause
if /I "%~1"=="--force" goto :arg_force
if /I "%~1"=="--no-download" goto :arg_nodownload
if /I "%~1"=="--only" goto :arg_only
goto :arg_next

:arg_nopause
set "PAUSE=0"
goto :arg_next

:arg_force
set "PREPARE_ARGS=%PREPARE_ARGS% -Force"
goto :arg_next

:arg_nodownload
set "PREPARE_ARGS=%PREPARE_ARGS% -Offline"
goto :arg_next

:arg_only
shift
set "PREPARE_ARGS=%PREPARE_ARGS% -Only %~1"
goto :arg_next

:arg_next
shift
goto :parse

:parsed
if exist "%LOG%" del "%LOG%"
echo [build] log: %LOG%

echo [build] - Preparing build dependencies (Python, Node, LanguageTool, WordNet, JRE)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%prepare.ps1" %PREPARE_ARGS% -LogPath "%LOG%"
REM A missing -File target exits with a negative code, which `if errorlevel 1`
REM would miss; compare for exactly zero instead.
if not "%ERRORLEVEL%"=="0" goto :fail

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
if "%PAUSE%"=="1" pause
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
if "%PAUSE%"=="1" pause
exit /b 1
