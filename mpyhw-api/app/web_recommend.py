"""Website hardware recommendation: turn a natural-language idea into a grounded
list of real catalog modules.

Pipeline: extract capabilities (LLM when available, else a deterministic idea-tuned
keyword map) -> query the real package catalog (package_store) for each capability
-> assemble a deduped module list with buy links. The LLM only ever returns
capability tokens validated against the catalog taxonomy, so module names are never
hallucinated. The endpoint is anonymous, so spend is bounded by a per-IP rate limit,
a global daily LLM-call cap (degrade to fallback), a tiny token budget, and a short
timeout.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from collections import deque
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException

from app import package_store, recommendation_catalog

logger = logging.getLogger(__name__)

_TAXONOMY = {capability for capability, _ in package_store.CAPABILITY_KEYWORDS}

# Idea-tuned keyword map (ported and extended from the extension's capabilities.ts).
# Tuned for how beginners phrase an *idea* ("light", "sit"), unlike
# package_store.CAPABILITY_KEYWORDS which is tuned for package descriptions. Every
# capability here must be a valid taxonomy token.
# Covers the full package_store taxonomy (24 capabilities) so that when the LLM is
# unavailable the site still finds parts for most beginner ideas, instead of falling
# off a cliff to a breadboard-only answer for everything outside a handful of caps.
# Tuned for idea phrasing: keep keywords that collide with another capability OUT
# (e.g. bare "light" stays in digital_output, NOT light_sensing; "current"/"press"
# are avoided so they don't fire on "current temperature"/"pressure"). _matches_keyword
# does word-boundary + optional plural matching for ascii, plain substring for CJK.
_FALLBACK_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("temperature_sensing", ("temperature", "temp", "hot", "heat", "thermometer", "温度")),
    ("humidity_sensing", ("humidity", "humid", "moisture", "soil", "plant", "湿度", "土壤")),
    ("pressure_sensing", ("pressure", "barometer", "barometric", "altitude", "altimeter", "weather station", "气压", "海拔")),
    ("display_text", ("display", "screen", "oled", "lcd", "show", "屏幕", "显示")),
    ("digital_output", ("led", "light", "lamp", "turn on", "turn off", "blink", "灯", "亮")),
    ("digital_input", ("button", "switch", "press", "keypad", "joystick", "按钮", "开关")),
    ("motion_sensing", ("motion", "move", "movement", "sit", "presence", "pir", "someone", "有人", "坐", "移动")),
    ("distance_sensing", ("distance", "ultrasonic", "proximity", "range", "parking", "距离")),
    ("light_sensing", ("brightness", "ambient light", "lux", "illuminance", "how bright", "darkness", "light sensor", "光照", "亮度")),
    ("uv_sensing", ("uv", "ultraviolet", "uv index", "sunscreen", "紫外线")),
    ("color_sensing", ("color", "colour", "color sensor", "rgb sensor", "颜色", "色")),
    ("gas_sensing", ("air quality", "gas", "co2", "carbon dioxide", "smoke", "voc", "pollution", "空气质量", "气体", "烟雾")),
    ("sound_sensing", ("microphone", "mic", "noise", "clap", "sound reactive", "loud", "sound level", "声音", "噪音", "麦克风")),
    ("audio_output", ("buzzer", "beep", "speaker", "play sound", "play music", "melody", "tts", "play a tune", "蜂鸣器", "喇叭", "播放", "音乐")),
    ("servo_control", ("servo", "robot arm", "gripper", "pan tilt", "steering", "舵机", "机械臂")),
    ("motor_control", ("motor", "stepper", "dc motor", "fan", "wheels", "spin", "car", "vehicle", "电机", "马达", "风扇", "轮子")),
    ("touch_sensing", ("touch", "capacitive", "touchpad", "touch sensor", "触摸")),
    ("magnetic_sensing", ("magnet", "magnetic", "compass", "hall", "magnetometer", "磁", "指南针")),
    ("current_sensing", ("current sensor", "amps", "amperage", "power consumption", "power monitor", "measure current", "电流")),
    ("analog_input", ("analog", "potentiometer", "knob", "voltage", "电位器", "模拟")),
    ("analog_output", ("dac", "analog output", "digital potentiometer", "digipot")),
    ("weight_sensing", ("weight", "scale", "load cell", "how heavy", "grams", "重量", "称重")),
    ("heart_rate_sensing", ("heart rate", "heartrate", "pulse", "bpm", "spo2", "oximeter", "心率", "脉搏")),
    ("timekeeping", ("clock", "rtc", "alarm clock", "real time clock", "keep time", "时钟")),
]

_rate_lock = threading.Lock()
_rate_hits: dict[str, deque[float]] = {}

_daily_lock = threading.Lock()
_daily: dict[str, Any] = {"date": None, "count": 0}


def reset() -> None:
    """Clear in-process limiter and daily-cap state (tests)."""
    with _rate_lock:
        _rate_hits.clear()
    with _daily_lock:
        _daily["date"] = None
        _daily["count"] = 0


# --- rate limit + cost ceiling -------------------------------------------


def enforce_rate_limit(request: Any) -> None:
    client = getattr(request, "client", None)
    ip = getattr(client, "host", None) or "unknown"
    window = float(os.getenv("MPYHW_WEB_RECOMMEND_WINDOW", "60"))
    limit = int(os.getenv("MPYHW_WEB_RECOMMEND_RATE", "10"))
    now = time.monotonic()
    with _rate_lock:
        hits = _rate_hits.setdefault(ip, deque())
        while hits and now - hits[0] > window:
            hits.popleft()
        if len(hits) >= limit:
            raise HTTPException(status_code=429, detail={"error": "rate_limited"})
        hits.append(now)


def _today_iso() -> str:
    return datetime.now(UTC).date().isoformat()


def _daily_cap() -> int:
    return int(os.getenv("MPYHW_WEB_RECOMMEND_DAILY_LLM_CAP", "2000"))


def _reserve_llm_call() -> bool:
    """Atomically reserve one slot against the global daily LLM-call cap: returns True
    and consumes a slot when one is available, False once the cap is reached. The
    check and the increment happen under one lock so concurrent requests cannot all
    pass the check before any of them increments and overshoot the cap."""
    with _daily_lock:
        today = _today_iso()
        if _daily["date"] != today:
            _daily["date"] = today
            _daily["count"] = 0
        if _daily["count"] >= _daily_cap():
            return False
        _daily["count"] += 1
        return True


# --- capability extraction ------------------------------------------------


def _llm_configured() -> bool:
    """Whether the LLM path is usable at all: key present and not stubbed. The daily
    cap is enforced separately and atomically by _reserve_llm_call, so the
    availability check and the slot consumption stay one atomic step apart."""
    if not os.getenv("DEEPSEEK_API_KEY"):
        return False
    if os.getenv("MPYHW_LLM_STUB") == "1":
        return False
    return True


# Alias: the LLM availability pre-check has been referred to by both names. Keep both
# bound to the same function so a monkeypatch on either resolves. Correctness of the
# daily cap does not depend on this check -- _reserve_llm_call is the atomic guard.
_llm_available = _llm_configured


def _matches_keyword(text: str, keyword: str) -> bool:
    # Word-boundary match for ascii keywords (so "OLED" is not read as "led"); plain
    # substring for non-ascii (CJK), mirroring the extension's capabilities.ts. The
    # optional trailing "s" lets a singular keyword match the common plural a beginner
    # writes ("motor" -> "motors", "servo" -> "servos") without matching unrelated
    # words ("press" still does not fire on "pressure").
    if re.fullmatch(r"[a-z0-9 ]+", keyword):
        return re.search(rf"(^|[^a-z0-9]){re.escape(keyword)}s?($|[^a-z0-9])", text) is not None
    return keyword in text


def _fallback_capabilities(idea: str) -> list[str]:
    text = idea.lower()
    capabilities: list[str] = []
    for capability, words in _FALLBACK_KEYWORDS:
        if capability not in capabilities and any(_matches_keyword(text, word) for word in words):
            capabilities.append(capability)
    return capabilities


# Board family a beginner names in the idea itself, so board selection follows the
# idea even when the LLM is unavailable (the LLM otherwise supplies board_family_hint).
_BOARD_FAMILY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("rp2040", ("pico", "rp2040", "rp2350", "raspberry pi pico")),
    ("esp32", ("esp32", "esp8266", "esp32-s3", "esp32-c3", "wemos", "nodemcu", "espressif")),
]


def _fallback_board_family(idea: str) -> str | None:
    text = idea.lower()
    for family, words in _BOARD_FAMILY_KEYWORDS:
        if any(_matches_keyword(text, word) for word in words):
            return family
    return None


def _build_prompt(idea: str) -> str:
    tokens = ", ".join(sorted(_TAXONOMY))
    return (
        "You extract hardware capabilities from a beginner's electronics project idea.\n"
        "Return ONLY a JSON object, no prose, no code fences.\n"
        'Schema: {"capabilities": [<tokens>], "board_family_hint": "esp32" | "rp2040" | null}\n'
        f"Allowed capability tokens (use ONLY these): {tokens}\n"
        "Rules: pick the 1-4 capabilities the idea needs. Do NOT invent tokens. "
        "Do NOT name any specific sensor, chip, or part. If unsure, return fewer.\n"
        # JSON-encode the idea so quotes/newlines in it can't break out of the prompt
        # structure or smuggle in instructions.
        f"Idea: {json.dumps(idea, ensure_ascii=False)}"
    )


def _llm_extract(idea: str) -> tuple[list[str], str | None]:
    from app.routes_llm import _call_deepseek_plain, _strip_code_fences

    max_tokens = int(os.getenv("MPYHW_WEB_RECOMMEND_MAX_TOKENS", "256"))
    timeout = int(os.getenv("MPYHW_WEB_RECOMMEND_TIMEOUT", "10"))
    text, _usage = _call_deepseek_plain(
        [{"role": "user", "content": _build_prompt(idea)}],
        max_tokens,
        timeout=timeout,
    )
    data = json.loads(_strip_code_fences(text))
    capabilities = [token for token in data.get("capabilities", []) if token in _TAXONOMY]
    hint = data.get("board_family_hint")
    if hint not in ("esp32", "rp2040"):
        hint = None
    return capabilities, hint


def extract_capabilities(idea: str) -> dict[str, Any]:
    # Availability pre-check, then an atomic slot reservation right before using the
    # LLM, so concurrent callers can't overshoot the cap and the fallback path never
    # consumes a slot.
    if _llm_configured() and _reserve_llm_call():
        try:
            capabilities, hint = _llm_extract(idea)
            if capabilities:
                return {"capabilities": capabilities, "board_family_hint": hint, "source": "llm"}
        except Exception:  # noqa: BLE001 - any LLM/parse failure degrades to fallback
            logger.warning("web recommend LLM extraction failed; using fallback", exc_info=True)
    return {
        "capabilities": _fallback_capabilities(idea),
        "board_family_hint": _fallback_board_family(idea),
        "source": "fallback",
    }


# --- module assembly ------------------------------------------------------


def _display_name(name: str) -> str:
    chip = package_store.canonical_chip_id(name)
    if "_" not in chip and any(char.isdigit() for char in chip):
        return chip.upper()
    return chip.replace("_", " ").title()


def _part_row(hit: dict[str, Any], region: str = "us") -> dict[str, Any]:
    name = hit["name"]
    links = recommendation_catalog.module_purchase_links(name, region)
    return {
        "name": _display_name(name),
        "reason": hit.get("description") or "Beginner-friendly module for this project.",
        "capabilities": hit.get("capabilities", []),
        "support_level": hit.get("support_level"),
        "package_name": name,
        "version": hit.get("version"),
        "buy_url": links[0]["url"] if links else None,
        "purchase_links": links,
    }


def _breadboard_fallback_row(region: str = "us") -> dict[str, Any]:
    links = recommendation_catalog.module_purchase_links("breadboard jumper wire kit", region)
    return {
        "name": "Breadboard jumper wire kit",
        "reason": "Connects the board to beginner-friendly modules.",
        "capabilities": [],
        "support_level": None,
        "package_name": "breadboard_jumper_wire_kit",
        "version": None,
        "buy_url": links[0]["url"] if links else None,
        "purchase_links": links,
    }


def assemble_parts(
    idea: str,
    capabilities: list[str],
    *,
    store: package_store.PackageStore | None = None,
    max_parts: int | None = None,
    board_family: str = "",
    region: str = "us",
) -> list[dict[str, Any]]:
    store = store or package_store.PackageStore.default()
    if max_parts is None:
        max_parts = int(os.getenv("MPYHW_WEB_RECOMMEND_MAX_PARTS", "4"))
    parts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for capability in capabilities:
        # board_family keeps parts compatible with the chosen board (a chip-agnostic
        # driver is neutral, a wrong-family-only driver is demoted).
        hits = store.search(query=idea, capabilities=[capability], limit=3, board_family=board_family)
        if not hits:
            continue
        hit = hits[0]
        key = package_store.canonical_chip_id(hit["name"])
        if key in seen:
            continue
        seen.add(key)
        parts.append(_part_row(hit, region))
        if len(parts) >= max_parts:
            break
    if not parts:
        return [_breadboard_fallback_row(region)]
    return parts


def recommend(idea: str, *, store: package_store.PackageStore | None = None, region: str = "us") -> dict[str, Any]:
    """Full pipeline. Never raises for content reasons: any failure degrades to a
    single breadboard fallback row so the website always renders.

    The idea drives the board too: a board-family hint (esp32 / rp2040) selects a
    beginner board of that family, and that board's family then keeps the assembled
    parts compatible with it. The chosen board is returned so the route doesn't
    re-select it."""
    try:
        extraction = extract_capabilities(idea)
        board = recommendation_catalog.select_beginner_board(extraction["board_family_hint"])
        board_family = package_store.board_family(board.get("slug", "")) if board else ""
        parts = assemble_parts(idea, extraction["capabilities"], store=store, board_family=board_family, region=region)
        return {
            "capabilities": extraction["capabilities"],
            "board_family_hint": extraction["board_family_hint"],
            "board": board,
            "parts": parts,
            "source": extraction["source"],
        }
    except Exception:  # noqa: BLE001 - the endpoint must never 500 on a recommendation
        logger.warning("web recommend pipeline failed; using breadboard fallback", exc_info=True)
        return {"capabilities": [], "board_family_hint": None, "board": None, "parts": [_breadboard_fallback_row(region)], "source": "error"}
