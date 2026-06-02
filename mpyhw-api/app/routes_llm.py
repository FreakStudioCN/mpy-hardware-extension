from __future__ import annotations

import http.client
import json
import os
import urllib.error
import urllib.request
from asyncio import to_thread
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.package_store import PackageStore
from app.tool_registry import CANONICAL_TOOL_NAMES


router = APIRouter()
ROOT = Path(__file__).resolve().parents[1]

SYSTEM_PROMPT = """You are a MicroPython hardware coding agent.
Stay inside this product path: intent -> capabilities -> API-backed Package Intelligence -> driver context -> manifest -> code -> audit -> shim loop -> runtime observation.
Use only capabilities exposed by Package Intelligence tool schemas.
Do not invent package APIs. Fetch package context before generating code. Prefer resolve_package_candidates over independent package searches when the user intent is known."""

TOOL_PARAMETERS: dict[str, dict[str, Any]] = {
    "query_board_profile": {
        "type": "object",
        "properties": {"board_id": {"type": "string", "description": "Board id, for example esp32-s3-devkitc-1."}},
        "required": ["board_id"],
        "additionalProperties": False,
    },
    "search_packages": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "capabilities": {"type": "array", "items": {"type": "string"}},
            "board_id": {"type": "string"},
        },
        "required": ["query", "capabilities", "board_id"],
        "additionalProperties": False,
    },
    "resolve_package_candidates": {
        "type": "object",
        "properties": {
            "intent": {"type": "string"},
            "capabilities": {"type": "array", "items": {"type": "string"}},
            "board_id": {"type": "string"},
        },
        "required": ["intent", "capabilities", "board_id"],
        "additionalProperties": False,
    },
    "get_package_context": {
        "type": "object",
        "properties": {"name": {"type": "string"}, "version": {"type": "string"}},
        "required": ["name", "version"],
        "additionalProperties": False,
    },
    "scan_device": {"type": "object", "properties": {}, "additionalProperties": False},
    "install_package": {
        "type": "object",
        "properties": {"package_json_url": {"type": "string"}, "port": {"type": "string"}},
        "required": ["package_json_url", "port"],
        "additionalProperties": False,
    },
    "write_main_py": {
        "type": "object",
        "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
        "required": ["path", "content"],
        "additionalProperties": False,
    },
    "flash_and_run": {
        "type": "object",
        "properties": {"port": {"type": "string"}, "path": {"type": "string"}},
        "required": ["port", "path"],
        "additionalProperties": False,
    },
    "read_serial_until": {
        "type": "object",
        "properties": {"port": {"type": "string"}, "markers": {"type": "array", "items": {"type": "string"}}},
        "required": ["port", "markers"],
        "additionalProperties": False,
    },
    "load_skill": {
        "type": "object",
        "properties": {"skill": {"type": "string"}},
        "required": ["skill"],
        "additionalProperties": False,
    },
    "propose_manifest": {
        "type": "object",
        "properties": {"manifest": {"type": "object"}},
        "required": ["manifest"],
        "additionalProperties": False,
    },
    "generate_code": {
        "type": "object",
        "properties": {"manifest": {"type": "object"}, "target_path": {"type": "string"}},
        "required": ["manifest", "target_path"],
        "additionalProperties": False,
    },
    "audit_code": {
        "type": "object",
        "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
        "required": ["path", "content"],
        "additionalProperties": False,
    },
    "ask_user": {
        "type": "object",
        "properties": {"question": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}}},
        "required": ["question"],
        "additionalProperties": False,
    },
}


@router.post("/v1/llm/messages")
async def llm_messages(request: Request):
    body = await request.json()
    rejected = _noncanonical_tools(body.get("tools", []))
    if rejected:
        raise HTTPException(status_code=403, detail={"error": "tool_not_whitelisted", "rejected": rejected})

    if os.getenv("MPYHW_LLM_STUB") == "1":
        return StreamingResponse(_stub_sse(), media_type="text/event-stream")

    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail={"error": "llm_upstream_not_configured"})

    try:
        upstream = await to_thread(_open_deepseek_stream, body, api_key)
    except UpstreamError as error:
        raise HTTPException(status_code=502, detail={"error": "llm_upstream_error", "status": error.status})
    return StreamingResponse(_translate_deepseek_stream(upstream), media_type="text/event-stream")


def _noncanonical_tools(tools: Iterable[dict[str, Any]]) -> list[str]:
    rejected: list[str] = []
    for tool in tools:
        name = tool.get("name")
        if name not in CANONICAL_TOOL_NAMES:
            rejected.append(str(name))
    return rejected


def _stub_sse():
    events = [
        {
            "type": "content_block_delta",
            "delta": {"type": "text_delta", "text": "Hardware intent accepted."},
        },
        {"type": "message_stop"},
    ]
    for event in events:
        yield _sse(event)


def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event)}\n\n"


class UpstreamError(Exception):
    def __init__(self, status: int):
        self.status = status


def _open_deepseek_stream(body: dict[str, Any], api_key: str):
    base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    model = os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro")
    payload = {
        "model": model,
        "messages": _deepseek_messages(body),
        "temperature": 0.2,
        "stream": True,
    }
    tools = _deepseek_tools(body.get("tools", []))
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
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


def _translate_deepseek_stream(upstream: Iterable[bytes]):
    """Translate DeepSeek/OpenAI streaming chunks into Anthropic SSE events.

    Text deltas stream live. Tool calls are buffered per index and flushed as
    contiguous start/args/stop blocks at end-of-stream, so interleaved fragments
    or a name that arrives in a later fragment cannot corrupt the single-tool
    client parser. A mid-stream upstream failure emits an `error` event (which the
    client maps to stream_error) instead of a silently truncated stream.
    """
    tool_calls: dict[int, dict[str, Any]] = {}
    order: list[int] = []
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
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
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
    tool_result (user) -> one {role: "tool", tool_call_id, content} message each.
    """
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    tool_messages: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "tool_use":
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
        parameters = json.loads(json.dumps(TOOL_PARAMETERS.get(name, {"type": "object", "additionalProperties": False})))
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
    names = sorted(path.stem for path in (ROOT / "content" / "skills" / "existing").glob("*.md"))
    schema: dict[str, Any] = {"type": "string"}
    if names:
        schema["enum"] = names
    return schema
