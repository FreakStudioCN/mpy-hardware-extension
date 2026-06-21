from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus, urljoin


from app.package_store import canonical_chip_id

MICROPYTHON_DOWNLOAD_URL = "https://micropython.org/download/"
ROOT = Path(__file__).resolve().parents[1]
RECOMMENDATION_DIR = ROOT / "content" / "recommendation"
BOARDS_PATH = RECOMMENDATION_DIR / "micropython_boards.json"
LINKS_PATH = RECOMMENDATION_DIR / "hardware_purchase_links_us.json"
MODULE_LINKS_PATH = RECOMMENDATION_DIR / "module_purchase_links.json"
BOARD_LINKS_PATH = RECOMMENDATION_DIR / "board_purchase_links.json"


class _BoardIndexParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.boards: list[dict[str, str]] = []
        self._current: dict[str, str] | None = None
        self._field: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        classes = set((attr.get("class") or "").split())
        if tag == "a" and "board-card" in classes:
            slug = (attr.get("href") or "").strip().strip("/")
            self._current = {
                "slug": slug,
                "detail_url": urljoin(MICROPYTHON_DOWNLOAD_URL, f"{slug}/"),
            }
            self._field = None
        elif self._current is not None and tag == "div" and "board-product" in classes:
            self._field = "name"
        elif self._current is not None and tag == "div" and "board-vendor" in classes:
            self._field = "vendor"
        elif self._current is not None and tag == "img":
            src = (attr.get("src") or "").strip()
            if src:
                self._current["image_url"] = urljoin(MICROPYTHON_DOWNLOAD_URL, src)

    def handle_data(self, data: str) -> None:
        if self._current is not None and self._field:
            value = data.strip()
            if value:
                self._current[self._field] = value

    def handle_endtag(self, tag: str) -> None:
        if self._current is not None and tag == "div":
            self._field = None
        elif self._current is not None and tag == "a":
            if self._current.get("slug"):
                self.boards.append(self._current)
            self._current = None
            self._field = None


class _BoardDetailParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.name = ""
        self.vendor = ""
        self.features: list[str] = []
        self.source_url = ""
        self.more_info_url = ""
        self.image_url = ""
        self.firmware_links: list[dict[str, str]] = []
        self._capture_h2 = False
        self._current_label = ""
        self._capture_label_text = False
        self._current_link: dict[str, str] | None = None
        self._in_anchor = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        if tag == "h2" and not self.name:
            self._capture_h2 = True
            return
        if tag == "img" and "hero" in (attr.get("class") or "").split():
            src = (attr.get("src") or "").strip()
            if src:
                self.image_url = urljoin(MICROPYTHON_DOWNLOAD_URL, src)
            return
        if tag == "strong":
            self._capture_label_text = True
            self._current_label = ""
            return
        if tag == "a":
            href = (attr.get("href") or "").strip()
            self._in_anchor = True
            self._current_link = {"href": href, "text": ""}

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if not text:
            return
        if self._capture_h2 and not self.name:
            self.name = text
        elif self._in_anchor and self._current_link is not None:
            self._current_link["text"] += text
        elif self._capture_label_text:
            self._current_label += text
        elif self._current_label.startswith("Vendor"):
            self.vendor = text
            self._current_label = ""
        elif self._current_label.startswith("Features"):
            self.features = [part.strip() for part in text.split(",") if part.strip()]
            self._current_label = ""

    def handle_endtag(self, tag: str) -> None:
        if tag == "h2":
            self._capture_h2 = False
        elif tag == "strong":
            self._capture_label_text = False
        elif tag == "a" and self._current_link is not None:
            href = self._current_link["href"]
            text = self._current_link["text"]
            full_url = urljoin(MICROPYTHON_DOWNLOAD_URL, href)
            if self._current_label.startswith("Source on GitHub"):
                self.source_url = full_url
                self._current_label = ""
            elif self._current_label.startswith("More info"):
                self.more_info_url = full_url
                self._current_label = ""
            elif "/resources/firmware/" in href:
                parsed = _parse_firmware_text(text)
                if parsed:
                    parsed["url"] = full_url
                    self.firmware_links.append(parsed)
            self._current_link = None
            self._in_anchor = False


def parse_download_index(html: str) -> list[dict[str, Any]]:
    parser = _BoardIndexParser()
    parser.feed(html)
    return parser.boards


def parse_board_detail(slug: str, html: str) -> dict[str, Any]:
    parser = _BoardDetailParser()
    parser.feed(html)
    releases = sorted(
        (item for item in parser.firmware_links if "preview" not in item["version"]),
        key=lambda item: item["date"],
        reverse=True,
    )
    previews = sorted(
        (item for item in parser.firmware_links if "preview" in item["version"]),
        key=lambda item: item["date"],
        reverse=True,
    )
    return {
        "slug": slug,
        "name": parser.name or slug,
        "vendor": parser.vendor,
        "features": parser.features,
        "detail_url": urljoin(MICROPYTHON_DOWNLOAD_URL, f"{slug}/"),
        "image_url": parser.image_url,
        "source_url": parser.source_url,
        "more_info_url": parser.more_info_url,
        "firmware": {
            "latest_release": releases[0] if releases else None,
            "latest_preview": previews[0] if previews else None,
        },
    }


def purchase_links_for_board(board: dict[str, Any]) -> list[dict[str, str]]:
    name = str(board.get("name") or board.get("slug") or "MicroPython board")
    vendor = str(board.get("vendor") or "")
    slug = str(board.get("slug") or "")
    query = quote_plus(f"{vendor} {name}".strip())
    links: list[dict[str, str]] = []
    more_info = str(board.get("more_info_url") or "")
    if more_info:
        links.append(
            {
                "vendor": vendor or "Official",
                "url": more_info,
                "link_type": "official",
                "confidence": "high" if "/product/" in more_info or "/products/" in more_info else "medium",
                "evidence_url": str(board.get("detail_url") or urljoin(MICROPYTHON_DOWNLOAD_URL, f"{slug}/")),
                "checked_at": _today(),
                "notes": "Official board More info link from MicroPython download page.",
            }
        )
    known = _known_vendor_link(vendor, slug)
    if known and all(link["url"] != known["url"] for link in links):
        links.append(known)
    # Beginner-friendly marketplace search only. DigiKey is deliberately NOT used: it
    # is an industrial/enterprise distributor whose huge catalog is off-putting and
    # confusing for the hardware-novice this site targets.
    links.append(
        {
            "vendor": "Amazon",
            "url": f"https://www.amazon.com/s?k={query}",
            "link_type": "search_fallback",
            "confidence": "low",
            "evidence_url": str(board.get("detail_url") or MICROPYTHON_DOWNLOAD_URL),
            "checked_at": _today(),
            "notes": "Search fallback; marketplace listing was not individually verified.",
        }
    )
    return links


def load_boards() -> list[dict[str, Any]]:
    if not BOARDS_PATH.is_file():
        return []
    return json.loads(BOARDS_PATH.read_text(encoding="utf-8")).get("boards", [])


def _region_links_path(default_path: Path, region: str) -> Path:
    """Resolve a region-specific links file. A `<stem>.<region>.json` override file
    next to the default wins when present; otherwise the shipped default (US) file is
    used. Region seam only -- today only the US files ship, so any region falls back
    to US until its curated file is added (e.g. module_purchase_links.cn.json)."""
    region = (region or "us").strip().lower()
    if region in ("", "us"):
        return default_path
    override = default_path.with_name(f"{default_path.stem}.{region}.json")
    return override if override.is_file() else default_path


def load_purchase_links(region: str = "us") -> dict[str, list[dict[str, Any]]]:
    path = _region_links_path(LINKS_PATH, region)
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8")).get("links_by_slug", {})


def load_module_purchase_links(region: str = "us") -> dict[str, list[dict[str, Any]]]:
    path = _region_links_path(MODULE_LINKS_PATH, region)
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8")).get("links_by_module", {})


def load_board_purchase_links(region: str = "us") -> dict[str, list[dict[str, Any]]]:
    path = _region_links_path(BOARD_LINKS_PATH, region)
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8")).get("links_by_slug", {})


def board_purchase_links(slug: str, region: str = "us") -> list[dict[str, Any]]:
    """Curated, verified, beginner-buyable product page(s) for a recommended board,
    keyed by MicroPython board slug. These take precedence over the generated
    hardware_purchase_links_us.json, whose first entry is the board's MicroPython
    "More info" link -- a vendor SoC/family page you cannot actually buy a dev board
    from. Returns [] when no curated link exists (then the generated links apply)."""
    if not slug:
        return []
    return load_board_purchase_links(region).get(slug, [])


def module_purchase_links(module_name: str, region: str = "us") -> list[dict[str, str]]:
    """Buy links for one hardware module, keyed by canonical_chip_id so a catalog
    name (`aht20_driver`) and its curated entry (`aht20`) join. Returns the curated,
    audited product links when present, else a labeled beginner-friendly search
    fallback (Adafruit maker store + Amazon) so the endpoint stays usable before the
    library is built. DigiKey is deliberately avoided: its industrial catalog is
    off-putting for the hardware novices this site targets."""
    key = canonical_chip_id(module_name)
    curated = load_module_purchase_links(region).get(key)
    if curated:
        return curated
    query = quote_plus(module_name.strip())
    return [
        {
            "vendor": "Adafruit",
            "url": f"https://www.adafruit.com/search?q={query}",
            "link_type": "search_fallback",
            "confidence": "low",
            "checked_at": _today(),
            "notes": "Maker-store search fallback; product page was not individually verified.",
        },
        {
            "vendor": "Amazon",
            "url": f"https://www.amazon.com/s?k={query}",
            "link_type": "search_fallback",
            "confidence": "low",
            "checked_at": _today(),
            "notes": "Search fallback; marketplace listing was not individually verified.",
        },
    ]


_BEGINNER_BOARD_ORDER = ("ESP32_GENERIC_S3", "RPI_PICO_W", "ESP32_GENERIC_C3", "ESP32_GENERIC")
_BOARD_ORDER_BY_FAMILY = {
    "rp2040": ("RPI_PICO_W", "RPI_PICO", "RPI_PICO2_W", "RPI_PICO2"),
    "esp32": ("ESP32_GENERIC_S3", "ESP32_GENERIC_C3", "ESP32_GENERIC", "ESP32_GENERIC_S2"),
}


def select_beginner_board(family_hint: str | None = None) -> dict[str, Any] | None:
    """Pick a beginner board. When the idea hints a board family (esp32 / rp2040 --
    e.g. "a raspberry pi pico project"), prefer a beginner board of that family;
    otherwise fall back to the default beginner priority. Always falls back to the
    general order, then any board, so a missing family list can't return nothing."""
    boards = load_boards()
    by_slug = {board.get("slug"): board for board in boards}
    order = _BOARD_ORDER_BY_FAMILY.get(family_hint or "", ()) + _BEGINNER_BOARD_ORDER
    for slug in order:
        if slug in by_slug:
            return by_slug[slug]
    return boards[0] if boards else None


def _parse_firmware_text(text: str) -> dict[str, str] | None:
    match = re.search(r"(v[^\s]+)\s+\((\d{4}-\d{2}-\d{2})\)", text)
    if not match:
        return None
    return {"version": match.group(1), "date": match.group(2)}


def _known_vendor_link(vendor: str, slug: str) -> dict[str, str] | None:
    vendor_key = vendor.lower()
    if "raspberry pi" in vendor_key:
        return _official("Raspberry Pi", "https://www.raspberrypi.com/products/raspberry-pi-pico/", slug)
    if "arduino" in vendor_key:
        return _official("Arduino Store", "https://store.arduino.cc/", slug)
    if "adafruit" in vendor_key:
        return _official("Adafruit", "https://www.adafruit.com/category/943", slug)
    if "sparkfun" in vendor_key:
        return _official("SparkFun", "https://www.sparkfun.com/", slug)
    if "espressif" in vendor_key:
        return _official("Espressif", "https://www.espressif.com/en/products/devkits", slug)
    if "seeed" in vendor_key:
        return _official("Seeed Studio", "https://www.seeedstudio.com/", slug)
    return None


def _official(vendor: str, url: str, slug: str) -> dict[str, str]:
    return {
        "vendor": vendor,
        "url": url,
        "link_type": "official",
        "confidence": "high",
        "evidence_url": urljoin(MICROPYTHON_DOWNLOAD_URL, f"{slug}/"),
        "checked_at": _today(),
        "notes": "Official vendor/product-family page.",
    }


def _today() -> str:
    return datetime.now(UTC).date().isoformat()
