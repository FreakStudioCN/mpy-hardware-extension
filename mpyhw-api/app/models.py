from typing import Literal

from pydantic import BaseModel, Field


SupportLevel = Literal["discoverable", "installable", "generatable", "verified", "experimental"]


class PackageResolveRequest(BaseModel):
    intent: str
    capabilities: list[str] = Field(default_factory=list)
    board_id: str
    constraints: dict = Field(default_factory=dict)


class PackageSearchRequest(BaseModel):
    query: str = ""
    capabilities: list[str] = Field(default_factory=list)
    board_id: str | None = None
    bus: str | None = None
    limit: int = 10
