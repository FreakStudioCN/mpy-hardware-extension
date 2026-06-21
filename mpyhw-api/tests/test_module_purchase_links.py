import json

import pytest

from app import recommendation_catalog


pytestmark = pytest.mark.no_db


def _write_library(tmp_path, monkeypatch, links_by_module):
    path = tmp_path / "module_purchase_links.json"
    path.write_text(json.dumps({"links_by_module": links_by_module}), encoding="utf-8")
    monkeypatch.setattr(recommendation_catalog, "MODULE_LINKS_PATH", path)
    return path


def test_curated_entry_is_returned_for_exact_module_key(tmp_path, monkeypatch):
    _write_library(
        tmp_path,
        monkeypatch,
        {
            "ssd1306": [
                {
                    "vendor": "Adafruit",
                    "url": "https://www.adafruit.com/product/938",
                    "link_type": "official",
                    "confidence": "high",
                    "checked_at": "2026-06-20",
                    "evidence_url": "https://www.adafruit.com/product/938",
                }
            ]
        },
    )

    links = recommendation_catalog.module_purchase_links("ssd1306")

    assert links[0]["url"] == "https://www.adafruit.com/product/938"
    assert links[0]["link_type"] == "official"


def test_driver_name_variant_resolves_to_same_curated_entry(tmp_path, monkeypatch):
    _write_library(
        tmp_path,
        monkeypatch,
        {"aht20": [{"vendor": "Adafruit", "url": "https://www.adafruit.com/product/4566", "link_type": "official", "confidence": "high"}]},
    )

    # canonical_chip_id strips a trailing _driver, so the catalog name aht20_driver
    # must hit the same curated entry keyed by "aht20".
    links = recommendation_catalog.module_purchase_links("aht20_driver")

    assert links[0]["url"] == "https://www.adafruit.com/product/4566"


def test_missing_key_falls_back_to_single_amazon_search(tmp_path, monkeypatch):
    _write_library(tmp_path, monkeypatch, {"ssd1306": []})

    links = recommendation_catalog.module_purchase_links("hcsr04")

    # One honest channel only (changed from the old dual Adafruit+Amazon): a non-engineer
    # wants one place to buy, not a choice between maker stores. Amazon is the
    # consumer-familiar default; Adafruit-search and industrial DigiKey are not offered.
    assert len(links) == 1
    link = links[0]
    assert link["vendor"] == "Amazon"
    assert link["link_type"] == "search_fallback"
    assert link["confidence"] == "low"
    assert link["url"].startswith("https://")


def test_shipped_curated_library_is_well_formed_and_keys_map_to_catalog():
    from app import package_store

    library = recommendation_catalog.load_module_purchase_links()
    assert library, "expected a shipped curated module link library"

    catalog_keys = {package_store.canonical_chip_id(r["name"]) for r in package_store.PackageStore.default().records}
    for key, links in library.items():
        # Every curated key must be a real catalog canonical chip id (keying discipline).
        assert key == package_store.canonical_chip_id(key)
        assert key in catalog_keys, f"curated key {key!r} is not a real catalog package"
        assert links, f"curated entry {key!r} has no links"
        for link in links:
            assert link["url"].startswith("https://")
            assert link["vendor"]
            assert link["link_type"]
            assert link["checked_at"]
            assert link["evidence_url"].startswith("https://")


def test_region_override_file_wins_and_defaults_to_us(tmp_path, monkeypatch):
    # Region seam: a `<stem>.<region>.json` override is used when present; any region
    # without one falls back to the shipped US file. Only US ships today.
    us_path = tmp_path / "module_purchase_links.json"
    us_path.write_text(json.dumps({"links_by_module": {"aht20": [
        {"vendor": "Adafruit", "url": "https://www.adafruit.com/product/4566", "link_type": "official"}]}}), encoding="utf-8")
    cn_path = tmp_path / "module_purchase_links.cn.json"
    cn_path.write_text(json.dumps({"links_by_module": {"aht20": [
        {"vendor": "Taobao", "url": "https://example.tmall.com/aht20", "link_type": "official"}]}}), encoding="utf-8")
    monkeypatch.setattr(recommendation_catalog, "MODULE_LINKS_PATH", us_path)

    assert recommendation_catalog.module_purchase_links("aht20", "cn")[0]["vendor"] == "Taobao"
    assert recommendation_catalog.module_purchase_links("aht20", "us")[0]["vendor"] == "Adafruit"
    # A region with no override file falls back to the US file.
    assert recommendation_catalog.module_purchase_links("aht20", "jp")[0]["vendor"] == "Adafruit"


def test_missing_library_file_does_not_crash(tmp_path, monkeypatch):
    monkeypatch.setattr(recommendation_catalog, "MODULE_LINKS_PATH", tmp_path / "does_not_exist.json")

    assert recommendation_catalog.load_module_purchase_links() == {}
    # Still yields a usable search fallback so the endpoint keeps working before the
    # curated library is built.
    links = recommendation_catalog.module_purchase_links("bme280")
    assert links[0]["url"].startswith("https://")
