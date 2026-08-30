#!/usr/bin/env python3
"""Replay archived run payloads through EVERY discoverable plugin validator, and grade the
messages a model would receive.

Why this exists: five separate phase stalls, each costing an hour-long hardware run to
diagnose, were all one defect -- a gate stating a true condition without saying where it
looked, what it saw, or which command produces the value. Every one of those messages was
reproducible from a saved payload in seconds.

Validators are DISCOVERED, not hand-listed. An earlier version mapped three scripts by hand out
of fifty, which is how the five same-code-different-read-path duplicates survived a sweep. Each
script is driven by the CLI it advertises:

  --project-dir                        -> run against an archived run's project tree
  --input + --validate-phase-complete  -> run against a matching phase_complete.*.json

Anything that advertises neither is REPORTED as unmapped rather than skipped quietly: a
coverage number nobody can see is how the first version looked complete while touching 6% of
the surface.

Usage:  python3 scripts/replay-gate-payloads.py <archives-dir> [--show-unmapped]

What it does NOT do: prove a model can act on a message. It checks the message CONTAINS what a
model needs (a destination path, a producing command, both sides of a comparison). A clean run
means "no known defect shape", not "this works".
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[2] / "third_party" / "MicroPython_Skills"
VENV_PY = Path(__file__).resolve().parents[1] / ".venv" / "bin" / "python"

# Directories that are not ours to grade: vendored dependencies, and the mpos-* product line,
# which has its own pipeline and is not reached by this build's phases.
EXCLUDE = re.compile(r"site-packages|\.venv|/mpos-")

# The phase_complete a validator OWNS, keyed by the plugin directory it lives in. A validator
# must only ever be handed its own phase's payload: feeding deploy_manifest.py a select-hw
# payload produces "phase must be upy-deploy-plugin", which is the validator working correctly
# and says nothing about message quality. The first version of this swept every payload through
# every validator and graded 16,469 messages, nearly all of them that artifact.
OWNED_PAYLOAD = {
    "upy-analyze-plugin": "phase_complete.analyze.json",
    "upy-analyze": "phase_complete.analyze.json",
    "upy-select-hw-plugin": "phase_complete.select_hw.json",
    "upy-flash-mpy-firmware-plugin": "phase_complete.upy_flash_mpy_firmware_plugin.json",
    "upy-scaffold-plugin": "phase_complete.upy_scaffold_plugin.json",
    "upy-generate-plugin": "phase_complete.upy_generate_plugin.json",
    "upy-deploy-plugin": "phase_complete.upy_deploy_plugin.json",
    "upy-diagram-plugin": "phase_complete.upy_diagram_plugin.json",
    "upy-wiring-plugin": "phase_complete.upy_wiring_plugin.json",
    "upy-gen-driver-plugin": "phase_complete.upy_gen_driver_plugin.json",
}

VAGUE = re.compile(r"\b(is required|must record|must include|is missing|must be|not found|failed)\b", re.I)
# A dotted path, a known container prefix, OR a bare field name leading the sentence:
# "protocol_version must be 1.0" names its destination perfectly well, and grading it as
# vague is the tool crying wolf.
NAMES_PATH = re.compile(r"[a-z_]+\.[a-z_]+|payload\.|checks\.|manifest_content\.|\[\]|^[a-z][a-z_]{3,}\s+(must|is|should)\b")
NAMES_PRODUCER = re.compile(r"\.py\b|--[a-z-]+|verbatim|copy")
BOTH_SIDES = re.compile(r"differs at|expected|actual|payload=|compare=|project=|valid values|accepted|but the|e\.g\.")
COMPARISON = re.compile(r"\b(differ|mismatch|does not match|must match|too old|later than)\b", re.I)


def faults_in(entry: dict) -> list[str]:
    """Which defect shapes does one error entry trip? Empty list = actionable."""
    message = str(entry.get("message", entry) if isinstance(entry, dict) else entry)
    keys = set(entry) if isinstance(entry, dict) else set()
    faults: list[str] = []
    has_path = bool(NAMES_PATH.search(message)) or bool(keys & {"field", "accepted_locations", "expected_entry", "gate", "path"})
    has_producer = bool(NAMES_PRODUCER.search(message)) or "source" in keys
    if VAGUE.search(message) and not has_path:
        faults.append("no destination")
    if re.search(r"must record", message, re.I) and not has_producer:
        faults.append("no producer")
    if COMPARISON.search(message) and not BOTH_SIDES.search(message):
        faults.append("no both-sides")
    return faults


def errors_from(stdout: str) -> list:
    text = (stdout or "").strip()
    if not text.startswith("{"):
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return []
    out = list(parsed.get("errors") or [])
    out.extend(parsed.get("structured_errors") or [])
    return out


def discover() -> list[Path]:
    found = [
        p for p in sorted(SKILLS.rglob("scripts/*.py"))
        if not EXCLUDE.search(str(p))
        and re.search(r"check_|_manifest\.py$|deploy_result\.py$|update_session_state\.py$", p.name)
    ]
    return found


def invocations(script: Path, run_dir: Path) -> list[list[str]]:
    """How to drive this script against an archived run. Empty = cannot drive it."""
    try:
        text = script.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    flags = set(re.findall(r'"(--[a-z-]+)"', text))
    calls: list[list[str]] = []
    # The plugin directory this validator lives in decides which payload it owns.
    plugin = next((part for part in script.parts if part in OWNED_PAYLOAD), None)
    owned = OWNED_PAYLOAD.get(plugin or "")
    payload = None
    if owned:
        for candidate in [run_dir / owned, *run_dir.glob(f"sessions/*/{owned}")]:
            if candidate.is_file():
                payload = candidate
                break

    if payload and "--validate-phase-complete" in flags and "--input" in flags:
        calls.append(["--validate-phase-complete", "--input", str(payload)])
    if payload and "--phase-complete" in flags and not calls:
        calls.append(["--phase-complete", str(payload), *(["--project-dir", str(run_dir)] if "--project-dir" in flags else [])])
    # Only a script that does NOT take --input can be driven by a project dir alone. Invoking
    # init_manifest.py with just --project-dir produced "must provide --stdin or --input" across
    # 65 archives: my invocation was wrong, and grading that as a bad message is noise.
    if "--project-dir" in flags and "--input" not in flags and not calls:
        calls.append(["--project-dir", str(run_dir)])
    return calls


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("archives", help="directory of archived runs")
    parser.add_argument("--show-unmapped", action="store_true", help="list validators this cannot drive")
    args = parser.parse_args()
    runs_root = Path(args.archives).expanduser()
    if not runs_root.is_dir():
        print(f"no such archive directory: {runs_root}")
        return 2

    python = str(VENV_PY) if VENV_PY.exists() else sys.executable
    scripts = discover()
    run_dirs = [d for d in sorted(runs_root.iterdir()) if d.is_dir()]

    seen: dict[str, dict] = {}
    invoked: set[str] = set()
    graded = 0

    for script in scripts:
        for run_dir in run_dirs:
            for argv in invocations(script, run_dir):
                invoked.add(script.name)
                try:
                    proc = subprocess.run(
                        [python, str(script), *argv],
                        capture_output=True, text=True, cwd=run_dir, timeout=60,
                    )
                except (subprocess.TimeoutExpired, OSError):
                    continue
                for entry in errors_from(proc.stdout):
                    graded += 1
                    faults = faults_in(entry if isinstance(entry, dict) else {"message": str(entry)})
                    if not faults:
                        continue
                    code = (entry.get("code") if isinstance(entry, dict) else None) or str(entry)[:40]
                    key = f"{script.name}|{code}|{','.join(faults)}"
                    seen.setdefault(key, {"script": script.name, "code": code, "faults": faults,
                                          "msg": str(entry.get("message", entry) if isinstance(entry, dict) else entry), "runs": set()})
                    seen[key]["runs"].add(run_dir.name.split("-")[0])

    unmapped = [s.name for s in scripts if s.name not in invoked]
    print(f"validators discovered: {len(scripts)}   driven: {len(invoked)}   unmapped: {len(unmapped)}")
    print(f"archived runs: {len(run_dirs)}   error messages graded: {graded}\n")

    if seen:
        for item in sorted(seen.values(), key=lambda i: -len(i["runs"])):
            print(f"[{', '.join(item['faults'])}]  {item['code']}   ({item['script']}, runs: {', '.join(sorted(item['runs']))})")
            print(f"    {item['msg'][:150]}")
        print(f"\n{len(seen)} suspect message shapes")
    else:
        print("no message tripped a known defect shape")

    if unmapped:
        # Named, not hidden: an unmapped validator is a gap in this sweep, and the previous
        # version's silence about it is exactly why five duplicate emitters went unnoticed.
        print(f"\n{len(unmapped)} validators this cannot drive from an archive "
              f"(they need inputs no archived run carries){':' if args.show_unmapped else ' -- pass --show-unmapped to list'}")
        if args.show_unmapped:
            for name in sorted(unmapped):
                print(f"    {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
