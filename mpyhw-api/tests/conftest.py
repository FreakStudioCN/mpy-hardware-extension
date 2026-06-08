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
    # Safety net: never let a test reach the live DeepSeek provider via a real key
    # in the developer's mpyhw-api/.env. Tests that exercise the LLM either set
    # MPYHW_LLM_STUB themselves or monkeypatch the provider; a forgotten one must
    # NOT silently bill the real account. Tests that need the stub re-set it after
    # this autouse fixture runs.
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
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
