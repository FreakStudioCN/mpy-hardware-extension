from __future__ import annotations

from fastapi import APIRouter

from app.tool_registry import CANONICAL_TOOLS, tool_registry_version


router = APIRouter()


@router.get("/v1/tools")
def tools():
    return {"version": tool_registry_version(), "tools": CANONICAL_TOOLS}
