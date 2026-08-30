#!/usr/bin/env python3
"""Find the converge-on-errors loops in archived runs, and the fixpoints hiding in them.

Every validating phase has a loop: the model emits a payload, the gate names what is wrong, the
model fixes it, repeat. That loop is normal. Two things about it are not, and both are only
visible across a run's whole trajectory rather than in any single verdict:

  FIXPOINT      the error count reaches zero (or falls) and then RISES again. Something the
                model did to satisfy one check invalidated another. Measured examples:
                recording a git commit changed HEAD, which staled the hash just recorded;
                recording manifest_hash then editing the manifest it hashes. A model cannot
                escape these from inside the loop, so they end at the turn cap.

  IDLE RE-RUN   a validator re-run several times while returning ZERO errors. Nothing is being
                fixed; the model is seeking reassurance. One deploy ran deploy_result.py six
                times this way, at roughly sixteen seconds a turn.

Rank by median rounds to see where the turns go. Split by MODE before believing any of it: a
first version merged select_hw_manifest.py's draft and phase-complete validations into one
trajectory, invented a rise-after-fall out of two clean convergences laid end to end, and
reported select-hw as the most expensive loop in the pipeline. With the modes separated it is
generate's consistency checker, which is also where every visible stall happened.

Usage:  python3 scripts/mine-convergence-loops.py <archives-dir> [--min-rounds N]
"""
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

VALIDATOR = re.compile(
    r"check_phase_complete_consistency\.py|select_hw_manifest\.py|deploy_manifest\.py"
    r"|deploy_result\.py|init_manifest\.py|apply_scaffold\.py|flash_mpy_firmware_manifest\.py"
    r"|run_quality_gates\.py|check_session_state\.py|update_session_state\.py"
)


def trajectories(log: Path):
    """Per (phase, validator), the sequence of error counts across that phase's rounds."""
    rows = []
    for line in log.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    phase = None
    seen: dict[tuple[str, str], list[int]] = defaultdict(list)
    for i, row in enumerate(rows):
        if row.get("type") == "phase_start":
            phase = row.get("phase")
        if row.get("type") != "tool_use":
            continue
        script = str((row.get("input") or {}).get("script", ""))
        if not VALIDATOR.search(script):
            continue
        result = None
        for j in range(i + 1, min(i + 3, len(rows))):
            if rows[j].get("type") == "tool_result":
                result = rows[j]
                break
        out = ((result or {}).get("observation") or {}).get("output", {}) if result else {}
        # A round only counts if the validator actually RETURNED A VERDICT. Zero structured
        # errors is not the same as "everything passed": `--help` exits 0 with usage text, a
        # missing --phase-complete exits 2 with argparse usage, and a payload not yet written
        # gives a load_json traceback. All three carry zero errors, and counting them as clean
        # verdicts is what produced a table of 30 GIT_COMMIT_MISSING "fixpoints" from a set that
        # contains five clean verdicts in total. 15 of the zero-error rounds in the archives are
        # one of these three.
        stdout = str(out.get("stdout") or "")
        args_text = " ".join(str(x) for x in ((row.get("input") or {}).get("args") or []))
        is_verdict = (
            out.get("ok") is not False
            and "--help" not in args_text
            and stdout.lstrip().startswith("{")
            and "Traceback" not in stdout
            and not stdout.lstrip().startswith("usage:")
        )
        if not is_verdict:
            continue
        # Keyed by MODE as well as script. select_hw_manifest.py validates a draft and a
        # phase_complete with the same binary, and merging them produced a fake fixpoint: one
        # run read 8 -> 3 -> 0 -> 0 -> 8 -> 6 -> 0 and looked like a contract trap, when it was
        # two clean convergences (draft 8 -> 3 -> 0, then phase_complete 8 -> 6 -> 0) laid end
        # to end. That single artifact inflated select-hw to 21 "fixpoints" out of 23 loops.
        args = " ".join(str(x) for x in ((row.get("input") or {}).get("args") or []))
        mode = ("validate-phase-complete" if "--validate-phase-complete" in args
                else "check" if "--check" in args
                else "draft" if "--write-path" in args
                else "run")
        seen[(str(phase), f"{script.split('/')[-1]} [{mode}]")].append(len(out.get("structured_errors") or []))
    return seen


def rises_after_falling(counts: list[int]) -> bool:
    """A fixpoint signature: a round returned ZERO errors and a later round did not.

    Deliberately strict. The first version flagged any rise, and most rises are not fixpoints:
    an early round that fails on the ENVELOPE (PAYLOAD_MISSING, TYPE_NOT_PHASE_COMPLETE) short
    circuits every downstream check, so it reports two or three errors, and fixing it lets all
    seventeen checks run for the first time. `3 -> 23` looks like a collapse and is actually
    progress. That artifact reported 17 of 19 generate loops as contract traps.

    A round that reached zero, however, means every check passed on that payload. If a later
    round is non-zero, something the model did afterwards genuinely un-satisfied a check -- the
    GIT_COMMIT_MISSING shape, where recording the value invalidates the value.
    """
    seen_clean = False
    for n in counts:
        if n == 0:
            seen_clean = True
        elif seen_clean:
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("archives", help="directory of archived runs")
    parser.add_argument("--min-rounds", type=int, default=2, help="ignore loops shorter than this")
    args = parser.parse_args()
    root = Path(args.archives).expanduser()
    if not root.is_dir():
        print(f"no such archive directory: {root}")
        return 2

    loops: dict[tuple[str, str], list[list[int]]] = defaultdict(list)
    for log in sorted(root.glob("*/.mpyhw/sessions/*/session.jsonl")):
        for key, counts in trajectories(log).items():
            if len(counts) >= args.min_rounds:
                loops[key].append(counts)

    if not loops:
        print("no convergence loops found")
        return 0

    ranked = []
    for (phase, script), runs in loops.items():
        rounds = sorted(len(r) for r in runs)
        median = rounds[len(rounds) // 2]
        fixpoints = [r for r in runs if rises_after_falling(r)]
        idle = [r for r in runs if all(n == 0 for n in r)]
        ranked.append((median, phase, script, len(runs), fixpoints, idle, max(runs, key=len)))

    print(f"{'phase':<26} {'validator':<38} {'loops':>5} {'median':>7} {'fixpoint':>9} {'idle':>5}")
    print("-" * 96)
    for median, phase, script, n, fixpoints, idle, longest in sorted(ranked, reverse=True):
        print(f"{phase[:25]:<26} {script[:37]:<38} {n:>5} {median:>7} {len(fixpoints):>9} {len(idle):>5}")
        print(f"{'':>26}   worst: {' -> '.join(str(x) for x in longest[:8])}")

    total_fix = sum(len(f) for *_, f, _, _ in ranked)
    total_idle = sum(len(i) for *_, i, _ in ranked)
    print(f"\nfixpoint loops (count rose after falling): {total_fix}   "
          f"idle loops (all-zero re-runs): {total_idle}")
    print("A fixpoint is a contract defect: satisfying one check invalidated another, and the")
    print("model cannot escape it from inside the loop. An idle loop is wasted turns only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
