"""Contract test for the desktop shells.

Two shells can host the frontend — pywebview (``main.py::_WindowApi``) and the
Electron shell (``electron/preload.js``) — and they are meant to be
interchangeable: the frontend feature-detects a single ``window.pywebview.api``
shape. This pins that shape (method names, IPC channels, bridge hardening)
without booting either shell.
"""
from __future__ import annotations

import ast
import re

from app import config

ROOT = config.PROJECT_ROOT


def _window_api_methods() -> set[str]:
    """Public methods on main.py's _WindowApi (what pywebview exposes)."""
    tree = ast.parse((ROOT / "main.py").read_text(encoding="utf-8"))
    klass = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "_WindowApi"
    )
    return {
        node.name
        for node in klass.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and not node.name.startswith("_")
    }


def _preload_api_methods() -> set[str]:
    """Keys of the object passed as ``api`` to ``exposeInMainWorld``.

    Anchored to the indentation of the first key so the nested object literals
    inside the method bodies (e.g. ``folders:``) are not mistaken for methods.
    """
    lines = (ROOT / "electron" / "preload.js").read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == "api: {")
    first = next(line for line in lines[start + 1 :] if line.strip())
    indent = len(first) - len(first.lstrip())
    methods: set[str] = set()
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if not stripped:
            continue
        if len(line) - len(line.lstrip()) < indent:
            break
        if len(line) - len(line.lstrip()) == indent:
            match = re.match(r"([A-Za-z_]\w*)\s*:", stripped)
            if match:
                methods.add(match.group(1))
    return methods


def test_preload_exposes_exactly_the_window_api():
    assert _preload_api_methods() == _window_api_methods()


def test_every_preload_channel_is_handled_by_the_main_process():
    preload = (ROOT / "electron" / "preload.js").read_text(encoding="utf-8")
    main = (ROOT / "electron" / "main.js").read_text(encoding="utf-8")
    invoked = set(re.findall(r'ipcRenderer\.invoke\(\s*"([^"]+)"', preload))
    handled = set(re.findall(r'ipcMain\.handle\(\s*"([^"]+)"', main))
    assert invoked, "the preload shim must call into the main process"
    assert invoked <= handled, f"unhandled IPC channels: {sorted(invoked - handled)}"


def test_electron_window_and_bridge_are_hardened():
    main = (ROOT / "electron" / "main.js").read_text(encoding="utf-8")
    preload = (ROOT / "electron" / "preload.js").read_text(encoding="utf-8")
    assert "contextIsolation: true" in main
    assert "nodeIntegration: false" in main
    assert "sandbox: true" in main
    assert 'exposeInMainWorld("pywebview"' in preload
