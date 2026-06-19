import pytest
from fastapi.testclient import TestClient

from app.main import app


pytestmark = pytest.mark.no_db

client = TestClient(app)


def test_web_recommend_returns_website_contract_shape():
    response = client.post(
        "/v1/web/recommend",
        json={
            "idea": "a desk light that turns on when I sit down",
            "locale": "en",
            "region": "us",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["recommended_board"]["name"]
    assert body["recommended_board"]["why"]
    assert body["parts"]
    assert body["parts"][0]["name"]
    assert body["parts"][0]["reason"]
    assert body["parts"][0]["buy_url"].startswith("https://")
    assert "desk light" in body["starter_prompt"]


def test_web_best_effort_endpoints_accept_frontend_events():
    event_response = client.post(
        "/v1/web/events",
        json={"event_type": "idea_submitted", "payload": {"idea": "blink led"}, "locale": "en"},
    )
    newsletter_response = client.post(
        "/v1/web/newsletter",
        json={"email": "maker@example.com", "locale": "en", "source": "website-home"},
    )

    assert event_response.status_code == 204
    assert newsletter_response.status_code == 204


def test_web_recommend_allows_browser_cors_preflight():
    response = client.options(
        "/v1/web/recommend",
        headers={
            "Origin": "https://www.blockless.ai",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"
