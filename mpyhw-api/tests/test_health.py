from fastapi.testclient import TestClient

from app.main import app


def test_health_returns_ok_without_package_store(monkeypatch):
    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("health must not read package content")

    monkeypatch.setattr("pathlib.Path.read_text", fail_if_called)

    response = TestClient(app).get("/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
