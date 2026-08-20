#!/usr/bin/env python3
"""Grade every gate message the models were EVER handed, across all archived runs.

Replaying final phase_complete files (gate_replay.py) only reaches payloads that survived to
disk -- 60 pairs. The session logs hold every message actually delivered, including from
payloads overwritten seconds later, which is where most of the turn cost lives.

Note: bodies in the logs are digest-compacted, so payloads cannot be re-validated from here.
The MESSAGE text is intact, which is what is being graded.
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
import argparse
from pathlib import Path

# Two fault classes that are not about message wording at all, both found the expensive way:
#   BENIGN-STATE FAILURE: a non-zero exit reporting the desired state already holds. `mkdir` on
#   an existing directory cost one phase eleven calls of recovery, including a stray :lib2 it
#   then had to delete.
#   NEVER-RETURNS: a call that waits on something that cannot finish -- the app's own main loop,
#   or a --stdin read with no stdin attached. 33 archived timeouts, 17 of them --stdin.
BENIGN_STATE = re.compile(r"file exists|already exists|already installed|nothing to do|up to date", re.I)
NEVER_RETURNS = re.compile(r"shim_request_timeout|timed? ?out", re.I)

VAGUE = re.compile(r"\b(is required|must record|must include|is missing|must be|not found|failed)\b", re.I)
NAMES_PATH = re.compile(r"[a-z_]+\.[a-z_]+|payload\.|checks\.|manifest_content\.|\[\]")
NAMES_SOURCE = re.compile(r"\.py\b|--[a-z-]+|verbatim|copy|run scripts/")
BOTH_SIDES = re.compile(r"differs at|expected|actual|payload=|compare=|valid values|accepted|got |e\.g\.")
COMPARISON = re.compile(r"\b(differ|mismatch|does not match|must match|too old|later than)\b", re.I)


def grade(msg: str, entry: dict) -> list[str]:
    faults: list[str] = []
    has_path = bool(NAMES_PATH.search(msg)) or {"field", "accepted_locations", "expected_entry"} & set(entry)
    has_source = bool(NAMES_SOURCE.search(msg)) or "source" in entry
    if VAGUE.search(msg) and not has_path:
        faults.append("no destination")
    if COMPARISON.search(msg) and not BOTH_SIDES.search(msg):
        faults.append("no both-sides")
    if "must record" in msg.lower() and not has_source:
        faults.append("no producer")
    return faults


def messages_in(log: Path):
    """Every structured error the model received, with its run."""
    for line in log.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("type") != "tool_result":
            continue
        out = (row.get("observation") or {}).get("output")
        if not isinstance(out, dict):
            continue
        for entry in out.get("structured_errors") or []:
            if isinstance(entry, dict):
                yield entry, str(entry.get("message") or entry.get("code") or "")
            else:
                yield {}, str(entry)


def results_in(log: Path):
    """Every FAILING tool result, paired with the call that produced it."""
    rows = []
    for line in log.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    for i, row in enumerate(rows):
        if row.get("type") != "tool_result":
            continue
        out = (row.get("observation") or {}).get("output") or {}
        if out.get("ok") is not False and out.get("success") is not False:
            continue
        call = ""
        for j in range(i - 1, max(i - 3, -1), -1):
            if rows[j].get("type") == "tool_use":
                inp = rows[j].get("input") or {}
                name = str(inp.get("script") or rows[j].get("name") or "").split("/")[-1]
                call = f"{name} {' '.join(str(x) for x in (inp.get('args') or []))[:60]}".strip()
                break
        yield call, f"{out.get('stdout', '')}{out.get('stderr', '')}{out.get('error_kind', '')}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # No default: the archive lives wherever the person running this keeps it. Baking one
    # developer's path into a shared script makes it work for exactly that developer.
    parser.add_argument("archives", help="directory of archived runs (each with .mpyhw/sessions/*/session.jsonl)")
    parser.add_argument("--top", type=int, default=20, help="how many suspect shapes to print")
    args = parser.parse_args()
    RUNS = Path(args.archives).expanduser()
    if not RUNS.is_dir():
        print(f"no such archive directory: {RUNS}")
        return 2
    total = 0
    cost: Counter[str] = Counter()          # how many times each suspect message was delivered
    example: dict[str, str] = {}
    runs_hit: defaultdict[str, set] = defaultdict(set)
    logs = sorted(RUNS.glob("*/.mpyhw/sessions/*/session.jsonl"))

    benign: Counter[str] = Counter()
    hangs: Counter[str] = Counter()
    for log in logs:
        run = log.parts[len(RUNS.parts)]
        for call, text in results_in(log):
            if BENIGN_STATE.search(text):
                benign[call] += 1
            if NEVER_RETURNS.search(text):
                hangs[call] += 1
        for entry, msg in messages_in(log):
            if not msg:
                continue
            total += 1
            faults = grade(msg, entry)
            if not faults:
                continue
            key = f"{entry.get('code') or msg[:36]}|{','.join(faults)}"
            cost[key] += 1
            runs_hit[key].add(run.split("-")[0])
            example.setdefault(key, msg)

    print(f"{len(logs)} session logs, {total} gate messages delivered to models\n")
    if benign or hangs:
        print("=== failures reporting a state that already holds (should be success) ===")
        for call, n in benign.most_common(10):
            print(f"  {n:>4}  {call[:96]}")
        if not benign:
            print("  none")
        print("\n=== calls that timed out waiting on something that cannot return ===")
        for call, n in hangs.most_common(10):
            print(f"  {n:>4}  {call[:96]}")
        if not hangs:
            print("  none")
        print()
    if not cost:
        print("nothing tripped a known defect shape")
        return 0
    print(f"{'delivered':>9}  {'runs':>4}  code / faults")
    print("-" * 78)
    for key, n in cost.most_common(args.top):
        code, faults = key.split("|", 1)
        print(f"{n:>9}  {len(runs_hit[key]):>4}  {code}  [{faults}]")
        print(f"{'':>15}{example[key][:120]}")
    suspect = sum(cost.values())
    print(f"\n{suspect} of {total} delivered messages ({100*suspect/max(total,1):.0f}%) trip a defect shape")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
