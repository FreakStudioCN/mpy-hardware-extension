"""DeepSeek provider + SSE stream translation for /v1/llm/messages, plus the plain (non-agent) completion helper used by web_recommend. Pure move out of routes_llm.py (Phase B tidy)."""

from __future__ import annotations

import http.client
import json
import logging
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from typing import Any

import jsonschema

from app.tool_registry import (
    LLM_TOOL_DESCRIPTIONS,
    LLM_TOOL_INPUT_SCHEMAS,
    LLM_TOOL_NAMES,
    MESSAGE_SCHEMAS,
)

logger = logging.getLogger("mpyhw.llm")

# Applies to EACH socket read on the streaming response, not to the turn as a whole, so it
# bounds how long the model may think between chunks. At 60s it cut off four runs in one day
# across two providers, in scaffold and in generate, and the read timeout surfaced as an
# OSError -- indistinguishable from the provider hanging up, and reported to the client as
# upstream_stream_interrupted. A generate turn on a reasoning model routinely pauses longer
# than a minute. Kept at the same figure as UPSTREAM_IDLE_BUDGET_SECONDS so the socket and
# the heartbeat give up together rather than one masking the other; the heartbeat is what
# actually reports the cause. The much smaller web-recommend path keeps its own 120s.
# Raised to 600 after a real generate turn went silent for the full 300: with the heartbeat
# holding the connection open, waiting longer costs nothing but a slower failure, while
# giving up early throws away a phase that had already done its work.
STREAM_READ_TIMEOUT_SECONDS = 600


def _R():
    """routes_llm is the monkeypatch namespace of record (tests patch
    routes_llm.<name>). Moved code resolves patched siblings through it at
    call time so those patches keep working. Lazy import avoids the cycle
    (routes_llm imports this module at load)."""
    from app import routes_llm
    return routes_llm


def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event)}\n\n"


# An SSE comment: it carries no `data:` line, so every client ignores it (ours returns early
# on a block with no data line). Its only job is to be a body chunk.
_KEEP_ALIVE = ": keep-alive\n\n"
# Sentinel the reader yields in place of a line when the upstream has gone quiet.
_HEARTBEAT = object()
# How often a quiet upstream produces a keep-alive. The client's idle limit is what this has
# to stay under: undici, which backs fetch in Node and so in the extension host and the e2e
# harness, defaults bodyTimeout to 300s and measures it BETWEEN body chunks. Any proxy in
# front of us has its own, usually smaller. 20s is comfortably under all of them.
HEARTBEAT_INTERVAL_SECONDS = 20
# Total quiet time allowed before we give up. This is the ONLY ceiling on how long a model
# may think, which is the point: before the heartbeat, the binding limit was whichever
# invisible client default fired first, and it surfaced as an undici "terminated" or as
# upstream_stream_interrupted, neither of which names a cause.
UPSTREAM_IDLE_BUDGET_SECONDS = 600


def _lines_with_heartbeat(upstream: Iterable[bytes]):
    """Yield upstream lines, emitting a _HEARTBEAT sentinel while the upstream is quiet.

    The read runs on its own thread and hands lines over a queue, so a long pause between
    chunks becomes a wait on the queue rather than a blocked socket read. That is what lets
    the connection keep producing bytes while a reasoning model thinks: without it the whole
    request is idle and whichever client timeout is smallest kills a healthy turn.
    """
    lines: queue.Queue = queue.Queue(maxsize=64)
    done = object()

    def read_upstream() -> None:
        try:
            for raw_line in upstream:
                lines.put(raw_line)
            lines.put(done)
        except BaseException as error:  # re-raised on the consumer side, never swallowed
            lines.put(error)

    thread = threading.Thread(target=read_upstream, name="llm-upstream-reader", daemon=True)
    thread.start()
    idle_seconds = 0.0
    while True:
        try:
            item = lines.get(timeout=HEARTBEAT_INTERVAL_SECONDS)
        except queue.Empty:
            idle_seconds += HEARTBEAT_INTERVAL_SECONDS
            if idle_seconds >= UPSTREAM_IDLE_BUDGET_SECONDS:
                raise TimeoutError(f"no upstream data for {idle_seconds:.0f}s")
            yield _HEARTBEAT
            continue
        idle_seconds = 0.0
        if item is done:
            return
        if isinstance(item, BaseException):
            raise item
        yield item


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


from app.llm_providers import DeepSeekProvider, OpenAIProvider, _log_upstream_rejection, get_llm_provider, llm_provider_configured  # noqa: F401 - providers live there (line budget); re-exported onward via routes_llm


def _deepseek_payload(body: dict[str, Any], *, provider=None) -> dict[str, Any]:
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
    messages = _R()._deepseek_messages(body)
    if provider is not None and not provider.accepts_reasoning_content:
        # OpenAI 400s DeepSeek's nonstandard reasoning_content on replayed turns; strip it (the DeepSeek path keeps it).
        messages = [{k: v for k, v in m.items() if k != "reasoning_content"} for m in messages]
    payload = {
        "model": os.getenv("MPYHW_LLM_MODEL", provider.default_model if provider else "deepseek-v4-pro"),
        "messages": messages,
    }
    if provider is None or provider.send_temperature:
        payload["temperature"] = 0.2
    payload["stream"] = True
    # Ask the upstream for a final usage chunk so we can token-meter the turn.
    payload["stream_options"] = {"include_usage": True}
    payload[provider.max_tokens_param if provider else "max_tokens"] = max_tokens
    tools = _R()._deepseek_tools(body.get("tools", []))
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    return payload


def _open_deepseek_stream(body: dict[str, Any], api_key: str, *, provider=None):
    base_env, base_default = (provider.base_url_env, provider.default_base_url) if provider else ("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    base_url = os.getenv(base_env, base_default).rstrip("/")
    payload = _R()._deepseek_payload(body, provider=provider)
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
            return urllib.request.urlopen(request, timeout=STREAM_READ_TIMEOUT_SECONDS)
        except urllib.error.HTTPError as error:
            if _R()._is_outage_status(error.code) and attempt + 1 < attempts:
                logger.warning("llm upstream open retry", extra={"status": error.code, "attempt": attempt + 1})
                time.sleep(0.5)
                continue
            _log_upstream_rejection(error)
            raise UpstreamError(error.code)
        except urllib.error.URLError:
            if attempt + 1 < attempts:
                logger.warning("llm upstream open retry", extra={"status": 0, "attempt": attempt + 1})
                time.sleep(0.5)
                continue
            raise UpstreamError(0)


def _translate_deepseek_stream(upstream: Iterable[bytes], meter=None, on_interrupt=None):
    """Translate DeepSeek/OpenAI streaming chunks into Anthropic SSE events.

    Text deltas stream live. Tool calls are buffered per index and flushed as
    contiguous start/args/stop blocks at end-of-stream, so interleaved fragments
    or a name that arrives in a later fragment cannot corrupt the single-tool
    client parser. A mid-stream upstream failure emits an `error` event (which the
    client maps to stream_error) instead of a silently truncated stream, logs the
    underlying exception, and calls `on_interrupt(error)` so the caller can record the
    turn as an error rather than leaving a success row or none at all.

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
            for raw_line in _lines_with_heartbeat(upstream):
                if raw_line is _HEARTBEAT:
                    # Keeps the response body producing chunks while the model thinks, so a
                    # client idle timeout cannot cut off a healthy turn.
                    yield _KEEP_ALIVE
                    continue
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
                refusal = delta.get("refusal")
                if refusal:
                    # OpenAI streams safety refusals as delta.refusal, not content.
                    # Surface the text — dropping it would bill the turn and hand
                    # the client a charged, silently empty "success".
                    yield _sse({"type": "content_block_delta", "delta": {"type": "text_delta", "text": refusal}})
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
        except (OSError, http.client.HTTPException) as error:
            # Name the cause. This handler used to swallow the exception while every other
            # failure path in this file logged, so two runs died mid-phase on kimi and the
            # api log for the whole period held zero errors: whether it was a connection
            # reset, a read timeout or a truncated body was unrecoverable afterwards.
            logger.warning(
                "llm upstream stream interrupted",
                extra={"error_type": type(error).__name__, "detail": str(error)[:200]},
            )
            # The route records the turn as an error: a break can arrive AFTER the usage
            # chunk, and meter() writes status="success" the moment usage lands, so without
            # this a dead stream leaves either a success row or no row at all.
            if on_interrupt is not None:
                on_interrupt(error)
            yield _sse({"type": "error", "error": {"message": "upstream_stream_interrupted"}})
    finally:
        close = getattr(upstream, "close", None)
        if callable(close):
            try:
                close()
            except Exception as error:
                # The reader thread may still be blocked inside the upstream when we give up
                # on it (idle budget spent, or the client went away). Closing underneath it
                # can raise -- a socket mid-read, a generator mid-next. The response is
                # finished either way and the reader is a daemon, so log it rather than
                # turning teardown into the caller's error.
                logger.warning(
                    "llm upstream close failed",
                    extra={"error_type": type(error).__name__, "detail": str(error)[:200]},
                )


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
    provider=None,
) -> tuple[str, dict[str, Any]]:
    """A tool-free, single-shot DeepSeek generation (used for nested codegen).

    provider (keyword, None) selects the upstream; None keeps the DeepSeek constants verbatim.

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
        "model": model or os.getenv("MPYHW_LLM_MODEL", provider.default_model if provider else "deepseek-v4-pro"),
        "messages": messages,
    }
    if provider is None or provider.send_temperature:
        payload["temperature"] = 0.2
    payload["stream"] = True
    payload["stream_options"] = {"include_usage": True}
    payload[provider.max_tokens_param if provider else "max_tokens"] = max_tokens
    if response_format is not None:
        payload["response_format"] = response_format
    base_env, base_default = (provider.base_url_env, provider.default_base_url) if provider else ("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    base_url = os.getenv(base_env, base_default).rstrip("/")
    key_env = provider.api_key_env if provider else "DEEPSEEK_API_KEY"
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": f"Bearer {os.environ[key_env]}"},
        method="POST",
    )
    try:
        upstream = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        _log_upstream_rejection(error)
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
