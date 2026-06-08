import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import auth
from app.main import app

client = TestClient(app)


def test_get_current_user_rejects_missing_header():
    with pytest.raises(HTTPException) as error:
        auth.get_current_user(authorization=None)
    assert error.value.status_code == 401


def test_get_current_user_rejects_garbage_token():
    with pytest.raises(HTTPException) as error:
        auth.get_current_user(authorization="Bearer not-a-jwt")
    assert error.value.status_code == 401


def test_get_current_user_accepts_minted_token():
    token = auth.mint_session({"id": "42", "login": "octocat", "email": None})

    user = auth.get_current_user(authorization=f"Bearer {token}")

    assert user["id"] == "42"
    assert user["login"] == "octocat"


def test_prod_rejects_default_jwt_secret_for_mint_and_accept(monkeypatch):
    monkeypatch.setenv("MPYHW_ENV", "prod")
    monkeypatch.delenv("MPYHW_JWT_SECRET", raising=False)

    with pytest.raises(HTTPException) as mint_error:
        auth.mint_session({"id": "42", "login": "octocat", "email": None})
    assert mint_error.value.status_code == 500

    token = auth.session_token.encode({"sub": "42", "login": "octocat", "email": None}, "dev-insecure-secret", 3600)
    with pytest.raises(HTTPException) as accept_error:
        auth.get_current_user(authorization=f"Bearer {token}")
    assert accept_error.value.status_code == 500


def test_default_jwt_secret_rejected_outside_prod(monkeypatch):
    """Footgun guard: the public source-code default secret must be refused in EVERY
    environment, not just prod. A non-prod deploy (a second env, a manual service) that
    forgets to set the secret would otherwise sign/verify JWTs with a value anyone can
    read from the repo — letting an attacker forge a token for any user id and mint
    unlimited users to drain the free daily grant."""
    monkeypatch.delenv("MPYHW_ENV", raising=False)  # not prod
    monkeypatch.delenv("MPYHW_JWT_SECRET", raising=False)  # falls back to the default

    with pytest.raises(HTTPException) as mint_error:
        auth.mint_session({"id": "42", "login": "octocat", "email": None})
    assert mint_error.value.status_code == 500

    token = auth.session_token.encode({"sub": "42", "login": "octocat", "email": None}, auth.DEFAULT_JWT_SECRET, 3600)
    with pytest.raises(HTTPException) as accept_error:
        auth.get_current_user(authorization=f"Bearer {token}")
    assert accept_error.value.status_code == 500


def test_auth_github_exchanges_token_for_session_jwt(monkeypatch):
    monkeypatch.setattr(
        "app.routes_auth.verify_github_token",
        lambda _token: {"id": "42", "login": "octocat", "email": "o@example.com"},
    )

    response = client.post("/v1/auth/github", json={"access_token": "gh-abc"})

    assert response.status_code == 200
    body = response.json()
    assert body["login"] == "octocat"
    payload = auth.session_token.decode(body["token"], "test-secret")
    assert payload["sub"] == "42"


def test_auth_github_requires_access_token():
    response = client.post("/v1/auth/github", json={})

    assert response.status_code == 400
    assert response.json()["detail"]["error"] == "missing_access_token"
