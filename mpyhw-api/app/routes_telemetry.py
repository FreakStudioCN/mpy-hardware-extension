from datetime import datetime
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

    @field_validator("timestamp")
    @classmethod
    def timestamp_is_iso8601(cls, value: str) -> str:
        # A malformed timestamp would reach sessions.started_at/ended_at and break the
        # ::timestamptz cast in metrics_snapshot, 500-ing /v1/admin/metrics. Reject at
        # ingest so bad data never lands. The client sends new Date().toISOString().
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("timestamp must be ISO-8601")
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
