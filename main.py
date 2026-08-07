"""Lain's Writing Tools - entry point.

Runs the FastAPI app via uvicorn and opens the browser.
"""
import threading
import webbrowser

import uvicorn

from app.main import create_app

HOST = "127.0.0.1"
PORT = 8000


def _open_browser() -> None:
    webbrowser.open(f"http://{HOST}:{PORT}")


def main() -> None:
    app = create_app()
    timer = threading.Timer(1.2, _open_browser)
    timer.daemon = True
    timer.start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
