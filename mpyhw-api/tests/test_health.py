from fastapi.testclient import TestClient

from app.main import app


def test_health_returns_ok_without_package_store(monkeypatch):
    monkeypatch.delenv("MPYHW_LLM_STUB", raising=False)

    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("health must not read package content")

    monkeypatch.setattr("pathlib.Path.read_text", fail_if_called)

    response = TestClient(app).get("/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "mode": "live"}


def test_health_reports_stub_mode_when_stub_enabled(monkeypatch):
    # The client uses this to flag a stub backend so it can't be mistaken for a hang.
    monkeypatch.setenv("MPYHW_LLM_STUB", "1")

    response = TestClient(app).get("/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "mode": "stub"}
