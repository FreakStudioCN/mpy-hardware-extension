"""DB-free static checks for protocol recipes.

This guards the issue #1 failure mode where a served phase falls back to raw
local-agent SKILL.md behavior without a strong protocol recipe.
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import routes_llm, skill_catalog  # noqa: E402

REQUIRED_PHASES = ("analyze", "select-hw", "generate", "wiring", "diagram", "deploy")

REQUIRED_SNIPPETS = {
    "analyze": (
        "NO environment preflight",
        "Do NOT emit a script_run",
        "FIRST tool call is an approval_request",
        "device_confirm",
        "phase_complete",
    ),
    "select-hw": (
        "Do NOT run ANY scripts",
        "NEVER emit script_run or file_operation",
        "phase_complete",
    ),
    "generate": (
        "Do NOT run ANY scripts",
        "NEVER emit script_run or device_command",
        "file_operation",
        "firmware/main.py",
        "phase_complete",
    ),
    "wiring": (
        "Do NOT read or list any files",
        "file_operation",
        "docs/wiring.json",
        "phase_complete",
    ),
    "diagram": (
        "Do NOT read or list files",
        "file_operation",
        "docs/diagram.json",
        "phase_complete",
    ),
    "deploy": (
        "Drive the device strictly through device_command",
        "MPYHW_READY",
        "phase_complete",
    ),
}


def main() -> int:
    problems: list[str] = []
    served = set(skill_catalog.served_phase_names())
    recipes = getattr(routes_llm, "_PHASE_RECIPES")

    for phase in REQUIRED_PHASES:
        if phase not in served:
            problems.append(f"{phase}: not served")
        recipe = recipes.get(phase, "")
        if not recipe:
            problems.append(f"{phase}: missing protocol recipe")
            continue
        for snippet in REQUIRED_SNIPPETS[phase]:
            if snippet not in recipe:
                problems.append(f"{phase}: missing snippet {snippet!r}")

    if problems:
        print("PROTOCOL RECIPE CHECK: REVIEW")
        for problem in problems:
            print(" -", problem)
        return 1
    print("PROTOCOL RECIPE CHECK: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
