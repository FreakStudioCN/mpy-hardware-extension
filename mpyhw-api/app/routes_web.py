from __future__ import annotations

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field


router = APIRouter()


class WebRecommendRequest(BaseModel):
    idea: str = Field(min_length=1)
    locale: str = "en"
    region: str = "us"


class WebEventRequest(BaseModel):
    event_type: str
    payload: dict = Field(default_factory=dict)
    locale: str = "en"
    source: str = "website-home"


class WebNewsletterRequest(BaseModel):
    email: str
    locale: str = "en"
    source: str = "website-home"


def _parts_for_idea(idea: str) -> list[dict[str, str]]:
    text = idea.lower()
    if any(word in text for word in ("temperature", "hot", "heat", "humidity")):
        return [
            {
                "name": "DHT22 temperature and humidity sensor",
                "reason": "Measures temperature and humidity for the trigger.",
                "buy_url": "https://www.amazon.com/s?k=dht22+sensor+module",
            },
            {
                "name": "LED module",
                "reason": "Provides the visible alarm output.",
                "buy_url": "https://www.amazon.com/s?k=led+module+microcontroller",
            },
        ]
    if any(word in text for word in ("plant", "soil", "moisture")):
        return [
            {
                "name": "Capacitive soil moisture sensor",
                "reason": "Measures whether the plant soil is dry.",
                "buy_url": "https://www.amazon.com/s?k=capacitive+soil+moisture+sensor",
            },
            {
                "name": "LED or buzzer module",
                "reason": "Warns you when the soil needs water.",
                "buy_url": "https://www.amazon.com/s?k=led+buzzer+module+microcontroller",
            },
        ]
    if any(word in text for word in ("oled", "screen", "display")):
        return [
            {
                "name": "SSD1306 OLED display",
                "reason": "Shows the device status over I2C.",
                "buy_url": "https://www.amazon.com/s?k=ssd1306+oled+display",
            }
        ]
    if any(word in text for word in ("sit", "motion", "presence", "desk light", "light")):
        return [
            {
                "name": "PIR motion sensor",
                "reason": "Detects nearby movement or presence.",
                "buy_url": "https://www.amazon.com/s?k=pir+motion+sensor+module",
            },
            {
                "name": "LED light module",
                "reason": "Turns on when the trigger is active.",
                "buy_url": "https://www.amazon.com/s?k=led+light+module+microcontroller",
            },
        ]
    return [
        {
            "name": "Breadboard jumper wire kit",
            "reason": "Connects the board to beginner-friendly modules.",
            "buy_url": "https://www.amazon.com/s?k=breadboard+jumper+wire+kit",
        }
    ]


@router.post("/v1/web/recommend")
def web_recommend(request: WebRecommendRequest):
    idea = request.idea.strip()
    return {
        "recommended_board": {
            "name": "ESP32-S3 DevKitC-1",
            "why": "Good MicroPython support, Wi-Fi, USB, and enough GPIO pins for beginner hardware builds.",
            "buy_url": "https://www.amazon.com/s?k=esp32-s3+devkitc-1",
        },
        "parts": _parts_for_idea(idea),
        "starter_prompt": f"Build a MicroPython project for: {idea}",
        "handoff": {
            "starter_prompt": f"Build a MicroPython project for: {idea}",
            "locale": request.locale,
            "region": request.region,
        },
    }


@router.post("/v1/web/events", status_code=204)
def web_events(_request: WebEventRequest):
    return Response(status_code=204)


@router.post("/v1/web/newsletter", status_code=204)
def web_newsletter(_request: WebNewsletterRequest):
    return Response(status_code=204)
