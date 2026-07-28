from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from app import auth, db, llm_sessions
from app.logging_config import setup_logging
from app.routes_admin import router as admin_router
from app.health import router as health_router
from app.routes_auth import router as auth_router
from app.routes_content import router as content_router
from app.routes_credits import router as credits_router
from app.routes_packages import router as package_router
from app.routes_llm import router as llm_router
from app.routes_telemetry import router as telemetry_router
from app.routes_tools import router as tools_router
from app.routes_web import router as web_router

logger = logging.getLogger("mpyhw.request")
_startup_log = logging.getLogger("mpyhw.startup")

_DEFAULT_CORS_ORIGINS = [
    # Production site: recommend-widget CORS fix (2a1f243) + browser-IDE OAuth
    # redirect target (routes_auth.py default, render.yaml MPYHW_BROWSER_AUTH_REDIRECT_ORIGINS).
    "https://block-less.com",
    "https://www.block-less.com",  # www variant of the above; asserted by test_web_recommend_routes.py
    # NOTE: "https://blockless.co" / "https://www.blockless.co" removed 2026-07-03: DNS NXDOMAIN
    # (domain unregistered), no references in live frontend; only citation was a same-commit test.
    "http://localhost:3000",  # local web dev
    "http://127.0.0.1:3000",  # local web dev
]
_BODY_LIMITS = {
    "/v1/web/recommend": 4096,
    "/v1/web/events": 2048,
    "/v1/web/newsletter": 1024,
    "/v1/web/uploads": 12288,
    "/v1/web/quotes": 4096,
}


def _cors_origins() -> list[str]:
    configured = os.getenv("MPYHW_CORS_ORIGINS")
    if configured is None:
        return _DEFAULT_CORS_ORIGINS
    origins = [origin.strip() for origin in configured.split(",") if origin.strip()]
    return origins or _DEFAULT_CORS_ORIGINS


def validate_config() -> None:
    """Fail fast at startup so a misconfigured prod deploy never serves traffic.

    In prod (MPYHW_ENV=prod) every required secret must be present and non-default
    and the concurrency limits must parse to positive ints. uvicorn exits non-zero
    on a raised exception, so Fly rolls the deploy back instead of serving with a
    dev secret. Outside prod we only sanity-check what is actually configured.
    Reuses the existing per-component checks rather than duplicating their logic.
    """
    # DATABASE_URL: required everywhere; db._database_url raises on missing/non-postgres.
    db._database_url()

    # Concurrency limits must parse and be positive — a non-int or <=0 value would
    # silently break session admission. These getters call int(os.getenv(...)).
    for name, getter in (
        ("MPYHW_USER_CONCURRENCY_LIMIT", llm_sessions.user_limit),
        ("MPYHW_GLOBAL_CONCURRENCY_LIMIT", llm_sessions.global_limit),
        ("MPYHW_LLM_SESSION_TTL_SECONDS", llm_sessions.ttl_seconds),
    ):
        try:
            value = getter()
        except ValueError as exc:
            raise RuntimeError(f"{name} must be an integer") from exc
        if value <= 0:
            raise RuntimeError(f"{name} must be a positive integer (got {value})")

    if os.getenv("MPYHW_ENV") != "prod":
        return

    # JWT secret: reuse the existing prod guard (raises when still the dev default).
    try:
        auth._jwt_secret()
    except HTTPException as exc:
        raise RuntimeError("MPYHW_JWT_SECRET is not configured (still the dev default)") from exc

    # The key requirement follows the selected provider (MPYHW_LLM_PROVIDER):
    # openai requires OPENAI_API_KEY and deepseek is then NOT required. An
    # unsupported provider value must kill the boot, not surface as per-request 503s.
    from app.routes_llm import get_llm_provider

    try:
        provider = get_llm_provider()
    except HTTPException as exc:
        raise RuntimeError(f"MPYHW_LLM_PROVIDER is not supported: {os.getenv('MPYHW_LLM_PROVIDER')!r}") from exc
    missing = [name for name in (provider.api_key_env, "MPYHW_ADMIN_TOKEN") if not os.getenv(name)]
    if missing:
        raise RuntimeError(f"missing required prod secrets: {', '.join(missing)}")


def _init_sentry() -> None:
    """Optional error tracking, gated entirely by SENTRY_DSN (no-op if unset)."""
    dsn = os.getenv("SENTRY_DSN")
    if not dsn:
        return
    try:
        import sentry_sdk
    except ImportError:
        _startup_log.warning("SENTRY_DSN set but sentry-sdk is not installed; skipping")
        return
    sentry_sdk.init(dsn=dsn, traces_sample_rate=0.0, environment=os.getenv("MPYHW_ENV", "dev"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    _init_sentry()
    validate_config()
    # Create the schema up front so the first request doesn't pay for it. A
    # transient DB hiccup here must NOT crash the process — the readiness probe
    # (/v1/health/ready) holds the LB off until the DB is actually reachable.
    try:
        db.initialize()
    except Exception:
        _startup_log.warning("startup db.initialize failed; readiness probe gates traffic", exc_info=True)
    yield


class RequestLogMiddleware:
    """Pure-ASGI request logger.

    Deliberately NOT BaseHTTPMiddleware: that wrapper can buffer/stall streaming
    responses, and /v1/llm/messages is a long-lived SSE stream. This intercepts
    only the response-start message to capture the status, never touches the body,
    and logs once the response fully completes (so duration covers the whole SSE).
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.monotonic()
        status = {"code": 0}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            path = scope.get("path", "")
            if path not in ("/v1/health", "/v1/health/ready"):  # skip noisy health pings
                logger.info(
                    "request",
                    extra={
                        "method": scope.get("method"),
                        "path": path,
                        "status": status["code"],
                        "duration_ms": int((time.monotonic() - start) * 1000),
                    },
                )


class RequestBodyLimitMiddleware:
    """Reject selected anonymous website payloads before FastAPI parses JSON."""

    def __init__(self, app, limits: dict[str, int]):
        self.app = app
        self.limits = limits

    async def __call__(self, scope: dict[str, Any], receive, send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        limit = self.limits.get(scope.get("path", ""))
        if not limit:
            await self.app(scope, receive, send)
            return

        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        raw_length = headers.get(b"content-length")
        if raw_length is not None:
            try:
                if int(raw_length.decode("ascii")) > limit:
                    await self._reject(scope, send, limit)
                    return
            except ValueError:
                await self._reject(scope, send, limit)
                return

        messages = []
        total = 0
        more_body = True
        while more_body:
            message = await receive()
            messages.append(message)
            if message.get("type") == "http.request":
                total += len(message.get("body", b""))
                if total > limit:
                    await self._reject(scope, send, limit)
                    return
                more_body = bool(message.get("more_body", False))
            else:
                more_body = False

        index = 0

        async def replay_receive():
            nonlocal index
            if index < len(messages):
                message = messages[index]
                index += 1
                return message
            return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay_receive, send)

    async def _reject(self, scope: dict[str, Any], send, limit: int) -> None:
        response = JSONResponse({"detail": {"error": "request_body_too_large", "max_bytes": limit}}, status_code=413)
        await response(scope, None, send)


app = FastAPI(title="mpyhw-api", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["authorization", "content-type"],
)
app.add_middleware(RequestBodyLimitMiddleware, limits=_BODY_LIMITS)
app.add_middleware(RequestLogMiddleware)
app.include_router(admin_router)
app.include_router(health_router)
app.include_router(package_router)
app.include_router(content_router)
app.include_router(tools_router)
app.include_router(llm_router)
app.include_router(auth_router)
app.include_router(credits_router)
app.include_router(telemetry_router)
app.include_router(web_router)
