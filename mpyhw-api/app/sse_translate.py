"""DeepSeek provider + SSE stream translation for /v1/llm/messages, plus the plain (non-agent) completion helper used by web_recommend. Pure move out of routes_llm.py (Phase B tidy)."""

from __future__ import annotations

import http.client
import json
import logging
import os
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from typing import Any

import jsonschema
from fastapi import HTTPException

from app.tool_registry import (
    LLM_TOOL_DESCRIPTIONS,
    LLM_TOOL_INPUT_SCHEMAS,
    LLM_TOOL_NAMES,
    MESSAGE_SCHEMAS,
)

logger = logging.getLogger("mpyhw.llm")


def _R():
    """routes_llm is the monkeypatch namespace of record (tests patch
    routes_llm.<name>). Moved code resolves patched siblings through it at
    call time so those patches keep working. Lazy import avoids the cycle
    (routes_llm imports this module at load)."""
    from app import routes_llm
    return routes_llm


def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event)}\n\n"


def _stub_sse(meter=None):
    yield _sse({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hardware intent accepted."}})
    # Stub makes no real LLM call, so it costs 0 tokens (debit 0); still report the
    # current balance so the client UI updates.
    if meter is not None:
        yield _sse({"type": "credits", **meter(0)})
    yield _sse({"type": "message_stop"})


class UpstreamError(Exception):
    def __init__(self, status: int):
        self.status = status


class DeepSeekProvider:
    name = "deepseek"

    def ensure_configured(self) -> None:
        if not os.getenv("DEEPSEEK_API_KEY"):
            raise HTTPException(status_code=503, detail={"error": "llm_upstream_not_configured"})

    def open_stream(self, body: dict[str, Any]):
        return _R()._open_deepseek_stream(body, os.environ["DEEPSEEK_API_KEY"])

    def translate_stream(self, upstream: Iterable[bytes], meter=None):
        return _R()._translate_deepseek_stream(upstream, meter)


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
        "messages": _R()._deepseek_messages(body),
        "temperature": 0.2,
        "stream": True,
        # Ask DeepSeek for a final usage chunk so we can token-meter the turn.
        "stream_options": {"include_usage": True},
        "max_tokens": max_tokens,
    }
    tools = _R()._deepseek_tools(body.get("tools", []))
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    return payload


def _open_deepseek_stream(body: dict[str, Any], api_key: str):
    base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    payload = _R()._deepseek_payload(body)
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
            if _R()._is_outage_status(error.code) and attempt + 1 < attempts:
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
                # V0-pure: forward the model's tool arguments verbatim (no server-side
                # codegen interception — the plugin writes file content inline).
                arguments = entry["arguments"]
                # Server-side payload validation (belt to the client-side repair loop):
                # forward the call but log a violation so malformed-but-known payloads
                # are observable. The actionable repair is the client's tool_result.
                violation = _R()._payload_violation(entry["name"], arguments)
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


_PAYLOAD_VALIDATORS = {
    name: jsonschema.Draft7Validator(schema) for name, schema in MESSAGE_SCHEMAS.items()
}


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
    # Semantic check the JSON Schema can't express across enum values: V0 is
    # codegen-pure, so a write/append MUST inline content (the old `intent`
    # server-codegen path is gone) — otherwise the plugin would create an empty file.
    if name == "file_operation" and payload.get("op") in ("write", "append"):
        if not payload.get("content"):
            return "file_operation write/append requires content"
    return None


def _call_deepseek_plain(
    messages: list[dict[str, Any]],
    max_tokens: int,
    timeout: int = 120,
    response_format: dict[str, Any] | None = None,
    model: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """A tool-free, single-shot DeepSeek generation (used for nested codegen).

    Bypasses _deepseek_messages so the codegen prompt is clean (no adapter/SKILL
    prefix). Returns (text, usage). Raises UpstreamError on connect failure.

    timeout defaults to 120s for codegen; the anonymous web-recommend path passes a
    short value so a hung connection can't hold a worker for two minutes.

    response_format is optional and only sent when provided (the web-recommend path passes
    {"type": "json_object"} for JSON mode); codegen callers omit it and are unaffected.

    model overrides the upstream model for this single call; defaults to the global
    MPYHW_LLM_MODEL. The web-recommend path passes a non-thinking model so its tiny
    max_tokens budget isn't consumed by reasoning_content; codegen omits it and stays
    on the global (thinking) model.
    """
    payload = {
        "model": model or os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"),
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
