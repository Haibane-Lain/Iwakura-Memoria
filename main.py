"""Iwakura Memoria - entry point.

Starts the FastAPI server and opens the app in a native desktop window
(via pywebview) or falls back to the system browser.
"""

from __future__ import annotations

import copy
import ctypes
import sys
import threading
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

import uvicorn
from uvicorn.config import LOGGING_CONFIG as UVICORN_LOGGING_CONFIG

from app.main import create_app

HOST = "127.0.0.1"
PORT = 8000
URL = f"http://{HOST}:{PORT}"


def _logging_config() -> dict:
    """uvicorn's default logging config plus the health-probe filter.

    The filter must live in the config (not be attached to the logger later):
    uvicorn re-runs ``logging.config.dictConfig`` at startup, which would wipe
    a filter attached at import time.
    """
    cfg = copy.deepcopy(UVICORN_LOGGING_CONFIG)
    cfg.setdefault("filters", {})["health_probe"] = {
        "()": "app.logging_filters.HealthProbeFilter",
    }
    access_handler = cfg.get("handlers", {}).get("access")
    if isinstance(access_handler, dict):
        access_handler.setdefault("filters", []).append("health_probe")
    return cfg

WM_NCLBUTTONDOWN = 0xA1
SPI_GETWORKAREA = 0x0030

HT_LEFT = 10
HT_RIGHT = 11
HT_TOP = 12
HT_TOPLEFT = 13
HT_TOPRIGHT = 14
HT_BOTTOM = 15
HT_BOTTOMLEFT = 16
HT_BOTTOMRIGHT = 17

HT_MAP: dict[str, int] = {
    "n": HT_TOP,
    "s": HT_BOTTOM,
    "e": HT_RIGHT,
    "w": HT_LEFT,
    "ne": HT_TOPRIGHT,
    "nw": HT_TOPLEFT,
    "se": HT_BOTTOMRIGHT,
    "sw": HT_BOTTOMLEFT,
}


class _RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


def _get_working_area() -> tuple[int, int, int, int]:
    rect = _RECT()
    ctypes.windll.user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0)
    return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top


def _wait_for_server(timeout: float = 10.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(URL, timeout=0.5)
            return True
        except Exception:
            time.sleep(0.2)
    return False


def _start_grammar() -> None:
    """Start the bundled LanguageTool server (best-effort, non-blocking)."""
    from app.services.grammar import start_lt_server
    try:
        start_lt_server()
    except Exception as exc:
        print(f"[Grammar] LanguageTool not available: {exc}", file=sys.stderr)


def _start_server(port: int = PORT) -> threading.Thread:
    """Start uvicorn in a daemon thread. Returns the thread."""
    app = create_app()
    server = threading.Thread(
        target=uvicorn.run,
        args=(app,),
        kwargs={
            "host": HOST,
            "port": port,
            "log_level": "info",
            "log_config": _logging_config(),
        },
        daemon=True,
    )
    server.start()
    return server


def _run_server_only(port: int = PORT) -> None:
    """Headless server mode: uvicorn + grammar, no window (used by the
    Electron shell and by headless testing)."""
    server = _start_server(port)
    url = f"http://{HOST}:{port}"
    deadline = time.time() + 10.0
    while time.time() < deadline:
        if not server.is_alive():
            print("Server failed to start.", file=sys.stderr)
            sys.exit(1)
        try:
            urllib.request.urlopen(url, timeout=0.5)
            break
        except Exception:
            time.sleep(0.2)

    threading.Thread(target=_start_grammar, daemon=True).start()
    print(f"[server-only] ready on {url}", file=sys.stderr)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down.", file=sys.stderr)


def _parse_port(argv: list[str]) -> int:
    """Read ``--port <n>`` from argv (used with --server-only)."""
    for i, arg in enumerate(argv):
        if arg == "--port" and i + 1 < len(argv):
            try:
                return int(argv[i + 1])
            except ValueError:
                pass
    return PORT


def _run_browser() -> None:
    """Original browser-launch path (--browser flag)."""
    app = create_app()
    threading.Timer(0.5, lambda: _start_grammar()).start()
    threading.Timer(1.2, lambda: __import__("webbrowser").open(URL)).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info", log_config=_logging_config())


class _WindowApi:
    """Exposed to the frontend via pywebview's JS bridge."""

    def __init__(self) -> None:
        self._maximized = False
        self._fullscreen = False
        self._saved_x = 0
        self._saved_y = 0
        self._saved_w = 0
        self._saved_h = 0

    def minimize(self) -> None:
        import webview
        webview.active_window().minimize()

    def toggle_maximize(self) -> None:
        import webview
        w = webview.active_window()

        if self._maximized:
            w.move(self._saved_x, self._saved_y)
            w.resize(self._saved_w, self._saved_h)
            self._maximized = False
        else:
            self._saved_x = w.x
            self._saved_y = w.y
            self._saved_w = w.width
            self._saved_h = w.height

            la, ta, width, height = _get_working_area()
            w.move(la, ta)
            w.resize(width, height)
            self._maximized = True

    def toggle_fullscreen(self) -> None:
        import webview
        w = webview.active_window()
        w.toggle_fullscreen()
        self._fullscreen = not self._fullscreen

    def start_resize(self, direction: str | None = None) -> None:
        hit = HT_MAP.get(direction or "", 0)
        if not hit:
            return
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        ctypes.windll.user32.ReleaseCapture()
        ctypes.windll.user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, hit, 0)

    def export_with_dialog(self, project_id: str, fmt: str, folders: list[str] | None = None) -> dict:
        """Generate export and prompt user for save location. Returns {ok, cancelled?, path?}."""
        from webview import FileDialog

        from app.services.projects import export_zip, export_docx, export_pdf, export_epub

        ext_map: dict[str, str] = {"zip": ".zip", "docx": ".docx", "pdf": ".pdf", "epub": ".epub"}
        type_map: dict[str, str] = {
            "zip": "ZIP archive (*.zip)",
            "docx": "Word Document (*.docx)",
            "pdf": "PDF file (*.pdf)",
            "epub": "EPUB e-book (*.epub)",
        }
        ext = ext_map.get(fmt, ".zip")
        ftype = type_map.get(fmt, "All files (*.*)")

        import webview
        result = webview.active_window().create_file_dialog(
            dialog_type=FileDialog.SAVE,
            save_filename=f"{project_id}-writing{ext}",
            file_types=(ftype,),
        )
        if not result:
            return {"ok": False, "cancelled": True}
        filepath = result[0] if isinstance(result, (list, tuple)) else str(result)

        try:
            if fmt == "zip":
                data = export_zip(project_id, folders)
            elif fmt == "docx":
                data = export_docx(project_id, folders)
            elif fmt == "pdf":
                data = export_pdf(project_id, folders)
            elif fmt == "epub":
                data = export_epub(project_id, folders)
            else:
                return {"ok": False, "error": f"Unknown format: {fmt}"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

        Path(filepath).write_bytes(data)
        return {"ok": True, "path": filepath}

    def close(self) -> None:
        import webview
        webview.active_window().destroy()


def _run_desktop() -> None:
    """Start server in daemon thread, open native window. Fall back to browser on failure."""
    server = _start_server()

    if not _wait_for_server():
        print("Server failed to start.", file=sys.stderr)
        sys.exit(1)

    threading.Thread(target=_start_grammar, daemon=True).start()

    try:
        import webview

        webview.create_window(
            "Iwakura Memoria",
            URL,
            width=1200,
            height=800,
            frameless=True,
            easy_drag=False,
            shadow=False,
            js_api=_WindowApi(),
        )
        webview.start()
    except Exception as exc:
        print(f"Desktop mode unavailable ({exc}). Opening in browser instead.", file=sys.stderr)
        __import__("webbrowser").open(URL)
        try:
            while server.is_alive():
                server.join(1)
        except KeyboardInterrupt:
            print("\nGoodbye.")


def main() -> None:
    if "--server-only" in sys.argv:
        _run_server_only(_parse_port(sys.argv))
        return

    if "--browser" in sys.argv:
        _run_browser()
        return

    if getattr(sys, "frozen", False):
        # The packaged server exe is a backend component — the Electron shell
        # spawns it with --server-only. Double-clicked alone it can't open the
        # app window (the pywebview window path is not bundled), so explain
        # instead of hijacking the user's browser with a fallback tab.
        print(
            "This is Iwakura Memoria's server component. Launch the app from the "
            "'Iwakura Memoria' shortcut, or run with --server-only for the "
            "headless server.",
            file=sys.stderr,
        )
        return

    _run_desktop()


if __name__ == "__main__":
    main()
