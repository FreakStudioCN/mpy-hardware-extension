"""Website hardware recommendation: turn a natural-language idea into a grounded
list of real catalog modules.

Pipeline: extract capabilities with the LLM (DeepSeek) -> query the real package catalog
(package_store) for each capability -> assemble a deduped module list with buy links. The
LLM only ever returns capability tokens validated against the catalog taxonomy, so module
names are never hallucinated.

Fail fast: the LLM is *the* path. There is no silent keyword fallback. When the LLM is
unavailable, over capacity, or returns something we genuinely can't use, the request fails
with an explicit error (503 / 422) and a loud log, rather than quietly degrading to a guess
and pretending it is the AI's answer. The endpoint is anonymous, so spend is bounded by a
per-IP rate limit, a global daily LLM-call cap, a tiny token budget, and a short timeout.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException

from app import package_store, recommendation_catalog

logger = logging.getLogger(__name__)

_TAXONOMY = {capability for capability, _ in package_store.CAPABILITY_KEYWORDS}

# Common short-forms / near-synonyms the model may answer with, mapped to the canonical
# taxonomy token. Only *unambiguous* forms belong here: ambiguous words (bare "light" ->
# digital_output vs light_sensing, "analog" -> analog_input vs analog_output, "digital")
# are deliberately left out so they require the full token instead of guessing wrong.
_CAPABILITY_SYNONYMS: dict[str, str] = {
    "servo": "servo_control",
    "motor": "motor_control",
    "stepper": "motor_control",
    "temperature": "temperature_sensing",
    "temp": "temperature_sensing",
    "humidity": "humidity_sensing",
    "pressure": "pressure_sensing",
    "display": "display_text",
    "screen": "display_text",
    "motion": "motion_sensing",
    "distance": "distance_sensing",
    # bare "sound" is intentionally omitted: it splits between sound_sensing (mic) and
    # audio_output (speaker), so it requires the full token rather than a guess.
    "audio": "audio_output",
    "touch": "touch_sensing",
    "magnet": "magnetic_sensing",
    "magnetic": "magnetic_sensing",
    "color": "color_sensing",
    "colour": "color_sensing",
    "gas": "gas_sensing",
    "uv": "uv_sensing",
    "weight": "weight_sensing",
    "current": "current_sensing",
    "heartrate": "heart_rate_sensing",
    "heart_rate": "heart_rate_sensing",
    "clock": "timekeeping",
    "time": "timekeeping",
}

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
    pass the check before any of them increments and overshoot the cap.

    A slot is reserved before the upstream call and is *not* refunded if the call then
    fails: a real DeepSeek attempt costs tokens whether or not it parses, so a failing
    LLM legitimately draws down the cost ceiling (a broken-LLM incident burns the cap on
    503s -- loud and bounded, not hidden)."""
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


# Alias: the LLM availability pre-check has been referred to by both names. extract_capabilities
# calls _llm_available so a monkeypatch on it (e.g. the cap-concurrency test widening the
# check->reserve window) takes effect. Correctness of the daily cap does not depend on this
# check -- _reserve_llm_call is the atomic guard.
_llm_available = _llm_configured


# Short, beginner-facing gloss for each taxonomy token, sent to the LLM so it selects by
# what the idea must DO rather than which word it resembles. Motivating bug: "a box that
# screams when opened" -> the model chose `magnetic_sensing` (literally "magnet"/"open")
# and got an AS5600 rotary ANGLE encoder, when open/close detection is `digital_input`
# (reed/hall/limit switch). The two are spelled out so the model can tell them apart.
# Every taxonomy token must have an entry (enforced by test_build_prompt_*).
_CAPABILITY_DESCRIPTIONS: dict[str, str] = {
    "temperature_sensing": "measure temperature",
    "humidity_sensing": "measure humidity or soil moisture",
    "pressure_sensing": "measure barometric / air pressure",
    "display_text": "show text or graphics on a screen (OLED / LCD / e-ink)",
    "digital_output": "switch something on/off (LED, relay, addressable LED strip)",
    "digital_input": (
        "read an on/off signal: a button press, or detecting open/close or contact with "
        "a switch (reed switch, hall switch, limit switch, tilt) -- e.g. 'is the lid open'"
    ),
    "motion_sensing": "detect movement, tilt, orientation, or acceleration (PIR, accelerometer, gyro / IMU)",
    "distance_sensing": "measure distance or proximity to an object (ultrasonic, time-of-flight)",
    "color_sensing": "identify the color of something",
    "analog_input": "read a continuous analog value (a knob / potentiometer, a raw voltage via ADC)",
    "analog_output": "output a continuous analog voltage (DAC, digital potentiometer)",
    "servo_control": "move a servo motor to a specific angle",
    "touch_sensing": "detect a finger via capacitive touch",
    "gas_sensing": "detect gas or air quality (CO2, VOC, smoke)",
    "timekeeping": "keep real-world time / a real-time clock",
    "magnetic_sensing": (
        "measure magnetic field strength, compass direction, or a rotation ANGLE "
        "(magnetometer, AS5600 rotary encoder) -- NOT simple open/close detection; use "
        "digital_input for 'is it opened'"
    ),
    "light_sensing": "measure ambient light level / brightness in lux",
    "uv_sensing": "measure ultraviolet (UV) light",
    "current_sensing": "measure electrical current or power draw",
    "motor_control": "drive a DC or stepper motor (spin / move)",
    "weight_sensing": "measure weight or force with a load cell",
    "heart_rate_sensing": "measure heart rate or blood-oxygen (SpO2)",
    "sound_sensing": "detect or measure sound with a microphone",
    "audio_output": "play sound or audio -- a beep, alarm, or 'scream' (buzzer, speaker, MP3 module)",
}


def _capability_glossary() -> str:
    return "\n".join(
        f"- {token}: {_CAPABILITY_DESCRIPTIONS.get(token, '')}" for token in sorted(_TAXONOMY)
    )


def _build_prompt(idea: str) -> str:
    return (
        "You extract hardware capabilities from a beginner's electronics project idea.\n"
        "Return ONLY a JSON object, no prose, no code fences.\n"
        'Schema: {"capabilities": [<tokens>], "board_family_hint": "esp32" | "rp2040" | null}\n'
        "Allowed capability tokens (use ONLY these; pick by what the idea must DO, not by "
        "the word it resembles):\n"
        f"{_capability_glossary()}\n"
        "Rules: pick the 1-4 capabilities the idea needs. Do NOT invent tokens. "
        "Do NOT name any specific sensor, chip, or part. If unsure, return fewer.\n"
        # JSON-encode the idea so quotes/newlines in it can't break out of the prompt
        # structure or smuggle in instructions.
        f"Idea: {json.dumps(idea, ensure_ascii=False)}"
    )


def _parse_capability_json(text: str) -> dict[str, Any]:
    """Parse the LLM's JSON object, tolerating stray prose around it (DeepSeek sometimes
    prepends a word even in JSON mode). Raises ValueError when no JSON object can be
    parsed or the shape is wrong -- the caller turns that into an explicit 503, never a
    silent degrade."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Tolerate stray prose around the object: decode the JSON value starting at the
        # first "{" and ignore anything after it. raw_decode stops at the object's close,
        # so trailing remarks -- even ones containing braces -- can't corrupt the parse.
        start = text.find("{")
        if start == -1:
            raise ValueError("no JSON object in LLM response")
        try:
            data, _end = json.JSONDecoder().raw_decode(text, start)
        except json.JSONDecodeError as error:
            raise ValueError("unparseable JSON object in LLM response") from error
    if not isinstance(data, dict):
        raise ValueError("LLM JSON is not an object")
    capabilities = data.get("capabilities")
    if not isinstance(capabilities, list):
        raise ValueError("LLM JSON 'capabilities' is not a list")
    hint = data.get("board_family_hint")
    if hint not in ("esp32", "rp2040"):
        hint = None
    return {"capabilities": capabilities, "board_family_hint": hint}


def _normalize_capabilities(raw_tokens: list[Any]) -> list[str]:
    """Map LLM tokens to canonical taxonomy tokens (keep exact matches, normalize known
    synonyms), dropping genuinely unknown ones with a WARNING so taxonomy drift stays
    visible. Order-preserving and deduped."""
    normalized: list[str] = []
    dropped: list[Any] = []
    for token in raw_tokens:
        key = token.strip().lower() if isinstance(token, str) else None
        if key in _TAXONOMY:
            canonical = key
        elif key in _CAPABILITY_SYNONYMS:
            canonical = _CAPABILITY_SYNONYMS[key]
        else:
            dropped.append(token)
            continue
        if canonical not in normalized:
            normalized.append(canonical)
    if dropped:
        logger.warning("web recommend dropped off-taxonomy capability tokens: %s", dropped)
    return normalized


def _llm_extract(idea: str) -> dict[str, Any]:
    """Call DeepSeek (JSON mode), parse tolerantly, normalize to taxonomy tokens. Returns
    {capabilities, board_family_hint, raw_count}; raises on upstream/parse failure."""
    from app.routes_llm import _call_deepseek_plain

    max_tokens = int(os.getenv("MPYHW_WEB_RECOMMEND_MAX_TOKENS", "256"))
    timeout = int(os.getenv("MPYHW_WEB_RECOMMEND_TIMEOUT", "10"))
    # Capability extraction is a trivial classification, so use a NON-thinking model. The
    # global MPYHW_LLM_MODEL is a thinking model (deepseek-v4-pro) whose reasoning_content
    # counts against max_tokens; on a complex idea the ~256-token budget is fully consumed
    # by reasoning -> finish_reason="length", content="" -> parse failure -> 503 llm_failed.
    # A non-thinking model emits the tiny JSON directly (0 reasoning tokens), so the answer
    # always fits and the call is ~1s instead of 15-26s. Overridable by env.
    model = os.getenv("MPYHW_WEB_RECOMMEND_MODEL", "deepseek-chat")
    text, _usage = _call_deepseek_plain(
        [{"role": "user", "content": _build_prompt(idea)}],
        max_tokens,
        timeout=timeout,
        response_format={"type": "json_object"},
        model=model,
    )
    parsed = _parse_capability_json(text)
    return {
        "capabilities": _normalize_capabilities(parsed["capabilities"]),
        "board_family_hint": parsed["board_family_hint"],
        "raw_count": len(parsed["capabilities"]),
    }


def extract_capabilities(idea: str) -> dict[str, Any]:
    """Extract hardware capabilities for an idea via the LLM. Fail fast: raises
    HTTPException rather than degrading to a keyword guess.

    - 503 llm_unconfigured: the LLM path is not usable (missing/stubbed key).
    - 503 llm_capacity: the global daily LLM cap is reached.
    - 503 llm_failed: the call/parse failed, or the model returned only off-taxonomy
      tokens (a schema violation).
    - 422 no_capabilities: the model succeeded but returned an empty list (vague idea)."""
    if not _llm_available():
        logger.error("web recommend: LLM not configured (missing/stubbed DEEPSEEK_API_KEY)")
        raise HTTPException(status_code=503, detail={"error": "llm_unconfigured"})
    if not _reserve_llm_call():
        logger.warning("web recommend: daily LLM cap reached")
        raise HTTPException(status_code=503, detail={"error": "llm_capacity"})
    try:
        result = _llm_extract(idea)
    except Exception:  # noqa: BLE001 - any upstream/parse failure surfaces, never degrades
        logger.error("web recommend LLM extraction failed", exc_info=True)
        raise HTTPException(status_code=503, detail={"error": "llm_failed"}) from None
    if not result["capabilities"]:
        if result["raw_count"] == 0:
            raise HTTPException(status_code=422, detail={"error": "no_capabilities"})
        logger.error("web recommend: LLM returned only off-taxonomy capability tokens")
        raise HTTPException(status_code=503, detail={"error": "llm_failed"})
    return {
        "capabilities": result["capabilities"],
        "board_family_hint": result["board_family_hint"],
        "source": "llm",
    }


# --- module assembly ------------------------------------------------------


def _display_name(name: str) -> str:
    chip = package_store.canonical_chip_id(name)
    if "_" not in chip and any(char.isdigit() for char in chip):
        return chip.upper()
    return chip.replace("_", " ").title()


def _part_row(hit: dict[str, Any], region: str = "us") -> dict[str, Any]:
    name = hit["name"]
    links = recommendation_catalog.filter_buyable_links(
        recommendation_catalog.module_purchase_links(name, region)
    )
    primary = recommendation_catalog.select_primary_link(links)
    return {
        "name": _display_name(name),
        "reason": hit.get("description") or "Beginner-friendly module for this project.",
        "capabilities": hit.get("capabilities", []),
        "support_level": hit.get("support_level"),
        "package_name": name,
        "version": hit.get("version"),
        # buy_url stays as the single primary URL (back-compat); primary_link carries the
        # store + is_search flag so the UI shows one honest button.
        "buy_url": primary["url"] if primary else None,
        "primary_link": primary,
        "purchase_links": links,
    }


def _breadboard_fallback_row(region: str = "us") -> dict[str, Any]:
    links = recommendation_catalog.module_purchase_links("breadboard jumper wire kit", region)
    primary = recommendation_catalog.select_primary_link(links)
    return {
        "name": "Breadboard jumper wire kit",
        "reason": "Connects the board to beginner-friendly modules.",
        "capabilities": [],
        "support_level": None,
        "package_name": "breadboard_jumper_wire_kit",
        "version": None,
        "buy_url": primary["url"] if primary else None,
        "primary_link": primary,
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
        # Capabilities were identified but the catalog matched no part for any of them:
        # a coverage gap worth seeing, not silently hiding behind a lone breadboard.
        if capabilities:
            logger.warning("web recommend: no catalog parts matched capabilities %s", capabilities)
        return [_breadboard_fallback_row(region)]
    return parts


def recommend(idea: str, *, store: package_store.PackageStore | None = None, region: str = "us") -> dict[str, Any]:
    """Full pipeline. Fail fast: capability extraction raises an explicit HTTPException
    (503/422) when the LLM is unusable, and any other unexpected failure (e.g. a corrupt
    catalog) propagates instead of being masked as a breadboard 200.

    The idea drives the board too: the LLM's board-family hint (esp32 / rp2040) selects a
    beginner board of that family, and that board's family then keeps the assembled parts
    compatible with it. The chosen board is returned so the route doesn't re-select it."""
    extraction = extract_capabilities(idea)
    board = recommendation_catalog.select_beginner_board(extraction["board_family_hint"])
    board_family = package_store.board_family(board.get("slug", "")) if board else ""
    parts = assemble_parts(idea, extraction["capabilities"], store=store, board_family=board_family, region=region)
    return {
        "capabilities": extraction["capabilities"],
        "board_family_hint": extraction["board_family_hint"],
        "board": board,
        "parts": parts,
        "source": "llm",
    }
