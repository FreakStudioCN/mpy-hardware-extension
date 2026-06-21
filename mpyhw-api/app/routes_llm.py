from __future__ import annotations

import http.client
import json
import logging
import os
import re
import threading
import time
import uuid
import urllib.error
import urllib.request
from asyncio import to_thread
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import jsonschema
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app import analytics, credit_store, llm_sessions, skill_catalog
from app.auth import get_current_user
from app.tool_registry import (
    LLM_TOOL_DESCRIPTIONS,
    LLM_TOOL_INPUT_SCHEMAS,
    LLM_TOOL_NAMES,
    MESSAGE_SCHEMAS,
)


router = APIRouter()
ROOT = Path(__file__).resolve().parents[1]
logger = logging.getLogger("mpyhw.llm")


class _CircuitBreaker:
    """Minimal in-process breaker for the DeepSeek upstream.

    Per-worker (NOT distributed): local stampede protection so a provider outage
    doesn't make every request reserve-then-refund a credit and churn session slots.
    After `threshold` consecutive failures it opens for `cooldown` seconds. While
    open, is_open() admits exactly ONE probe per cooldown window — it re-arms the
    timer as it admits, so concurrent callers in the same window are still blocked
    (no stampede onto a dead upstream). The probe's outcome closes the breaker
    (recovered) or keeps it open. If a probe's outcome is never recorded (e.g. the
    request fails earlier on out-of-credits), the next probe is auto-admitted after
    another cooldown, so the breaker can never get stuck disabled.
    """

    def __init__(self, threshold: int = 5, cooldown: float = 30.0):
        self._threshold = threshold
        self._cooldown = cooldown
        self._failures = 0
        self._state = "closed"  # closed | open
        self._opened_at = 0.0
        self._lock = threading.Lock()

    def is_open(self) -> bool:
        """Whether to short-circuit this request. NOTE: not side-effect-free —
        admitting a probe re-arms the cooldown so only the single admitted caller
        sees False until the window expires again."""
        with self._lock:
            if self._state != "open":
                return False
            if time.monotonic() - self._opened_at >= self._cooldown:
                self._opened_at = time.monotonic()  # re-arm: admit exactly one probe
                logger.info("deepseek circuit breaker probing (single probe admitted)")
                return False
            return True

    def record_success(self) -> None:
        with self._lock:
            if self._state != "closed":
                logger.info("deepseek circuit breaker closed (recovered)")
            self._failures = 0
            self._state = "closed"

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._state != "open" and self._failures >= self._threshold:
                logger.warning("deepseek circuit breaker opened", extra={"failures": self._failures})
                self._state = "open"
                self._opened_at = time.monotonic()
            elif self._state == "open":
                self._opened_at = time.monotonic()  # a probe failed; restart the cooldown

    def reset(self) -> None:
        with self._lock:
            self._failures = 0
            self._state = "closed"
            self._opened_at = 0.0


# A status that signals a transient upstream OUTAGE (worth tripping the breaker),
# as opposed to a 4xx config/auth error (bad key, bad request) which should not.
def _is_outage_status(status: int) -> bool:
    return status == 0 or status == 429 or status >= 500


_deepseek_breaker = _CircuitBreaker()

ADAPTER_PREAMBLE = """You are the cloud brain of a MicroPython hardware build agent. A thin VS Code plugin on the user's machine is your hands and screen; you have NO direct filesystem, shell, serial, or terminal access. You drive everything by emitting protocol tools — the plugin executes them and returns results.

The phase instructions below (THE SKILL) are written as if for a local agent with Read/Write/Bash/AskUserQuestion and concrete script paths. Treat them as INTENT, not literal commands. NEVER try to run a shell command, mpremote, or a local path directly. Translate every action into exactly one of these protocol tools:

- Read or write a project file -> file_operation(op=read|write|append|list|delete|mkdir, path, content). Paths are relative to the project root; ignore absolute paths like G:/... that appear in the SKILL.
- Any mpremote / device / serial action (scan a bus, install a package, upload files, soft reset, run code, read serial) -> device_command(action=devs|scan|exec|cp|cp_from|mkdir|ls|rm|soft_reset|stream|run, ...).
- Run a host script the SKILL mentions (flake8, pylint, pytest, init_scaffold.py, render_*.py, extract_pdf.py, validate_json.py, ...) -> script_run(interpreter, script, args). Use the script's bare name; drop any G:/MicroPython_Skills/... prefix.
- Ask the user ANYTHING (confirm components, pick an option, type a URL/value, follow a wiring/debug step) -> approval_request(...). This REPLACES AskUserQuestion. NEVER ask a question in plain assistant text — the user cannot answer it, so the turn just stalls.
- Narrate progress ("searching drivers...", "1/3 found") -> status_update(level, message, ...). Fire-and-forget.
- Finish the current phase -> phase_complete(result, summary, next_phase, manifest_content, artifacts). next_phase is the next SKILL phase (e.g. "select-hw") or null to stop. manifest_content carries project-manifest.json forward to the next phase.

Generating code: when the SKILL says to write a firmware .py file, emit file_operation(op=write, path, intent="<what this file must do>") WITHOUT inlining the code — the server generates the file from the manifest and verified driver context and fills content in. Only inline content yourself for small non-code files (json/markdown/config).

Worked examples:
- SKILL: "运行 mpremote exec 'import machine; print(machine.I2C(0).scan())'" -> device_command(action=exec, code="import machine; print(machine.I2C(0).scan())").
- SKILL: "用 AskUserQuestion 确认器件清单" -> approval_request(approval_id="device_confirm", question="以下器件是否正确？", items=[...], actions=[{"label":"确认","value":"confirm","primary":true}]).
- SKILL: "python scripts/validate_json.py docs/wiring.json" -> script_run(interpreter="python", script="validate_json.py", args=["docs/wiring.json"]).

Keep ALL user-facing text (status messages, approval questions/options, the manifest summary) in the user's language; keep code identifiers (GPIO5, I2C, ssd1306, ESP32) unchanged. Never use emoji in user-facing text. Drive the workflow forward by emitting tools; end the phase with phase_complete.
"""


_PHASE_RECIPES: dict[str, str] = {
    "analyze": """
PROTOCOL RECIPE (analyze) — overrides any conflicting literal step in the SKILL above:
- There is NO environment preflight in protocol mode. Do NOT emit a script_run to check python/requests/versions or run the "前置检查" block — the plugin guarantees the runtime. Skip it entirely.
- Do NOT write your intent analysis as assistant prose or markdown tables. Keep prose to at most one short sentence; put any progress narration in status_update.
- Your FIRST tool call is an approval_request that confirms the component list (SKILL Step 2 器件确认), built from your intent breakdown:
    approval_id: "device_confirm"
    header: the project name (user's language)
    question: "以下器件是否正确？不对的去掉，缺的补上" (in the user's language)
    items: one entry per inferred device -> {"id": "<slug>", "name": "<device>", "subtitle": "<interface> <type>", "selectable": true, "selected": true}
    allow_add: true, allow_remove: true, multi_select: true
    actions: [{"label":"确认，开始搜索驱动","value":"confirm","primary":true}, {"label":"修改","value":"modify"}]
  If the user did not specify an MCU, put a recommended board in summary.board (default ESP32) instead of asking a separate MCU question — keep it to this one card.
- AFTER the user confirms (a later turn), narrate driver search with status_update, then finish with phase_complete:
    result: "success"
    summary: a short user-language description of the device and the plan
    next_phase: "select-hw"
    manifest_content: project-manifest.json with phase "analyze", schema_version "1.0", project_name, requirements, and devices[] (each {name, type, interface}).
- Do NOT pick final MCU/pins or generate code here — that is select-hw.
""",
    "select-hw": """
PROTOCOL RECIPE (select-hw) — this OVERRIDES the SKILL above; when they conflict, follow THIS.
- Do NOT run ANY scripts (no validate/update_manifest/etc.) and do NOT read or list files. Everything you need is in the RESOLVED DATA block (board profile + current manifest). NEVER emit script_run or file_operation in this phase.
- The components are already confirmed (from analyze). Do NOT re-confirm them. At most one short status_update.
- Decide the board (default ESP32 family) and assign a pin (gpio) for every device, respecting the board's pin_capabilities and forbidden_pins; detect I2C address conflicts. Build a BOM. Only emit an approval_request if a genuine board/power tradeoff truly needs the user.
- Then immediately emit phase_complete:
    result "success"; a short user-language summary; next_phase "generate";
    manifest_content: the manifest advanced to phase "select-hw" with mcu, pinout[] (each {device, pin_name, gpio}), and bom[].
""",
    "generate": """
PROTOCOL RECIPE (generate) — this OVERRIDES the SKILL above; whenever they conflict, follow THIS, not the SKILL.
- Do NOT run ANY scripts (no scaffold, download_drivers, normalize, black, flake8, pylint, validate) and do NOT read or list files. There is no pre-scaffolded tree to inspect — skip all of that. NEVER emit script_run or device_command in this phase.
- No prose. At most one short status_update ("正在生成代码...").
- WRITE the firmware files NOW by emitting file_operation calls, one per file:
    op: "write"; path: "firmware/main.py" (the runnable entry; add firmware/lib/*.py or firmware/drivers/*.py ONLY if the project truly needs a separate module); intent: a precise description of what this file must do, referencing the manifest's devices and pins.
    Do NOT put code in `content` yourself — OMIT content and provide `intent`; the server generates the code from the manifest + driver context.
- Most builds need only firmware/main.py. Write at most 3 files total.
- Immediately after the write(s), emit phase_complete:
    result "success"; a short user-language summary of the code; next_phase "wiring"; manifest_content = the manifest advanced to phase "generate".
""",
    "wiring": """
PROTOCOL RECIPE (wiring) — this OVERRIDES the SKILL above; when they conflict, follow THIS.
- Do NOT read or list any files and do NOT run scripts. Everything you need is in the RESOLVED DATA block (manifest devices[] + pinout[]).
- Directly emit ONE file_operation(op="write", path="docs/wiring.json", content=<a JSON string describing each device's connections: device, interface, and pin_name -> gpio>). Put the JSON in content yourself (this is not code).
- Immediately after, emit phase_complete: result "success"; short user-language summary; next_phase "diagram"; manifest_content carried forward.
""",
    "diagram": """
PROTOCOL RECIPE (diagram) — this OVERRIDES the SKILL above; when they conflict, follow THIS.
- Do NOT read or list files and do NOT run scripts. Base the diagram on the manifest in RESOLVED DATA.
- Directly emit ONE file_operation(op="write", path="docs/diagram.json", content=<a JSON string with architecture.layers[] of the modules and a flow[] of the main steps>). Put the JSON in content yourself.
- Immediately after, emit phase_complete: result "success"; short user-language summary; next_phase "deploy"; manifest_content carried forward.
""",
    "deploy": """
PROTOCOL RECIPE (deploy) — this OVERRIDES the SKILL above; when they conflict, follow THIS.
- Do NOT read/list files or run scripts. Drive the device strictly through device_command; never emit raw mpremote/shell.
- Issue this sequence, one tool at a time, reacting to each device_result: device_command(action="devs"); device_command(action="cp", src="firmware", dst=":"); device_command(action="soft_reset"); device_command(action="stream") to read serial until you see the marker "MPYHW_READY". Install packages first with device_command(action="exec", code="import mip; mip.install('<url>')") only if the manifest needs them. (Valid actions: devs, scan, exec, cp, cp_from, mkdir, ls, rm, soft_reset, stream, run.)
- Narrate with status_update. Do NOT ask the user to confirm the board.
- When a device_result contains "MPYHW_READY", finish with phase_complete(result="success", next_phase=null, summary=<user-language>). If a device_result reports a runtime failure, finish with phase_complete(result="failed", errors=[...], next_phase="autofix").
""",
}


def _phase_recipe(phase: str) -> str:
    """R1 PROTOCOL ADDENDUM (per the plan): an additive block appended after the raw
    SKILL.md that restates THIS phase's steps as an explicit protocol-tool sequence.

    Our own text, decoupled from the upstream SKILL.md (never a fork of those files).
    The analyze smoke gate showed pure-adapter is insufficient — the model follows
    local-agent steps literally (env preflight) and narrates in prose — so recipes
    are the default for any phase that needs deterministic protocol behavior.
    """
    recipe = _PHASE_RECIPES.get(phase)
    return f"\n\n--- PROTOCOL RECIPE ({phase}) ---\n{recipe}" if recipe else ""


def _system_prompt(phase: str) -> str:
    skill = skill_catalog.skill_md_body(phase) or "(No SKILL.md is available for this phase.)"
    return (
        f"{ADAPTER_PREAMBLE}\n\n--- PHASE SKILL ({phase}) ---\n{skill}{_phase_recipe(phase)}"
    )

@router.post("/v1/llm/messages")
async def llm_messages(request: Request, user: dict = Depends(get_current_user)):
    try:
        body = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid_json"}) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail={"error": "json_object_required"})
    rejected = _noncanonical_tools(body.get("tools", []))
    if rejected:
        raise HTTPException(status_code=403, detail={"error": "tool_not_whitelisted", "rejected": rejected})

    session_id = str(uuid.uuid4())
    limit_error = llm_sessions.acquire(session_id, user)
    if limit_error:
        raise HTTPException(status_code=429, detail={"error": limit_error})

    # Pre-flight credit check. Stub mode has no paid upstream call, so it reports
    # the balance without reserving. Real upstream turns reserve one credit before
    # spending tokens; final metering debits any additional usage.
    state = credit_store.ensure_daily_grant(user, credit_store.grant_for(user))
    if state["balance"] <= 0:
        llm_sessions.release(session_id, "out_of_credits")
        raise HTTPException(
            status_code=402,
            detail={"error": "out_of_credits", "balance": 0, "resets_at": state["resets_at"]},
        )

    if os.getenv("MPYHW_LLM_STUB") == "1":
        return StreamingResponse(
            _release_after(
                _stub_sse(lambda _tokens: {"remaining": state["balance"], "daily_grant": state["daily_grant"], "resets_at": state["resets_at"]}),
                session_id,
            ),
            media_type="text/event-stream",
        )

    # Any failure between here and the start of streaming must release the slot, or
    # it leaks until the TTL and the user gets spurious 429s. The inner branches set
    # a precise status first; the outer guard then catches anything they don't (e.g.
    # get_llm_provider raising 503), and is a no-op once a status is already set.
    try:
        provider = get_llm_provider()
        try:
            provider.ensure_configured()
        except HTTPException:
            llm_sessions.release(session_id, "not_configured")
            raise

        is_deepseek = getattr(provider, "name", "") == "deepseek"
        # Fail fast during an upstream outage: short-circuit BEFORE reserving a
        # credit (and release the slot), so a provider incident doesn't churn
        # reserve/refund or leak session slots across every request.
        if is_deepseek and _deepseek_breaker.is_open():
            llm_sessions.release(session_id, "upstream_unavailable")
            raise HTTPException(status_code=503, detail={"error": "llm_upstream_unavailable"})

        # Free-tier global daily budget breaker: once today's cumulative free-tier
        # spend hits the cap, refuse new turns BEFORE reserving so abusive free traffic
        # can't drive DeepSeek to its hard console cap and DoS every user. Checked after
        # the breaker (don't churn) and only on the paid path (stub costs nothing).
        budget = _daily_global_budget()
        if budget and credit_store.global_spend_today() >= budget:
            llm_sessions.release(session_id, "daily_free_budget_exhausted")
            raise HTTPException(
                status_code=503,
                detail={"error": "daily_free_budget_exhausted", "resets_at": state["resets_at"]},
            )

        reserved_remaining = credit_store.reserve(user, 1)
        if reserved_remaining is None:
            llm_sessions.release(session_id, "out_of_credits")
            raise HTTPException(
                status_code=402,
                detail={"error": "out_of_credits", "balance": 0, "resets_at": state["resets_at"]},
            )

        started_at = datetime.now(timezone.utc)

        def meter(usage: dict[str, Any]) -> dict:
            # Charge on cache-discounted tokens, not the raw prompt: DeepSeek auto-caches
            # the stable request prefix and bills cache hits at a fraction, so re-sent
            # context must not be re-charged at full price (measured ~85-99% hit rate on
            # later rounds). record_tokens does the cumulative crossing vs the reserved 1.
            total_tokens = int(usage.get("total_tokens", 0) or 0)
            charge = credit_store.record_tokens(user, _billable_tokens(usage))
            if charge == 0:
                remaining = credit_store.refund(user, 1)
            elif charge > 1:
                remaining = credit_store.debit(user, charge - 1)
            else:
                remaining = credit_store.debit(user, 0)
            analytics.record_llm_turn(
                trace_id=body.get("trace_id"),
                user_id=str(user["id"]),
                kind="chat",
                model=os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"),
                started_at=started_at,
                total_tokens=total_tokens,
                credits_charged=charge,
                status="success",
            )
            return {"remaining": remaining, "daily_grant": state["daily_grant"], "resets_at": state["resets_at"]}

        try:
            upstream = await to_thread(provider.open_stream, body)
        except UpstreamError as error:
            # Only a transient outage (timeout/5xx/429) trips the breaker; a 4xx
            # (bad key/request) is a config error that retrying won't fix.
            if is_deepseek and _is_outage_status(error.status):
                _deepseek_breaker.record_failure()
            logger.warning("llm upstream error", extra={"status": error.status})
            credit_store.refund(user, 1)
            analytics.record_llm_turn(
                trace_id=body.get("trace_id"),
                user_id=str(user["id"]),
                kind="chat",
                model=os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"),
                started_at=started_at,
                total_tokens=None,
                credits_charged=0,
                status="error",
                error_kind="upstream_error",
            )
            llm_sessions.release(session_id, "upstream_error")
            raise HTTPException(status_code=502, detail={"error": "llm_upstream_error", "status": error.status})
        if is_deepseek:
            _deepseek_breaker.record_success()
        codegen = _make_codegen(user, body, started_at)
        return StreamingResponse(_release_after(provider.translate_stream(upstream, meter, codegen), session_id), media_type="text/event-stream")
    except Exception:
        llm_sessions.release(session_id, "setup_error")
        raise


def _daily_global_budget() -> int:
    """Free-tier daily credit ceiling; 0 / unset / invalid means unlimited (no gate)."""
    try:
        return max(0, int(os.getenv("MPYHW_DAILY_GLOBAL_BUDGET", "0") or "0"))
    except ValueError:
        return 0


def _billable_tokens(usage: dict[str, Any]) -> int:
    """Tokens to charge credits on: what DeepSeek effectively bills, not raw prompt size.

    DeepSeek auto-caches a byte-stable request prefix and bills cache-hit tokens at a
    fraction of miss tokens, so charge `miss + completion + MPYHW_CACHE_HIT_WEIGHT*hit`
    (default weight 0.1, matching DeepSeek's ~10x cache-hit discount). Falls back to
    raw total_tokens when the cache breakdown is absent (older model / cache disabled).
    """
    total = int(usage.get("total_tokens", 0) or 0)
    hit = usage.get("prompt_cache_hit_tokens")
    miss = usage.get("prompt_cache_miss_tokens")
    if hit is None or miss is None:
        return total
    completion = int(usage.get("completion_tokens", 0) or 0)
    # Clamp to [0, 1] and fall back to the default on a bad value: a misconfigured
    # env var must not raise inside the streaming meter() generator (it would abort
    # the turn) or let cache hits be billed above full price.
    try:
        weight = float(os.getenv("MPYHW_CACHE_HIT_WEIGHT", "0.1"))
    except ValueError:
        weight = 0.1
    weight = min(1.0, max(0.0, weight))
    return int(int(miss) + completion + weight * int(hit))


def _noncanonical_tools(tools: Iterable[dict[str, Any]]) -> list[str]:
    """Reject any client-offered tool outside the 6 protocol tools.

    The client may omit `tools` entirely (the server offers the 6 protocol tools
    regardless); when present, every name must be one of the protocol tools.
    """
    if not isinstance(tools, list):
        return ["<tools-not-a-list>"]
    rejected: list[str] = []
    for tool in tools:
        name = tool.get("name") if isinstance(tool, dict) else None
        if name not in LLM_TOOL_NAMES:
            rejected.append(str(name))
    return rejected


def _stub_sse(meter=None):
    yield _sse({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hardware intent accepted."}})
    # Stub makes no real LLM call, so it costs 0 tokens (debit 0); still report the
    # current balance so the client UI updates.
    if meter is not None:
        yield _sse({"type": "credits", **meter(0)})
    yield _sse({"type": "message_stop"})


def _release_after(events: Iterable[str], session_id: str):
    try:
        yield from events
    finally:
        llm_sessions.release(session_id)


def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event)}\n\n"


class UpstreamError(Exception):
    def __init__(self, status: int):
        self.status = status


class DeepSeekProvider:
    name = "deepseek"

    def ensure_configured(self) -> None:
        if not os.getenv("DEEPSEEK_API_KEY"):
            raise HTTPException(status_code=503, detail={"error": "llm_upstream_not_configured"})

    def open_stream(self, body: dict[str, Any]):
        return _open_deepseek_stream(body, os.environ["DEEPSEEK_API_KEY"])

    def translate_stream(self, upstream: Iterable[bytes], meter=None, codegen=None):
        return _translate_deepseek_stream(upstream, meter, codegen)


def get_llm_provider():
    provider = os.getenv("MPYHW_LLM_PROVIDER", "deepseek").lower()
    if provider == "deepseek":
        return DeepSeekProvider()
    raise HTTPException(status_code=503, detail={"error": "llm_provider_not_supported", "provider": provider})


def _deepseek_payload(body: dict[str, Any]) -> dict[str, Any]:
    # Prefix-cache contract: the leading bytes of the request (system prompt + the
    # stable head of the conversation + tools) MUST be byte-identical across rounds
    # for DeepSeek's automatic prefix caching to hit — that is what makes the re-sent
    # context cheap instead of re-billed at full price. Keep this deterministic: no
    # timestamps, no set iteration, no per-round reordering. The enum schemas below
    # are sorted() and tools keep the client's fixed order; see the byte-stability
    # regression test in tests/test_llm_messages.py.
    # Bound a single turn's output so an unbounded generation can't run up an
    # arbitrary token bill (the credit floor would otherwise absorb the overage).
    # The client may request more for an output-heavy call (codegen, which must emit a
    # whole file AFTER the reasoning_content has already consumed part of the budget),
    # but it is always clamped to a ceiling so the anti-abuse bound still holds.
    default_max = int(os.getenv("MPYHW_LLM_MAX_TOKENS", "8192"))
    ceiling = int(os.getenv("MPYHW_LLM_MAX_TOKENS_CEILING", "32768"))
    requested = body.get("max_tokens")
    max_tokens = min(int(requested), ceiling) if isinstance(requested, int) and requested > 0 else default_max
    payload = {
        "model": os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"),
        "messages": _deepseek_messages(body),
        "temperature": 0.2,
        "stream": True,
        # Ask DeepSeek for a final usage chunk so we can token-meter the turn.
        "stream_options": {"include_usage": True},
        "max_tokens": max_tokens,
    }
    tools = _deepseek_tools(body.get("tools", []))
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    return payload


def _open_deepseek_stream(body: dict[str, Any], api_key: str):
    base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    payload = _deepseek_payload(body)
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    # Retry only the connect / pre-first-byte phase: this returns BEFORE any SSE
    # byte is yielded and before the turn is metered, so a retry can never
    # double-charge. A mid-stream drop is handled downstream and is NOT retried.
    # Runs inside to_thread, so the blocking sleep is off the event loop.
    attempts = 2
    for attempt in range(attempts):
        try:
            return urllib.request.urlopen(request, timeout=60)
        except urllib.error.HTTPError as error:
            if _is_outage_status(error.code) and attempt + 1 < attempts:
                logger.warning("deepseek open retry", extra={"status": error.code, "attempt": attempt + 1})
                time.sleep(0.5)
                continue
            raise UpstreamError(error.code)
        except urllib.error.URLError:
            if attempt + 1 < attempts:
                logger.warning("deepseek open retry", extra={"status": 0, "attempt": attempt + 1})
                time.sleep(0.5)
                continue
            raise UpstreamError(0)


def _translate_deepseek_stream(upstream: Iterable[bytes], meter=None, codegen=None):
    """Translate DeepSeek/OpenAI streaming chunks into Anthropic SSE events.

    Text deltas stream live. Tool calls are buffered per index and flushed as
    contiguous start/args/stop blocks at end-of-stream, so interleaved fragments
    or a name that arrives in a later fragment cannot corrupt the single-tool
    client parser. A mid-stream upstream failure emits an `error` event (which the
    client maps to stream_error) instead of a silently truncated stream.

    On clean completion, the final `usage` chunk is metered: `meter(total_tokens)`
    reconciles the request-start reservation and a `credits` event carrying the
    remaining balance is emitted just before message_stop. An interrupted stream
    keeps the one-credit reservation as the minimum paid-call cost.
    """
    tool_calls: dict[int, dict[str, Any]] = {}
    order: list[int] = []
    usage_obj: dict[str, Any] = {}
    finish_reason: str | None = None
    try:
        try:
            for raw_line in upstream:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                usage = chunk.get("usage")
                if usage:
                    usage_obj = usage
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                if choices[0].get("finish_reason"):
                    # "length" here means the turn was truncated at max_tokens — for a
                    # reasoning model the budget can be spent on reasoning_content with
                    # no answer left, which surfaces downstream as an empty codegen.
                    finish_reason = choices[0]["finish_reason"]
                delta = choices[0].get("delta") or {}
                reasoning = delta.get("reasoning_content")
                if reasoning:
                    # Thinking-mode models (deepseek-v4-pro) stream reasoning_content
                    # before the answer. Surface it so the client can store it on the
                    # assistant turn and pass it back next round — DeepSeek 400s a
                    # tool-calling thinking turn that is replayed without its reasoning.
                    yield _sse({"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": reasoning}})
                content = delta.get("content")
                if content:
                    yield _sse({"type": "content_block_delta", "delta": {"type": "text_delta", "text": content}})
                for tool_call in delta.get("tool_calls") or []:
                    index = tool_call.get("index", 0)
                    entry = tool_calls.get(index)
                    if entry is None:
                        entry = {"id": None, "name": None, "arguments": ""}
                        tool_calls[index] = entry
                        order.append(index)
                    function = tool_call.get("function") or {}
                    if tool_call.get("id"):
                        entry["id"] = tool_call["id"]
                    if function.get("name"):
                        entry["name"] = function["name"]
                    if function.get("arguments"):
                        entry["arguments"] += function["arguments"]
            for index in order:
                entry = tool_calls[index]
                if entry["name"] not in LLM_TOOL_NAMES:
                    # Off-protocol tool name (e.g. the model tried a dead 27-tool name).
                    # Forward it ANYWAY so the client returns an unknown_tool repair
                    # result and the model corrects next turn — dropping it silently
                    # would leave a tool-only turn with no tool_use and stall the phase.
                    logger.warning("forwarding off-protocol tool for client repair", extra={"tool": entry["name"]})
                # Server-internal codegen: a file_operation(op=write, *.py, intent)
                # gets its content generated here and inlined before forwarding.
                arguments = _maybe_fill_code(entry["name"], entry["arguments"], codegen)
                # Server-side payload validation (belt to the client-side repair loop):
                # forward the call but log a violation so malformed-but-known payloads
                # are observable. The actionable repair is the client's tool_result.
                violation = _payload_violation(entry["name"], arguments)
                if violation:
                    logger.warning(
                        "protocol payload violation",
                        extra={"tool": entry["name"], "violation": violation},
                    )
                call_id = entry["id"] or f"tool_{index}"
                yield _sse({
                    "type": "content_block_start",
                    "content_block": {"type": "tool_use", "id": call_id, "name": entry["name"]},
                })
                if arguments:
                    yield _sse({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": arguments}})
                yield _sse({"type": "content_block_stop"})
            if meter is not None:
                yield _sse({"type": "credits", **meter(usage_obj)})
            # finish_reason is additive: only attached when the upstream reported one, so
            # the no-finish_reason golden stays byte-identical and existing parsers are
            # unaffected. A "length" here flags a max_tokens truncation downstream.
            stop_event = {"type": "message_stop"}
            if finish_reason is not None:
                stop_event["finish_reason"] = finish_reason
            yield _sse(stop_event)
        except (OSError, http.client.HTTPException):
            yield _sse({"type": "error", "error": {"message": "upstream_stream_interrupted"}})
    finally:
        close = getattr(upstream, "close", None)
        if callable(close):
            close()


def _first_user_text(body: dict[str, Any]) -> str:
    """The user's original intent — the first user message that carries plain text.

    Tool results are also role:"user" but their content is a block list with no
    "text" parts, so they are skipped and the real intent is returned.
    """
    for message in body.get("messages", []):
        if message.get("role") != "user":
            continue
        content = message.get("content", "")
        if isinstance(content, str):
            if content.strip():
                return content
        elif isinstance(content, list):
            text = " ".join(
                b["text"] for b in content
                if isinstance(b, dict) and isinstance(b.get("text"), str)
            )
            if text.strip():
                return text
    return ""


def _language_directive(body: dict[str, Any]) -> str:
    """Pin the session's user-facing language to the user's first message.

    Mirrors the webview's CJK detection (detectLocale) so chrome and the model's
    prose agree. Naming the concrete language — and the first message is byte-stable
    across rounds — keeps this deterministic for prefix caching while stopping
    reference material from changing the user's language.
    """
    text = _first_user_text(body)
    language = "Chinese" if any("一" <= ch <= "鿿" for ch in text) else "English"
    return (
        f"\n\nLANGUAGE — non-negotiable: The user is writing in {language}. "
        f"Everything the user reads MUST be in {language}: every ask_user question AND "
        f"every one of its options, every plain-text summary, and the manifest's "
        f"requirements.description and summary. Tool results and phase profiles "
        f"you read are reference material and may use another language. NEVER copy that "
        f"text verbatim and NEVER let it change yours — render every question "
        f"and option in {language}. Keep code identifiers (ssd1306, GPIO5, I2C, ESP32-S3) "
        f"unchanged. Do not switch languages partway through the session."
    )


def _phase(body: dict[str, Any]) -> str:
    """The pipeline phase whose SKILL.md drives this turn (default: analyze)."""
    phase = body.get("phase")
    return phase if isinstance(phase, str) and phase else "analyze"


_DATA_INJECTION_PHASES = {"select-hw", "scaffold", "generate", "wiring", "diagram", "deploy"}


def _phase_data_injection(phase: str, body: dict[str, Any]) -> str:
    """Server-resolved grounding (board profile + driver contexts + manifest) for
    downstream phases. Replaces the deleted query_board_profile/get_package_context
    client tools — the model gets the data in-prompt instead of fetching it. Stays
    byte-stable within a phase (manifest is fixed per request) for the prefix cache.
    """
    if phase not in _DATA_INJECTION_PHASES:
        return ""
    manifest = body.get("manifest") if isinstance(body.get("manifest"), dict) else {}
    if not manifest:
        return ""
    board = _resolve_board(manifest, body)
    contexts = _resolve_driver_contexts(manifest)
    # sort_keys keeps the system-prompt prefix byte-stable across same-phase rounds
    # (a fixed manifest serializes identically) so DeepSeek prefix caching keeps hitting.
    return (
        "\n\n--- RESOLVED DATA (server-provided; do not re-fetch) ---\n"
        f"Board profile:\n{json.dumps(board, ensure_ascii=False, sort_keys=True)}\n\n"
        f"Driver contexts:\n{json.dumps(contexts, ensure_ascii=False, sort_keys=True)}\n\n"
        f"Current manifest:\n{json.dumps(manifest, ensure_ascii=False, sort_keys=True)}\n"
    )


def _deepseek_messages(body: dict[str, Any]) -> list[dict[str, Any]]:
    phase = _phase(body)
    system = _system_prompt(phase) + _phase_data_injection(phase, body) + _language_directive(body)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for message in body.get("messages", []):
        role = message.get("role", "user")
        content = message.get("content", "")
        if isinstance(content, list):
            messages.extend(_translate_blocks(role, content))
        else:
            messages.append({"role": role, "content": str(content)})
    return _pair_tool_messages(messages)


def _pair_tool_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Demote any role:"tool" message that no preceding assistant.tool_calls announced.

    OpenAI/DeepSeek 400 if a tool message references an id that no prior assistant
    tool_call announced (e.g. a resumed/trimmed history). Falling back to a plain
    user message keeps the request valid instead of erroring out the whole turn.
    """
    announced: set[str] = set()
    paired: list[dict[str, Any]] = []
    for message in messages:
        if message.get("role") == "assistant":
            announced.update(call.get("id") for call in message.get("tool_calls", []))
            paired.append(message)
        elif message.get("role") == "tool" and message.get("tool_call_id") not in announced:
            paired.append({"role": "user", "content": message.get("content", "")})
        else:
            paired.append(message)
    return paired


def _translate_blocks(role: str, blocks: list[Any]) -> list[dict[str, Any]]:
    """Translate Anthropic content blocks into OpenAI-shaped messages.

    text -> message content; tool_use (assistant) -> assistant.tool_calls;
    tool_result (user) -> one {role: "tool", tool_call_id, content} message each;
    thinking (assistant) -> assistant.reasoning_content (required passback for
    thinking-mode tool turns; see _translate_deepseek_stream).
    """
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    tool_messages: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "thinking":
            if isinstance(block.get("thinking"), str):
                reasoning_parts.append(block["thinking"])
        elif block_type == "tool_use":
            tool_calls.append({
                "id": block.get("id", ""),
                "type": "function",
                "function": {
                    "name": block.get("name", ""),
                    "arguments": json.dumps(block.get("input", {}), ensure_ascii=False),
                },
            })
        elif block_type == "tool_result":
            tool_messages.append({
                "role": "tool",
                "tool_call_id": block.get("tool_use_id", ""),
                "content": _tool_result_content(block.get("content", "")),
            })
        elif isinstance(block.get("text"), str):
            text_parts.append(block["text"])

    text = "\n".join(text_parts)
    if role == "assistant":
        assistant: dict[str, Any] = {"role": "assistant", "content": text}
        if reasoning_parts:
            assistant["reasoning_content"] = "\n".join(reasoning_parts)
        if tool_calls:
            assistant["tool_calls"] = tool_calls
        return [assistant, *tool_messages]
    out: list[dict[str, Any]] = list(tool_messages)
    if text:
        out.append({"role": role, "content": text})
    elif not tool_messages and not tool_calls:
        out.append({"role": role, "content": ""})
    if tool_calls:
        # tool_use is an assistant action; if it appears under another role
        # (malformed/replayed history), emit it as assistant rather than dropping it.
        out.append({"role": "assistant", "content": "", "tool_calls": tool_calls})
    return out


def _tool_result_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "") if isinstance(part, dict) else str(part) for part in content
        )
    return json.dumps(content, ensure_ascii=False)


def _deepseek_tools(tools: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Offer the 6 protocol tools, regardless of what the client requested.

    Order is fixed (sorted) for the prefix-cache byte-stability contract; the
    client's `tools` arg is only used for the whitelist gate in the route, not to
    pick which tools the model sees.
    """
    converted = []
    for name in sorted(LLM_TOOL_NAMES):
        converted.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": LLM_TOOL_DESCRIPTIONS.get(name) or f"Plugin-interface protocol tool: {name}",
                    "parameters": LLM_TOOL_INPUT_SCHEMAS[name],
                },
            }
        )
    return converted


_PAYLOAD_VALIDATORS = {
    name: jsonschema.Draft7Validator(schema) for name, schema in MESSAGE_SCHEMAS.items()
}

CODEGEN_MAX_TOKENS = int(os.getenv("MPYHW_CODEGEN_MAX_TOKENS", "16384"))
_BOARDS_DIR = ROOT / "content" / "boards"


# --- Server-internal codegen (resolution A) ---------------------------------
# In the protocol the model emits file_operation(op=write, path, intent) for a
# firmware .py file WITHOUT inlining code. The server intercepts that, runs a
# focused nested DeepSeek generation grounded on the board profile + resolved
# driver contexts + manifest (ported from the extension's generateCodeViaLlm),
# and forwards file_operation(op=write, path, content) to the plugin. This keeps
# codegen quality (dedicated budget + grounding) and its credit metering server
# side instead of degrading to inline writes from the huge main-loop context.


def _resolve_board(manifest: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    board_id = (
        manifest.get("board_id")
        or manifest.get("mcu")
        or (manifest.get("board") or {}).get("id")
        or body.get("board_id")
    )
    if isinstance(board_id, str) and board_id:
        path = (_BOARDS_DIR / f"{board_id}.json").resolve()
        try:
            if path.is_relative_to(_BOARDS_DIR.resolve()) and path.is_file():
                return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        # Unknown board: reflect only a bounded, id-shaped token so a caller can't
        # inject long/instruction-like strings into the model's resolved board data.
        safe = board_id if re.fullmatch(r"[A-Za-z0-9._-]{1,64}", board_id) else "unknown"
        return {"board_id": safe}
    return {}


def _resolve_driver_contexts(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    from app.package_store import PackageStore  # local import: avoid load-time cost

    store = PackageStore.default()
    contexts: list[dict[str, Any]] = []
    for device in manifest.get("devices", []) or []:
        driver = (device or {}).get("driver") or {}
        name, version = driver.get("package_name"), driver.get("version")
        if not name or not version:
            continue
        try:
            ctx = store.get_driver_context(name, version)
        except Exception:  # noqa: BLE001 - best-effort grounding, never fail codegen
            logger.warning("driver context resolution failed (codegen grounding degraded)", extra={"package": name})
            continue
        if ctx:
            contexts.append(ctx)
    return contexts


def _codegen_user_prompt(
    target_path: str,
    file_intent: str,
    intent: str,
    board: dict[str, Any],
    contexts: list[dict[str, Any]],
    manifest: dict[str, Any],
) -> str:
    is_entry = target_path in ("main.py", "firmware/main.py")
    file_rules = (
        'CRITICAL: the FIRST executable statement at startup MUST be exactly print("MPYHW_READY") '
        "(the host watches serial for this exact marker to confirm the program started). After that, "
        "run a main loop that prints structured status lines; wrap the loop body in try/except."
        if is_entry
        else "produce a focused, importable module consistent with the manifest and the entry main.py; define classes/functions only, with no top-level side effects."
    )
    return (
        f"You are a MicroPython hardware codegen assistant. Output ONLY the complete contents of {target_path} — no markdown fences, no prose.\n"
        f"Rules: import only modules on the board profile or the provided driver import_names; use the given constructors; never use __import__, exec, or eval to bypass audit; "
        f"if a needed module is not available, report that constraint instead of bypassing it; {file_rules}\n\n"
        f"Board profile:\n{json.dumps(board, ensure_ascii=False, sort_keys=True)}\n\n"
        f"Resolved driver contexts:\n{json.dumps(contexts, ensure_ascii=False, sort_keys=True)}\n\n"
        f"Hardware manifest (pins already allocated):\n{json.dumps(manifest, ensure_ascii=False, sort_keys=True)}\n\n"
        f"File intent: {file_intent}\n"
        f"Original hardware request: {intent}"
    )


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return stripped


def _call_deepseek_plain(
    messages: list[dict[str, Any]],
    max_tokens: int,
    timeout: int = 120,
    response_format: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    """A tool-free, single-shot DeepSeek generation (used for nested codegen).

    Bypasses _deepseek_messages so the codegen prompt is clean (no adapter/SKILL
    prefix). Returns (text, usage). Raises UpstreamError on connect failure.

    timeout defaults to 120s for codegen; the anonymous web-recommend path passes a
    short value so a hung connection can't hold a worker for two minutes.

    response_format is optional and only sent when provided (the web-recommend path passes
    {"type": "json_object"} for JSON mode); codegen callers omit it and are unaffected.
    """
    payload = {
        "model": os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"),
        "messages": messages,
        "temperature": 0.2,
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_tokens": max_tokens,
    }
    if response_format is not None:
        payload["response_format"] = response_format
    base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": f"Bearer {os.environ['DEEPSEEK_API_KEY']}"},
        method="POST",
    )
    try:
        upstream = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        raise UpstreamError(error.code)
    except urllib.error.URLError:
        raise UpstreamError(0)
    text_parts: list[str] = []
    usage_obj: dict[str, Any] = {}
    try:
        for raw_line in upstream:
            line = raw_line.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            if chunk.get("usage"):
                usage_obj = chunk["usage"]
            for choice in chunk.get("choices") or []:
                piece = (choice.get("delta") or {}).get("content")
                if piece:
                    text_parts.append(piece)
    finally:
        close = getattr(upstream, "close", None)
        if callable(close):
            close()
    return "".join(text_parts), usage_obj


def _make_codegen(user: dict[str, Any], body: dict[str, Any], started_at: datetime):
    """Build the interception callback the stream translator uses to fill code.

    Resolves the codegen grounding once (manifest/board/contexts/intent), then
    returns codegen(target_path, file_intent) -> code|None, metering each nested
    generation as a kind="codegen" turn (so server-internal codegen still bills).
    """
    manifest = body.get("manifest") if isinstance(body.get("manifest"), dict) else {}
    board = _resolve_board(manifest, body)
    contexts = _resolve_driver_contexts(manifest)
    intent = _first_user_text(body)

    def codegen(target_path: str, file_intent: str) -> str | None:
        prompt = _codegen_user_prompt(target_path, file_intent, intent, board, contexts, manifest)
        try:
            text, usage = _call_deepseek_plain([{"role": "user", "content": prompt}], CODEGEN_MAX_TOKENS)
        except UpstreamError as error:
            logger.warning("nested codegen upstream error", extra={"status": error.status})
            return None
        code = _strip_code_fences(text)
        # Metering must never abort the SSE stream (this runs mid-translation): a DB /
        # analytics failure should degrade to "code without billing", not kill the turn.
        try:
            charge = credit_store.record_tokens(user, _billable_tokens(usage))
            if charge > 0:
                credit_store.debit(user, charge)
            analytics.record_llm_turn(
                trace_id=body.get("trace_id"),
                user_id=str(user["id"]),
                kind="codegen",
                model=os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"),
                started_at=started_at,
                total_tokens=int(usage.get("total_tokens", 0) or 0),
                credits_charged=charge,
                status="success" if code else "error",
                error_kind=None if code else "codegen_empty",
            )
        except Exception:  # noqa: BLE001 - never abort the stream on a metering error
            logger.warning("codegen metering failed", exc_info=False)
        return code or None

    return codegen


def _maybe_fill_code(name: str, arguments: str, codegen) -> str:
    """If this is a code-file write with only an intent, generate and inline the
    content; otherwise return the arguments unchanged."""
    if codegen is None or name != "file_operation":
        return arguments
    try:
        payload = json.loads(arguments) if arguments else {}
    except json.JSONDecodeError:
        return arguments
    if payload.get("op") != "write":
        return arguments
    path = payload.get("path", "")
    # Only firmware Python files get server codegen — never docs/*.py or odd paths,
    # so an errant write can't burn codegen budget outside the firmware tree.
    if not isinstance(path, str) or not (path.startswith("firmware/") and path.endswith(".py")):
        return arguments
    if payload.get("content"):  # model already inlined content; leave it
        return arguments
    intent = payload.get("intent")
    if not intent:
        return arguments
    try:
        code = codegen(path, str(intent))
    except Exception:  # noqa: BLE001 - codegen must never abort the SSE stream
        logger.warning("codegen failed; forwarding intent unchanged", extra={"path": path})
        return arguments
    if not code:
        return arguments
    payload["content"] = code
    payload.pop("intent", None)
    return json.dumps(payload, ensure_ascii=False)


def _payload_violation(name: str, arguments: str) -> str | None:
    """Return a short reason if a protocol tool's payload is malformed, else None.

    Used for observability inside the streaming translator. The actionable repair
    is the client's tool_result (it imports the same contract and re-prompts the
    model next turn); this is the server-side belt that makes violations visible.
    """
    validator = _PAYLOAD_VALIDATORS.get(name)
    if validator is None:
        return None
    try:
        payload = json.loads(arguments) if arguments else {}
    except json.JSONDecodeError as error:
        return f"invalid_json: {error}"
    errors = sorted(validator.iter_errors(payload), key=lambda e: list(e.path))
    if errors:
        first = errors[0]
        location = "/".join(str(p) for p in first.path) or "<root>"
        return f"{location}: {first.message}"
    # Semantic checks the JSON Schema can't express across enum values: a write/append
    # must carry either content or an intent (so the server codegen has something to
    # generate from) — otherwise the plugin would create an empty file.
    if name == "file_operation" and payload.get("op") in ("write", "append"):
        if not payload.get("content") and not payload.get("intent"):
            return "file_operation write/append requires content or intent"
    return None
