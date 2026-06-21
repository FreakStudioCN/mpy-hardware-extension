from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, EmailStr, Field, field_validator

from app import recommendation_catalog, web_recommend, web_store


router = APIRouter()


class WebRecommendRequest(BaseModel):
    idea: str = Field(min_length=1, max_length=500)
    locale: str = Field(default="en", max_length=8)
    region: str = Field(default="us", max_length=32)

    @field_validator("idea")
    @classmethod
    def _idea_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("idea must not be blank")
        return value


class WebEventRequest(BaseModel):
    event_type: str = Field(max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)
    locale: str = Field(default="en", max_length=8)
    source: str = Field(default="website-home", max_length=64)


class WebNewsletterRequest(BaseModel):
    email: EmailStr = Field(max_length=254)
    locale: str = Field(default="en", max_length=8)
    source: str = Field(default="website-home", max_length=64)


@router.post("/v1/web/recommend")
def web_recommend_route(request: WebRecommendRequest, http_request: Request):
    web_recommend.enforce_rate_limit(http_request)
    idea = request.idea.strip()
    result = web_recommend.recommend(idea, region=request.region)
    # The pipeline already chose the board (idea-driven: a board-family hint picks a
    # board of that family), so don't re-select it here.
    board = result.get("board")
    purchase_links = recommendation_catalog.load_purchase_links(request.region)
    starter_prompt = f"Build a MicroPython project for: {idea}"
    handoff = {
        "starter_prompt": starter_prompt,
        "locale": request.locale,
        "region": request.region,
        "board_slug": board.get("slug") if board else None,
        "capabilities": result["capabilities"],
        "board_family_hint": result["board_family_hint"],
    }
    if board:
        slug = board.get("slug")
        # Curated, verified, buyable product page first; then the generated catalog
        # links (whose first entry is the board's MicroPython "More info" page -- a
        # vendor SoC/family page with no add-to-cart). Without this the "buy" button
        # sent beginners to e.g. espressif.com/en/products/modules.
        curated = recommendation_catalog.board_purchase_links(slug, request.region)
        seen_urls = {link.get("url") for link in curated}
        generated = purchase_links.get(slug, []) if slug else []
        links = curated + [link for link in generated if link.get("url") not in seen_urls]
        primary_link = links[0]["url"] if links else board.get("more_info_url") or board.get("detail_url")
        firmware = board.get("firmware") or {}
        release = firmware.get("latest_release") or {}
        recommended_board = {
            "name": board.get("name") or slug or "MicroPython board",
            "why": "Beginner-friendly MicroPython target with official firmware and purchase guidance.",
            "buy_url": primary_link,
            "purchase_links": links,
            "micropython_url": board.get("detail_url"),
            "firmware_url": release.get("url"),
            "source": "micropython_catalog",
        }
    else:
        recommended_board = {
            "name": "ESP32-S3 DevKitC-1",
            "why": "Good MicroPython support, Wi-Fi, USB, and enough GPIO pins for beginner hardware builds.",
            "buy_url": "https://www.amazon.com/s?k=esp32-s3+devkitc-1",
        }
    return {
        "recommended_board": recommended_board,
        "parts": result["parts"],
        "starter_prompt": starter_prompt,
        "handoff": handoff,
        # Retrieval path that served: always "llm" on success. The endpoint fails fast
        # rather than degrading -- an unusable LLM returns an explicit 503/422, never a
        # masked keyword guess. (Distinct from recommended_board["source"], which is the
        # board's data provenance.)
        "source": result["source"],
    }


@router.post("/v1/web/events", status_code=204)
def web_events(request: WebEventRequest, http_request: Request):
    web_recommend.enforce_rate_limit(http_request)
    # Best-effort persist (swallows DB/no-DB failures); the endpoint always 204s.
    web_store.record_web_event(request.event_type, request.payload, request.locale, request.source)
    return Response(status_code=204)


@router.post("/v1/web/newsletter", status_code=204)
def web_newsletter(request: WebNewsletterRequest, http_request: Request):
    web_recommend.enforce_rate_limit(http_request)
    # Best-effort persist; on failure the email is logged, so the lead is recoverable.
    web_store.record_newsletter_signup(request.email, request.locale, request.source)
    return Response(status_code=204)
