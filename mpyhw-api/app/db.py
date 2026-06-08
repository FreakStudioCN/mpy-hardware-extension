from __future__ import annotations

import logging
import os
import threading
from contextlib import contextmanager
from typing import Any, Iterator

logger = logging.getLogger("mpyhw.db")

_initialized: set[str] = set()
write_failure_count = 0


def _database_url() -> str:
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required")
    if not _is_postgres(url):
        raise RuntimeError("DATABASE_URL must be a postgres:// or postgresql:// URL")
    return url


def _is_postgres(url: str) -> bool:
    return url.startswith("postgres://") or url.startswith("postgresql://")


@contextmanager
def connect() -> Iterator[Any]:
    url = _database_url()
    initialize()
    import psycopg
    from psycopg.rows import dict_row

    conn = psycopg.connect(url, row_factory=dict_row)
    try:
        yield conn
    finally:
        conn.close()


def execute(conn: Any, sql: str, params: tuple[Any, ...] = ()):
    try:
        return conn.execute(_sql(sql), params)
    except Exception:
        global write_failure_count
        if sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE", "CREATE")):
            write_failure_count += 1
            logger.warning("db write failed", exc_info=True)
        raise


def fetchone(conn: Any, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    row = execute(conn, sql, params).fetchone()
    if row is None:
        return None
    return dict(row)


def fetchall(conn: Any, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in execute(conn, sql, params).fetchall()]


_readiness_lock = threading.Lock()
_readiness_conn: Any = None


def ping() -> None:
    """Cheap readiness check: confirm the DB is reachable. Raises on failure.

    The readiness probe fires every ~15s, so reuse one lazily-created connection
    instead of paying a fresh connect handshake each time. A dropped/stale connection
    is transparently reconnected once before the failure propagates. The probe route
    is sync (threadpool) and this is lock-guarded, so the shared connection is only
    ever touched by one caller at a time."""
    global _readiness_conn
    import psycopg

    with _readiness_lock:
        for attempt in range(2):
            try:
                if _readiness_conn is None or _readiness_conn.closed:
                    initialize()
                    _readiness_conn = psycopg.connect(_database_url())
                _readiness_conn.execute("SELECT 1")
                _readiness_conn.commit()
                return
            except Exception:
                if _readiness_conn is not None:
                    try:
                        _readiness_conn.close()
                    except Exception:
                        pass
                    _readiness_conn = None
                if attempt == 1:
                    raise


def _sql(sql: str) -> str:
    return sql.replace("?", "%s")


def initialize() -> None:
    url = _database_url()
    if url in _initialized:
        return
    _initialize_postgres(url)
    _initialized.add(url)


def _initialize_postgres(url: str) -> None:
    import psycopg

    conn = psycopg.connect(url)
    try:
        for statement in _schema():
            conn.execute(statement)
        conn.commit()
    finally:
        conn.close()


def _schema() -> list[str]:
    return [
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            gh_user_id TEXT UNIQUE,
            login TEXT,
            email TEXT,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS credit_balances (
            user_id TEXT PRIMARY KEY,
            balance INTEGER NOT NULL,
            daily_grant INTEGER NOT NULL,
            last_grant_date TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS credit_ledger (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            action TEXT NOT NULL,
            credits INTEGER NOT NULL,
            balance_after INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS token_tallies (
            user_id TEXT PRIMARY KEY,
            total_tokens INTEGER NOT NULL,
            last_tally_date TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS daily_global_spend (
            spend_date TEXT PRIMARY KEY,
            credits_spent INTEGER NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS active_llm_sessions (
            session_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            started_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            status TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS telemetry_events (
            id BIGSERIAL PRIMARY KEY,
            trace_id TEXT NOT NULL,
            user_id TEXT,
            event_type TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            payload_json JSONB NOT NULL,
            created_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS llm_turns (
            id BIGSERIAL PRIMARY KEY,
            trace_id TEXT,
            user_id TEXT,
            kind TEXT NOT NULL,
            model TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_ms INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            total_tokens INTEGER,
            credits_charged INTEGER,
            status TEXT NOT NULL,
            error_kind TEXT
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS sessions (
            trace_id TEXT PRIMARY KEY,
            user_id TEXT,
            board_id TEXT,
            intent_hash TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            terminal TEXT,
            turn_count INTEGER NOT NULL DEFAULT 0,
            repair_count INTEGER NOT NULL DEFAULT 0
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_telemetry_trace ON telemetry_events(trace_id)",
        "CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry_events(event_type)",
        "CREATE INDEX IF NOT EXISTS idx_llm_turns_user ON llm_turns(user_id)",
        "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
    ]


def reset_for_tests() -> None:
    global _readiness_conn
    _initialized.clear()
    if _readiness_conn is not None:
        try:
            _readiness_conn.close()
        except Exception:
            pass
        _readiness_conn = None
