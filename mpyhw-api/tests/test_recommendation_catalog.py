import pytest

from app import recommendation_catalog as catalog


pytestmark = pytest.mark.no_db

INDEX_HTML = """
<a class="board-card" href="ESP32_GENERIC">
  <div class="board-image">
    <img src="https://micropython.org/resources/micropython-media/boards/ESP32_GENERIC/esp32_devkitc.thumb.jpg">
  </div>
  <div class="board-product">ESP32 / WROOM</div>
  <div class="board-vendor">Espressif</div>
</a>
<a class="board-card" href="RPI_PICO_W">
  <div class="board-product">Raspberry Pi Pico W</div>
  <div class="board-vendor">Raspberry Pi</div>
</a>
"""


DETAIL_HTML = """
<h2> ESP32 / WROOM </h2>
<img src="https://micropython.org/resources/micropython-media/boards/ESP32_GENERIC/esp32_devkitc.jpg" class="img-responsive thumb hero">
<div><strong>Vendor:</strong> Espressif</div>
<div><strong>Features:</strong> BLE, External Flash, WiFi</div>
<div><strong>Source on GitHub:</strong>
  <a href="https://github.com/micropython/micropython/tree/master/ports/esp32/boards/ESP32_GENERIC">esp32/ESP32_GENERIC</a>
</div>
<div><strong>More info:</strong> <a href="https://www.espressif.com/en/products/modules">Website</a></div>
<h2>Firmware</h2>
<h3>Releases</h3>
<div><a href="/resources/firmware/ESP32_GENERIC-20220117-v1.18.bin">v1.18 (2022-01-17) .bin</a></div>
<div><strong><a href="/resources/firmware/ESP32_GENERIC-20260406-v1.28.0.uf2">v1.28.0 (2026-04-06) .uf2</a></strong> (latest)</div>
<h3>Preview builds</h3>
<div><a href="/resources/firmware/ESP32_GENERIC-20250618-v1.29.0-preview.1.gabc.bin">v1.29.0-preview.1.gabc (2025-06-18) .bin</a></div>
<div><a href="/resources/firmware/ESP32_GENERIC-20260618-v1.29.0-preview.123.gabc.bin">v1.29.0-preview.123.gabc (2026-06-18) .bin</a></div>
"""


def test_parse_download_index_extracts_board_cards():
    boards = catalog.parse_download_index(INDEX_HTML)

    assert boards[0]["slug"] == "ESP32_GENERIC"
    assert boards[0]["name"] == "ESP32 / WROOM"
    assert boards[0]["vendor"] == "Espressif"
    assert boards[0]["detail_url"] == "https://micropython.org/download/ESP32_GENERIC/"
    assert boards[0]["image_url"].endswith("esp32_devkitc.thumb.jpg")
    assert boards[1]["slug"] == "RPI_PICO_W"


def test_parse_board_detail_extracts_metadata_and_firmware():
    board = catalog.parse_board_detail("ESP32_GENERIC", DETAIL_HTML)

    assert board["slug"] == "ESP32_GENERIC"
    assert board["name"] == "ESP32 / WROOM"
    assert board["vendor"] == "Espressif"
    assert board["features"] == ["BLE", "External Flash", "WiFi"]
    assert board["source_url"].endswith("/ESP32_GENERIC")
    assert board["more_info_url"] == "https://www.espressif.com/en/products/modules"
    assert board["firmware"]["latest_release"]["version"] == "v1.28.0"
    assert board["firmware"]["latest_release"]["date"] == "2026-04-06"
    assert board["firmware"]["latest_release"]["url"].endswith(".uf2")
    assert board["firmware"]["latest_preview"]["version"].startswith("v1.29.0-preview")


def test_purchase_links_prefer_known_official_and_include_search_fallback():
    links = catalog.purchase_links_for_board({"slug": "RPI_PICO_W", "name": "Raspberry Pi Pico W", "vendor": "Raspberry Pi"})

    assert links[0]["vendor"] == "Raspberry Pi"
    assert links[0]["link_type"] == "official"
    assert links[0]["confidence"] == "high"
    assert any(link["link_type"] == "search_fallback" for link in links)


def test_purchase_links_use_more_info_as_official_vendor_page():
    links = catalog.purchase_links_for_board(
        {
            "slug": "PYBD_SF2",
            "name": "Pyboard D-series SF2",
            "vendor": "George Robotics",
            "more_info_url": "https://store.micropython.org/product/PYBD-SF2-W4F2",
        }
    )

    assert links[0]["vendor"] == "George Robotics"
    assert links[0]["url"] == "https://store.micropython.org/product/PYBD-SF2-W4F2"
    assert links[0]["link_type"] == "official"
