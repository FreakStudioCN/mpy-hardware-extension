from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_anonymous_quota_response_contains_limit_and_reset():
    response = client.get("/v1/quota")

    assert response.status_code == 200
    body = response.json()
    assert body["used"] == 0
    assert body["limit"] == 5
    assert body["resets_at"]


def test_exhausted_quota_returns_client_usable_error():
    response = client.get("/v1/quota", headers={"X-Quota-Used": "5"})

    assert response.status_code == 429
    body = response.json()
    assert body["error"] == "quota_exhausted"
    assert body["limit"] == 5
