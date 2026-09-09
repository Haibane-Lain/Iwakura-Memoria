# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec: bundle the FastAPI server into a single server.exe.

Build (from the repo root):

    .venv\\Scripts\\python.exe -m pip install -r requirements-dev.txt   # adds pyinstaller
    .venv\\Scripts\\python.exe -m PyInstaller scripts\\build\\app.spec   # -> dist/app/server.exe

The frozen server runs the same headless entry point the Electron shell always
used in dev:

    server.exe --server-only --port 8000

`config._resolve_static_dir()` already returns `_MEIPASS/static` under
PyInstaller, so the frontend (including `static/dist/editor.bundle.js`) is read
from the bundle. Build the frontend bundle first:

    npm run build

User data is *not* bundled or touched: it lives in %LOCALAPPDATA%/IwakuraMemoria
at runtime via the normal config path resolution.
"""

import os

from PyInstaller.utils.hooks import collect_submodules

# PyInstaller runs the spec with SPEC/SPECPATH globals (no __file__). The spec
# lives at <repo>/scripts/build/; repo root is two levels up.
SPEC_DIR = os.path.dirname(os.path.abspath(SPEC))
ROOT = os.path.abspath(os.path.join(SPEC_DIR, "..", ".."))

# Every runtime import under app/ and the routes/services/ai packages.
hiddenimports = (
    collect_submodules("app")
    # uvicorn[standard] pulls these dynamically (workers/transports), and
    # PyInstaller can't always see them from main.py's `uvicorn.run` import.
    + collect_submodules("uvicorn")
    + collect_submodules("websockets")
    + collect_submodules("httptools")
    + [
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.lifespan.on",
        "watchfiles",
    ]
)

# Package the whole static tree, including the esbuild-built editor bundle.
datas = [
    (os.path.join(ROOT, "static").replace("\\", "/"), "static"),
]

a = Analysis(
    [os.path.join(ROOT, "main.py")],
    pathex=[ROOT],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        # The legacy pywebview window is never used by the frozen exe (Electron
        # is the shell); dropping it trims a big chunk of the bundle.
        "webview",
        "pywebview",
        # Not needed server-side; keeps the onefile smaller.
        "tkinter",
        "PyQt5", "PySide6",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="Iwakura-Memoria-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,        # keep a console so the access log / errors are visible
    disable_windowed_traceback=False,
)
