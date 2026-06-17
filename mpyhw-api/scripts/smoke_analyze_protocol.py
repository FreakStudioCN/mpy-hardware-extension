"""Decisive R1 smoke gate: does the model emit valid protocol tools from the raw
SKILL.md + adapter, with no full stack?

Runs the REAL production path (routes_llm._system_prompt + the 6 protocol tools +
_translate_deepseek_stream) against DeepSeek directly, bypassing auth/credit/DB.
Reports how many emitted tool calls are in-protocol with schema-valid payloads,
whether it reached an approval_request, and any off-protocol / raw-shell attempts.

Usage:  python scripts/smoke_analyze_protocol.py ["intent in user's language"]
Bills one DeepSeek turn (~cents).
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Load mpyhw-api/.env so DEEPSEEK_API_KEY / MPYHW_LLM_MODEL are available.
env = ROOT / ".env"
if env.exists():
    for line in env.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if "=" in s and not s.startswith("#"):
            k, v = s.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

from app import routes_llm, tool_registry  # noqa: E402

INTENT = sys.argv[1] if len(sys.argv) > 1 else "做一个温湿度监测仪，温度超过阈值就让蜂鸣器报警"


def main() -> int:
    body = {"phase": "analyze", "messages": [{"role": "user", "content": INTENT}]}
    upstream = routes_llm._open_deepseek_stream(body, os.environ["DEEPSEEK_API_KEY"])

    tool_uses: list[dict] = []
    text_chunks: list[str] = []
    cur: dict | None = None
    for sse in routes_llm._translate_deepseek_stream(upstream, None):
        line = sse[len("data:"):].strip()
        if not line:
            continue
        ev = json.loads(line)
        t = ev.get("type")
        if t == "content_block_start" and ev["content_block"]["type"] == "tool_use":
            cur = {"name": ev["content_block"]["name"], "args": ""}
        elif t == "content_block_delta":
            d = ev["delta"]
            if d["type"] == "input_json_delta" and cur is not None:
                cur["args"] += d["partial_json"]
            elif d["type"] == "text_delta":
                text_chunks.append(d["text"])
        elif t == "content_block_stop" and cur is not None:
            tool_uses.append(cur)
            cur = None
        elif t == "error":
            print("UPSTREAM ERROR:", ev)
            return 2

    text = "".join(text_chunks)
    print("=== SMOKE: analyze phase (real DeepSeek) ===")
    print("model:", os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"))
    print("intent:", INTENT)
    print("assistant prose chars:", len(text))
    print("tool calls emitted:", len(tool_uses))
    valid = 0
    for i, tu in enumerate(tool_uses):
        name = tu["name"]
        in_proto = name in tool_registry.LLM_TOOL_NAMES
        violation = routes_llm._payload_violation(name, tu["args"]) if in_proto else "OFF_PROTOCOL"
        ok = in_proto and violation is None
        valid += ok
        preview = tu["args"][:160].replace("\n", " ")
        print(f"  [{i}] {name:16} in_protocol={in_proto} valid={'OK' if violation is None else violation}")
        print(f"        args: {preview}")
    total = len(tool_uses)
    pct = (100 * valid // total) if total else 0
    names = [tu["name"] for tu in tool_uses]
    raw_shell = any(tok in text.lower() for tok in ["mpremote ", "```bash", "```sh", "pip install", "$ "])
    led_with_preflight = bool(names) and names[0] == "script_run"
    reached_approval = "approval_request" in names
    print("---")
    print(f"valid protocol tools: {valid}/{total} ({pct}%)")
    print("reached approval_request:", reached_approval)
    print("emitted phase_complete:", "phase_complete" in names)
    print("led with preflight script_run:", led_with_preflight)
    print("raw-shell smell in prose:", raw_shell)
    if text.strip():
        print("prose snippet:", text[:300].replace("\n", " "))
    # Real bar (plan acceptance): the analyze turn's primary action is the device
    # approval_request, every emitted tool is in-protocol with a valid payload, it
    # does NOT lead with an irrelevant env preflight, and no raw shell leaks to prose.
    passed = (
        total > 0
        and valid == total
        and reached_approval
        and not led_with_preflight
        and not raw_shell
    )
    print("GATE:", "PASS" if passed else "REVIEW")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
