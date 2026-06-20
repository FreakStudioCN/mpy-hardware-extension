import json

import pytest

from app import recommendation_catalog


pytestmark = pytest.mark.no_db


def test_generated_micropython_catalog_has_expected_coverage():
    boards_payload = json.loads(recommendation_catalog.BOARDS_PATH.read_text(encoding="utf-8"))
    links_payload = json.loads(recommendation_catalog.LINKS_PATH.read_text(encoding="utf-8"))
    manifest = json.loads((recommendation_catalog.RECOMMENDATION_DIR / "scrape_manifest.json").read_text(encoding="utf-8"))

    boards = boards_payload["boards"]
    links_by_slug = links_payload["links_by_slug"]

    assert manifest["requested_count"] >= 200
    assert manifest["board_count"] == len(boards)
    assert manifest["error_count"] == 0
    assert len(links_by_slug) == len(boards)
    assert all(board.get("name") and board.get("vendor") and board.get("detail_url") for board in boards)
    assert sum(1 for board in boards if (board.get("firmware") or {}).get("latest_release")) >= 200


def test_generated_purchase_links_are_actionable_for_us_buyers():
    links_payload = json.loads(recommendation_catalog.LINKS_PATH.read_text(encoding="utf-8"))
    links_by_slug = links_payload["links_by_slug"]

    assert all(links for links in links_by_slug.values())
    assert sum(
        1
        for links in links_by_slug.values()
        if any(link.get("link_type") == "official" and link.get("confidence") in ("high", "medium") for link in links)
    ) >= 170
    for links in links_by_slug.values():
        assert any(link["vendor"] == "DigiKey" for link in links)
        assert any(link["vendor"] == "Amazon" for link in links)
        for link in links:
            assert link["url"].startswith(("https://", "http://"))
            assert link["vendor"]
            assert link["checked_at"]
            assert link["evidence_url"].startswith("https://")


def test_beginner_recommendation_uses_current_firmware_and_purchase_link():
    board = recommendation_catalog.select_beginner_board()
    links = recommendation_catalog.load_purchase_links()[board["slug"]]

    assert board["slug"] == "ESP32_GENERIC_S3"
    assert board["firmware"]["latest_release"]["version"] == "v1.28.0"
    assert board["firmware"]["latest_release"]["date"] == "2026-04-06"
    assert board["firmware"]["latest_release"]["url"].endswith(".uf2")
    assert links[0]["link_type"] == "official"
