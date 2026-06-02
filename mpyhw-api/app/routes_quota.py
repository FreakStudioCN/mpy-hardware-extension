from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse


router = APIRouter()

LIMIT = 5

# Server-authoritative, in-memory per-client daily session tally. The server owns
# the count so a client can no longer report used=0 to bypass the limit. Keyed by
# X-Client-Id (falls back to the peer address); resets at the next UTC midnight.
# Process-local: an MVP stand-in for durable per-user accounting.
_usage: dict[str, dict] = {}


def _reset_usage() -> None:
    """Test hook: clear the in-memory tally."""
    _usage.clear()


def _next_utc_midnight(now: datetime) -> datetime:
    return (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def _client_key(request: Request, client_id: str | None) -> str:
    if client_id:
        return client_id
    return request.client.host if request.client else "anonymous"


def _entry(request: Request, client_id: str | None) -> dict:
    now = datetime.now(timezone.utc)
    key = _client_key(request, client_id)
    entry = _usage.get(key)
    if entry is None or entry["resets_at"] <= now:
        entry = {"used": 0, "resets_at": _next_utc_midnight(now)}
        _usage[key] = entry
    return entry


@router.get("/v1/quota")
def quota(request: Request, claim: int = 0, x_client_id: str | None = Header(default=None)):
    entry = _entry(request, x_client_id)
    body = {"used": entry["used"], "limit": LIMIT, "resets_at": entry["resets_at"].isoformat()}
    if entry["used"] >= LIMIT:
        return JSONResponse(status_code=429, content={**body, "error": "quota_exhausted", "message": "Daily free session quota exhausted."})
    # A plain read (display poll) does not consume; the extension passes ?claim=1
    # once per session start to consume one slot.
    if claim:
        entry["used"] += 1
        body["used"] = entry["used"]
    return body
