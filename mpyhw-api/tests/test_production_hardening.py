"""Tests for the production-hardening additions: startup config validation,
the readiness probe, the DeepSeek open-phase retry, and the circuit breaker."""
import urllib.error

import pytest
from fastapi.testclient import TestClient

from app import db, main, routes_llm
from app.auth import get_current_user
from app.main import app
from app.routes_llm import _CircuitBreaker

client = TestClient(app)


# --- validate_config (fail-fast) --------------------------------------------
# conftest's autouse fixture sets DATABASE_URL + MPYHW_JWT_SECRET=test-secret.

def test_validate_config_passes_outside_prod(monkeypatch):
    monkeypatch.delenv("MPYHW_ENV", raising=False)
    main.validate_config()  # no raise


def test_validate_config_requires_jwt_secret_in_prod(monkeypatch):
    monkeypatch.setenv("MPYHW_ENV", "prod")
    monkeypatch.delenv("MPYHW_JWT_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="JWT"):
        main.validate_config()


def test_validate_config_requires_upstream_secrets_in_prod(monkeypatch):
    monkeypatch.setenv("MPYHW_ENV", "prod")
    monkeypatch.setenv("MPYHW_JWT_SECRET", "a-real-secret")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("MPYHW_ADMIN_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="prod secrets"):
        main.validate_config()


def test_validate_config_passes_in_prod_with_all_secrets(monkeypatch):
    monkeypatch.setenv("MPYHW_ENV", "prod")
    monkeypatch.setenv("MPYHW_JWT_SECRET", "a-real-secret")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-x")
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "admin-x")
    main.validate_config()  # no raise


def test_validate_config_rejects_nonpositive_concurrency_limit(monkeypatch):
    monkeypatch.delenv("MPYHW_ENV", raising=False)
    monkeypatch.setenv("MPYHW_GLOBAL_CONCURRENCY_LIMIT", "0")
    with pytest.raises(RuntimeError, match="positive"):
        main.validate_config()


# --- readiness vs liveness --------------------------------------------------

def test_liveness_is_db_free():
    assert client.get("/v1/health").json()["status"] == "ok"


def test_readiness_ok_when_db_reachable():
    response = client.get("/v1/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "db": "ok"}


def test_readiness_503_when_db_unreachable(monkeypatch):
    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(db, "ping", boom)
    response = client.get("/v1/health/ready")
    assert response.status_code == 503


# --- DeepSeek open-phase retry ----------------------------------------------

def test_deepseek_open_retries_transient_then_succeeds(monkeypatch):
    calls = {"n": 0}

    class FakeResp:
        pass

    def fake_urlopen(_request, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("boom")
        return FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(routes_llm.time, "sleep", lambda *_: None)

    result = routes_llm._open_deepseek_stream({"messages": [{"role": "user", "content": "hi"}], "tools": []}, "k")
    assert isinstance(result, FakeResp)
    assert calls["n"] == 2  # one retry


def test_deepseek_open_does_not_retry_4xx(monkeypatch):
    calls = {"n": 0}

    def fake_urlopen(_request, timeout):
        calls["n"] += 1
        raise urllib.error.HTTPError("u", 401, "unauthorized", None, None)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(routes_llm.time, "sleep", lambda *_: None)

    with pytest.raises(routes_llm.UpstreamError) as exc:
        routes_llm._open_deepseek_stream({"messages": [{"role": "user", "content": "hi"}], "tools": []}, "k")
    assert exc.value.status == 401
    assert calls["n"] == 1  # no retry on a 4xx


# --- circuit breaker --------------------------------------------------------

def test_breaker_opens_after_threshold():
    breaker = _CircuitBreaker(threshold=3, cooldown=999)
    assert not breaker.is_open()
    for _ in range(3):
        breaker.record_failure()
    assert breaker.is_open()


def test_breaker_success_recovers():
    breaker = _CircuitBreaker(threshold=2, cooldown=999)
    breaker.record_failure()
    breaker.record_failure()
    assert breaker.is_open()
    breaker.record_success()
    assert not breaker.is_open()


def test_breaker_half_open_probe_after_cooldown():
    breaker = _CircuitBreaker(threshold=1, cooldown=0.0)
    breaker.record_failure()
    # cooldown elapsed -> next check lets a single probe through (returns not-open)
    assert breaker.is_open() is False
    # a failing probe re-opens it
    breaker.record_failure()
    assert breaker.is_open() is False  # cooldown 0 again allows the next probe


def test_llm_messages_short_circuits_when_breaker_open(monkeypatch):
    # An open breaker must 503 BEFORE reserving a credit (no churn during an outage).
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    app.dependency_overrides[get_current_user] = lambda: {"id": "breaker-user", "login": "b", "email": None}
    routes_llm._deepseek_breaker.reset()
    try:
        for _ in range(5):
            routes_llm._deepseek_breaker.record_failure()
        response = client.post(
            "/v1/llm/messages",
            json={"messages": [{"role": "user", "content": "hi"}], "tools": []},
        )
        assert response.status_code == 503
        assert response.json()["detail"]["error"] == "llm_upstream_unavailable"
    finally:
        routes_llm._deepseek_breaker.reset()
        app.dependency_overrides.pop(get_current_user, None)


def test_breaker_admits_single_probe_per_cooldown_and_self_heals(monkeypatch):
    # Drive the clock so the cooldown window is deterministic.
    clock = {"t": 1000.0}
    monkeypatch.setattr(routes_llm.time, "monotonic", lambda: clock["t"])
    breaker = _CircuitBreaker(threshold=1, cooldown=30.0)
    breaker.record_failure()                                   # opens at t=1000
    assert breaker.is_open() is True                          # within cooldown -> blocked
    clock["t"] = 1031.0                                        # cooldown elapsed
    assert breaker.is_open() is False                         # exactly ONE probe admitted
    assert [breaker.is_open() for _ in range(3)] == [True, True, True]  # re-armed -> others blocked
    clock["t"] = 1062.0                                        # probe outcome never recorded
    assert breaker.is_open() is False                         # self-heals: a new probe is admitted


def test_readiness_ping_reuses_one_connection(monkeypatch):
    import psycopg

    db.initialize()                  # warm _initialized so ping()'s initialize() is a no-op
    db._readiness_conn = None         # start the probe connection cold
    count = {"n": 0}

    class FakeConn:
        closed = 0

        def execute(self, _sql):
            return None

        def commit(self):
            return None

        def close(self):
            return None

    def counting_connect(_url, **_kw):
        count["n"] += 1
        return FakeConn()

    monkeypatch.setattr(psycopg, "connect", counting_connect)
    try:
        db.ping()
        db.ping()
        assert count["n"] == 1        # one connection reused across both readiness pings
    finally:
        # Restore the real psycopg.connect BEFORE the conftest teardown truncation
        # runs (which uses a real db connection), then drop the fake probe conn.
        monkeypatch.undo()
        db._readiness_conn = None
