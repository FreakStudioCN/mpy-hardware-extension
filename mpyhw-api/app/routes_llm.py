from __future__ import annotations

import http.client
import json
import os
import uuid
import urllib.error
import urllib.request
from asyncio import to_thread
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app import analytics, credit_store, llm_sessions, skill_catalog
from app.auth import get_current_user
from app.package_store import PackageStore
from app.tool_registry import CANONICAL_TOOL_INPUT_SCHEMAS, CANONICAL_TOOL_NAMES


router = APIRouter()
ROOT = Path(__file__).resolve().parents[1]

SYSTEM_PROMPT = """You are a MicroPython hardware coding agent.
Stay inside this product path: intent -> capabilities -> API-backed Package Intelligence -> driver context -> manifest -> code -> audit -> shim loop -> runtime observation.
Use only capabilities exposed by Package Intelligence tool schemas.
Do not invent package APIs. Fetch package context before generating code. Prefer resolve_package_candidates over independent package searches when the user intent is known.
Understand the request before touching hardware: confirm what device to build and its core behaviour first. If a request is ambiguous or does not obviously map to hardware, do NOT refuse. Many requests CAN be hardware (e.g. an "AI companion" may be a desk robot or screen-faced device with sensors and sound). Clarify what physical device the user wants and what it should do (sensors, display, motors, sound, touch), then continue the workflow. Only decline after clarifying if the request truly involves no microcontroller or device at all.
Whenever you need the user to choose, confirm, or answer anything, you MUST call the ask_user tool. NEVER ask a question only in plain assistant text: the user cannot reply to plain text, so a text-only question ends the turn with no answer and stalls the session.
Never suggest bypassing audit_code. Do not use or recommend __import__, exec, or eval to hide imports. If audit_code rejects a module, either regenerate code using available modules, choose a compatible board/profile, or ask_user for a product-level tradeoff.
In the manifest you propose, include a "summary" field: a short, friendly explanation, in the user's language, of what the device will do, why you chose this board / these packages / these pins, the key wiring, and what the generated code will do. This summary is shown to the user AS the build plan, so make it clear and specific (a few sentences or short bullets) rather than a bare restatement of the other fields — this is where you put the reasoning, since your step-by-step thinking is not shown to the user.
After you propose the manifest, the host shows the user a build plan (your summary + requirements + estimated credits) and gets their confirmation before you generate code — do NOT ask the user whether to generate; just call generate_code. If generate_code returns error_kind "plan_revision_requested", the user has requested changes in its "feedback": adjust the manifest accordingly (board, packages, pins, wiring, logic, and the summary) and call generate_code again — the host re-shows the plan. Do NOT call ask_user about this revision. The wiring diagram is rendered automatically from the manifest; never offer to "show wiring". Once audit_code passes, continue by calling install_package, write_main_py, flash_and_run, then read_serial_until in order — but do NOT narrate this as if it deploys immediately: before the first device action the host shows a deploy-readiness checkpoint (a board-connection check plus the wiring diagram) and waits for the user to confirm. Do NOT ask the user whether to deploy or whether the board is connected — the host owns that checkpoint; just call the tools in order and let the host gate them. NEVER end your turn with a plain-text menu of next steps (e.g. "1. flash 2. install driver 3. view wiring 4. modify code"); drive the workflow by calling tools.
When the current request is complete (code delivered, question answered, or build verified), give the user a short summary in plain assistant text and then stop — that ends your turn and returns control to the user. Do NOT call ask_user just to ask "what would you like to do next" or to offer more help. Only call ask_user when you genuinely need an answer to make progress on the current request."""

@router.post("/v1/llm/messages")
async def llm_messages(request: Request, user: dict = Depends(get_current_user)):
    body = await request.json()
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
    state = credit_store.ensure_daily_grant(user, credit_store.DAILY_GRANT)
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
        return StreamingResponse(_release_after(provider.translate_stream(upstream, meter), session_id), media_type="text/event-stream")
    except Exception:
        llm_sessions.release(session_id, "setup_error")
        raise


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
    rejected: list[str] = []
    for tool in tools:
        name = tool.get("name")
        if name not in CANONICAL_TOOL_NAMES:
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

    def translate_stream(self, upstream: Iterable[bytes], meter=None):
        return _translate_deepseek_stream(upstream, meter)


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
    payload = {
        "model": os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"),
        "messages": _deepseek_messages(body),
        "temperature": 0.2,
        "stream": True,
        # Ask DeepSeek for a final usage chunk so we can token-meter the turn.
        "stream_options": {"include_usage": True},
        # Bound a single turn's output so an unbounded generation can't run up an
        # arbitrary token bill (the credit floor would otherwise absorb the overage).
        "max_tokens": int(os.getenv("MPYHW_LLM_MAX_TOKENS", "4096")),
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
    try:
        return urllib.request.urlopen(request, timeout=60)
    except urllib.error.HTTPError as error:
        raise UpstreamError(error.code)
    except urllib.error.URLError:
        raise UpstreamError(0)


def _translate_deepseek_stream(upstream: Iterable[bytes], meter=None):
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
                if entry["name"] not in CANONICAL_TOOL_NAMES:
                    continue
                call_id = entry["id"] or f"tool_{index}"
                yield _sse({
                    "type": "content_block_start",
                    "content_block": {"type": "tool_use", "id": call_id, "name": entry["name"]},
                })
                if entry["arguments"]:
                    yield _sse({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": entry["arguments"]}})
                yield _sse({"type": "content_block_stop"})
            if meter is not None:
                yield _sse({"type": "credits", **meter(usage_obj)})
            yield _sse({"type": "message_stop"})
        except (OSError, http.client.HTTPException):
            yield _sse({"type": "error", "error": {"message": "upstream_stream_interrupted"}})
    finally:
        close = getattr(upstream, "close", None)
        if callable(close):
            close()


def _deepseek_messages(body: dict[str, Any]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
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
    tools = list(tools)
    capability_schema = (
        _capability_schema()
        if any(tool.get("name") in {"search_packages", "resolve_package_candidates"} for tool in tools)
        else None
    )
    skill_schema = _skill_name_schema() if any(tool.get("name") == "load_skill" for tool in tools) else None
    converted = []
    for tool in tools:
        name = tool.get("name")
        if name not in CANONICAL_TOOL_NAMES:
            continue
        parameters = json.loads(json.dumps(CANONICAL_TOOL_INPUT_SCHEMAS.get(name, {"type": "object", "additionalProperties": False})))
        if capability_schema is not None and name in {"search_packages", "resolve_package_candidates"}:
            parameters["properties"]["capabilities"] = capability_schema
        if skill_schema is not None and name == "load_skill":
            parameters["properties"]["skill"] = skill_schema
        converted.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": f"Canonical MicroPython hardware workflow tool: {name}",
                    "parameters": parameters,
                },
            }
        )
    return converted


def _capability_schema() -> dict[str, Any]:
    capabilities = sorted(
        {
            capability
            for record in PackageStore.default().records
            for capability in record.get("capabilities", [])
        }
    )
    schema: dict[str, Any] = {"type": "array", "items": {"type": "string"}}
    if capabilities:
        schema["items"]["enum"] = capabilities
    return schema


def _skill_name_schema() -> dict[str, Any]:
    names = skill_catalog.served_skill_names()
    schema: dict[str, Any] = {"type": "string"}
    if names:
        schema["enum"] = names
    return schema
