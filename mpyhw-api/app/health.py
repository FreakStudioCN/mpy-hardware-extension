from fastapi import APIRouter, HTTPException

from app import db


router = APIRouter()


@router.get("/v1/health")
def health() -> dict[str, str]:
    """Liveness: cheap, DB-free. For uptime pings and fast process checks."""
    return {"status": "ok"}


@router.get("/v1/health/ready")
def ready() -> dict[str, str]:
    """Readiness: OK only when the DB is reachable, so the load balancer drains a
    machine that can't actually serve. Fly's health check points here."""
    try:
        db.ping()
    except Exception:
        raise HTTPException(status_code=503, detail={"status": "unavailable", "db": "error"})
    return {"status": "ok", "db": "ok"}
