import os

from fastapi import APIRouter, HTTPException

from app import db


router = APIRouter()


@router.get("/v1/health")
def health() -> dict[str, object]:
    """Liveness: cheap, DB-free. For uptime pings and fast process checks.

    `mode` reports whether this instance answers with the real LLM ("live") or the
    deterministic stub ("stub"). The stub returns a fixed reply and never thinks, so
    without this signal a stub instance is indistinguishable from a broken one — the
    client surfaces it so a stub backend can't be mistaken for a hang.

    `llm_configured` reports whether the active provider's API key (per
    MPYHW_LLM_PROVIDER) is actually present, so we can tell from outside whether
    the LLM path is usable at all. The endpoints fail fast: with no key every
    request returns 503 rather than degrading, so this flag is the early warning.
    The boolean never echoes the key itself."""
    from app.routes_llm import llm_provider_configured

    mode = "stub" if os.getenv("MPYHW_LLM_STUB") == "1" else "live"
    return {"status": "ok", "mode": mode, "llm_configured": llm_provider_configured()}


@router.get("/v1/health/ready")
def ready() -> dict[str, str]:
    """Readiness: OK only when the DB is reachable, so the load balancer drains a
    machine that can't actually serve. Fly's health check points here."""
    try:
        db.ping()
    except Exception:
        raise HTTPException(status_code=503, detail={"status": "unavailable", "db": "error"})
    return {"status": "ok", "db": "ok"}
