"""Guard: every shim tool is exactly pinned (A1). Unpinned tools made the
16 quality gates drift with upstream lint releases."""
from pathlib import Path

import re


def test_every_requirement_is_exact_pinned():
    lines = [
        ln.strip()
        for ln in (Path(__file__).parent / "requirements.txt").read_text().splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    assert lines, "requirements.txt is empty"
    for ln in lines:
        assert re.fullmatch(r"[A-Za-z0-9._-]+==[A-Za-z0-9.]+", ln), f"not exact-pinned: {ln!r}"


def test_expected_tool_set_unchanged():
    text = (Path(__file__).parent / "requirements.txt").read_text()
    for tool in ("mpremote", "pyserial", "pytest", "jsonschema", "flake8", "pylint", "requests", "pypdf"):
        assert re.search(rf"^{tool}==", text, re.M), f"missing pin for {tool}"
