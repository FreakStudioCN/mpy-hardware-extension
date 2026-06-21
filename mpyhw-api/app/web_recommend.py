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
_FALLBACK_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("temperature_sensing", ("temperature", "temp", "hot", "heat", "thermometer", "温度")),
    ("humidity_sensing", ("humidity", "humid", "moisture", "soil", "plant", "湿度", "土壤")),
    ("digital_output", ("led", "light", "lamp", "turn on", "turn off", "blink", "灯", "亮")),
    ("display_text", ("display", "screen", "oled", "show", "屏幕", "显示")),
    ("motion_sensing", ("motion", "move", "movement", "sit", "presence", "pir", "someone", "有人", "坐", "移动")),
    ("distance_sensing", ("distance", "ultrasonic", "proximity", "range", "距离")),
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


def _daily_cap_exhausted() -> bool:
    with _daily_lock:
        today = _today_iso()
        if _daily["date"] != today:
            _daily["date"] = today
            _daily["count"] = 0
        return _daily["count"] >= _daily_cap()


def _record_llm_call() -> None:
    with _daily_lock:
        today = _today_iso()
        if _daily["date"] != today:
            _daily["date"] = today
            _daily["count"] = 0
        _daily["count"] += 1


# --- capability extraction ------------------------------------------------


def _llm_available() -> bool:
    if not os.getenv("DEEPSEEK_API_KEY"):
        return False
    if os.getenv("MPYHW_LLM_STUB") == "1":
        return False
    return not _daily_cap_exhausted()


def _matches_keyword(text: str, keyword: str) -> bool:
    # Word-boundary match for ascii keywords (so "OLED" is not read as "led"); plain
    # substring for non-ascii (CJK), mirroring the extension's capabilities.ts.
    if re.fullmatch(r"[a-z0-9 ]+", keyword):
        return re.search(rf"(^|[^a-z0-9]){re.escape(keyword)}($|[^a-z0-9])", text) is not None
    return keyword in text


def _fallback_capabilities(idea: str) -> list[str]:
    text = idea.lower()
    capabilities: list[str] = []
    for capability, words in _FALLBACK_KEYWORDS:
        if capability not in capabilities and any(_matches_keyword(text, word) for word in words):
            capabilities.append(capability)
    return capabilities


def _build_prompt(idea: str) -> str:
    tokens = ", ".join(sorted(_TAXONOMY))
    return (
        "You extract hardware capabilities from a beginner's electronics project idea.\n"
        "Return ONLY a JSON object, no prose, no code fences.\n"
        'Schema: {"capabilities": [<tokens>], "board_family_hint": "esp32" | "rp2040" | null}\n'
        f"Allowed capability tokens (use ONLY these): {tokens}\n"
        "Rules: pick the 1-4 capabilities the idea needs. Do NOT invent tokens. "
        "Do NOT name any specific sensor, chip, or part. If unsure, return fewer.\n"
        f'Idea: "{idea}"'
    )


def _llm_extract(idea: str) -> tuple[list[str], str | None]:
    from app.routes_llm import _call_deepseek_plain, _strip_code_fences

    _record_llm_call()
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
    if _llm_available():
        try:
            capabilities, hint = _llm_extract(idea)
            if capabilities:
                return {"capabilities": capabilities, "board_family_hint": hint, "source": "llm"}
        except Exception:  # noqa: BLE001 - any LLM/parse failure degrades to fallback
            logger.warning("web recommend LLM extraction failed; using fallback", exc_info=True)
    return {"capabilities": _fallback_capabilities(idea), "board_family_hint": None, "source": "fallback"}


# --- module assembly ------------------------------------------------------


def _display_name(name: str) -> str:
    chip = package_store.canonical_chip_id(name)
    if "_" not in chip and any(char.isdigit() for char in chip):
        return chip.upper()
    return chip.replace("_", " ").title()


def _part_row(hit: dict[str, Any]) -> dict[str, Any]:
    name = hit["name"]
    links = recommendation_catalog.module_purchase_links(name)
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


def _breadboard_fallback_row() -> dict[str, Any]:
    links = recommendation_catalog.module_purchase_links("breadboard jumper wire kit")
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
) -> list[dict[str, Any]]:
    store = store or package_store.PackageStore.default()
    if max_parts is None:
        max_parts = int(os.getenv("MPYHW_WEB_RECOMMEND_MAX_PARTS", "4"))
    parts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for capability in capabilities:
        hits = store.search(query=idea, capabilities=[capability], limit=3)
        if not hits:
            continue
        hit = hits[0]
        key = package_store.canonical_chip_id(hit["name"])
        if key in seen:
            continue
        seen.add(key)
        parts.append(_part_row(hit))
        if len(parts) >= max_parts:
            break
    if not parts:
        return [_breadboard_fallback_row()]
    return parts


def recommend(idea: str, *, store: package_store.PackageStore | None = None) -> dict[str, Any]:
    """Full pipeline. Never raises for content reasons: any failure degrades to a
    single breadboard fallback row so the website always renders."""
    try:
        extraction = extract_capabilities(idea)
        parts = assemble_parts(idea, extraction["capabilities"], store=store)
        return {
            "capabilities": extraction["capabilities"],
            "board_family_hint": extraction["board_family_hint"],
            "parts": parts,
            "source": extraction["source"],
        }
    except Exception:  # noqa: BLE001 - the endpoint must never 500 on a recommendation
        logger.warning("web recommend pipeline failed; using breadboard fallback", exc_info=True)
        return {"capabilities": [], "board_family_hint": None, "parts": [_breadboard_fallback_row()], "source": "error"}
