import pytest

from app import db


@pytest.fixture(autouse=True)
def _api_env(monkeypatch, request):
    """Run API tests against a real Postgres database only."""
    import os

    # Provider selection and the OpenAI key must come from here, never the
    # developer's shell/.env: a leaked MPYHW_LLM_PROVIDER would flip every
    # provider-default assertion (including in no_db tests, hence before the
    # early return below). The DEEPSEEK_API_KEY delenv stays in the DB branch
    # where it always was.
    #
    # Pinned to deepseek rather than deleted. Most of this suite sets
    # DEEPSEEK_API_KEY and stubs the DeepSeek call path, so it needs DeepSeek
    # selected — but that is a property of what those tests stub, NOT of which
    # provider is the code default. Leaving it implicit coupled ~60 otherwise
    # unrelated tests to that default: they all failed the moment it moved to
    # openai, in four files, for a reason none of them were about. A test that
    # genuinely cares about the default deletes this itself and asserts against
    # the code (see test_provider_dispatch).
    monkeypatch.setenv("MPYHW_LLM_PROVIDER", "deepseek")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    if request.node.get_closest_marker("no_db"):
        monkeypatch.setenv("MPYHW_JWT_SECRET", "test-secret")
        yield
        return

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
                daily_global_spend,
                active_llm_sessions,
                telemetry_events,
                llm_turns,
                sessions,
                users,
                newsletter_subscribers,
                web_events
            RESTART IDENTITY CASCADE
            """,
        )
        conn.commit()
