import json

from fastapi.testclient import TestClient

from app import auth, credit_store
from app.main import app

client = TestClient(app)


def _auth_header(user_id="42", login="octocat"):
    token = auth.mint_session({"id": user_id, "login": login, "email": None})
    return {"authorization": f"Bearer {token}"}


def _sse_bytes(*chunks):
    lines = [f"data: {json.dumps(chunk)}".encode("utf-8") for chunk in chunks]
    lines.append(b"data: [DONE]")
    return lines


def test_credits_requires_auth():
    assert client.get("/v1/credits").status_code == 401


def test_credits_returns_balance_for_authed_user():
    response = client.get("/v1/credits", headers=_auth_header())

    assert response.status_code == 200
    body = response.json()
    assert body["balance"] == credit_store.DAILY_GRANT
    assert body["daily_grant"] == credit_store.DAILY_GRANT
    assert body["resets_at"]


def test_llm_messages_requires_auth():
    response = client.post(
        "/v1/llm/messages",
        json={"messages": [{"role": "user", "content": "blink"}], "tools": []},
    )
    assert response.status_code == 401


def test_llm_messages_meters_tokens_and_emits_remaining(monkeypatch):
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    def fake_open(_body, _api_key):
        return _sse_bytes(
            {"choices": [{"delta": {"content": "ok"}}]},
            {"choices": [], "usage": {"total_tokens": 25_000}},
        )

    monkeypatch.setattr("app.routes_llm._open_deepseek_stream", fake_open)

    response = client.post(
        "/v1/llm/messages",
        headers=_auth_header(),
        json={"messages": [{"role": "user", "content": "blink"}], "tools": []},
    )

    assert response.status_code == 200
    # 25_000 tokens, cumulative from 0 -> 25000//10000 = 2 credits debited (floor on the
    # running daily tally, not ceil-per-call: 20k crossed, the trailing 5k not yet).
    assert '"type": "credits"' in response.text
    assert client.get("/v1/credits", headers=_auth_header()).json()["balance"] == credit_store.DAILY_GRANT - 2


def test_llm_messages_charges_cache_discounted_tokens(monkeypatch):
    # DeepSeek auto-caches the stable prefix and bills cache hits at ~1/10. The meter
    # must charge on cache-discounted tokens, not raw total: a turn that is mostly
    # cache hits costs a fraction of what the raw prompt size implies.
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    def fake_open(_body, _api_key):
        return _sse_bytes(
            {"choices": [{"delta": {"content": "ok"}}]},
            {"choices": [], "usage": {
                "total_tokens": 100_000,
                "prompt_cache_hit_tokens": 80_000,
                "prompt_cache_miss_tokens": 15_000,
                "completion_tokens": 5_000,
            }},
        )

    monkeypatch.setattr("app.routes_llm._open_deepseek_stream", fake_open)

    response = client.post(
        "/v1/llm/messages",
        headers=_auth_header(),
        json={"messages": [{"role": "user", "content": "blink"}], "tools": []},
    )

    assert response.status_code == 200
    # billable = 15000 miss + 5000 completion + 0.1*80000 hit = 28000 -> 2 credits
    # (raw total of 100000 would have been 10 credits).
    assert client.get("/v1/credits", headers=_auth_header()).json()["balance"] == credit_store.DAILY_GRANT - 2


def test_llm_messages_returns_402_when_out_of_credits():
    user = {"id": "broke", "login": "broke", "email": None}
    credit_store.ensure_daily_grant(user, credit_store.DAILY_GRANT)
    credit_store.debit(user, 99_999)

    response = client.post(
        "/v1/llm/messages",
        headers=_auth_header(user_id="broke", login="broke"),
        json={"messages": [{"role": "user", "content": "blink"}], "tools": []},
    )

    assert response.status_code == 402
    assert response.json()["detail"]["error"] == "out_of_credits"


def test_llm_messages_refunds_reservation_when_no_tokens_reported(monkeypatch):
    # A turn that streams but reports no usage costs 0 credits: the up-front
    # reservation must be refunded, leaving the balance untouched.
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(
        "app.routes_llm._open_deepseek_stream",
        lambda _body, _key: _sse_bytes({"choices": [{"delta": {"content": "ok"}}]}),
    )

    response = client.post(
        "/v1/llm/messages",
        headers=_auth_header(),
        json={"messages": [{"role": "user", "content": "blink"}], "tools": []},
    )

    assert response.status_code == 200
    assert client.get("/v1/credits", headers=_auth_header()).json()["balance"] == credit_store.DAILY_GRANT


def test_llm_messages_refunds_reservation_on_upstream_error(monkeypatch):
    # The reservation happens before the upstream call. If the upstream errors, the
    # reserved credit must be returned — otherwise a flaky DeepSeek silently drains
    # the user's balance on every failed attempt.
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
    assert client.get("/v1/credits", headers=_auth_header()).json()["balance"] == credit_store.DAILY_GRANT
