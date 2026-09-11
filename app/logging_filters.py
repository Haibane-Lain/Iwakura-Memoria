"""Logging filters used to keep the server console focused."""
from __future__ import annotations

import logging


class HealthProbeFilter(logging.Filter):
    """Drop access-log lines for external localhost health probes.

    Unknown callers occasionally hit ``GET /health`` and receive a 404; the
    requests carry no meaning to the app but spam the console. Matched on
    uvicorn's access-log arguments::

        '%s - "%s %s HTTP/%s" %d', client, method, path, version, status

    Only the exact probe (``GET`` of ``/health``) is silenced — real traffic
    and other mistakes still show up.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not isinstance(args, tuple) or len(args) < 3:
            return True
        return not (args[1] == "GET" and args[2] == "/health")
