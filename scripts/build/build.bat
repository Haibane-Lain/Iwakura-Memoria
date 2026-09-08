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
REM =====================================================================
setlocal
cd /d "%~dp0..\.."

echo [build] - Installing Python build deps (PyInstaller)...
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
if errorlevel 1 ( echo Failed to install Python build deps & exit /b 1 )

echo [build] - Building the frontend bundle (static/dist/editor.bundle.js)...
call npm run build
if errorlevel 1 ( echo Frontend build failed & exit /b 1 )

echo [build] - Freezing the Python server with PyInstaller...
if exist "scripts\build\_bundle" rmdir /s /q "scripts\build\_bundle"
.venv\Scripts\python.exe -m PyInstaller --noconfirm --distpath "scripts\build\_bundle\server" --workpath "scripts\build\_pyinstaller-work" scripts\build\app.spec
if errorlevel 1 ( echo PyInstaller failed & exit /b 1 )

echo [build] - Building the installer with electron-builder...
pushd electron
if not exist "node_modules\electron-builder" (
  echo Installing electron-builder (one-time)...
  call npm install
)
call npm run dist
set RESULT=%ERRORLEVEL%
popd
if not %RESULT% neq 0 goto :done

echo.
echo Installer written to dist\electron\*.exe
exit /b 0

:done
endlocal
exit /b %RESULT%
