from fastapi.testclient import TestClient
from datetime import datetime, timedelta, timezone

from app import analytics, db
from app.main import app


client = TestClient(app)


def test_telemetry_accepts_valid_event_batch():
    response = client.post("/v1/telemetry", json={"events": [event("tool_dispatch", {"tool": "search_packages"})]})

    assert response.status_code == 204
    rows = analytics.telemetry_events(trace_id="trace-1")
    assert rows == [{"event_type": "tool_dispatch", "payload": {"tool": "search_packages"}, "user_id": None}]


def test_telemetry_rejects_oversized_payload():
    response = client.post("/v1/telemetry", json={"events": [event("tool_dispatch", {"blob": "x" * 70_000})]})

    assert response.status_code == 413
    assert response.json()["detail"]["error"] == "payload_too_large"


def test_telemetry_rejects_unknown_event_type():
    response = client.post("/v1/telemetry", json={"events": [event("unknown", {})]})

    assert response.status_code == 422


def test_telemetry_allows_64kb_batches():
    response = client.post("/v1/telemetry", json={"events": [event("code_generated", {"blob": "x" * 5000})]})

    assert response.status_code == 204


def test_telemetry_sanitizes_private_payload_fields():
    response = client.post(
        "/v1/telemetry",
        json={"events": [event("code_generated", {"code": "print('secret')", "prompt": "make a secret sensor", "serial_log": "secret data"})]},
    )

    assert response.status_code == 204
    payload = analytics.telemetry_events(trace_id="trace-1")[0]["payload"]
    assert "code" not in payload
    assert "prompt" not in payload
    assert "serial_log" not in payload
    assert payload["code_sha256"]
    assert payload["code_length"] == len("print('secret')")
    assert payload["intent_hash"]


def test_admin_metrics_returns_operational_snapshot(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    client.post("/v1/telemetry", json={"events": [event("auth_completed", {}), event("session_started", {}), event("serial_marker_seen", {})]})

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    body = response.json()
    assert body["active_sse_count"] == 0
    assert body["daily_active_users"] >= 0
    assert "activation_funnel" in body


def test_admin_metrics_rejects_without_token(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")

    response = client.get("/v1/admin/metrics")

    assert response.status_code == 401
    assert response.json()["detail"]["error"] == "admin_unauthorized"


def test_admin_metrics_rejects_wrong_token(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "nope"})

    assert response.status_code == 401
    assert response.json()["detail"]["error"] == "admin_unauthorized"


def test_admin_metrics_disabled_when_secret_unset(monkeypatch):
    monkeypatch.delenv("MPYHW_ADMIN_TOKEN", raising=False)

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "anything"})

    assert response.status_code == 401
    assert response.json()["detail"]["error"] == "admin_disabled"


def test_telemetry_rejects_malformed_timestamp():
    response = client.post("/v1/telemetry", json={"events": [event("tool_dispatch", {}, timestamp="not-a-date")]})

    assert response.status_code == 422


def test_telemetry_accepts_iso8601_millis_z():
    # The real client sends new Date().toISOString() -> e.g. "2026-06-03T10:00:00.000Z".
    response = client.post("/v1/telemetry", json={"events": [event("tool_dispatch", {}, timestamp="2026-06-03T10:00:00.000Z")]})

    assert response.status_code == 204


def test_admin_metrics_survives_session_with_client_timestamps(monkeypatch):
    # A finished session with the client's millis-Z timestamps must not break the
    # ended_at::timestamptz - started_at::timestamptz cast in metrics_snapshot.
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    client.post(
        "/v1/telemetry",
        json={"events": [
            event("session_started", {}, timestamp="2026-06-03T10:00:00.000Z"),
            event("session_finished", {}, timestamp="2026-06-03T10:00:05.000Z"),
        ]},
    )

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    assert response.json()["session_duration_ms"]["p50"] == 5000


def test_admin_metrics_uses_session_finished_terminal_payload(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    client.post(
        "/v1/telemetry",
        json={"events": [
            event("session_started", {}, timestamp="2026-06-03T10:00:00.000Z"),
            event("session_finished", {"terminal": "generated"}, timestamp="2026-06-03T10:00:05.000Z"),
        ]},
    )

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    assert response.json()["session_terminal_distribution"] == {"generated": 1}


def test_admin_metrics_counts_daily_users_in_current_utc_day(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    now = datetime.now(timezone.utc)
    old = now - timedelta(days=2)
    with db.connect() as conn:
        db.execute(conn, "INSERT INTO users(id, gh_user_id, login, email, created_at, last_seen_at) VALUES(?,?,?,?,?,?)", ("old", "old", "old", None, old.isoformat(), old.isoformat()))
        db.execute(conn, "INSERT INTO users(id, gh_user_id, login, email, created_at, last_seen_at) VALUES(?,?,?,?,?,?)", ("new", "new", "new", None, now.isoformat(), now.isoformat()))
        db.execute(conn, "INSERT INTO users(id, gh_user_id, login, email, created_at, last_seen_at) VALUES(?,?,?,?,?,?)", ("returning", "returning", "returning", None, old.isoformat(), now.isoformat()))
        conn.commit()

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    body = response.json()
    assert body["daily_active_users"] == 2
    assert body["new_users_day"] == 1
    assert body["returning_users_day"] == 1


def test_admin_metrics_averages_credits_by_user_day(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    now = datetime.now(timezone.utc)
    with db.connect() as conn:
        for uid in ("a", "b"):
            db.execute(conn, "INSERT INTO users(id, gh_user_id, login, email, created_at, last_seen_at) VALUES(?,?,?,?,?,?)", (uid, uid, uid, None, now.isoformat(), now.isoformat()))
        db.execute(conn, "INSERT INTO credit_ledger(user_id, action, credits, balance_after, status, created_at) VALUES(?,?,?,?,?,?)", ("a", "debit", -1, 49, "posted", now.isoformat()))
        db.execute(conn, "INSERT INTO credit_ledger(user_id, action, credits, balance_after, status, created_at) VALUES(?,?,?,?,?,?)", ("a", "debit", -3, 46, "posted", now.isoformat()))
        db.execute(conn, "INSERT INTO credit_ledger(user_id, action, credits, balance_after, status, created_at) VALUES(?,?,?,?,?,?)", ("b", "debit", -2, 48, "posted", now.isoformat()))
        conn.commit()

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    assert response.json()["credits_per_user_day"] == 3


def event(event_type, payload, timestamp="2026-06-01T00:00:00Z"):
    return {"trace_id": "trace-1", "event_type": event_type, "timestamp": timestamp, "payload": payload}
