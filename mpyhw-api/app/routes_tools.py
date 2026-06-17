from __future__ import annotations

from fastapi import APIRouter

from app.tool_registry import PROTOCOL_VERSION, llm_tool_list, protocol_registry_version


router = APIRouter()


@router.get("/v1/tools")
def tools():
    return {
        "version": protocol_registry_version(),
        "protocol_version": PROTOCOL_VERSION,
        "tools": llm_tool_list(),
    }
