from fastapi.testclient import TestClient

from app import analytics
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


def event(event_type, payload):
    return {"trace_id": "trace-1", "event_type": event_type, "timestamp": "2026-06-01T00:00:00Z", "payload": payload}
