"""Persistence for the anonymous website data-capture endpoints (newsletter
signups + frontend analytics events).

Kept separate from app.analytics (the in-product agent telemetry): website
marketing data is a different namespace and must not pollute the product funnel in
telemetry_events / metrics_snapshot.

Every write is BEST-EFFORT: the /v1/web/* endpoints are anonymous and must always
return 204, exactly as they did before they persisted anything. A DB outage (or a
no-DB context like local dev / the `no_db` test suite, where db.connect() raises
RuntimeError) is swallowed and logged, never surfaced to the caller. On a failed
newsletter write the email is logged so the lead is recoverable from logs.
"""

from __future__ import annotations

import logging
import uuid
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


def record_newsletter_signup(email: str, locale: str, source: str) -> None:
    """Persist one newsletter signup (idempotent on the normalized email). Best-effort:
    on failure the email is logged so a DB outage does not truly lose the lead."""
    normalized = email.strip().lower()
    try:
        with db.connect() as conn:
            db.execute(
                conn,
                "INSERT INTO newsletter_subscribers(email, locale, source, created_at) "
                "VALUES(?,?,?,?) ON CONFLICT(email) DO NOTHING",
                (normalized, locale, source, _now()),
            )
            conn.commit()
    except Exception:
        global web_write_failure_count
        web_write_failure_count += 1
        # Log the email so the signup is recoverable even when the DB write failed.
        logger.warning(
            "newsletter signup persist failed; email=%s locale=%s source=%s", normalized, locale, source, exc_info=True
        )


def record_recipe_upload(
    title: str,
    email: str | None,
    summary: str,
    recipe: dict[str, Any],
    locale: str,
    source: str,
) -> str:
    """Persist a website recipe upload for later review. Best-effort; returns a
    stable request id even when storage is unavailable so the frontend can show a
    real submission receipt instead of only a local draft."""
    from psycopg.types.json import Jsonb

    upload_id = f"upl_{uuid.uuid4().hex[:12]}"
    try:
        with db.connect() as conn:
            db.execute(
                conn,
                "INSERT INTO web_recipe_uploads(id, title, email, summary, recipe_json, locale, source, created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (upload_id, title, email, summary, Jsonb(recipe or {}), locale, source, _now()),
            )
            conn.commit()
    except Exception:
        global web_write_failure_count
        web_write_failure_count += 1
        logger.warning("recipe upload persist failed; id=%s title=%s email=%s", upload_id, title, email, exc_info=True)
    return upload_id


def record_quote_request(
    email: str,
    recipe_slug: str | None,
    recipe_title: str,
    goal: str,
    quantity: str,
    notes: str,
    locale: str,
    source: str,
) -> str:
    """Persist a manufacturing/productization lead. Best-effort, but logs the
    lead id and email on failure so it can be recovered from application logs."""
    quote_id = f"qt_{uuid.uuid4().hex[:12]}"
    try:
        with db.connect() as conn:
            db.execute(
                conn,
                "INSERT INTO web_quote_requests(id, email, recipe_slug, recipe_title, goal, quantity, notes, locale, source, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (quote_id, email, recipe_slug, recipe_title, goal, quantity, notes, locale, source, _now()),
            )
            conn.commit()
    except Exception:
        global web_write_failure_count
        web_write_failure_count += 1
        logger.warning("quote request persist failed; id=%s email=%s recipe=%s", quote_id, email, recipe_slug, exc_info=True)
    return quote_id
