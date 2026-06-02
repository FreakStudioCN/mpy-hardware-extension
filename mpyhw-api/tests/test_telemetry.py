from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_telemetry_accepts_valid_event_batch():
    response = client.post("/v1/telemetry", json={"events": [event("tool_dispatch", {"tool": "search_packages"})]})

    assert response.status_code == 204


def test_telemetry_rejects_oversized_payload():
    response = client.post("/v1/telemetry", json={"events": [event("tool_dispatch", {"blob": "x" * 5000})]})

    assert response.status_code == 413
    assert response.json()["detail"]["error"] == "payload_too_large"


def test_telemetry_rejects_unknown_event_type():
    response = client.post("/v1/telemetry", json={"events": [event("unknown", {})]})

    assert response.status_code == 422


def event(event_type, payload):
    return {"trace_id": "trace-1", "event_type": event_type, "timestamp": "2026-06-01T00:00:00Z", "payload": payload}
