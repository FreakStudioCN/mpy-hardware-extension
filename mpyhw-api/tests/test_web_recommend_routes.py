import json

import pytest
from fastapi.testclient import TestClient

from app import package_store, recommendation_catalog, web_recommend
from app.main import app


pytestmark = pytest.mark.no_db

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset_web_recommend_state():
    web_recommend.reset()
    yield
    web_recommend.reset()


def test_web_recommend_returns_website_contract_shape():
    response = client.post(
        "/v1/web/recommend",
        json={
            "idea": "a desk light that turns on when I sit down",
            "locale": "en",
            "region": "us",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["recommended_board"]["name"]
    assert body["recommended_board"]["why"]
    assert body["parts"]
    assert body["parts"][0]["name"]
    assert body["parts"][0]["reason"]
    assert body["parts"][0]["buy_url"].startswith("https://")
    assert "desk light" in body["starter_prompt"]


def test_web_recommend_parts_come_from_real_catalog_with_capabilities():
    response = client.post(
        "/v1/web/recommend",
        json={"idea": "a temperature alarm with an OLED display", "locale": "en", "region": "us"},
    )

    assert response.status_code == 200
    body = response.json()
    # Each part is a real catalog package (carries a package_name), deduped.
    package_names = [part["package_name"] for part in body["parts"]]
    assert all(package_names)
    assert len(package_names) == len(set(package_names))
    # Idea touches temperature + display; the grounded list covers both.
    covered = {cap for part in body["parts"] for cap in part["capabilities"]}
    assert "display_text" in covered
    assert "temperature_sensing" in covered
    assert body["handoff"]["capabilities"]


def test_web_recommend_exposes_recommendation_source(monkeypatch):
    # Without an LLM key the deterministic fallback served; the response surfaces which
    # path ran ("llm"/"fallback"/"error") so we can see from outside whether live is
    # actually using the LLM. conftest's no_db branch does NOT clear the key, so do it.
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    response = client.post(
        "/v1/web/recommend",
        json={"idea": "blink an led", "locale": "en", "region": "us"},
    )

    assert response.status_code == 200
    assert response.json()["source"] == "fallback"


def test_web_recommend_never_500s_when_catalog_load_fails(monkeypatch):
    def boom():
        raise RuntimeError("catalog file corrupt")

    monkeypatch.setattr(package_store.PackageStore, "default", staticmethod(boom))

    response = client.post(
        "/v1/web/recommend",
        json={"idea": "blink an led", "locale": "en", "region": "us"},
    )

    assert response.status_code == 200
    parts = response.json()["parts"]
    assert parts[0]["name"] == "Breadboard jumper wire kit"
    assert parts[0]["buy_url"].startswith("https://")


def test_web_recommend_rate_limited_after_threshold(monkeypatch):
    monkeypatch.setenv("MPYHW_WEB_RECOMMEND_RATE", "1")

    first = client.post("/v1/web/recommend", json={"idea": "blink led", "locale": "en", "region": "us"})
    second = client.post("/v1/web/recommend", json={"idea": "blink led", "locale": "en", "region": "us"})

    assert first.status_code == 200
    assert second.status_code == 429
    assert second.json()["detail"]["error"] == "rate_limited"


def test_web_recommend_rejects_overlong_idea():
    response = client.post("/v1/web/recommend", json={"idea": "x" * 501, "locale": "en", "region": "us"})

    assert response.status_code == 422


def test_web_recommend_rejects_whitespace_only_idea():
    response = client.post("/v1/web/recommend", json={"idea": "   ", "locale": "en", "region": "us"})

    assert response.status_code == 422


def test_web_recommend_rejects_oversized_body_before_validation():
    response = client.post(
        "/v1/web/recommend",
        content=json.dumps({"idea": "x" * 5000, "locale": "en", "region": "us"}),
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 413


def test_web_best_effort_endpoints_accept_frontend_events():
    event_response = client.post(
        "/v1/web/events",
        json={"event_type": "idea_submitted", "payload": {"idea": "blink led"}, "locale": "en"},
    )
    newsletter_response = client.post(
        "/v1/web/newsletter",
        json={"email": "maker@example.com", "locale": "en", "source": "website-home"},
    )

    assert event_response.status_code == 204
    assert newsletter_response.status_code == 204


def test_web_best_effort_endpoints_validate_payloads():
    event_response = client.post(
        "/v1/web/events",
        json={"event_type": "x" * 65, "payload": {}, "locale": "en"},
    )
    newsletter_response = client.post(
        "/v1/web/newsletter",
        json={"email": "not-an-email", "locale": "en", "source": "website-home"},
    )

    assert event_response.status_code == 422
    assert newsletter_response.status_code == 422


def test_web_best_effort_endpoints_share_rate_limit(monkeypatch):
    monkeypatch.setenv("MPYHW_WEB_RECOMMEND_RATE", "1")

    first = client.post(
        "/v1/web/events",
        json={"event_type": "idea_submitted", "payload": {"idea": "blink led"}, "locale": "en"},
    )
    second = client.post(
        "/v1/web/newsletter",
        json={"email": "maker@example.com", "locale": "en", "source": "website-home"},
    )

    assert first.status_code == 204
    assert second.status_code == 429


def test_web_recommend_allows_browser_cors_preflight():
    response = client.options(
        "/v1/web/recommend",
        headers={
            "Origin": "https://www.blockless.ai",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://www.blockless.ai"


def test_web_recommend_uses_generated_board_catalog(tmp_path, monkeypatch):
    boards_path = tmp_path / "micropython_boards.json"
    links_path = tmp_path / "hardware_purchase_links_us.json"
    boards_path.write_text(
        json.dumps(
            {
                "boards": [
                    {
                        "slug": "ESP32_GENERIC_S3",
                        "name": "ESP32-S3",
                        "vendor": "Espressif",
                        "detail_url": "https://micropython.org/download/ESP32_GENERIC_S3/",
                        "firmware": {
                            "latest_release": {
                                "version": "v1.28.0",
                                "date": "2026-04-06",
                                "url": "https://micropython.org/resources/firmware/ESP32_GENERIC_S3.bin",
                            }
                        },
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    links_path.write_text(
        json.dumps(
            {
                "links_by_slug": {
                    "ESP32_GENERIC_S3": [
                        {
                            "vendor": "Espressif",
                            "url": "https://www.espressif.com/en/products/devkits",
                            "link_type": "official",
                            "confidence": "high",
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(recommendation_catalog, "BOARDS_PATH", boards_path)
    monkeypatch.setattr(recommendation_catalog, "LINKS_PATH", links_path)
    # No curated board link for this slug -> the generated catalog link flows through.
    monkeypatch.setattr(recommendation_catalog, "BOARD_LINKS_PATH", tmp_path / "no_board_links.json")

    response = client.post("/v1/web/recommend", json={"idea": "blink led", "locale": "en", "region": "us"})

    assert response.status_code == 200
    board = response.json()["recommended_board"]
    assert board["name"] == "ESP32-S3"
    assert board["buy_url"] == "https://www.espressif.com/en/products/devkits"
    assert board["micropython_url"] == "https://micropython.org/download/ESP32_GENERIC_S3/"
    assert board["firmware_url"].endswith("ESP32_GENERIC_S3.bin")


def test_web_recommend_board_buy_link_prefers_curated_buyable_page(tmp_path, monkeypatch):
    # A curated buyable product page for the slug must win over the generated catalog's
    # first link (the MicroPython "More info" vendor page).
    boards_path = tmp_path / "micropython_boards.json"
    links_path = tmp_path / "hardware_purchase_links_us.json"
    board_links_path = tmp_path / "board_purchase_links.json"
    boards_path.write_text(
        json.dumps({"boards": [{"slug": "ESP32_GENERIC_S3", "name": "ESP32-S3", "vendor": "Espressif",
                                 "detail_url": "https://micropython.org/download/ESP32_GENERIC_S3/",
                                 "more_info_url": "https://www.espressif.com/en/products/modules"}]}),
        encoding="utf-8",
    )
    links_path.write_text(
        json.dumps({"links_by_slug": {"ESP32_GENERIC_S3": [
            {"vendor": "Espressif", "url": "https://www.espressif.com/en/products/modules", "link_type": "official"}
        ]}}),
        encoding="utf-8",
    )
    board_links_path.write_text(
        json.dumps({"links_by_slug": {"ESP32_GENERIC_S3": [
            {"vendor": "Adafruit", "url": "https://www.adafruit.com/product/5500", "link_type": "official", "confidence": "high"}
        ]}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(recommendation_catalog, "BOARDS_PATH", boards_path)
    monkeypatch.setattr(recommendation_catalog, "LINKS_PATH", links_path)
    monkeypatch.setattr(recommendation_catalog, "BOARD_LINKS_PATH", board_links_path)

    response = client.post("/v1/web/recommend", json={"idea": "blink led", "locale": "en", "region": "us"})

    board = response.json()["recommended_board"]
    assert board["buy_url"] == "https://www.adafruit.com/product/5500"
    assert board["purchase_links"][0]["link_type"] == "official"
    assert board["buy_url"] != "https://www.espressif.com/en/products/modules"


def test_default_board_buy_link_is_buyable_not_vendor_family_page():
    # Against the REAL shipped catalog: the default recommended board (ESP32-S3) must
    # link to a buyable product page, not the espressif SoC-module family page that
    # had no add-to-cart.
    response = client.post("/v1/web/recommend", json={"idea": "blink an led", "locale": "en", "region": "us"})

    board = response.json()["recommended_board"]
    assert board["buy_url"].startswith("https://")
    assert "espressif.com/en/products/modules" not in board["buy_url"]
    assert "/product/" in board["buy_url"]


def test_idea_naming_pico_selects_rp2040_board_with_buyable_link():
    # Board follows the idea: naming Raspberry Pi Pico picks an rp2040 board (Pico W),
    # with its curated buyable product page -- and this holds on the LLM-off fallback.
    response = client.post(
        "/v1/web/recommend",
        json={"idea": "a raspberry pi pico that blinks an led", "locale": "en", "region": "us"},
    )

    body = response.json()
    assert body["handoff"]["board_slug"] == "RPI_PICO_W"
    assert body["handoff"]["board_family_hint"] == "rp2040"
    assert "/product/" in body["recommended_board"]["buy_url"]
