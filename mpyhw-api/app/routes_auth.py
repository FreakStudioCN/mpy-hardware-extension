from __future__ import annotations

import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
import time

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from starlette.concurrency import run_in_threadpool

from app.auth import mint_session, verify_github_token

router = APIRouter()

_oauth_states: dict[str, dict[str, object]] = {}
_browser_codes: dict[str, dict[str, object]] = {}
_STATE_TTL_SECONDS = 10 * 60
_CODE_TTL_SECONDS = 5 * 60


def _now() -> float:
    return time.time()


def _cleanup() -> None:
    now = _now()
    for key, value in list(_oauth_states.items()):
        if float(value.get("expires_at", 0)) < now:
            _oauth_states.pop(key, None)
    for key, value in list(_browser_codes.items()):
        if float(value.get("expires_at", 0)) < now:
            _browser_codes.pop(key, None)


def _allowed_redirect_origins() -> set[str]:
    raw = os.getenv("MPYHW_BROWSER_AUTH_REDIRECT_ORIGINS", "https://block-less.com")
    return {item.strip().rstrip("/") for item in raw.split(",") if item.strip()}


def _origin_for(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail={"error": "invalid_redirect_uri"})
    return f"{parsed.scheme}://{parsed.netloc}"


def _callback_url() -> str:
    base = os.getenv("MPYHW_PUBLIC_API_BASE", "https://blockless-api.onrender.com").rstrip("/")
    return f"{base}/v1/auth/github/callback"


def _append_query(url: str, key: str, value: str) -> str:
    parsed = urllib.parse.urlparse(url)
    pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    pairs = [(k, v) for (k, v) in pairs if k != key]
    pairs.append((key, value))
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(pairs)))


def exchange_github_code(code: str) -> str:
    client_id = os.getenv("MPYHW_GITHUB_CLIENT_ID")
    client_secret = os.getenv("MPYHW_GITHUB_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise HTTPException(status_code=500, detail={"error": "github_oauth_not_configured"})
    body = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": _callback_url(),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        "https://github.com/login/oauth/access_token",
        data=body,
        headers={"accept": "application/json", "content-type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=502, detail={"error": "github_oauth_unreachable"}) from exc
    access_token = data.get("access_token")
    if not access_token:
        raise HTTPException(status_code=401, detail={"error": "github_oauth_failed"})
    return str(access_token)


@router.post("/v1/auth/github")
async def auth_github(request: Request):
    """Verify a GitHub access token and mint a session JWT keyed to the user."""
    try:
        body = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid_json"}) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail={"error": "json_object_required"})
    access_token = body.get("access_token")
    if not access_token:
        raise HTTPException(status_code=400, detail={"error": "missing_access_token"})
    # verify_github_token does blocking I/O and retry sleeps; keep it off the event loop.
    user = await run_in_threadpool(verify_github_token, access_token)
    return {"token": mint_session(user), "login": user.get("login")}


@router.post("/v1/auth/dev")
async def auth_dev(request: Request):
    if os.getenv("MPYHW_ENABLE_DEV_AUTH") != "1":
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    try:
        body = await request.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    login = str(body.get("login") or "local-dev")[:80]
    user = {"id": f"dev:{login}", "login": login, "email": None}
    return {"token": mint_session(user), "login": login}


@router.get("/v1/auth/github/start")
def auth_github_start(redirect_uri: str = Query(...)):
    _cleanup()
    origin = _origin_for(redirect_uri)
    if origin not in _allowed_redirect_origins():
        raise HTTPException(status_code=400, detail={"error": "redirect_origin_not_allowed"})
    client_id = os.getenv("MPYHW_GITHUB_CLIENT_ID")
    if not client_id:
        raise HTTPException(status_code=500, detail={"error": "github_oauth_not_configured"})
    state = secrets.token_urlsafe(32)
    _oauth_states[state] = {"redirect_uri": redirect_uri, "expires_at": _now() + _STATE_TTL_SECONDS}
    query = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": _callback_url(),
            "scope": "read:user user:email",
            "state": state,
        }
    )
    return RedirectResponse(f"https://github.com/login/oauth/authorize?{query}")


@router.get("/v1/auth/github/callback")
async def auth_github_callback(code: str = Query(...), state: str = Query(...)):
    _cleanup()
    state_payload = _oauth_states.pop(state, None)
    if not state_payload:
        raise HTTPException(status_code=400, detail={"error": "invalid_oauth_state"})
    access_token = await run_in_threadpool(exchange_github_code, code)
    user = await run_in_threadpool(verify_github_token, access_token)
    short_code = secrets.token_urlsafe(32)
    _browser_codes[short_code] = {"user": user, "expires_at": _now() + _CODE_TTL_SECONDS}
    return RedirectResponse(_append_query(str(state_payload["redirect_uri"]), "auth_token", short_code))


@router.post("/v1/auth/browser/exchange")
async def auth_browser_exchange(request: Request):
    _cleanup()
    try:
        body = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid_json"}) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail={"error": "json_object_required"})
    code = str(body.get("code") or "")
    payload = _browser_codes.pop(code, None)
    if not payload:
        raise HTTPException(status_code=400, detail={"error": "invalid_auth_code"})
    user = payload["user"]
    return {"token": mint_session(user), "login": user.get("login")}
