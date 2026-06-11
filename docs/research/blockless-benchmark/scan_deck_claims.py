#!/usr/bin/env python3
"""Scan deck copy for Blockless claim-gate violations.

This is intentionally conservative. It catches obvious risky phrasing before a
deck rewrite can smuggle benchmark-gated or market-gated claims back in.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


SEVERITY_ORDER = {
    "review": 0,
    "benchmark_gated": 1,
    "market_gated": 2,
    "forbidden": 3,
}

SAFE_NEGATION_RE = re.compile(
    r"\b(not proof|not prove|does not prove|do not prove|not evidence|unproven|"
    r"hypothesis|after proof|only if|before claiming|benchmark|baselines?|"
    r"market-gated|benchmark-gated|forbidden)\b",
    re.IGNORECASE,
)


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def iter_scan_lines(path: Path) -> list[tuple[int, str]]:
    lines: list[tuple[int, str]] = []
    in_fence = False
    for index, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not stripped:
            continue
        if stripped.startswith("> **v") or stripped.startswith("> Date:"):
            continue
        if stripped.startswith("`Sources:") or stripped.startswith("Sources:"):
            continue
        lines.append((index, line))
    return lines


def scan(deck: Path, patterns: dict[str, Any], claim_ids: set[str]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    compiled = []
    for pattern in patterns["patterns"]:
        claim_id = pattern["claim_id"]
        if claim_id not in claim_ids:
            raise ValueError(f"Pattern {pattern['pattern_id']} references unknown claim_id {claim_id!r}")
        try:
            regex = re.compile(pattern["regex"], re.IGNORECASE)
        except re.error as exc:
            raise ValueError(f"Pattern {pattern['pattern_id']} has invalid regex: {exc}") from exc
        compiled.append((pattern, regex))

    for lineno, line in iter_scan_lines(deck):
        for pattern, regex in compiled:
            if regex.search(line):
                if SAFE_NEGATION_RE.search(line):
                    continue
                findings.append(
                    {
                        "line": lineno,
                        "pattern_id": pattern["pattern_id"],
                        "claim_id": pattern["claim_id"],
                        "severity": pattern["severity"],
                        "message": pattern["message"],
                        "text": line.strip(),
                    }
                )
    return findings


def main() -> int:
    default_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Scan a deck for risky Blockless claim language.")
    parser.add_argument("deck", type=Path, help="Deck markdown file to scan")
    parser.add_argument("--patterns", type=Path, default=default_dir / "claim-scan-patterns.json")
    parser.add_argument("--matrix", type=Path, default=default_dir / "claim-gate-matrix.json")
    parser.add_argument(
        "--fail-on",
        choices=["review", "benchmark_gated", "market_gated", "forbidden"],
        default="forbidden",
        help="Minimum severity that should produce a non-zero exit code.",
    )
    parser.add_argument(
        "--expect-findings",
        action="store_true",
        help="Return success only if at least one finding is produced. Useful for fixtures.",
    )
    args = parser.parse_args()

    try:
        matrix = load_json(args.matrix)
        patterns = load_json(args.patterns)
        claim_ids = {claim["claim_id"] for claim in matrix["claims"]}
        findings = scan(args.deck, patterns, claim_ids)
    except Exception as exc:  # noqa: BLE001 - CLI error reporting
        print(f"error: {exc}", file=sys.stderr)
        return 2

    for finding in findings:
        print(
            f"{args.deck}:{finding['line']}: {finding['severity']} "
            f"{finding['claim_id']}/{finding['pattern_id']}: {finding['message']}"
        )
        print(f"  {finding['text']}")

    if args.expect_findings:
        if findings:
            print(f"{args.deck}: produced {len(findings)} expected finding(s)")
            return 0
        print(f"{args.deck}: expected findings, found none", file=sys.stderr)
        return 1

    threshold = SEVERITY_ORDER[args.fail_on]
    failed = [finding for finding in findings if SEVERITY_ORDER[finding["severity"]] >= threshold]
    if failed:
        print(f"{args.deck}: {len(failed)} finding(s) at or above {args.fail_on}", file=sys.stderr)
        return 1

    print(f"{args.deck}: no findings at or above {args.fail_on}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
