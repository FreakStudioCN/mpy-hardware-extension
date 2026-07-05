from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import analytics
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def admin_client(monkeypatch, client):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "test-admin")
    return client


@pytest.fixture
def seeded_llm_turns():
    now = datetime.now(timezone.utc)
    analytics.record_llm_turn(
        trace_id="t1", user_id="user-a", kind="chat", model="deepseek-chat",
        started_at=now, total_tokens=41210, credits_charged=5, status="ok",
    )
    analytics.record_llm_turn(
        trace_id="t2", user_id="user-b", kind="chat", model="deepseek-chat",
        started_at=now - timedelta(days=1), total_tokens=12000, credits_charged=2, status="ok",
    )
    analytics.record_llm_turn(
        trace_id="t3", user_id="user-a", kind="chat", model="deepseek-chat",
        started_at=now - timedelta(days=2), total_tokens=5000, credits_charged=1, status="ok",
    )


def test_admin_usage_rolls_up_llm_turns_per_day_per_user(admin_client, seeded_llm_turns):
    resp = admin_client.get("/v1/admin/usage?days=7", headers={"X-Admin-Token": "test-admin"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["rows"], "expected at least one rollup row"
    row = body["rows"][0]
    assert set(row) == {"date", "user_id", "turns", "total_tokens", "credits_charged", "est_cost_usd"}
    assert row["est_cost_usd"] == round(row["credits_charged"] * body["est_usd_per_credit"], 4)


def test_admin_usage_requires_admin_token(client):
    assert client.get("/v1/admin/usage").status_code == 401
