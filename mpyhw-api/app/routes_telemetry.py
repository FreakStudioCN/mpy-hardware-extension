from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


router = APIRouter()


AllowedEvent = Literal["session_started", "tool_dispatch", "shim_call", "skill_loaded", "terminal", "error"]


class TelemetryEvent(BaseModel):
    trace_id: str
    event_type: AllowedEvent
    timestamp: str
    payload: dict = Field(default_factory=dict)


class TelemetryRequest(BaseModel):
    events: list[TelemetryEvent]


@router.post("/v1/telemetry", status_code=204)
def telemetry(request: TelemetryRequest):
    size = len(request.model_dump_json())
    if size > 4096:
        raise HTTPException(status_code=413, detail={"error": "payload_too_large"})
    return None
