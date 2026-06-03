from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from app import analytics
from app.auth import get_optional_user

router = APIRouter()
MAX_TELEMETRY_BYTES = 64 * 1024


class TelemetryEvent(BaseModel):
    trace_id: str
    event_type: str
    timestamp: str
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("event_type")
    @classmethod
    def event_type_is_allowed(cls, value: str) -> str:
        if value not in analytics.ALLOWED_EVENT_TYPES:
            raise ValueError("unknown event_type")
        return value


class TelemetryRequest(BaseModel):
    events: list[TelemetryEvent]


@router.post("/v1/telemetry", status_code=204)
def telemetry(request: TelemetryRequest, user: dict[str, Any] | None = Depends(get_optional_user)):
    size = len(request.model_dump_json())
    if size > MAX_TELEMETRY_BYTES:
        raise HTTPException(status_code=413, detail={"error": "payload_too_large"})
    # Identity is server-derived, never client-supplied: a verified bearer token
    # attributes the events to that user; anonymous batches stay user_id=None. This
    # stops an unauthenticated caller from spoofing another user's id.
    user_id = user["id"] if user else None
    analytics.record_telemetry([{**event.model_dump(), "user_id": user_id} for event in request.events])
    return None
