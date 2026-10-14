"""Persistence for the anonymous /v1/web/events analytics endpoint.

Kept separate from app.analytics (the in-product agent telemetry): website
marketing data is a different namespace and must not pollute the product funnel in
telemetry_events / metrics_snapshot.

Every write is BEST-EFFORT: the endpoint is anonymous and must always return 204. A DB
outage (or a no-DB context like local dev / the `no_db` test suite, where db.connect()
raises RuntimeError) is swallowed and logged, never surfaced to the caller.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from app import db

logger = logging.getLogger("mpyhw.web_store")

web_write_failure_count = 0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def record_web_event(event_type: str, payload: dict[str, Any], locale: str, source: str) -> None:
    """Persist one frontend analytics event. Payload is already size-capped by
    RequestBodyLimitMiddleware (2 KB), so it is stored as-is. Best-effort."""
    from psycopg.types.json import Jsonb

    try:
        with db.connect() as conn:
            db.execute(
                conn,
                "INSERT INTO web_events(event_type, payload_json, locale, source, created_at) VALUES(?,?,?,?,?)",
                (event_type, Jsonb(payload or {}), locale, source, _now()),
            )
            conn.commit()
    except Exception:
        global web_write_failure_count
        web_write_failure_count += 1
        logger.warning("web event persist failed; dropped (type=%s)", event_type, exc_info=True)
