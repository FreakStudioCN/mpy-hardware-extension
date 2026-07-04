import json

import pytest
from fastapi.testclient import TestClient

from app import package_store, recommendation_catalog, routes_llm, web_recommend
from app.main import app


pytestmark = pytest.mark.no_db

client = TestClient(app)


def _fake_deepseek(messages, max_tokens, timeout=120, response_format=None, model=None):
    """Deterministic stand-in for DeepSeek in route contract tests: derive a few
    capabilities + a board hint from the idea embedded in the prompt, so the website
    contract can be asserted via the (now sole) LLM path without a live model. This is
    test infrastructure, NOT the deleted production keyword fallback."""
    prompt = messages[-1]["content"].lower()
    caps = []
    if "temperature" in prompt:
        caps.append("temperature_sensing")
    if "oled" in prompt or "display" in prompt:
        caps.append("display_text")
    if "motion" in prompt or "sit" in prompt:
        caps.append("motion_sensing")
    if "led" in prompt or "blink" in prompt or "light" in prompt:
        caps.append("digital_output")
    if not caps:
        caps = ["digital_output"]
    hint = None
    if "pico" in prompt or "rp2040" in prompt:
        hint = "rp2040"
    elif "esp32" in prompt:
        hint = "esp32"
    return json.dumps({"capabilities": caps, "board_family_hint": hint}), {}


@pytest.fixture(autouse=True)
def _reset_web_recommend_state():
    web_recommend.reset()
    yield
    web_recommend.reset()


@pytest.fixture(autouse=True)
def _stub_deepseek(monkeypatch):
    # The endpoint now has no keyword fallback: without a working LLM every request 503s.
    # Stub DeepSeek so the contract tests exercise the real LLM path; failure tests opt
    # out by clearing the key / patching the call themselves.
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setattr(routes_llm, "_call_deepseek_plain", _fake_deepseek)
    yield


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


def test_web_recommend_unconfigured_returns_503(monkeypatch):
    # Fail fast: with no usable LLM there is no keyword fallback to mask it -- the request
    # surfaces an explicit 503 instead of silently degrading. (conftest's no_db branch
    # does NOT clear the key, and the autouse stub sets it, so clear it here.)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    response = client.post(
        "/v1/web/recommend",
        json={"idea": "blink an led", "locale": "en", "region": "us"},
    )

    assert response.status_code == 503
    assert response.json()["detail"]["error"] == "llm_unconfigured"


def test_web_recommend_surfaces_catalog_failure_instead_of_masking(monkeypatch):
    # A corrupt catalog is a real failure: it must surface (uncaught -> 500), not be
    # masked as a breadboard 200. TestClient re-raises uncaught server exceptions.
    def boom():
        raise RuntimeError("catalog file corrupt")

    monkeypatch.setattr(package_store.PackageStore, "default", staticmethod(boom))

    with pytest.raises(RuntimeError, match="catalog file corrupt"):
        client.post(
            "/v1/web/recommend",
            json={"idea": "blink an led", "locale": "en", "region": "us"},
        )


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


def test_web_upload_and_quote_endpoints_accept_frontend_submissions(monkeypatch):
    captured = {}

    def _record_upload(title, email, summary, recipe, locale, source):
        captured["upload"] = {
            "title": title,
            "email": email,
            "summary": summary,
            "recipe": recipe,
            "locale": locale,
            "source": source,
        }
        return "upl_test"

    def _record_quote(email, recipe_slug, recipe_title, goal, quantity, notes, locale, source):
        captured["quote"] = {
            "email": email,
            "recipe_slug": recipe_slug,
            "recipe_title": recipe_title,
            "goal": goal,
            "quantity": quantity,
            "notes": notes,
            "locale": locale,
            "source": source,
        }
        return "qt_test"

    from app import web_store

    monkeypatch.setattr(web_store, "record_recipe_upload", _record_upload)
    monkeypatch.setattr(web_store, "record_quote_request", _record_quote)

    upload_response = client.post(
        "/v1/web/uploads",
        json={
            "title": "Desk CO2 Monitor",
            "email": "Maker@Example.com",
            "summary": "A verified desk prototype",
            "recipe": {"prompt": "Build a CO2 monitor", "board_id": "esp32-s3-devkitc-1"},
            "locale": "en",
        },
    )
    quote_response = client.post(
        "/v1/web/quotes",
        json={
            "email": "Buyer@Example.com",
            "recipe_slug": "soil-moisture-monitor",
            "recipe_title": "Soil Moisture Monitor",
            "goal": "Cleaner PCB",
            "quantity": "25",
            "notes": "Need battery review",
            "locale": "en",
        },
    )

    assert upload_response.status_code == 202
    assert upload_response.json()["upload_id"] == "upl_test"
    assert captured["upload"]["title"] == "Desk CO2 Monitor"
    assert captured["upload"]["email"] == "maker@example.com"
    assert captured["upload"]["recipe"]["board_id"] == "esp32-s3-devkitc-1"
    assert quote_response.status_code == 202
    assert quote_response.json()["quote_id"] == "qt_test"
    assert captured["quote"]["email"] == "buyer@example.com"
    assert captured["quote"]["recipe_slug"] == "soil-moisture-monitor"


def test_web_upload_and_quote_endpoints_validate_payloads():
    upload_response = client.post(
        "/v1/web/uploads",
        json={"title": " ", "email": "not-an-email", "recipe": {}},
    )
    quote_response = client.post(
        "/v1/web/quotes",
        json={"email": "not-an-email", "notes": "x"},
    )

    assert upload_response.status_code == 422
    assert quote_response.status_code == 422


def test_web_best_effort_endpoints_swallow_persistence_failure(monkeypatch):
    # Force the persistence write to fail deterministically (simulating a DB outage /
    # no-DB context) rather than relying on DATABASE_URL being unset in the env -- under
    # `no_db` the conftest leaves DATABASE_URL as-is, so a CI run with a live DB would
    # otherwise let the write succeed and the counter stay 0. The endpoints must still
    # 204, AND the write must have been *attempted* and swallowed (failure counter bumps)
    # rather than silently skipped.
    from app import db, web_store

    def _boom(*_args, **_kwargs):
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(db, "connect", _boom)
    web_store.web_write_failure_count = 0
    event_response = client.post(
        "/v1/web/events",
        json={"event_type": "buy_link_clicked", "payload": {"vendor": "Adafruit"}, "locale": "en"},
    )
    newsletter_response = client.post(
        "/v1/web/newsletter",
        json={"email": "Maker@Example.com", "locale": "en", "source": "website-home"},
    )

    assert event_response.status_code == 204
    assert newsletter_response.status_code == 204
    assert web_store.web_write_failure_count == 2


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
            "Origin": "https://www.block-less.com",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://www.block-less.com"


def test_web_write_endpoints_allow_block_less_com_cors_preflight():
    # blockless.co (the origin this test used to assert) was removed from
    # _DEFAULT_CORS_ORIGINS in the task-6 audit: it doesn't resolve in DNS and has
    # no live frontend. block-less.com is the real, evidence-backed production origin.
    response = client.options(
        "/v1/web/quotes",
        headers={
            "Origin": "https://block-less.com",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://block-less.com"


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
                            # A real buyable product page in the generated catalog (NOT a
                            # vendor family/SoC page, which is filtered -- see
                            # test_board_family_page_is_filtered_not_surfaced).
                            "vendor": "Adafruit",
                            "url": "https://www.adafruit.com/product/5477",
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
    # No curated board link for this slug -> the generated catalog product link flows through.
    monkeypatch.setattr(recommendation_catalog, "BOARD_LINKS_PATH", tmp_path / "no_board_links.json")

    response = client.post("/v1/web/recommend", json={"idea": "blink led", "locale": "en", "region": "us"})

    assert response.status_code == 200
    board = response.json()["recommended_board"]
    assert board["name"] == "ESP32-S3"
    assert board["buy_url"] == "https://www.adafruit.com/product/5477"
    assert board["primary_link"]["is_search"] is False
    assert board["primary_link"]["store"] == "Adafruit"
    assert board["micropython_url"] == "https://micropython.org/download/ESP32_GENERIC_S3/"
    assert board["firmware_url"].endswith("ESP32_GENERIC_S3.bin")


def test_board_family_page_is_filtered_not_surfaced(tmp_path, monkeypatch):
    # The bug: the generated catalog leads with a vendor family/SoC page
    # (espressif.com/en/products/modules) that has no add-to-cart. It must never be the
    # buy action nor leak into purchase_links; with no curated page the board falls to the
    # honest single Amazon search instead.
    boards_path = tmp_path / "micropython_boards.json"
    links_path = tmp_path / "hardware_purchase_links_us.json"
    boards_path.write_text(
        json.dumps({"boards": [{"slug": "ESP32_GENERIC_S3", "name": "ESP32-S3", "vendor": "Espressif",
                                "detail_url": "https://micropython.org/download/ESP32_GENERIC_S3/"}]}),
        encoding="utf-8",
    )
    links_path.write_text(
        json.dumps({"links_by_slug": {"ESP32_GENERIC_S3": [
            {"vendor": "Espressif", "url": "https://www.espressif.com/en/products/modules", "link_type": "official"},
            {"vendor": "Amazon", "url": "https://www.amazon.com/s?k=ESP32-S3", "link_type": "search_fallback"},
        ]}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(recommendation_catalog, "BOARDS_PATH", boards_path)
    monkeypatch.setattr(recommendation_catalog, "LINKS_PATH", links_path)
    monkeypatch.setattr(recommendation_catalog, "BOARD_LINKS_PATH", tmp_path / "no_board_links.json")

    board = client.post(
        "/v1/web/recommend", json={"idea": "blink led", "locale": "en", "region": "us"}
    ).json()["recommended_board"]

    assert "espressif.com/en/products/modules" not in board["buy_url"]
    assert all("espressif.com/en/products/modules" not in link["url"] for link in board["purchase_links"])
    assert board["buy_url"] == "https://www.amazon.com/s?k=ESP32-S3"
    assert board["primary_link"]["is_search"] is True
    assert board["primary_link"]["store"] == "Amazon"


def test_board_with_no_buyable_link_fails_loudly(tmp_path, monkeypatch):
    # Fail-fast: if every board link is a filtered family/SoC page (nothing buyable), the
    # endpoint must ERROR loudly -- NOT return a card with a soft "Link pending" state nor a
    # fabricated corporate link. A missing buyable board link is a data gap we want screaming.
    boards_path = tmp_path / "micropython_boards.json"
    links_path = tmp_path / "hardware_purchase_links_us.json"
    boards_path.write_text(
        json.dumps({"boards": [{"slug": "ESP32_GENERIC_S3", "name": "ESP32-S3", "vendor": "Espressif",
                                "detail_url": "https://micropython.org/download/ESP32_GENERIC_S3/",
                                "more_info_url": "https://www.espressif.com/en/products/modules"}]}),
        encoding="utf-8",
    )
    links_path.write_text(
        json.dumps({"links_by_slug": {"ESP32_GENERIC_S3": [
            {"vendor": "Espressif", "url": "https://www.espressif.com/en/products/modules", "link_type": "official"},
        ]}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(recommendation_catalog, "BOARDS_PATH", boards_path)
    monkeypatch.setattr(recommendation_catalog, "LINKS_PATH", links_path)
    monkeypatch.setattr(recommendation_catalog, "BOARD_LINKS_PATH", tmp_path / "none.json")

    response = client.post("/v1/web/recommend", json={"idea": "blink led", "locale": "en", "region": "us"})

    assert response.status_code == 500
    assert response.json()["detail"]["error"] == "board_unbuyable"


def test_parts_carry_single_primary_link():
    # Each part exposes one render-ready primary_link {url, store, is_search}; buy_url
    # mirrors its url for back-compat.
    body = client.post(
        "/v1/web/recommend",
        json={"idea": "a temperature alarm with an oled display", "locale": "en", "region": "us"},
    ).json()

    assert body["parts"]
    for part in body["parts"]:
        primary = part["primary_link"]
        assert primary["url"].startswith("https://")
        assert "is_search" in primary
        assert part["buy_url"] == primary["url"]


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
