"""GitHub identity + session JWT.

`get_current_user` is a FastAPI dependency that protected routes depend on; it
reads the `Authorization: Bearer <jwt>` header and returns the user. The JWT is
minted by `/v1/auth/github` after verifying a GitHub access token (which the VS
Code extension obtains via the built-in GitHub auth provider).
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from fastapi import Header, HTTPException

from app import session_token

JWT_TTL_SECONDS = int(os.getenv("MPYHW_JWT_TTL", str(24 * 3600)))
DEFAULT_JWT_SECRET = "dev-insecure-secret"


def _jwt_secret() -> str:
    secret = os.getenv("MPYHW_JWT_SECRET", DEFAULT_JWT_SECRET)
    if os.getenv("MPYHW_ENV") == "prod" and secret == DEFAULT_JWT_SECRET:
        raise HTTPException(status_code=500, detail={"error": "jwt_secret_not_configured"})
    return secret


def mint_session(user: dict[str, Any]) -> str:
    payload = {"sub": user["id"], "login": user.get("login"), "email": user.get("email")}
    return session_token.encode(payload, _jwt_secret(), JWT_TTL_SECONDS)


def get_current_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail={"error": "auth_required"})
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = session_token.decode(token, _jwt_secret())
    except session_token.TokenError:
        raise HTTPException(status_code=401, detail={"error": "invalid_token"})
    return {"id": payload["sub"], "login": payload.get("login"), "email": payload.get("email")}


def verify_github_token(access_token: str) -> dict[str, Any]:
    """Exchange a GitHub access token for the stable user id/login/email."""
    request = urllib.request.Request(
        "https://api.github.com/user",
        headers={
            "authorization": f"token {access_token}",
            "user-agent": "mpyhw-api",
            "accept": "application/vnd.github+json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise HTTPException(status_code=401, detail={"error": "github_auth_failed", "status": error.code})
    except urllib.error.URLError:
        raise HTTPException(status_code=502, detail={"error": "github_unreachable"})
    return {"id": str(data["id"]), "login": data.get("login"), "email": data.get("email")}
