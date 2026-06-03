import pytest

from app import db


@pytest.fixture(autouse=True)
def _api_env(monkeypatch):
    """Run API tests against a real Postgres database only."""
    import os

    url = os.getenv("MPYHW_TEST_DATABASE_URL") or os.getenv("DATABASE_URL")
    if not url:
        pytest.fail("Set DATABASE_URL or MPYHW_TEST_DATABASE_URL to a test Postgres database")
    if not (url.startswith("postgres://") or url.startswith("postgresql://")):
        pytest.fail("DATABASE_URL must point to Postgres; SQLite fallback is not supported")
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("MPYHW_JWT_SECRET", "test-secret")
    db.reset_for_tests()
    db.initialize()
    _truncate_postgres()
    yield
    monkeypatch.setenv("DATABASE_URL", url)
    _truncate_postgres()


def _truncate_postgres():
    with db.connect() as conn:
        db.execute(
            conn,
            """
            TRUNCATE TABLE
                credit_ledger,
                credit_balances,
                token_tallies,
                active_llm_sessions,
                telemetry_events,
                llm_turns,
                sessions,
                users
            RESTART IDENTITY CASCADE
            """,
        )
        conn.commit()
