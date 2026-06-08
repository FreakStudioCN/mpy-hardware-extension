"""GitHub identity + session JWT.

`get_current_user` is a FastAPI dependency that protected routes depend on; it
reads the `Authorization: Bearer <jwt>` header and returns the user. The JWT is
minted by `/v1/auth/github` after verifying a GitHub access token (which the VS
Code extension obtains via the built-in GitHub auth provider).
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any

from fastapi import Header, HTTPException

from app import session_token

JWT_TTL_SECONDS = int(os.getenv("MPYHW_JWT_TTL", str(24 * 3600)))
DEFAULT_JWT_SECRET = "dev-insecure-secret"
logger = logging.getLogger("mpyhw.auth")


def _jwt_secret() -> str:
    # Fail closed in EVERY environment, not only prod: the default is the public
    # source-code value, so anyone could forge a JWT for any user id (and mint
    # unlimited users to drain the free daily grant) the moment a deploy runs with
    # it. Refusing a missing/empty/default secret unconditionally removes the
    # footgun where a non-prod env (a second service, a manual deploy) silently
    # falls back to it. Tests and local dev set a real non-default value.
    secret = os.getenv("MPYHW_JWT_SECRET", DEFAULT_JWT_SECRET)
    if not secret or secret == DEFAULT_JWT_SECRET:
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


def get_optional_user(authorization: str | None = Header(default=None)) -> dict[str, Any] | None:
    """Like get_current_user, but returns None instead of 401 when the token is
    missing or invalid. For ingestion routes that accept anonymous events yet must
    derive identity server-side rather than trusting a client-supplied user id."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = session_token.decode(token, _jwt_secret())
    except session_token.TokenError:
        return None
    return {"id": payload["sub"], "login": payload.get("login"), "email": payload.get("email")}


def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    """Gate operational/admin routes behind a shared secret.

    Distinct from the per-user JWT: admin routes expose all users' data, so they
    require the `X-Admin-Token` header to match `MPYHW_ADMIN_TOKEN`. Fail closed —
    if the env secret is unset the route is unreachable.
    """
    expected = os.getenv("MPYHW_ADMIN_TOKEN")
    if not expected:
        raise HTTPException(status_code=401, detail={"error": "admin_disabled"})
    if not x_admin_token or not hmac.compare_digest(x_admin_token, expected):
        raise HTTPException(status_code=401, detail={"error": "admin_unauthorized"})


def verify_github_token(access_token: str) -> dict[str, Any]:
    """Exchange a GitHub access token for the stable user id/login/email.

    Retries transient failures (network errors, GitHub 5xx) with short backoff so a
    momentary blip doesn't block every login. A 4xx (e.g. a bad/expired token) is
    not retried — it won't succeed on a second try.
    """
    request = urllib.request.Request(
        "https://api.github.com/user",
        headers={
            "authorization": f"token {access_token}",
            "user-agent": "mpyhw-api",
            "accept": "application/vnd.github+json",
        },
    )
    backoffs = (0.25, 0.5)  # 3 attempts total
    for attempt in range(len(backoffs) + 1):
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                data = json.loads(response.read().decode("utf-8"))
            return {"id": str(data["id"]), "login": data.get("login"), "email": data.get("email")}
        except urllib.error.HTTPError as error:
            if error.code >= 500 and attempt < len(backoffs):
                logger.warning("github verify retry", extra={"status": error.code, "attempt": attempt + 1})
                time.sleep(backoffs[attempt])
                continue
            raise HTTPException(status_code=401, detail={"error": "github_auth_failed", "status": error.code})
        except urllib.error.URLError:
            if attempt < len(backoffs):
                logger.warning("github verify retry", extra={"status": 0, "attempt": attempt + 1})
                time.sleep(backoffs[attempt])
                continue
            raise HTTPException(status_code=502, detail={"error": "github_unreachable"})
