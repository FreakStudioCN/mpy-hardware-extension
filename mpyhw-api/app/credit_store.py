"""Durable per-user credit balance (SQLite).

Replaces the in-memory `/v1/quota` tally. Credits are token-metered: every LLM
turn debits `ceil(total_tokens / CREDIT_TOKENS)` from the user's balance. The
balance refills to DAILY_GRANT on the first metered action of a new UTC day
(use-it-or-lose-it). Keyed by GitHub user id.

DAILY_GRANT is the one number to tune after measuring real session token usage
(see the plan); the architecture does not depend on its value.
"""
from __future__ import annotations

import math
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

CREDIT_TOKENS = 10_000
DAILY_GRANT = int(os.getenv("MPYHW_DAILY_GRANT", "50"))
_DEFAULT_DB = str(Path(__file__).resolve().parents[1] / "credits.db")


def _db_path() -> str:
    # Read per-call so tests (and deployments) can redirect the store via env.
    return os.getenv("MPYHW_CREDIT_DB", _DEFAULT_DB)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE IF NOT EXISTS users ("
        "gh_user_id TEXT PRIMARY KEY, login TEXT, email TEXT, "
        "balance INTEGER NOT NULL, last_grant_date TEXT, created_at TEXT)"
    )
    return conn


def _next_utc_midnight(now: datetime) -> datetime:
    return (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def credits_for_tokens(total_tokens: int) -> int:
    if total_tokens <= 0:
        return 0
    return math.ceil(total_tokens / CREDIT_TOKENS)


def ensure_daily_grant(user: dict[str, Any], grant: int, now: datetime | None = None) -> dict[str, Any]:
    """Create the user if new, refill to `grant` on a new UTC day, return state."""
    now = now or datetime.now(timezone.utc)
    today = now.date().isoformat()
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM users WHERE gh_user_id=?", (user["id"],)).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO users(gh_user_id, login, email, balance, last_grant_date, created_at) "
                "VALUES(?,?,?,?,?,?)",
                (user["id"], user.get("login"), user.get("email"), grant, today, now.isoformat()),
            )
            balance = grant
        elif row["last_grant_date"] != today:
            balance = grant
            conn.execute(
                "UPDATE users SET balance=?, last_grant_date=?, login=?, email=? WHERE gh_user_id=?",
                (grant, today, user.get("login") or row["login"], user.get("email") or row["email"], user["id"]),
            )
        else:
            balance = row["balance"]
        conn.commit()
    finally:
        conn.close()
    return {
        "balance": balance,
        "daily_grant": grant,
        "resets_at": _next_utc_midnight(now).isoformat(),
        "login": user.get("login"),
    }


def debit(user: dict[str, Any], credits: int) -> int:
    """Subtract `credits` atomically (floored at 0); return remaining balance.

    Assumes `ensure_daily_grant` already created the row this UTC day.
    """
    amount = max(0, credits)
    conn = _connect()
    try:
        conn.execute(
            "UPDATE users SET balance=CASE WHEN balance >= ? THEN balance - ? ELSE 0 END WHERE gh_user_id=?",
            (amount, amount, user["id"]),
        )
        row = conn.execute("SELECT balance FROM users WHERE gh_user_id=?", (user["id"],)).fetchone()
        remaining = row["balance"] if row else 0
        conn.commit()
    finally:
        conn.close()
    return remaining


def reserve(user: dict[str, Any], credits: int) -> int | None:
    """Atomically reserve `credits`; return remaining balance or None if short."""
    amount = max(0, credits)
    conn = _connect()
    try:
        result = conn.execute(
            "UPDATE users SET balance=balance - ? WHERE gh_user_id=? AND balance >= ?",
            (amount, user["id"], amount),
        )
        if result.rowcount != 1:
            conn.rollback()
            return None
        row = conn.execute("SELECT balance FROM users WHERE gh_user_id=?", (user["id"],)).fetchone()
        remaining = row["balance"] if row else 0
        conn.commit()
    finally:
        conn.close()
    return remaining


def refund(user: dict[str, Any], credits: int) -> int:
    """Atomically add credits back; return remaining balance."""
    amount = max(0, credits)
    conn = _connect()
    try:
        conn.execute("UPDATE users SET balance=balance + ? WHERE gh_user_id=?", (amount, user["id"]))
        row = conn.execute("SELECT balance FROM users WHERE gh_user_id=?", (user["id"],)).fetchone()
        remaining = row["balance"] if row else 0
        conn.commit()
    finally:
        conn.close()
    return remaining


def reset() -> None:
    """Test hook: drop the durable store."""
    try:
        os.remove(_db_path())
    except FileNotFoundError:
        pass
