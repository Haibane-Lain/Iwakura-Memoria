"""Health-probe log silencing: unit tests for the filter and its wiring."""
from __future__ import annotations

import logging
import logging.config

from app.logging_filters import HealthProbeFilter
from main import _logging_config


def _record(method: str, path: str, status: int = 404) -> logging.LogRecord:
    """A record shaped like uvicorn's access log:
    '%s - "%s %s HTTP/%s" %d', client, method, path, version, status.
    """
    return logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        0,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:61922", method, path, "1.1", status),
        None,
    )


def test_filter_drops_get_health():
    filt = HealthProbeFilter()
    assert filt.filter(_record("GET", "/health")) is False
    # The probe is meaningless regardless of what we answer.
    assert filt.filter(_record("GET", "/health", 200)) is False


def test_filter_keeps_real_traffic():
    filt = HealthProbeFilter()
    assert filt.filter(_record("GET", "/api/projects")) is True
    assert filt.filter(_record("GET", "/js/project.js")) is True
    assert filt.filter(_record("POST", "/api/grammar/check", 503)) is True
    # A different method or a longer path is not the probe.
    assert filt.filter(_record("POST", "/health")) is True
    assert filt.filter(_record("GET", "/health/check")) is True


def test_filter_tolerates_malformed_records():
    filt = HealthProbeFilter()
    assert filt.filter(logging.LogRecord("uvicorn.access", logging.INFO, __file__, 0, "x", None, None)) is True
    assert filt.filter(logging.LogRecord("uvicorn.access", logging.INFO, __file__, 0, "x", ("a", "b"), None)) is True


def test_logging_config_wires_the_filter():
    cfg = _logging_config()
    assert cfg["filters"]["health_probe"]["()"] == "app.logging_filters.HealthProbeFilter"
    assert cfg["handlers"]["access"]["filters"] == ["health_probe"]


def test_dictconfig_installs_filter_that_silences_probes():
    # This is exactly what uvicorn does at startup; the filter must survive it.
    logging.config.dictConfig(_logging_config())
    logger = logging.getLogger("uvicorn.access")

    def access_handler():
        return next(
            h for h in logger.handlers
            if any(isinstance(f, HealthProbeFilter) for f in getattr(h, "filters", []))
        )

    handler = access_handler()
    # Py3.14+ Handler.filter() returns the record (truthy) on accept and
    # False on reject — assert truthiness, not identity.
    assert not handler.filter(_record("GET", "/health"))
    assert handler.filter(_record("GET", "/api/projects"))
