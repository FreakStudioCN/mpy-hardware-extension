import urllib.parse

import pytest
from fastapi.testclient import TestClient

from app import auth
from app.main import app

client = TestClient(app)

pytestmark = pytest.mark.no_db


def test_dev_auth_is_env_gated(monkeypatch):
    monkeypatch.delenv("MPYHW_ENABLE_DEV_AUTH", raising=False)
    assert client.post("/v1/auth/dev", json={"login": "local"}).status_code == 404

    monkeypatch.setenv("MPYHW_ENABLE_DEV_AUTH", "1")
    response = client.post("/v1/auth/dev", json={"login": "local"})

    assert response.status_code == 200
    body = response.json()
    assert body["login"] == "local"
    payload = auth.session_token.decode(body["token"], "test-secret")
    assert payload["sub"] == "dev:local"


def test_browser_oauth_start_rejects_unallowlisted_redirect(monkeypatch):
    monkeypatch.setenv("MPYHW_GITHUB_CLIENT_ID", "cid")
    monkeypatch.setenv("MPYHW_BROWSER_AUTH_REDIRECT_ORIGINS", "https://block-less.com,http://127.0.0.1:8098")

    response = client.get("/v1/auth/github/start", params={"redirect_uri": "https://evil.example/ide/"})

    assert response.status_code == 400
    assert response.json()["detail"]["error"] == "redirect_origin_not_allowed"


def test_browser_oauth_start_redirects_to_github_with_state(monkeypatch):
    monkeypatch.setenv("MPYHW_GITHUB_CLIENT_ID", "cid")
    monkeypatch.setenv("MPYHW_BROWSER_AUTH_REDIRECT_ORIGINS", "https://block-less.com,http://127.0.0.1:8098")

    response = client.get(
        "/v1/auth/github/start",
        params={"redirect_uri": "https://block-less.com/ide/?recipe_id=abc"},
        follow_redirects=False,
    )

    assert response.status_code == 307
    location = response.headers["location"]
    parsed = urllib.parse.urlparse(location)
    query = urllib.parse.parse_qs(parsed.query)
    assert parsed.netloc == "github.com"
    assert query["client_id"] == ["cid"]
    assert query["redirect_uri"] == ["https://blockless.upypi.net/v1/auth/github/callback"]
    assert query["scope"] == ["read:user user:email"]
    assert query["state"][0]


def test_browser_oauth_callback_validates_state(monkeypatch):
    response = client.get("/v1/auth/github/callback", params={"code": "abc", "state": "missing"})

    assert response.status_code == 400
    assert response.json()["detail"]["error"] == "invalid_oauth_state"


def test_browser_oauth_callback_and_exchange_are_one_time(monkeypatch):
    monkeypatch.setenv("MPYHW_GITHUB_CLIENT_ID", "cid")
    monkeypatch.setenv("MPYHW_GITHUB_CLIENT_SECRET", "secret")
    monkeypatch.setenv("MPYHW_BROWSER_AUTH_REDIRECT_ORIGINS", "https://block-less.com")
    monkeypatch.setattr("app.routes_auth.exchange_github_code", lambda code: "gh-token-" + code)
    monkeypatch.setattr("app.routes_auth.verify_github_token", lambda token: {"id": "42", "login": "octocat", "email": None})

    start = client.get(
        "/v1/auth/github/start",
        params={"redirect_uri": "https://block-less.com/ide/?recipe_id=abc"},
        follow_redirects=False,
    )
    state = urllib.parse.parse_qs(urllib.parse.urlparse(start.headers["location"]).query)["state"][0]

    callback = client.get(
        "/v1/auth/github/callback",
        params={"code": "browser-code", "state": state},
        follow_redirects=False,
    )

    assert callback.status_code == 307
    callback_location = callback.headers["location"]
    parsed = urllib.parse.urlparse(callback_location)
    assert parsed.scheme + "://" + parsed.netloc + parsed.path == "https://block-less.com/ide/"
    query = urllib.parse.parse_qs(parsed.query)
    assert query["recipe_id"] == ["abc"]
    short_code = query["auth_token"][0]

    exchanged = client.post("/v1/auth/browser/exchange", json={"code": short_code})
    assert exchanged.status_code == 200
    body = exchanged.json()
    assert body["login"] == "octocat"
    assert auth.session_token.decode(body["token"], "test-secret")["sub"] == "42"

    second = client.post("/v1/auth/browser/exchange", json={"code": short_code})
    assert second.status_code == 400
    assert second.json()["detail"]["error"] == "invalid_auth_code"
