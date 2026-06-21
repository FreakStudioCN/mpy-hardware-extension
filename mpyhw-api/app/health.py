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

    `llm_configured` reports whether a DeepSeek key is actually present, so we can tell
    from outside whether the recommendation pipeline can use the LLM path at all. The
    recommendation endpoint fails fast: with no key every request returns 503
    (llm_unconfigured) rather than degrading, so this flag is the early warning. The
    boolean never echoes the key itself."""
    mode = "stub" if os.getenv("MPYHW_LLM_STUB") == "1" else "live"
    return {"status": "ok", "mode": mode, "llm_configured": bool(os.getenv("DEEPSEEK_API_KEY"))}


@router.get("/v1/health/ready")
def ready() -> dict[str, str]:
    """Readiness: OK only when the DB is reachable, so the load balancer drains a
    machine that can't actually serve. Fly's health check points here."""
    try:
        db.ping()
    except Exception:
        raise HTTPException(status_code=503, detail={"status": "unavailable", "db": "error"})
    return {"status": "ok", "db": "ok"}
