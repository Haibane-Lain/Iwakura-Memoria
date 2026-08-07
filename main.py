"""Iwakura Memoria - entry point.

Starts the FastAPI server and opens the app in a native desktop window
(via pywebview) or falls back to the system browser.
"""

from __future__ import annotations

import ctypes
import sys
import threading
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

import uvicorn

from app.main import create_app

HOST = "127.0.0.1"
PORT = 8000
URL = f"http://{HOST}:{PORT}"

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


def _start_server() -> threading.Thread:
    """Start uvicorn in a daemon thread. Returns the thread."""
    app = create_app()
    server = threading.Thread(
        target=uvicorn.run,
        args=(app,),
        kwargs={"host": HOST, "port": PORT, "log_level": "info"},
        daemon=True,
    )
    server.start()
    return server


def _run_browser() -> None:
    """Original browser-launch path (--browser flag)."""
    app = create_app()
    threading.Timer(0.5, lambda: _start_grammar()).start()
    threading.Timer(1.2, lambda: __import__("webbrowser").open(URL)).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


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
    if "--browser" in sys.argv:
        _run_browser()
        return

    _run_desktop()


if __name__ == "__main__":
    main()
