from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLANS_DIR = ROOT / "docs" / "superpowers" / "plans"

PLAN_FILES = [
    "2026-06-01-mpyhw-mvp-full-roadmap.md",
    "2026-06-01-package-intelligence-hardware-loop.md",
    "2026-06-01-phase-02-api-content-package-intelligence.md",
    "2026-06-01-phase-03-client-agent-loop-tools.md",
    "2026-06-01-phase-04-vscode-webview-product.md",
    "2026-06-01-phase-05-release-observability-hardening.md",
]

PLACEHOLDER_PATTERNS = [
    r"\bTBD\b",
    r"\bTODO\b",
    r"implement later",
    r"fill in",
    r"placeholder",
]

OBSOLETE_ARCH_PATTERNS = [
    r"search_upypi",
    r"get_package_metadata",
    r"/v1/upypi",
    r"without LLM, API",
    r"Replace local package fixtures",
    r"fixture-backed package",
    r"mpyhw\.manifest\.json",
]

REQUIRED_HEADER_SNIPPETS = [
    "> **For agentic workers:**",
    "**Goal:**",
    "**Architecture:**",
    "**Tech Stack:**",
]


def line_for(text: str, pattern: str) -> int:
    compiled = re.compile(pattern, re.IGNORECASE)
    for index, line in enumerate(text.splitlines(), start=1):
        if compiled.search(line):
            return index
    return 0


def require(condition: bool, failures: list[str], message: str) -> None:
    if not condition:
        failures.append(message)


def check_plan(path: Path) -> list[str]:
    failures: list[str] = []
    text = path.read_text(encoding="utf-8-sig")
    rel = path.relative_to(ROOT)

    require(text.startswith("# "), failures, f"{rel}: missing top-level title")
    for snippet in REQUIRED_HEADER_SNIPPETS:
        require(snippet in text, failures, f"{rel}: missing required header snippet `{snippet}`")

    if path.name != "2026-06-01-mpyhw-mvp-full-roadmap.md":
        require("## Task " in text, failures, f"{rel}: missing task sections")
        require("**Files:**" in text, failures, f"{rel}: missing file list sections")
        require("- [ ]" in text, failures, f"{rel}: missing checkbox steps")

    require("Acceptance Checklist" in text, failures, f"{rel}: missing Acceptance Checklist")
    require("Automated acceptance:" in text or "Global Done Definition" in text, failures, f"{rel}: missing automated acceptance or global done definition")
    require("Blocking failures:" in text or "Global Done Definition" in text, failures, f"{rel}: missing blocking failures or global done definition")

    for pattern in PLACEHOLDER_PATTERNS:
        line = line_for(text, pattern)
        require(line == 0, failures, f"{rel}:{line}: placeholder pattern `{pattern}`")

    for pattern in OBSOLETE_ARCH_PATTERNS:
        line = line_for(text, pattern)
        require(line == 0, failures, f"{rel}:{line}: obsolete architecture pattern `{pattern}`")

    return failures


def check_cross_plan() -> list[str]:
    failures: list[str] = []
    all_text = "\n".join((PLANS_DIR / name).read_text(encoding="utf-8-sig") for name in PLAN_FILES)

    require("mpyhw-api` is canonical for Package Intelligence" in all_text, failures, "missing API-canonical Package Intelligence rule")
    require("must not reimplement package search/ranking/context logic" in all_text, failures, "missing no-reimplementation rule")
    require("driver-context contract" in all_text.lower(), failures, "missing driver-context contract test requirement")
    require("pipeline-shim.test.ts" in all_text, failures, "missing non-hardware fake-shim pipeline integration test")
    require("manifest.json" in all_text, failures, "missing standard manifest.json artifact name")
    require("GET /v1/health" in all_text, failures, "missing API health route requirement")
    require("no need for hardware" not in all_text.lower(), failures, "plans should not encode temporary user instruction as permanent requirement")

    return failures


def main() -> int:
    failures: list[str] = []

    for name in PLAN_FILES:
        path = PLANS_DIR / name
        if not path.exists():
            failures.append(f"missing plan file: {path.relative_to(ROOT)}")
            continue
        failures.extend(check_plan(path))

    failures.extend(check_cross_plan())

    if failures:
        print("Plan verification failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print(f"Plan verification passed: {len(PLAN_FILES)} plan files checked.")
    print("Scope: planning-document structure and architecture guardrails only; implementation/runtime behavior requires phase tests.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
