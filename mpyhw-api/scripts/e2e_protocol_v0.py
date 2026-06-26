"""End-to-end V0 protocol run with REAL DeepSeek through the V0-migrated path.

The V0 sibling of e2e_protocol.py. Drives the multi-turn, multi-phase loop against
the real server protocol core, but for the V0 architecture:
- skill_catalog serves the 6 protocol-native `-plugin` skills
- _system_prompt uses the SLIM adapter + raw SKILL.md (no per-phase recipe)
- V0-pure codegen: the model writes file content inline (no `intent` interception)
- script_run ACTUALLY runs the vendored plugin scripts (the V0 design moves the
  deterministic work into those scripts, so mocking them would not test V0)

Auth/credit/DB are bypassed (provider core called directly). Device I/O is mocked
(no board). Phases auto-advance on phase_complete.next_phase, following the real
V0 chain analyze -> select-hw -> upy-flash-mpy-firmware-plugin -> upy-scaffold-plugin
-> upy-generate-plugin -> upy-deploy-plugin; a next_phase with no served skill
(project-library-upload / upy-simulate-plugin / null) is terminal.

Usage:  python scripts/e2e_protocol_v0.py ["intent"]
Bills several DeepSeek turns.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SKILLS_ROOT = ROOT.parent / "third_party" / "MicroPython_Skills"

env = ROOT / ".env"
if env.exists():
    for line in env.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if "=" in s and not s.startswith("#"):
            k, v = s.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

from app import routes_llm, skill_catalog, tool_registry  # noqa: E402

INTENT = sys.argv[1] if len(sys.argv) > 1 else "做一个温湿度监测仪，温度超过阈值就让蜂鸣器报警，OLED 屏幕显示读数"
MAX_TURNS_PER_PHASE = int(os.getenv("E2E_MAX_TURNS", "22"))
MAX_PHASES = int(os.getenv("E2E_MAX_PHASES", "10"))
KEY = os.environ["DEEPSEEK_API_KEY"]


def run_turn(phase, manifest, messages):
    """One server turn: real DeepSeek + protocol translation (V0-pure: no codegen)."""
    body = {"phase": phase, "manifest": manifest, "messages": messages, "trace_id": "e2e-v0"}
    upstream = routes_llm._open_deepseek_stream(body, KEY)
    text_parts, thinking_parts, tool_uses = [], [], []
    cur = None
    for sse in routes_llm._translate_deepseek_stream(upstream, None):
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
        return f"file:{p.get('op')}:{p.get('path')}{'(code)' if p.get('content') else ''}"
    if n == "device_command":
        return f"dev:{p.get('action')}"
    if n == "script_run":
        return f"script:{p.get('script')}"
    if n == "approval_request":
        return f"approval:{p.get('approval_id')}"
    if n == "phase_complete":
        return f"complete:{p.get('result')}->{p.get('next_phase')}"
    return n


# Headless CI tier: no real board, so the "user" takes the no-hardware path for any
# device-flashing / device-guided approval (the skill treats these as success without
# touching hardware). Ordinary approvals fall through to the primary action.
NO_HW_ACTIONS = ("already_flashed", "use_local_firmware", "confirm_flashed", "copied_uf2", "copied", "confirmed")


def _primary_action(p):
    values = [a.get("value") for a in p.get("actions", []) if isinstance(a, dict) and a.get("value")]
    for pref in NO_HW_ACTIONS:
        if pref in values:
            return pref
    for a in p.get("actions", []):
        if isinstance(a, dict) and a.get("primary"):
            return a.get("value", "confirm")
    return values[0] if values else "confirm"


def _selected_ids(p):
    ids = []
    for i in p.get("items", []):
        if isinstance(i, dict) and i.get("id") and i.get("selected", True):
            ids.append(i["id"])
    groups = p.get("item_groups", [])
    group_iter = groups if isinstance(groups, list) else list(groups.values())
    for g in group_iter:
        for i in (g or {}).get("items", []) if isinstance(g, dict) else []:
            if isinstance(i, dict) and i.get("id"):
                ids.append(i["id"])
    return ids


def _subst(s, project_dir, skill_dir):
    if not isinstance(s, str):
        return s
    return s.replace("{project_dir}", str(project_dir)).replace("{skill_dir}", str(skill_dir))


def _script_result(p, proc):
    out = proc.stdout or ""
    err = proc.stderr or ""
    result_json = None
    if out.strip():
        try:
            result_json = json.loads(out)
        except json.JSONDecodeError:
            pass
    return {"ok": True, "script_id": p.get("script_id"), "success": proc.returncode == 0,
            "stdout": "" if result_json is not None else out[:4000], "stderr": err[:2000],
            "exit_code": proc.returncode, "result_json": result_json}


def run_script(p, project_dir, skill_dir):
    """Faithful V0 script execution — scripts do the real work.

    python  -> resolve the bare name to the current plugin's scripts/ dir and run it.
    shell   -> run for real (e.g. git add/commit) in the git-init'd project dir, so
               generate's commit-verification checks see a genuine commit.
    node    -> skipped (no node toolchain assumed in this harness).
    """
    interpreter = p.get("interpreter", "python")
    script = p.get("script", "")
    args = [_subst(a, project_dir, skill_dir) for a in p.get("args", [])]
    cwd = _subst(p.get("cwd", "{project_dir}"), project_dir, skill_dir) or str(project_dir)
    stdin_content = p.get("stdin_content")
    if p.get("stdin_json") is not None:
        stdin_content = json.dumps(p["stdin_json"], ensure_ascii=False)
    try:
        if interpreter == "shell":
            cmd = script if not args else script + " " + " ".join(args)
            proc = subprocess.run(cmd, shell=True, cwd=cwd, input=stdin_content,
                                  capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
            return _script_result(p, proc)
        if interpreter == "node":
            # No node toolchain in this harness — fail loud (matches serve.py), never
            # fake a pass for a gate we didn't run.
            return {"ok": False, "script_id": p.get("script_id"), "success": False, "error_kind": "node_interpreter_unavailable", "stderr": "node not supported", "exit_code": 1}
        # python: resolve the bare script name to the current plugin's scripts/ dir, else search.
        cand = skill_dir / "scripts" / pathlib.Path(script).name
        if not cand.is_file():
            found = list(SKILLS_ROOT.rglob(pathlib.Path(script).name)) if script else []
            cand = found[0] if found else None
        if cand is None or not cand.is_file():
            # An unresolvable script is a hard failure, not a faked success — otherwise
            # a required gate could "pass" without ever running.
            return {"ok": False, "script_id": p.get("script_id"), "success": False, "error_kind": "script_not_found", "stderr": f"script {script} not vendored", "exit_code": 1}
        proc = subprocess.run([sys.executable, str(cand), *args], cwd=cwd, input=stdin_content,
                              capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        return _script_result(p, proc)
    except Exception as e:  # noqa: BLE001
        return {"ok": True, "script_id": p.get("script_id"), "success": False, "stdout": "", "stderr": str(e)[:600], "exit_code": 1}


def execute_tool(tu, project_dir, skill_dir, stats):
    name, p = tu["name"], tu["input"]
    stats["by_tool"][name] = stats["by_tool"].get(name, 0) + 1
    violation = routes_llm._payload_violation(name, tu["args"])
    if name not in tool_registry.LLM_TOOL_NAMES:
        stats["off_protocol"] += 1
        return {"ok": False, "error_kind": "off_protocol_tool"}, None
    if violation:
        stats["invalid_payload"] += 1
        return {"ok": False, "error_kind": "protocol_payload_invalid", "detail": violation}, None
    stats["valid"] += 1

    if name == "approval_request":
        return {"ok": True, "approval_id": p.get("approval_id"), "action": _primary_action(p),
                "selected_ids": _selected_ids(p), "added_items": [], "text_values": {}, "notes": ""}, None
    if name == "status_update":
        return {"ok": True}, None
    if name == "device_command":
        action = p.get("action")
        out = {"devs": "COM3", "scan": "[60, 68]"}.get(action, "")
        if action in ("read", "stream", "run", "exec"):
            out = "MPYHW_READY\nstatus: ok temp=24.1 hum=51\n"
        return {"ok": True, "cmd_id": p.get("cmd_id"), "success": True, "stdout": out, "stderr": "", "exit_code": 0}, None
    if name == "file_operation":
        op, path = p.get("op"), p.get("path", "")
        root = project_dir.resolve()
        resource_root = SKILLS_ROOT.resolve()

        def _contained(rel):
            # Resolve a workspace-relative path; return it only if it stays inside the
            # project root (the root itself counts as inside — callers that mutate also
            # reject root). Mirrors the shipped extension's containment; refuses escapes.
            target = (project_dir / rel).resolve()
            return target if (target == root or root in target.parents) else None

        def _contained_resource(rel):
            # Read-only access to vendored skill resources. V0 skills are allowed to
            # inspect sibling assets such as upy-analyze-plugin/boards, but the
            # harness must never let those paths escape the vendored skill root.
            raw = pathlib.Path(str(rel))
            target = (raw if raw.is_absolute() else resource_root / raw).resolve()
            return target if (target == resource_root or resource_root in target.parents) else None

        def _read_target(rel):
            project_target = _contained(rel)
            if project_target is not None and project_target.exists():
                return project_target, root
            resource_target = _contained_resource(rel)
            if resource_target is not None and resource_target.exists():
                return resource_target, resource_root
            return None, None

        if op in ("write", "append") and path:
            target = _contained(path)
            if target is None or target == root:
                return {"ok": False, "op_id": p.get("op_id"), "error_kind": "path_outside_workspace"}, None
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "a" if op == "append" else "w", encoding="utf-8") as fh:
                fh.write(p.get("content", ""))
            stats["files_written"].add(path)
            if path.endswith(".py"):
                stats["code_chars"] += len(p.get("content", ""))
            return {"ok": True, "op_id": p.get("op_id"), "success": True, "error": None}, None
        if op == "read" and path:
            target, _ = _read_target(path)
            if target is None or not target.is_file():
                return {"ok": False, "op_id": p.get("op_id"), "error_kind": "not_found"}, None
            return {"ok": True, "op_id": p.get("op_id"), "success": True, "content": target.read_text(encoding="utf-8")}, None
        if op == "list":
            base, list_root = _read_target(path) if path else (root, root)
            if base is None or not base.is_dir():
                return {"ok": False, "op_id": p.get("op_id"), "error_kind": "not_found"}, None
            entries = []
            for child in sorted(base.rglob("*")):
                if ".git" in child.parts:
                    continue
                rel = child.relative_to(list_root).as_posix()
                entries.append(rel + "/" if child.is_dir() else rel)
            return {"ok": True, "op_id": p.get("op_id"), "success": True, "entries": entries}, None
        if op in ("mkdir", "delete") and path:
            # Real, contained fs mutation (matches the shipped extension's backings;
            # the old no-op faked success and let generate's firmware/tools/ cleanup
            # silently not happen). Refuse the root itself and any escape.
            target = _contained(path)
            if target is None or target == root:
                return {"ok": False, "op_id": p.get("op_id"), "error_kind": "path_outside_workspace"}, None
            if op == "mkdir":
                target.mkdir(parents=True, exist_ok=True)
            elif target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            elif target.exists():
                target.unlink()
            return {"ok": True, "op_id": p.get("op_id"), "success": True, "error": None}, None
        # Unknown/invalid file op — fail loud, never fake success.
        return {"ok": False, "op_id": p.get("op_id"), "error_kind": "unsupported_file_op", "error": op}, None
    if name == "script_run":
        return run_script(p, project_dir, skill_dir), None
    if name == "phase_complete":
        return {"ok": True}, {"result": p.get("result"), "next_phase": p.get("next_phase"),
                              "manifest": p.get("manifest_content")}
    return {"ok": True}, None


def main():
    project_dir = pathlib.Path(tempfile.mkdtemp(prefix="mpyhw_e2e_v0_"))
    # generate's phase_complete(success) requires a real git commit — init a repo.
    for cmd in (["git", "init", "-q"], ["git", "config", "user.email", "e2e@blockless.local"],
                ["git", "config", "user.name", "e2e"]):
        try:
            subprocess.run(cmd, cwd=project_dir, check=False, capture_output=True)
        except Exception:  # noqa: BLE001
            pass
    print("=== E2E V0 protocol run (real DeepSeek) ===")
    print("intent:", INTENT)
    print("project_dir:", project_dir)
    print("model:", os.getenv("MPYHW_LLM_MODEL"))
    print("served phases:", skill_catalog.served_phases())

    stats = {"by_tool": {}, "valid": 0, "invalid_payload": 0, "off_protocol": 0,
             "files_written": set(), "code_chars": 0}
    # Dev shortcut: seed a known-good upstream manifest and start mid-chain, so the
    # already-proven analyze+select-hw turns don't have to be re-billed when iterating
    # on a later phase. The official green is still a full run from "analyze".
    phase = os.getenv("E2E_START_PHASE", "analyze")
    manifest = {}
    seed = os.getenv("E2E_SEED_MANIFEST", "").strip()
    if seed:
        seeded = json.loads(pathlib.Path(seed).read_text(encoding="utf-8"))
        manifest = (seeded.get("payload", {}).get("manifest_content")
                    or seeded.get("manifest_content") or seeded)
        print(f"SEEDED start: phase={phase} manifest_keys={sorted(manifest)[:8]}... mcu_type={type(manifest.get('mcu')).__name__}")
    phases_done = []

    for _ in range(MAX_PHASES):
        skill_name = skill_catalog.SKILL_BY_PHASE.get(phase)
        if not skill_name:
            print(f"\n----- next_phase '{phase}' has no served skill -> terminal -----")
            break
        skill_dir = SKILLS_ROOT / skill_name
        print(f"\n----- PHASE: {phase}  (skill={skill_name}) -----")
        messages = [{"role": "user", "content": INTENT}]
        phase_result = next_phase = None
        for turn in range(MAX_TURNS_PER_PHASE):
            blocks, tool_uses = run_turn(phase, manifest, messages)
            messages.append({"role": "assistant", "content": blocks})
            print(f"  turn {turn}: tools={[_summarize(tu) for tu in tool_uses]}")
            if not tool_uses:
                print("  (model ended turn with no tool — stopping phase)")
                break
            tool_results, done = [], False
            for tu in tool_uses:
                result, control = execute_tool(tu, project_dir, skill_dir, stats)
                if isinstance(result, dict) and (result.get("ok") is False or result.get("success") is False):
                    detail = result.get("error_kind") or result.get("stderr") or result.get("detail") or result.get("note") or ""
                    print(f"      ! {tu['name']}({_summarize(tu)}) failed: {str(detail)[:240]}")
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
        if phase_result != "success" or not next_phase:
            break
        phase = next_phase

    # --- report ---
    print("\n=== SUMMARY ===")
    print("phases:", " -> ".join(f"{p}({r})" for p, r in phases_done))
    print("tool calls by type:", stats["by_tool"])
    total = stats["valid"] + stats["invalid_payload"] + stats["off_protocol"]
    validity = (stats["valid"] / total) if total else 0.0
    print(f"valid protocol tools: {stats['valid']}/{total} ({validity:.0%})")
    print("off-protocol:", stats["off_protocol"], " invalid payloads:", stats["invalid_payload"])
    print("files written:", sorted(stats["files_written"]))
    print("generated code chars:", stats["code_chars"])
    main_py = project_dir / "firmware" / "main.py"
    main_ok = main_py.is_file() and len(main_py.read_text(encoding="utf-8")) > 100
    reached = {p for p, r in phases_done if r == "success"}
    reached_generate = "upy-generate-plugin" in reached
    reached_deploy = "upy-deploy-plugin" in reached
    print("firmware/main.py written+nontrivial:", main_ok)
    print("reached generate:", reached_generate, " reached deploy:", reached_deploy)
    passed = reached_generate and main_ok and stats["off_protocol"] == 0 and validity >= 0.95
    print("E2E-V0:", "PASS" if passed else "REVIEW")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
