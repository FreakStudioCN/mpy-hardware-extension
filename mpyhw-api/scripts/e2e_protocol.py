"""End-to-end protocol run with REAL DeepSeek and REAL messages going through.

Simulates the VS Code plugin headlessly: it drives the multi-turn, multi-phase
loop against the real server protocol core (per-phase SKILL.md + adapter + recipe
+ data injection + server-internal codegen + payload validation), executing each
of the 6 protocol tools as a thin plugin would (approval auto-confirm, file writes
to a temp project dir, device/script mocked) and feeding tool_results back. Phases
auto-advance on phase_complete.next_phase, carrying manifest_content forward.

Bypasses only the auth/credit/DB plumbing (orthogonal) by calling the provider
core directly; everything protocol-shaped is the real production code path.

Usage:  python scripts/e2e_protocol.py ["intent"]
Bills several DeepSeek turns (~tens of cents).
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile

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

INTENT = sys.argv[1] if len(sys.argv) > 1 else "做一个温湿度监测仪，温度超过阈值就让蜂鸣器报警，OLED 屏幕显示读数"
MAX_TURNS_PER_PHASE = 8
MAX_PHASES = 7
KEY = os.environ["DEEPSEEK_API_KEY"]


# --- DB-free codegen (real generation, no credit metering) ------------------
def make_harness_codegen(body):
    manifest = body.get("manifest") if isinstance(body.get("manifest"), dict) else {}
    board = routes_llm._resolve_board(manifest, body)
    contexts = routes_llm._resolve_driver_contexts(manifest)
    intent = routes_llm._first_user_text(body)

    def codegen(target_path, file_intent):
        prompt = routes_llm._codegen_user_prompt(target_path, file_intent, intent, board, contexts, manifest)
        try:
            text, _usage = routes_llm._call_deepseek_plain([{"role": "user", "content": prompt}], routes_llm.CODEGEN_MAX_TOKENS)
        except routes_llm.UpstreamError as e:
            print(f"    codegen upstream error {e.status}")
            return None
        return routes_llm._strip_code_fences(text) or None

    return codegen


def run_turn(phase, manifest, messages, project_dir):
    """One server turn: real DeepSeek + protocol translation + codegen interception.
    Returns (assistant_blocks, tool_uses)."""
    body = {"phase": phase, "manifest": manifest, "messages": messages, "trace_id": "e2e"}
    upstream = routes_llm._open_deepseek_stream(body, KEY)
    codegen = make_harness_codegen(body)

    text_parts, thinking_parts, tool_uses = [], [], []
    cur = None
    for sse in routes_llm._translate_deepseek_stream(upstream, None, codegen):
        line = sse[len("data:"):].strip()
        if not line:
            continue
        ev = json.loads(line)
        t = ev.get("type")
        if t == "content_block_start" and ev["content_block"]["type"] == "tool_use":
            cur = {"id": ev["content_block"]["id"], "name": ev["content_block"]["name"], "args": ""}
        elif t == "content_block_delta":
            d = ev["delta"]
            if d["type"] == "input_json_delta" and cur is not None:
                cur["args"] += d["partial_json"]
            elif d["type"] == "text_delta":
                text_parts.append(d["text"])
            elif d["type"] == "thinking_delta":
                thinking_parts.append(d["thinking"])
        elif t == "content_block_stop" and cur is not None:
            tool_uses.append(cur)
            cur = None
        elif t == "error":
            print("  UPSTREAM ERROR:", ev)

    blocks = []
    if thinking_parts:
        blocks.append({"type": "thinking", "thinking": "".join(thinking_parts)})
    if text_parts:
        blocks.append({"type": "text", "text": "".join(text_parts)})
    for tu in tool_uses:
        try:
            tu["input"] = json.loads(tu["args"]) if tu["args"] else {}
        except json.JSONDecodeError:
            tu["input"] = {}
        blocks.append({"type": "tool_use", "id": tu["id"], "name": tu["name"], "input": tu["input"]})
    return blocks, tool_uses


def _summarize(tu):
    p = tu.get("input", {})
    n = tu["name"]
    if n == "file_operation":
        return f"file:{p.get('op')}:{p.get('path')}{'(code)' if p.get('content') else ('(intent)' if p.get('intent') else '')}"
    if n == "device_command":
        return f"dev:{p.get('action')}"
    if n == "script_run":
        return f"script:{p.get('script')}"
    if n == "approval_request":
        return f"approval:{p.get('approval_id')}"
    if n == "phase_complete":
        return f"complete:{p.get('result')}->{p.get('next_phase')}"
    return n


def execute_tool(tu, project_dir, stats):
    """The 'plugin': execute one protocol tool and return (result_dict, control)."""
    name, p = tu["name"], tu["input"]
    stats["by_tool"][name] = stats["by_tool"].get(name, 0) + 1
    violation = routes_llm._payload_violation(name, tu["args"])
    if name not in tool_registry.LLM_TOOL_NAMES:
        stats["off_protocol"] += 1
        return {"ok": False, "error_kind": "off_protocol_tool"}, None
    if violation:
        # Client-side repair loop: a malformed payload is NOT executed; the plugin
        # returns a structured error so the model corrects it next turn.
        stats["invalid_payload"] += 1
        return {"ok": False, "error_kind": "protocol_payload_invalid", "detail": violation}, None
    stats["valid"] += 1

    if name == "approval_request":
        ids = [i.get("id") for i in p.get("items", []) if isinstance(i, dict)]
        for g in p.get("item_groups", []):
            ids += [i.get("id") for i in (g or {}).get("items", []) if isinstance(i, dict)]
        return {"ok": True, "approval_id": p.get("approval_id"), "action": "confirm",
                "selected_ids": [i for i in ids if i], "added_items": [], "notes": ""}, None
    if name == "status_update":
        return {"ok": True}, None
    if name == "device_command":
        action = p.get("action")
        out = ""
        if action == "devs":
            out = "COM3"
        elif action == "scan":
            out = "[60, 68]"
        elif action in ("read", "stream", "run"):
            out = "MPYHW_READY\nstatus: ok temp=24.1 hum=51\n"
        return {"ok": True, "cmd_id": p.get("cmd_id"), "success": True, "stdout": out, "stderr": "", "exit_code": 0}, None
    if name == "file_operation":
        op = p.get("op")
        path = p.get("path", "")
        if op in ("write", "append") and path:
            target = (project_dir / path)
            target.parent.mkdir(parents=True, exist_ok=True)
            content = p.get("content", "")
            mode = "a" if op == "append" else "w"
            with open(target, mode, encoding="utf-8") as fh:
                fh.write(content)
            stats["files_written"].add(path)
            if path.endswith(".py") and "content" in p:
                stats["code_chars"] += len(content)
            return {"ok": True, "op_id": p.get("op_id"), "success": True, "error": None}, None
        if op == "read" and path and (project_dir / path).is_file():
            return {"ok": True, "op_id": p.get("op_id"), "success": True,
                    "content": (project_dir / path).read_text(encoding="utf-8")}, None
        return {"ok": True, "op_id": p.get("op_id"), "success": True, "error": None}, None
    if name == "script_run":
        return {"ok": True, "script_id": p.get("script_id"), "success": True, "stdout": "", "stderr": "", "exit_code": 0}, None
    if name == "phase_complete":
        return {"ok": True}, {"result": p.get("result"), "next_phase": p.get("next_phase"),
                              "manifest": p.get("manifest_content")}
    return {"ok": True}, None


def main():
    project_dir = pathlib.Path(tempfile.mkdtemp(prefix="mpyhw_e2e_"))
    print("=== E2E protocol run (real DeepSeek) ===")
    print("intent:", INTENT)
    print("project_dir:", project_dir)
    print("model:", os.getenv("MPYHW_LLM_MODEL"))

    stats = {"by_tool": {}, "valid": 0, "invalid_payload": 0, "off_protocol": 0,
             "files_written": set(), "code_chars": 0, "phases": []}
    phase = "analyze"
    manifest = {}
    phases_done = []

    for _ in range(MAX_PHASES):
        print(f"\n----- PHASE: {phase} -----")
        messages = [{"role": "user", "content": INTENT}]
        phase_result = None
        next_phase = None
        for turn in range(MAX_TURNS_PER_PHASE):
            blocks, tool_uses = run_turn(phase, manifest, messages, project_dir)
            messages.append({"role": "assistant", "content": blocks})
            print(f"  turn {turn}: tools={[_summarize(tu) for tu in tool_uses]}")
            if not tool_uses:
                print("  (model ended turn with no tool — stopping phase)")
                break
            tool_results, done = [], False
            for tu in tool_uses:
                result, control = execute_tool(tu, project_dir, stats)
                tool_results.append({"type": "tool_result", "tool_use_id": tu["id"],
                                     "content": json.dumps(result, ensure_ascii=False)})
                if tu["name"] == "phase_complete" and control:
                    done = True
                    phase_result = control["result"]
                    next_phase = control["next_phase"]
                    if isinstance(control["manifest"], dict):
                        manifest = control["manifest"]
            messages.append({"role": "user", "content": tool_results})
            if done:
                print(f"  phase_complete: result={phase_result} next_phase={next_phase}")
                break
        phases_done.append((phase, phase_result))
        if not phase_result:
            print(f"  phase {phase} did not reach phase_complete")
            break
        if not next_phase:
            break
        phase = next_phase

    # --- report ---
    print("\n=== SUMMARY ===")
    print("phases:", " -> ".join(f"{p}({r})" for p, r in phases_done))
    print("tool calls by type:", stats["by_tool"])
    total_tools = stats["valid"] + stats["invalid_payload"] + stats["off_protocol"]
    print(f"valid protocol tools: {stats['valid']}/{total_tools}")
    print("off-protocol:", stats["off_protocol"], " invalid payloads:", stats["invalid_payload"])
    print("files written:", sorted(stats["files_written"]))
    print("generated code chars:", stats["code_chars"])
    main_py = project_dir / "firmware" / "main.py"
    has_main = main_py.is_file()
    main_ok = has_main and "MPYHW_READY" in main_py.read_text(encoding="utf-8")
    print("firmware/main.py written:", has_main, " contains MPYHW_READY:", main_ok)
    reached_generate = any(p == "generate" and r == "success" for p, r in phases_done)
    reached_deploy = any(p == "deploy" and r == "success" for p, r in phases_done)
    validity = (stats["valid"] / total_tools) if total_tools else 0.0
    print(f"validity rate: {validity:.0%}   reached deploy: {reached_deploy}")
    # Real bar: full pipeline reaches generate with a runnable main.py, no off-protocol
    # tool calls ever, and >=95% of payloads valid (transient hiccups the repair loop
    # corrects are fine — the model recovers and the phase still completes).
    passed = reached_generate and main_ok and stats["off_protocol"] == 0 and validity >= 0.95
    print("E2E:", "PASS" if passed else "REVIEW")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
