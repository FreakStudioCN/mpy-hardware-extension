"""Smoke one protocol phase with the real LLM and production prompt path.

This is the phase-generic companion to smoke_analyze_protocol.py. It tests the
thing that local fixtures cannot: whether ADAPTER_PREAMBLE + raw SKILL.md +
PROTOCOL RECIPE causes the model to emit the 6 protocol tools instead of local
agent actions.

Usage:
  python scripts/smoke_phase_protocol.py analyze "make a temperature alarm"
  python scripts/smoke_phase_protocol.py generate "make a temperature alarm" --manifest tmp/manifest.json

Requires DEEPSEEK_API_KEY. Bills one LLM turn.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

env = ROOT / ".env"
if env.exists():
    for line in env.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if "=" in s and not s.startswith("#"):
            k, v = s.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

from app import routes_llm, tool_registry  # noqa: E402

DEFAULT_INTENT = "make an ESP32 temperature alarm with a buzzer"
RAW_SHELL_TOKENS = ("mpremote ", "```bash", "```sh", "pip install", "$ ")

PHASE_RULES: dict[str, dict[str, set[str]]] = {
    "analyze": {
        "required_any": {"approval_request"},
        "forbidden": {"device_command", "file_operation"},
    },
    "select-hw": {
        "required_any": {"phase_complete"},
        "forbidden": {"script_run", "file_operation", "device_command"},
    },
    "generate": {
        "required_any": {"file_operation", "phase_complete"},
        "forbidden": {"script_run", "device_command"},
    },
    "wiring": {
        "required_any": {"file_operation", "phase_complete"},
        "forbidden": {"script_run", "device_command"},
    },
    "diagram": {
        "required_any": {"file_operation", "phase_complete"},
        "forbidden": {"script_run", "device_command"},
    },
    "deploy": {
        "required_any": {"device_command"},
        "forbidden": {"script_run", "file_operation"},
    },
}


def _load_manifest(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def _collect_tool_uses(body: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    upstream = routes_llm._open_deepseek_stream(body, os.environ["DEEPSEEK_API_KEY"])
    tool_uses: list[dict[str, str]] = []
    text_chunks: list[str] = []
    cur: dict[str, str] | None = None

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
            raise RuntimeError(f"upstream error: {ev}")

    return "".join(text_chunks), tool_uses


def _validity(tool_uses: list[dict[str, str]]) -> tuple[int, list[str]]:
    valid = 0
    problems: list[str] = []
    for i, tu in enumerate(tool_uses):
        name = tu["name"]
        if name not in tool_registry.LLM_TOOL_NAMES:
            problems.append(f"[{i}] {name}: OFF_PROTOCOL")
            continue
        violation = routes_llm._payload_violation(name, tu["args"])
        if violation:
            problems.append(f"[{i}] {name}: {violation}")
            continue
        valid += 1
    return valid, problems


def _phase_policy_problems(phase: str, names: list[str], text: str) -> list[str]:
    problems: list[str] = []
    rules = PHASE_RULES.get(phase, {})
    required = rules.get("required_any", set())
    forbidden = rules.get("forbidden", set())

    for name in sorted(required):
        if name not in names:
            problems.append(f"missing required tool: {name}")
    for name in sorted(forbidden):
        if name in names:
            problems.append(f"forbidden tool for {phase}: {name}")

    if names and names[0] == "script_run" and phase == "analyze":
        problems.append("analyze led with script_run preflight")
    if any(tok in text.lower() for tok in RAW_SHELL_TOKENS):
        problems.append("raw-shell smell in assistant prose")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", help="phase name, e.g. analyze/generate/deploy")
    parser.add_argument("intent", nargs="?", default=DEFAULT_INTENT)
    parser.add_argument("--manifest", help="JSON manifest to inject for downstream phases")
    parser.add_argument("--board-id", help="optional board_id in the request body")
    args = parser.parse_args()

    body: dict[str, Any] = {
        "phase": args.phase,
        "messages": [{"role": "user", "content": args.intent}],
    }
    manifest = _load_manifest(args.manifest)
    if manifest:
        body["manifest"] = manifest
    if args.board_id:
        body["board_id"] = args.board_id

    text, tool_uses = _collect_tool_uses(body)
    valid, validity_problems = _validity(tool_uses)
    names = [tu["name"] for tu in tool_uses]
    policy_problems = _phase_policy_problems(args.phase, names, text)

    print(f"=== SMOKE: {args.phase} phase (real LLM) ===")
    print("model:", os.getenv("MPYHW_LLM_MODEL", "deepseek-v4-pro"))
    print("intent:", args.intent)
    print("assistant prose chars:", len(text))
    print("tools:", names)
    for i, tu in enumerate(tool_uses):
        preview = tu["args"][:160].replace("\n", " ")
        print(f"  [{i}] {tu['name']}: {preview}")
    print("---")
    print(f"valid protocol tools: {valid}/{len(tool_uses)}")
    for problem in [*validity_problems, *policy_problems]:
        print("problem:", problem)
    passed = bool(tool_uses) and valid == len(tool_uses) and not policy_problems
    print("GATE:", "PASS" if passed else "REVIEW")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
