import hashlib
import json
import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response

from app import skill_catalog
from app.toolchain import TOOLCHAIN_VERSION
from app.tool_registry import PROTOCOL_VERSION


ROOT = Path(__file__).resolve().parents[1]
router = APIRouter()
logger = logging.getLogger("mpyhw.content")


def _safe_content_path(base: Path, name: str, suffix: str) -> Path:
    root = base.resolve()
    path = (base / f"{name}{suffix}").resolve()
    if not path.is_relative_to(root):
        raise HTTPException(status_code=404, detail={"error": "content_not_found"})
    return path


@router.get("/v1/boards")
def boards():
    entries = []
    for path in sorted((ROOT / "content" / "boards").glob("*.json")):
        body = path.read_bytes()
        data = json.loads(body.decode("utf-8"))
        board_id = data.get("board_id")
        if not board_id:
            # Skip a malformed board file rather than 500 the whole listing.
            continue
        entries.append({
            "board_id": board_id,
            "display_name": data.get("display_name", board_id),
            "manufacturer": data.get("manufacturer", ""),
            "detail_url": f"/v1/boards/{board_id}",
            "detail_sha256": hashlib.sha256(body).hexdigest(),
        })
    return {"version": hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest(), "builtin": entries, "community": []}


@router.get("/v1/boards/{board_id}")
def board(board_id: str):
    path = _safe_content_path(ROOT / "content" / "boards", board_id, ".json")
    if not path.exists():
        raise HTTPException(status_code=404, detail={"error": "board_not_found"})
    return json.loads(path.read_text(encoding="utf-8"))


_OFFICIAL_BOARD_MAPPINGS = {
    "ESP32_GENERIC_C3": {"local_board_id": "esp32-c3-devkitm-1", "skill_board_id": "esp32-c3-devkitm", "chip_family": "esp32c3"},
    "ESP32_GENERIC_S3": {"local_board_id": "esp32-s3-devkitc-1", "skill_board_id": "esp32-s3-devkitc", "chip_family": "esp32s3"},
    "RPI_PICO_W": {"local_board_id": "rpi-pico-w", "skill_board_id": "raspberry-pi-pico-w", "chip_family": "rp2"},
    "ESP32_GENERIC": {"local_board_id": "esp32-devkit-v1", "skill_board_id": "esp32-devkit-v1", "chip_family": "esp32"},
    "RPI_PICO": {"local_board_id": "raspberry-pi-pico", "skill_board_id": "raspberry-pi-pico", "chip_family": "rp2"},
    "ESP8266_GENERIC": {"local_board_id": "esp8266-nodemcu", "skill_board_id": "esp8266-nodemcu", "chip_family": "esp8266"},
}


def _official_boards_path() -> Path:
    return ROOT / "content" / "recommendation" / "micropython_boards.json"


def _local_board_ids() -> set[str]:
    ids: set[str] = set()
    for path in (ROOT / "content" / "boards").glob("*.json"):
        try:
            board_id = json.loads(path.read_text(encoding="utf-8")).get("board_id")
        except Exception:
            continue
        if board_id:
            ids.add(str(board_id))
    return ids


def _skill_boards_dir() -> Path:
    return ROOT.parent / "third_party" / "MicroPython_Skills" / "upy-analyze-plugin" / "boards"


def _skill_board_ids() -> set[str]:
    return {path.stem for path in _skill_boards_dir().glob("*.json") if not path.name.startswith("_")}


def _port_from_board(board: dict) -> str:
    source = str(board.get("source_url") or "")
    match = re.search(r"/ports/([^/]+)/boards/", source)
    if match:
        return match.group(1)
    slug = str(board.get("slug") or "").upper()
    if slug.startswith("ESP32"):
        return "esp32"
    if slug.startswith(("RPI_", "PICO", "WAVESHARE_RP", "ADAFRUIT_FEATHER_RP", "SPARKFUN_PROMICRO_RP")):
        return "rp2"
    if slug.startswith(("PYB", "STM32", "VCC_GND", "WEACT")):
        return "stm32"
    return ""


def _mcu_from_board(board: dict, port: str) -> str:
    slug = str(board.get("slug") or "").upper()
    source = str(board.get("source_url") or "").lower()
    if "esp32c3" in source or "_C3" in slug:
        return "esp32c3"
    if "esp32s3" in source or "_S3" in slug:
        return "esp32s3"
    if "esp32s2" in source or "_S2" in slug:
        return "esp32s2"
    if "esp32c6" in source or "_C6" in slug:
        return "esp32c6"
    if "rp2350" in source or "RP2350" in slug:
        return "rp2350"
    if "rp2040" in source or "PICO" in slug or "RP2040" in slug:
        return "rp2040"
    if slug == "PYBD_SF2":
        return "stm32f722"
    return port


def _slug_to_skill_board_id(slug: str) -> str:
    # Every official MicroPython board's Skill board id is a pure transform of its download slug
    # (verified: id == slug.lower().replace("_","-") for all 222 boards at Skill bc1769e). The only
    # exceptions are the curated builtin dev-boards, handled via _OFFICIAL_BOARD_MAPPINGS below.
    return slug.lower().replace("_", "-")


def _official_board_entry(board: dict, *, local_ids: set[str], skill_ids: set[str], source_url: str) -> dict:
    slug = str(board.get("slug") or "").strip()
    port = _port_from_board(board)
    mapping = _OFFICIAL_BOARD_MAPPINGS.get(slug, {})
    local_board_id = mapping.get("local_board_id")
    has_local_layout = bool(local_board_id and local_board_id in local_ids)
    # Keep a stable kebab UI id for every official board. Only expose skill_board_id when the pinned
    # Skill submodule actually contains boards/<id>.json; callers can otherwise use official firmware
    # without trying to load a nonexistent profile. Curated builtin ids override the slug transform.
    candidate_skill_board_id = mapping.get("skill_board_id") or _slug_to_skill_board_id(slug)
    skill_profile_available = candidate_skill_board_id in skill_ids
    skill_board_id = candidate_skill_board_id if skill_profile_available else None
    detail_url = str(board.get("detail_url") or f"https://micropython.org/download/{slug}/")
    features = board.get("features") if isinstance(board.get("features"), list) else []
    latest = (board.get("firmware") or {}).get("latest_release") or (board.get("firmware") or {}).get("latest_preview") or {}
    mcu = _mcu_from_board(board, port)
    return {
        "id": candidate_skill_board_id,
        "official_id": slug,
        "display_name": board.get("name") or slug,
        "vendor": board.get("vendor") or "",
        "port": port,
        "mcu": mcu,
        "chip_family": mapping.get("chip_family") or mcu,
        "features": features,
        "firmware": {
            "url": detail_url,
            "port": port,
            "board_name": slug,
            "latest_release_url": latest.get("url"),
            "latest_release_version": latest.get("version"),
            "latest_version": latest.get("version"),
        },
        "download_slug": slug,
        "skill_board_id": skill_board_id,
        "skill_profile_available": skill_profile_available,
        "source_url": source_url,
        "detail_url": detail_url,
        "image_url": board.get("image_url") or "",
        "support_status": "builtin_pin_layout" if has_local_layout else "official_firmware_only",
        "local_board_id": local_board_id if has_local_layout else None,
    }


VENDOR_SUPPORT_STATUS = "skill_vendor_profile"


def _vendor_board_paths() -> list[Path]:
    try:
        return sorted(
            path for path in _skill_boards_dir().iterdir()
            if path.suffix == ".json" and not path.name.startswith("_")
        )
    except FileNotFoundError:
        # No Skill submodule checkout (fresh clone, or a test ROOT): serve the official
        # index alone. Any other read error (permissions, not-a-directory) must surface.
        return []


def _vendor_board_entry(data: dict) -> dict | None:
    """A curated Skill vendor board as one `boards[]` entry, or None if the file is malformed.

    These boards have no official download slug of their own (LilyGO/Waveshare ESP32-S3
    boards share the ESP32_GENERIC_S3 firmware page), so `official_id`/`download_slug`/
    `local_board_id` stay null: the entry is a real physical board, not an official index row.
    """
    board_id = data.get("id")
    firmware = data.get("firmware")
    if not isinstance(board_id, str) or not board_id.strip() or not isinstance(firmware, dict):
        return None
    # Vendor profiles carry no top-level port; the firmware block is the one that names it.
    port = str(firmware.get("port") or "")
    mcu = str(data.get("mcu") or "")
    media = data.get("media") if isinstance(data.get("media"), dict) else {}
    return {
        "id": board_id,
        "official_id": None,
        "display_name": data.get("display_name") or board_id,
        "vendor": data.get("vendor") or "",
        "port": port,
        "mcu": mcu,
        "chip_family": str(data.get("chip_family") or mcu),
        "features": data["features"] if isinstance(data.get("features"), list) else [],
        # Copied verbatim: the flash phase needs every key the vendor profile declares
        # (variant/source/file_type/flash_method, and whatever a future family adds), not a
        # re-projection of the handful of fields the official entry happens to use.
        "firmware": dict(firmware),
        # Onboard peripherals ride along verbatim so the driver-package metadata
        # (uPyPi package/version/install_cmd, expander and revision-dependent notes) reaches
        # the phases unfiltered instead of being rebuilt downstream.
        "onboard_peripherals": data["onboard_peripherals"] if isinstance(data.get("onboard_peripherals"), list) else [],
        "download_slug": None,
        "skill_board_id": board_id,
        "skill_profile_available": True,
        "source_url": str(media.get("source_url") or media.get("product_page_url") or ""),
        "detail_url": str(firmware.get("url") or ""),
        "image_url": str(media.get("board_image_url") or ""),
        "support_status": VENDOR_SUPPORT_STATUS,
        "local_board_id": None,
    }


def _vendor_boards() -> list[dict]:
    """Curated vendor boards from the pinned Skill profiles, for the same `boards[]` list.

    Only profiles that opt in (`ui_visible` + `support_status`) are served, so a vendor family
    whose flash workflow is not wired up yet stays out of the picker until it flips the flag.
    """
    entries: list[dict] = []
    for path in _vendor_board_paths():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue  # deleted between listing and read
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            # Unparseable content (bad JSON, or a profile saved in a non-UTF-8 encoding): skip the
            # bad file rather than 500 the listing or drop the boards after it.
            logger.warning("skipping vendor board profile %s: unreadable JSON (%s)", path.name, exc)
            continue
        if not isinstance(data, dict):
            logger.warning("skipping vendor board profile %s: not a JSON object", path.name)
            continue
        if data.get("ui_visible") is not True or data.get("support_status") != VENDOR_SUPPORT_STATUS:
            continue  # not opted in for the picker: the official index is its only listing
        entry = _vendor_board_entry(data)
        if entry is None:
            logger.warning("skipping vendor board profile %s: missing id or firmware block", path.name)
            continue
        entries.append(entry)
    return entries


@router.get("/v1/micropython/boards")
def micropython_boards():
    path = _official_boards_path()
    if not path.exists():
        return {
            "source_url": "https://micropython.org/download/",
            "fetched_at": None,
            "cache_version": None,
            "board_count": 0,
            "boards": [],
            "filters": {"vendor": [], "port": [], "mcu": [], "feature": []},
            "stale": True,
        }
    raw = path.read_bytes()
    payload = json.loads(raw.decode("utf-8"))
    source_url = payload.get("source") or "https://micropython.org/download/"
    local_ids = _local_board_ids()
    skill_ids = _skill_board_ids()
    boards = [
        _official_board_entry(board, local_ids=local_ids, skill_ids=skill_ids, source_url=source_url)
        for board in payload.get("boards", [])
        if board.get("slug")
    ]
    # Curated vendor boards are appended to the same list (flagged by support_status) rather
    # than served as a sibling key: the picker's search/filters/paging then cover them with no
    # merge code, and the official index above stays exactly the official download page.
    boards += _vendor_boards()
    filters = {
        "vendor": sorted({board["vendor"] for board in boards if board["vendor"]}),
        "port": sorted({board["port"] for board in boards if board["port"]}),
        "mcu": sorted({board["mcu"] for board in boards if board["mcu"]}),
        "feature": sorted({feature for board in boards for feature in board["features"] if feature}),
    }
    return {
        "source_url": source_url,
        "fetched_at": payload.get("fetched_at"),
        "cache_version": hashlib.sha256(raw).hexdigest(),
        "board_count": len(boards),
        "boards": boards,
        "filters": filters,
        "stale": False,
    }


@router.get("/v1/skills")
def skills():
    summaries = []
    for name in skill_catalog.served_skill_names():
        body = skill_catalog.skill_md_path(name).read_text(encoding="utf-8")
        summaries.append({
            "name": name,
            "description": skill_catalog.skill_description(body),
            "body_url": f"/v1/skills/{name}",
            "body_sha256": hashlib.sha256(body.encode()).hexdigest(),
        })
    return {
        "version": hashlib.sha256(json.dumps(summaries, sort_keys=True).encode()).hexdigest(),
        "toolchain_version": TOOLCHAIN_VERSION,
        "protocol_version": PROTOCOL_VERSION,
        "skills": summaries,
    }


@router.get("/v1/skills/{name}")
def skill(name: str):
    path = skill_catalog.skill_md_path(name)
    if path is None:
        raise HTTPException(status_code=404, detail={"error": "skill_not_found"})
    body = path.read_text(encoding="utf-8")
    headers = {"ETag": hashlib.sha256(body.encode()).hexdigest()}
    return Response(content=body, media_type="text/markdown; charset=utf-8", headers=headers)
