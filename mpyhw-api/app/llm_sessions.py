from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

from app import db

# 2, not 1: a single user turn opens the main agent stream AND, while it is still
# draining, the generate_code tool opens a nested /v1/llm/messages stream for
# codegen. With a limit of 1 the nested call collides with its own parent's slot
# and 429s, so codegen never runs. Cost is still bounded per turn by credits.
DEFAULT_USER_LIMIT = 2
DEFAULT_GLOBAL_LIMIT = 30
DEFAULT_TTL_SECONDS = 120

# Fixed key for the transaction-scoped advisory lock that serializes acquire().
# A single lock is enough: the check-and-insert critical section is sub-millisecond
# and concurrency is low, so serializing all acquires keeps both the per-user and
# global limits exact without a meaningful throughput cost.
ACQUIRE_LOCK_KEY = 982451653


def user_limit() -> int:
    return int(os.getenv("MPYHW_USER_CONCURRENCY_LIMIT", str(DEFAULT_USER_LIMIT)))


def global_limit() -> int:
    return int(os.getenv("MPYHW_GLOBAL_CONCURRENCY_LIMIT", str(DEFAULT_GLOBAL_LIMIT)))


def ttl_seconds() -> int:
    return int(os.getenv("MPYHW_LLM_SESSION_TTL_SECONDS", str(DEFAULT_TTL_SECONDS)))


def acquire(
    session_id: str,
    user: dict[str, Any],
    *,
    user_limit_value: int | None = None,
    global_limit_value: int | None = None,
    ttl_seconds: int | None = None,
) -> str | None:
    """Return an error key if no slot is available, otherwise create a slot."""
    cleanup_stale(ttl_seconds=globals()["ttl_seconds"]() if ttl_seconds is None else ttl_seconds)
    uid = str(user["id"])
    limit_user = user_limit() if user_limit_value is None else user_limit_value
    limit_global = global_limit() if global_limit_value is None else global_limit_value
    now = datetime.now(timezone.utc).isoformat()
    with db.connect() as conn:
        try:
            # Serialize the check-and-insert: without this, two concurrent requests
            # can both read COUNT=0 and both insert, bypassing the limit. The lock is
            # transaction-scoped and auto-releases on the commit/rollback below.
            db.execute(conn, "SELECT pg_advisory_xact_lock(?)", (ACQUIRE_LOCK_KEY,))
            user_active = db.fetchone(
                conn,
                "SELECT COUNT(*) AS count FROM active_llm_sessions WHERE user_id=? AND status='active'",
                (uid,),
            )["count"]
            if user_active >= limit_user:
                conn.rollback()
                return "user_concurrency_limit"
            global_active = db.fetchone(
                conn,
                "SELECT COUNT(*) AS count FROM active_llm_sessions WHERE status='active'",
            )["count"]
            if global_active >= limit_global:
                conn.rollback()
                return "global_concurrency_limit"
            db.execute(
                conn,
                "INSERT INTO active_llm_sessions(session_id, user_id, started_at, last_seen_at, status) VALUES(?,?,?,?,?)",
                (session_id, uid, now, now, "active"),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return None


def release(session_id: str, status: str = "released") -> None:
    now = datetime.now(timezone.utc).isoformat()
    with db.connect() as conn:
        db.execute(
            conn,
            "UPDATE active_llm_sessions SET status=?, last_seen_at=? WHERE session_id=? AND status='active'",
            (status, now, session_id),
        )
        conn.commit()


def cleanup_stale(*, ttl_seconds: int | None = None) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=globals()["ttl_seconds"]() if ttl_seconds is None else ttl_seconds)
    with db.connect() as conn:
        result = db.execute(
            conn,
            "UPDATE active_llm_sessions SET status='stale' WHERE status='active' AND last_seen_at < ?",
            (cutoff.isoformat(),),
        )
        conn.commit()
        return result.rowcount


def counts() -> dict[str, Any]:
    cleanup_stale()
    with db.connect() as conn:
        global_row = db.fetchone(conn, "SELECT COUNT(*) AS count FROM active_llm_sessions WHERE status='active'")
        by_user = db.fetchall(
            conn,
            "SELECT user_id, COUNT(*) AS count FROM active_llm_sessions WHERE status='active' GROUP BY user_id",
        )
    return {"global": global_row["count"], "by_user": {row["user_id"]: row["count"] for row in by_user}}


def mark_last_seen_for_test(session_id: str, last_seen_at: datetime) -> None:
    with db.connect() as conn:
        db.execute(conn, "UPDATE active_llm_sessions SET last_seen_at=? WHERE session_id=?", (last_seen_at.isoformat(), session_id))
        conn.commit()
