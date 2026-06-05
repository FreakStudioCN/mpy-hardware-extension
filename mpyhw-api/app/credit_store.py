"""Durable per-user credit balance, backed by Postgres via `DATABASE_URL`."""
from __future__ import annotations

import math
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from app import db

CREDIT_TOKENS = 10_000
DAILY_GRANT = int(os.getenv("MPYHW_DAILY_GRANT", "50"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _next_utc_midnight(now: datetime) -> datetime:
    return (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def _user_id(user: dict[str, Any]) -> str:
    return str(user["id"])


def credits_for_tokens(total_tokens: int) -> int:
    if total_tokens <= 0:
        return 0
    return math.ceil(total_tokens / CREDIT_TOKENS)


def record_tokens(user: dict[str, Any], tokens: int, now: datetime | None = None) -> int:
    """Add `tokens` to today's cumulative tally; return the whole credits this call
    pushes the running daily total across (0 or more).

    Cumulative, not per-call: credits are charged per full CREDIT_TOKENS consumed
    across the day, so a long agent session of many small calls doesn't pay a
    rounded-up credit per call. Assumes `ensure_daily_grant` created/reset the row.
    """
    tokens = max(0, tokens)
    uid = _user_id(user)
    now = now or _now()
    today = now.date().isoformat()
    with db.connect() as conn:
        try:
            _upsert_user(conn, user, now)
            row = db.fetchone(conn, "SELECT total_tokens, last_tally_date FROM token_tallies WHERE user_id=?", (uid,))
            before = 0 if row is None or row["last_tally_date"] != today else row["total_tokens"]
            after = before + tokens
            if row is None:
                db.execute(
                    conn,
                    "INSERT INTO token_tallies(user_id, total_tokens, last_tally_date) VALUES(?,?,?)",
                    (uid, after, today),
                )
            else:
                db.execute(
                    conn,
                    "UPDATE token_tallies SET total_tokens=?, last_tally_date=? WHERE user_id=?",
                    (after, today, uid),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return after // CREDIT_TOKENS - before // CREDIT_TOKENS


def ensure_daily_grant(user: dict[str, Any], grant: int, now: datetime | None = None) -> dict[str, Any]:
    """Create/update the user and refill to `grant` once per UTC day."""
    now = now or _now()
    today = now.date().isoformat()
    uid = _user_id(user)
    with db.connect() as conn:
        try:
            _upsert_user(conn, user, now)
            # Atomic create so concurrent first-touch requests (the agent turn, the
            # nested generate_code turn, and the webview's /v1/credits poll can all hit
            # a brand-new user at once) don't race: exactly one INSERT wins. A losing
            # creator's uncommitted INSERT blocks this one until it commits, so the row
            # is always present for the locked SELECT below — never a missing-row read
            # that the meter would later stream to the UI as a spurious `remaining: 0`.
            inserted = db.execute(
                conn,
                "INSERT INTO credit_balances(user_id, balance, daily_grant, last_grant_date) "
                "VALUES(?,?,?,?) ON CONFLICT(user_id) DO NOTHING",
                (uid, grant, grant, today),
            ).rowcount == 1
            # Lock the row for the once-a-day refill read-modify-write.
            row = db.fetchone(
                conn,
                "SELECT balance, daily_grant, last_grant_date FROM credit_balances WHERE user_id=? FOR UPDATE",
                (uid,),
            )
            if inserted:
                balance = grant
                _ledger(conn, uid, "grant", grant, balance, "posted", now)
            elif row["last_grant_date"] != today:
                balance = grant
                # New UTC day: refill the balance and zero the cumulative token tally.
                db.execute(
                    conn,
                    "UPDATE credit_balances SET balance=?, daily_grant=?, last_grant_date=? WHERE user_id=?",
                    (balance, grant, today, uid),
                )
                db.execute(
                    conn,
                    """
                    INSERT INTO token_tallies(user_id, total_tokens, last_tally_date) VALUES(?,?,?)
                    ON CONFLICT(user_id) DO UPDATE SET total_tokens=0, last_tally_date=excluded.last_tally_date
                    """,
                    (uid, 0, today),
                )
                _ledger(conn, uid, "grant", grant, balance, "posted", now)
            else:
                balance = row["balance"]
                grant = row["daily_grant"]
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {
        "balance": balance,
        "daily_grant": grant,
        "resets_at": _next_utc_midnight(now).isoformat(),
        "login": user.get("login"),
    }


def debit(user: dict[str, Any], credits: int) -> int:
    """Subtract `credits` atomically (floored at zero); return remaining balance."""
    amount = max(0, credits)
    uid = _user_id(user)
    now = _now()
    with db.connect() as conn:
        try:
            _upsert_user(conn, user, now)
            db.execute(
                conn,
                "UPDATE credit_balances SET balance=CASE WHEN balance >= ? THEN balance - ? ELSE 0 END WHERE user_id=?",
                (amount, amount, uid),
            )
            remaining = _balance(conn, uid)
            if amount:
                _ledger(conn, uid, "debit", -amount, remaining, "posted", now)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return remaining


def reserve(user: dict[str, Any], credits: int) -> int | None:
    """Atomically reserve `credits`; return remaining balance or None if short."""
    amount = max(0, credits)
    uid = _user_id(user)
    now = _now()
    with db.connect() as conn:
        try:
            _upsert_user(conn, user, now)
            result = db.execute(
                conn,
                "UPDATE credit_balances SET balance=balance - ? WHERE user_id=? AND balance >= ?",
                (amount, uid, amount),
            )
            if result.rowcount != 1:
                conn.rollback()
                return None
            remaining = _balance(conn, uid)
            if amount:
                _ledger(conn, uid, "reserve", -amount, remaining, "reserved", now)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return remaining


def refund(user: dict[str, Any], credits: int) -> int:
    """Atomically add credits back; return remaining balance."""
    amount = max(0, credits)
    uid = _user_id(user)
    now = _now()
    with db.connect() as conn:
        try:
            _upsert_user(conn, user, now)
            db.execute(conn, "UPDATE credit_balances SET balance=balance + ? WHERE user_id=?", (amount, uid))
            remaining = _balance(conn, uid)
            if amount:
                _ledger(conn, uid, "refund", amount, remaining, "posted", now)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return remaining


def get_user(user_id: str) -> dict[str, Any] | None:
    with db.connect() as conn:
        return db.fetchone(conn, "SELECT * FROM users WHERE id=?", (str(user_id),))


def ledger_for_user(user_id: str) -> list[dict[str, Any]]:
    with db.connect() as conn:
        rows = db.fetchall(
            conn,
            "SELECT action, credits, balance_after, status FROM credit_ledger WHERE user_id=? ORDER BY id",
            (str(user_id),),
        )
    return rows


def reset() -> None:
    """Test hook: clear initialized connection metadata only."""
    db.reset_for_tests()


def _upsert_user(conn: Any, user: dict[str, Any], now: datetime) -> None:
    # Race-safe upsert: concurrent first-touch requests for the same new user must not
    # race a SELECT-then-INSERT into a PK-conflict 500. `ON CONFLICT DO NOTHING` with no
    # target ignores BOTH unique constraints on this table (id PK and gh_user_id), so a
    # losing creator no-ops instead of erroring; the UPDATE then refreshes the mutable
    # fields whether the row was just inserted or already existed.
    uid = _user_id(user)
    db.execute(
        conn,
        "INSERT INTO users(id, gh_user_id, login, email, created_at, last_seen_at) "
        "VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        (uid, uid, user.get("login"), user.get("email"), now.isoformat(), now.isoformat()),
    )
    db.execute(
        conn,
        "UPDATE users SET login=COALESCE(?, login), email=COALESCE(?, email), last_seen_at=? WHERE id=?",
        (user.get("login"), user.get("email"), now.isoformat(), uid),
    )


def _balance(conn: Any, user_id: str) -> int:
    row = db.fetchone(conn, "SELECT balance FROM credit_balances WHERE user_id=?", (user_id,))
    return row["balance"] if row else 0


def _ledger(conn: Any, user_id: str, action: str, credits: int, balance_after: int, status: str, now: datetime) -> None:
    db.execute(
        conn,
        "INSERT INTO credit_ledger(user_id, action, credits, balance_after, status, created_at) VALUES(?,?,?,?,?,?)",
        (user_id, action, credits, balance_after, status, now.isoformat()),
    )
