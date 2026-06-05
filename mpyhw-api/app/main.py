from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

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

logger = logging.getLogger("mpyhw.request")
_startup_log = logging.getLogger("mpyhw.startup")


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

    missing = [name for name in ("DEEPSEEK_API_KEY", "MPYHW_ADMIN_TOKEN") if not os.getenv(name)]
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


app = FastAPI(title="mpyhw-api", version="0.2.0", lifespan=lifespan)
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
