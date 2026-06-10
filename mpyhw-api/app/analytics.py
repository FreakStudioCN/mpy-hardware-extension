from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from app import db, llm_sessions

logger = logging.getLogger("mpyhw.analytics")

ALLOWED_EVENT_TYPES = {
    "auth_started",
    "auth_completed",
    "auth_failed",
    "credits_viewed",
    "session_started",
    "intent_submitted",
    "board_selected",
    "template_selected",
    "tool_dispatch",
    "tool_result",
    "package_resolved",
    "driver_context_loaded",
    "manifest_proposed",
    "plan_confirmed",
    "plan_cancelled",
    "code_generated",
    "audit_passed",
    "audit_failed",
    "deploy_checkpoint_shown",
    "deploy_confirmed",
    "deploy_cancelled",
    "device_scan_result",
    "package_installed",
    "main_written",
    "flash_started",
    "flash_finished",
    "serial_marker_seen",
    "serial_output",
    "runtime_error",
    "session_finished",
    "session_error",
    "session_cancelled",
    "repair_exhausted",
    "max_turns",
    "llm_turn_started",
    "llm_turn_finished",
    "llm_upstream_error",
    "credits_charged",
    # Existing MVP event names kept for client compatibility.
    "shim_call",
    "skill_loaded",
    "terminal",
    "error",
}

ingestion_failure_count = 0


def record_telemetry(events: list[dict[str, Any]]) -> None:
    from psycopg.types.json import Jsonb

    now = datetime.now(timezone.utc).isoformat()
    with db.connect() as conn:
        try:
            for event in events:
                payload = sanitize_payload(event.get("payload") or {})
                payload_value = Jsonb(payload)
                user_id = event.get("user_id")
                db.execute(
                    conn,
                    "INSERT INTO telemetry_events(trace_id, user_id, event_type, timestamp, payload_json, created_at) VALUES(?,?,?,?,?,?)",
                    (
                        event["trace_id"],
                        user_id,
                        event["event_type"],
                        event["timestamp"],
                        payload_value,
                        now,
                    ),
                )
                _update_session(conn, event, payload)
            conn.commit()
        except Exception:
            conn.rollback()
            global ingestion_failure_count
            ingestion_failure_count += 1
            logger.warning("telemetry ingestion failed; rolled back", exc_info=True)
            raise


# Telemetry is stored RAW (intent, generated code, serial, error text) so a trace is
# replayable. The only bound is a size guard: a single oversized field (a flapping
# device's serial flood, a giant file) is truncated — flagged `_truncated` — rather
# than dropped or 413'd. Backstop to the client-side guard in telemetry.ts; the route
# still enforces MAX_TELEMETRY_BYTES on the whole batch.
FIELD_BYTE_BUDGET = 48 * 1024


def sanitize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    guarded, truncated = _guard_size(payload)
    if truncated:
        guarded["_truncated"] = True
    return guarded


def _guard_size(value: Any) -> tuple[Any, bool]:
    if isinstance(value, str):
        if len(value.encode("utf-8")) > FIELD_BYTE_BUDGET:
            return value.encode("utf-8")[:FIELD_BYTE_BUDGET].decode("utf-8", "ignore"), True
        return value, False
    if isinstance(value, list):
        # Keep the tail within budget (recent serial lines matter most).
        kept: list[Any] = []
        truncated = False
        size = 0
        for element in reversed(value):
            guarded, element_truncated = _guard_size(element)
            truncated = truncated or element_truncated
            length = len(json.dumps(guarded, ensure_ascii=False, default=str).encode("utf-8"))
            if size + length > FIELD_BYTE_BUDGET and kept:
                truncated = True
                break
            kept.insert(0, guarded)
            size += length
        return kept, truncated
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        truncated = False
        for key, inner in value.items():
            guarded, inner_truncated = _guard_size(inner)
            out[key] = guarded
            truncated = truncated or inner_truncated
        return out, truncated
    return value, False


def record_llm_turn(
    *,
    trace_id: str | None,
    user_id: str | None,
    kind: str,
    model: str | None,
    started_at: datetime,
    total_tokens: int | None,
    credits_charged: int | None,
    status: str,
    error_kind: str | None = None,
) -> None:
    ended_at = datetime.now(timezone.utc)
    duration_ms = int((ended_at - started_at).total_seconds() * 1000)
    with db.connect() as conn:
        db.execute(
            conn,
            """
            INSERT INTO llm_turns(
                trace_id, user_id, kind, model, started_at, ended_at, duration_ms,
                input_tokens, output_tokens, total_tokens, credits_charged, status, error_kind
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                trace_id,
                user_id,
                kind,
                model,
                started_at.isoformat(),
                ended_at.isoformat(),
                duration_ms,
                None,
                None,
                total_tokens,
                credits_charged,
                status,
                error_kind,
            ),
        )
        conn.commit()


def telemetry_events(*, trace_id: str) -> list[dict[str, Any]]:
    with db.connect() as conn:
        rows = db.fetchall(
            conn,
            "SELECT event_type, payload_json, user_id FROM telemetry_events WHERE trace_id=? ORDER BY id",
            (trace_id,),
        )
    return [
        {"event_type": row["event_type"], "payload": _json(row["payload_json"]), "user_id": row["user_id"]}
        for row in rows
    ]


def llm_turns_for(*, trace_id: str) -> list[dict[str, Any]]:
    with db.connect() as conn:
        return db.fetchall(
            conn,
            """
            SELECT kind, model, status, error_kind, total_tokens, credits_charged,
                   duration_ms, started_at, ended_at
            FROM llm_turns WHERE trace_id=? ORDER BY id
            """,
            (trace_id,),
        )


def session_for(*, trace_id: str) -> dict[str, Any] | None:
    with db.connect() as conn:
        return db.fetchone(conn, "SELECT * FROM sessions WHERE trace_id=?", (trace_id,))


def metrics_snapshot() -> dict[str, Any]:
    llm_counts = llm_sessions.counts()
    day_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    with db.connect() as conn:
        llm_durations = [row["duration_ms"] for row in db.fetchall(conn, "SELECT duration_ms FROM llm_turns WHERE duration_ms IS NOT NULL")]
        session_durations = [
            row["duration_ms"]
            for row in db.fetchall(
                conn,
                """
                SELECT CAST(EXTRACT(EPOCH FROM (ended_at::timestamptz - started_at::timestamptz)) * 1000 AS INTEGER) AS duration_ms
                FROM sessions WHERE ended_at IS NOT NULL
                """,
            )
        ]
        terminal_distribution = _counts(
            conn,
            "SELECT COALESCE(terminal, 'active') AS key, COUNT(*) AS count FROM sessions GROUP BY COALESCE(terminal, 'active')",
        )
        event_counts = _counts(conn, "SELECT event_type AS key, COUNT(*) AS count FROM telemetry_events GROUP BY event_type")
        tokens_session = db.fetchone(conn, "SELECT AVG(total_tokens) AS avg FROM llm_turns WHERE total_tokens IS NOT NULL")["avg"]
        credits_session = db.fetchone(conn, "SELECT AVG(credits_charged) AS avg FROM llm_turns WHERE credits_charged IS NOT NULL")["avg"]
        credits_day = db.fetchone(
            conn,
            """
            SELECT AVG(spent) AS avg FROM (
                SELECT user_id, created_at::date AS day, SUM(-credits) AS spent
                FROM credit_ledger
                WHERE credits < 0 AND action <> 'admin_set'
                GROUP BY user_id, created_at::date
            ) user_days
            """,
        )["avg"]
        daily_active_users = db.fetchone(conn, "SELECT COUNT(*) AS count FROM users WHERE last_seen_at::timestamptz >= ?::timestamptz", (day_start,))["count"]
        new_users_day = db.fetchone(conn, "SELECT COUNT(*) AS count FROM users WHERE created_at::timestamptz >= ?::timestamptz", (day_start,))["count"]
        returning_users_day = db.fetchone(
            conn,
            "SELECT COUNT(*) AS count FROM users WHERE last_seen_at::timestamptz >= ?::timestamptz AND created_at::timestamptz < ?::timestamptz",
            (day_start, day_start),
        )["count"]
    return {
        "active_sse_count": llm_counts["global"],
        "active_sessions": llm_counts,
        "llm_upstream_error_rate": _rate(event_counts.get("llm_upstream_error", 0), event_counts.get("llm_turn_finished", 0)),
        "llm_turn_duration_ms": _percentiles(llm_durations),
        "session_duration_ms": _percentiles(session_durations, include_p99=False),
        "tokens_per_session": tokens_session or 0,
        "credits_per_session": credits_session or 0,
        "credits_per_user_day": credits_day or 0,
        "audit_failure_rate": _rate(event_counts.get("audit_failed", 0), event_counts.get("audit_passed", 0)),
        "rejected_imports": event_counts.get("audit_failed", 0),
        "package_resolve_success_rate": _rate(event_counts.get("package_resolved", 0), event_counts.get("tool_dispatch", 0)),
        "deploy_confirmation_rate": _rate(event_counts.get("deploy_confirmed", 0), event_counts.get("deploy_checkpoint_shown", 0)),
        "flash_success_rate": _rate(event_counts.get("flash_finished", 0), event_counts.get("flash_started", 0)),
        "serial_marker_success_rate": _rate(event_counts.get("serial_marker_seen", 0), event_counts.get("flash_finished", 0)),
        "repair_loop_rate": _rate(event_counts.get("repair_exhausted", 0), event_counts.get("session_started", 0)),
        "session_terminal_distribution": terminal_distribution,
        "auth_failure_rate": _rate(event_counts.get("auth_failed", 0), event_counts.get("auth_completed", 0)),
        "postgres_write_failure_count": db.write_failure_count,
        "telemetry_ingestion_failure_count": ingestion_failure_count,
        "daily_active_users": daily_active_users,
        "new_users_day": new_users_day,
        "returning_users_day": returning_users_day,
        "activation_funnel": {
            "auth": event_counts.get("auth_completed", 0),
            "intent": event_counts.get("intent_submitted", 0),
            "plan_confirm": event_counts.get("plan_confirmed", 0),
            "audit_pass": event_counts.get("audit_passed", 0),
            "deploy_confirm": event_counts.get("deploy_confirmed", 0),
            "serial_success": event_counts.get("serial_marker_seen", 0),
        },
    }


def _update_session(conn: Any, event: dict[str, Any], payload: dict[str, Any]) -> None:
    event_type = event["event_type"]
    trace_id = event["trace_id"]
    user_id = event.get("user_id")
    if event_type == "session_started":
        db.execute(
            conn,
            """
            INSERT INTO sessions(trace_id, user_id, board_id, intent_hash, started_at, turn_count, repair_count)
            VALUES(?,?,?,?,?,0,0)
            ON CONFLICT(trace_id) DO UPDATE SET user_id=excluded.user_id, board_id=excluded.board_id, intent_hash=excluded.intent_hash
            """,
            (trace_id, user_id, payload.get("board_id"), payload.get("intent_hash"), event["timestamp"]),
        )
    elif event_type in {"session_finished", "session_error", "session_cancelled", "repair_exhausted", "max_turns", "terminal"}:
        terminal = payload.get("terminal") if event_type == "session_finished" else None
        db.execute(
            conn,
            "UPDATE sessions SET ended_at=?, terminal=? WHERE trace_id=?",
            (event["timestamp"], terminal or event_type, trace_id),
        )
    elif event_type == "llm_turn_finished":
        db.execute(conn, "UPDATE sessions SET turn_count=turn_count + 1 WHERE trace_id=?", (trace_id,))
    elif event_type == "runtime_error":
        db.execute(conn, "UPDATE sessions SET repair_count=repair_count + 1 WHERE trace_id=?", (trace_id,))


def _counts(conn: Any, sql: str) -> dict[str, int]:
    return {row["key"]: row["count"] for row in db.fetchall(conn, sql)}


def _rate(success: int, other: int) -> float:
    total = success + other
    return success / total if total else 0.0


def _percentiles(values: list[int], *, include_p99: bool = True) -> dict[str, int | None]:
    values = sorted(value for value in values if value is not None)
    out = {"p50": _percentile(values, 50), "p95": _percentile(values, 95)}
    if include_p99:
        out["p99"] = _percentile(values, 99)
    return out


def _percentile(values: list[int], percent: int) -> int | None:
    if not values:
        return None
    index = min(len(values) - 1, round((percent / 100) * (len(values) - 1)))
    return values[index]


def _json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return json.loads(value)
