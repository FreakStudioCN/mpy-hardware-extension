from __future__ import annotations

import os
import threading
import time
from collections import deque
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app import web_store


router = APIRouter()

_rate_lock = threading.Lock()
_rate_hits: dict[str, deque[float]] = {}


def reset() -> None:
    """Clear in-process limiter state (tests)."""
    with _rate_lock:
        _rate_hits.clear()


def enforce_rate_limit(request: Any) -> None:
    client = getattr(request, "client", None)
    ip = getattr(client, "host", None) or "unknown"
    window = float(os.getenv("MPYHW_WEB_RECOMMEND_WINDOW", "60"))
    limit = int(os.getenv("MPYHW_WEB_RECOMMEND_RATE", "10"))
    now = time.monotonic()
    with _rate_lock:
        hits = _rate_hits.setdefault(ip, deque())
        while hits and now - hits[0] > window:
            hits.popleft()
        if len(hits) >= limit:
            raise HTTPException(status_code=429, detail={"error": "rate_limited"})
        hits.append(now)


class WebEventRequest(BaseModel):
    event_type: str = Field(max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)
    locale: str = Field(default="en", max_length=8)
    source: str = Field(default="website-home", max_length=64)


# Caller: the VS Code extension's welcome page (mpy-hardware-extension/src/extension/web-telemetry.ts).
@router.post("/v1/web/events", status_code=204)
def web_events(request: WebEventRequest, http_request: Request):
    enforce_rate_limit(http_request)
    # Best-effort persist (swallows DB/no-DB failures); the endpoint always 204s.
    web_store.record_web_event(request.event_type, request.payload, request.locale, request.source)
    return Response(status_code=204)
