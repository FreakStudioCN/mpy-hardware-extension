import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app import auth, llm_sessions
from app.main import app

client = TestClient(app)


def _auth_header(user_id="42", login="octocat"):
    token = auth.mint_session({"id": user_id, "login": login, "email": None})
    return {"authorization": f"Bearer {token}"}


def _sse_bytes(*chunks):
    lines = [f"data: {json.dumps(chunk)}".encode("utf-8") for chunk in chunks]
    lines.append(b"data: [DONE]")
    return lines


def test_llm_messages_rejects_second_active_request_for_same_user(monkeypatch):
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("MPYHW_USER_CONCURRENCY_LIMIT", "1")
    llm_sessions.acquire("existing", {"id": "42", "login": "octocat"}, ttl_seconds=120)

    response = client.post(
        "/v1/llm/messages",
        headers=_auth_header(),
        json={"messages": [{"role": "user", "content": "blink"}], "tools": []},
    )

    assert response.status_code == 429
    assert response.json()["detail"]["error"] == "user_concurrency_limit"


def test_llm_messages_rejects_when_global_limit_is_full(monkeypatch):
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("MPYHW_GLOBAL_CONCURRENCY_LIMIT", "1")
    llm_sessions.acquire("existing", {"id": "other", "login": "other"}, ttl_seconds=120)

    response = client.post(
        "/v1/llm/messages",
        headers=_auth_header(user_id="42"),
        json={"messages": [{"role": "user", "content": "blink"}], "tools": []},
    )

    assert response.status_code == 429
    assert response.json()["detail"]["error"] == "global_concurrency_limit"


def test_llm_messages_releases_slot_after_success(monkeypatch):
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(
        "app.routes_llm._open_deepseek_stream",
        lambda _body, _key: _sse_bytes({"choices": [], "usage": {"total_tokens": 0}}),
    )

    response = client.post(
        "/v1/llm/messages",
        headers=_auth_header(),
        json={"messages": [{"role": "user", "content": "blink"}], "tools": []},
    )

    assert response.status_code == 200
    assert llm_sessions.counts()["global"] == 0


def test_llm_messages_releases_slot_on_upstream_error(monkeypatch):
    from app.routes_llm import UpstreamError

    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(
        "app.routes_llm._open_deepseek_stream",
        lambda _body, _key: (_ for _ in ()).throw(UpstreamError(500)),
    )

    response = client.post(
        "/v1/llm/messages",
        headers=_auth_header(),
        json={"messages": [{"role": "user", "content": "blink"}], "tools": []},
    )

    assert response.status_code == 502
    assert llm_sessions.counts()["global"] == 0


def test_llm_messages_releases_slot_on_provider_error(monkeypatch):
    # get_llm_provider() raises 503 for an unsupported provider — an unhandled path
    # after the slot is acquired. The outer guard must release it, not leak to TTL.
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("MPYHW_LLM_PROVIDER", "bogus")

    response = client.post(
        "/v1/llm/messages",
        headers=_auth_header(),
        json={"messages": [{"role": "user", "content": "blink"}], "tools": []},
    )

    assert response.status_code == 503
    assert llm_sessions.counts()["global"] == 0


def test_concurrent_acquire_admits_exactly_one_under_user_limit():
    # Fire many simultaneous acquires for the same user with a limit of 1. The
    # advisory lock must serialize the check-and-insert so exactly one wins; without
    # it, several threads read COUNT=0 and all insert, blowing past the limit.
    user = {"id": "42", "login": "octocat"}

    def attempt(n):
        return llm_sessions.acquire(f"sess-{n}", user, user_limit_value=1, ttl_seconds=120)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, range(8)))

    assert results.count(None) == 1
    assert results.count("user_concurrency_limit") == 7
    assert llm_sessions.counts()["global"] == 1


def test_stale_llm_sessions_are_cleaned_up():
    llm_sessions.acquire("stale", {"id": "42", "login": "octocat"}, ttl_seconds=120)
    old = datetime.now(timezone.utc) - timedelta(seconds=121)
    llm_sessions.mark_last_seen_for_test("stale", old)

    released = llm_sessions.cleanup_stale(ttl_seconds=120)

    assert released == 1
    assert llm_sessions.counts()["global"] == 0
