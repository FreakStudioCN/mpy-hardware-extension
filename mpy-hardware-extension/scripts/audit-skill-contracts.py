#!/usr/bin/env python3
"""Static contract audit of the plugin skills. Three predicates, each from a real stall.

The message replay (scripts/replay-gate-payloads.py) grades what a validator SAYS. These three
find faults that no message grader can see, because the message itself reads fine:

  1. SPLIT CODE  -- one error code emitted from several places. If two emitters read different
     locations, a model satisfies the one the message names, that emitter goes quiet, and the
     other keeps returning the identical sentence with no field left to add. Measured: a phase
     died at the turn cap on GIT_COMMIT_MISSING while fully compliant with one of its two
     readers. Being emitted twice is not itself a bug, so this reports candidates and shows the
     read path of each site; a difference in what they READ is the bug.

  2. UNPRODUCED MARKER -- a literal a script waits for that nothing in the tree ever emits.
     Measured: capture_repl.py stops on "MPYHW_READY" or "starting scheduler", and neither
     string appeared in any template or generated file, so every capture ran to its timeout and
     was killed. Passing runs survived on luck (a chatty main.py); a quieter app stalls by
     design, and the message blames the board.

  3. ABSENCE-WORDED TYPE CHECK -- `if not isinstance(x, dict)` answered with "x is required".
     A payload that HAS the field in the wrong shape is told it is missing, so the model, seeing
     what it wrote, looks everywhere else. Measured: a run wrote behavior_spec as a prose string
     where an object was required, spent 17 calls rewriting the payload around it, and ended
     partial with that as its only remaining error. Reported only when the message gives no way
     to act at all: no shape, no command to run, no accepted shape as a sibling key.

Usage:  python3 scripts/audit-skill-contracts.py [--skills <dir>]
Exit 0 always: these are candidates for a human to judge, not a gate.
"""
from __future__ import annotations

import argparse
import ast
import re
from collections import defaultdict
from pathlib import Path

DEFAULT_SKILLS = Path(__file__).resolve().parents[2] / "third_party" / "MicroPython_Skills"
EXCLUDE = re.compile(r"site-packages|\.venv|/mpos-|/test/")

CODE = re.compile(r'"code"\s*:\s*"([A-Z][A-Z0-9_]{3,})"')
# What the emitter READS near its site: the dotted payload path it consults. Two sites reading
# different paths under one code is the exact shape of the bug this looks for.
READS = re.compile(r'\b(payload|manifest|manifest_content|generate|state|result)\s*(?:\.|\.get\(")([a-z_]+)')
# Literals a script WAITS FOR, which is much narrower than "a literal near the word expect".
# The first version matched any quoted string in a list beside a name like `expect`, and
# reported two ordinary phrase constants as unproduced markers. The measured case is an
# argparse default for a --stop-pattern/--marker option, or a module constant named for one, so
# match those two shapes and nothing else.
AWAITS_DEFAULT = re.compile(r'add_argument\(\s*"--(?:stop-pattern|marker|ready-marker)"[^)]*?default\s*=\s*(\[[^\]]*\]|"[^"]+")', re.S)
# A module constant named *_MARKERS was tried and dropped: the maixpy validator uses that name
# for text-classification phrases it searches FOR in prose, which a name-based heuristic
# cannot tell apart from a literal awaited on a serial stream. Reporting those as unproduced
# markers is how a checker teaches people to ignore it. The argparse shape is unambiguous.
LITERAL = re.compile(r'"([^"]{4,60})"')


def py_files(root: Path) -> list[Path]:
    return [p for p in sorted(root.rglob("*.py")) if not EXCLUDE.search(str(p))]


def split_codes(root: Path) -> list[tuple[str, list[tuple[str, int, str]]]]:
    sites: dict[str, list[tuple[str, int, str]]] = defaultdict(list)
    for path in py_files(root):
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for n, line in enumerate(lines, 1):
            for code in CODE.findall(line):
                window = "\n".join(lines[max(0, n - 8):n + 2])
                reads = sorted({".".join(m) for m in READS.findall(window)})
                sites[code].append((str(path.relative_to(root)), n, ", ".join(reads[:4]) or "(no payload read found)"))
    out = []
    for code, where in sorted(sites.items()):
        if len(where) < 2:
            continue
        # Only interesting when the sites READ DIFFERENT THINGS. Identical reads are usually the
        # same check duplicated across phases, which is not the failure mode here.
        if len({w[2] for w in where}) < 2:
            continue
        out.append((code, where))
    return out


def unproduced_markers(root: Path) -> list[tuple[str, list[str]]]:
    awaited: dict[str, list[str]] = defaultdict(list)
    for path in py_files(root):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for blob in AWAITS_DEFAULT.findall(text):
            for literal in LITERAL.findall(blob):
                awaited[literal].append(str(path.relative_to(root)))
    # A producer is only something that REACHES THE DEVICE: a scaffold template, i.e. code that
    # gets rendered into the project and runs on the board. Docs, SKILL prose, sample payloads
    # and smoke tests all mention these strings, and counting them was this check's second false
    # answer: before the templates were fixed, "starting scheduler" appeared in six files and
    # none of them ever printed it on a serial line.
    findings = []
    for literal, waiters in sorted(awaited.items()):
        produced = []
        for path in root.rglob("*"):
            if not path.is_file() or EXCLUDE.search(str(path)):
                continue
            rel = str(path.relative_to(root))
            if "/templates/" not in f"/{rel}":
                continue
            try:
                if literal in path.read_text(encoding="utf-8", errors="replace"):
                    produced.append(rel)
            except OSError:
                continue
        if not produced:
            findings.append((literal, waiters))
    return findings


# Wordings a model reads as "you did not write this". `requires` earns its place by measurement,
# not symmetry: one emitter of CLOUD_CREDENTIAL_MANAGEMENT_MISSING says "is required" and the
# other says "requires", so leaving it out flagged one and hid its twin -- which is the
# two-emitters-one-code trap this file's first predicate exists to catch, scored against itself.
ABSENCE_WORDED = re.compile(
    r"\b(is required|are required|requires|must be present|is missing|are missing|must record|must include|must expose)\b",
    re.I,
)
# The three ways a rejection can be actionable. Naming the expected type is only one of them,
# and it is not the one that made the measured fix work: what ended that loop was naming what
# was SEEN ("it is a str"). A message that names a command to run, or carries the accepted shape
# as a machine-readable sibling key, is equally actionable while naming no type at all.
NAMES_A_SHAPE = re.compile(r"\b(object|dict|mapping|list|array|string|str|number|int|float|bool|boolean|JSON)\b", re.I)
NAMES_A_COMMAND = re.compile(r"\b[\w./-]+\.py\b|--[a-z][a-z-]+")
SHAPE_SIBLING_KEYS = {"expected_entry", "accepted_locations", "accepted_keys", "accepted", "expected", "example"}
CODE_LIKE = re.compile(r"^[A-Z][A-Z0-9_]{3,}$")


def _type_checked_ifs(tree: ast.AST) -> list[ast.If]:
    """Every `if not isinstance(...)` branch, including inside `or`/`and` chains."""
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.If):
            continue
        for sub in ast.walk(node.test):
            if isinstance(sub, ast.UnaryOp) and isinstance(sub.op, ast.Not) \
                    and isinstance(sub.operand, ast.Call) and getattr(sub.operand.func, "id", "") == "isinstance":
                found.append(node)
                break
    return found


def _own_body(branch: ast.If):
    """The statements this `if` actually guards: its body, never its else, and never a nested
    `if`'s body. Walking the whole subtree was this predicate's first wrong answer -- the
    generate-section check reported three codes at its own line number, because the two checks
    in its `else` are guarded by their own conditions and have nothing to do with its type
    test. An over-reporting audit is one nobody reads."""
    stack = [s for s in branch.body if not isinstance(s, ast.If)]
    while stack:
        node = stack.pop()
        yield node
        stack.extend(child for child in ast.iter_child_nodes(node) if not isinstance(child, ast.If))


def _fragments(node: ast.AST) -> str:
    """Every literal string under an expression, joined. Reads an f-string and a `"a" + b`
    concatenation the same way a reader does, which a Constant-only match cannot."""
    return " ".join(
        sub.value for sub in ast.walk(node)
        if isinstance(sub, ast.Constant) and isinstance(sub.value, str)
    ).strip()


def _reported_errors(branch: ast.If) -> list[tuple[str, str, set[str]]]:
    """(code, message, sibling keys) for every error this branch itself reports.

    Reads the expression a validator hands to `errors.append(...)` / `.extend(...)` / `return
    [...]`, in whatever shape it is written. The first version of this read literal dicts with
    constant "code" and "message" values ONLY, and that quietly reduced a tree-wide audit to one
    plugin: select-hw, gen-driver and flash append plain strings, diagram builds its dicts
    through an `error(code, message)` helper, and several messages are f-strings. Fourteen
    instances of the exact defect this predicate exists to find sat in those files, reported as
    nothing, so the output read as "those plugins are clean".
    """
    out = []
    for node in _own_body(branch):
        if isinstance(node, ast.Call) and getattr(node.func, "attr", "") in {"append", "extend"}:
            reported = list(node.args)
        elif isinstance(node, ast.Return) and node.value is not None:
            reported = node.value.elts if isinstance(node.value, ast.List) else [node.value]
        else:
            continue
        for entry in reported:
            out.append(_split_entry(entry))
    return [entry for entry in out if entry[1]]


def _split_entry(entry: ast.AST) -> tuple[str, str, set[str]]:
    """One reported error as (code, message, sibling keys), whatever shape it was written in."""
    if isinstance(entry, ast.Dict):
        keys = {k.value for k in entry.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)}
        parts = {
            k.value: _fragments(v)
            for k, v in zip(entry.keys, entry.values)
            if isinstance(k, ast.Constant) and isinstance(k.value, str)
        }
        return parts.get("code", ""), parts.get("message", ""), keys
    # A helper call (`error("CODE", "message")`) or a bare string. The CODE-shaped fragment is
    # the code and the rest is the message, so one level of indirection needs no resolving:
    # the message is a literal argument at the call site either way.
    pieces = [p for p in (_fragments(arg) for arg in getattr(entry, "args", [entry])) if p]
    if not pieces and isinstance(entry, (ast.Constant, ast.JoinedStr, ast.BinOp)):
        pieces = [_fragments(entry)]
    code = next((p for p in pieces if CODE_LIKE.match(p)), "")
    message = " ".join(p for p in pieces if p != code).strip()
    return code, message, set()


def _guard_names(branch: ast.If) -> set[str]:
    """What the isinstance actually tests: `requirements`, or the key in `.get("requirements")`.
    A message that names `<that>.<leaf>` is describing a field one level INSIDE the value being
    type-checked, which usually reads correctly (when the container is the wrong shape, the leaf
    genuinely is absent), so those are reported in their own lower tier rather than mixed in."""
    names: set[str] = set()
    for sub in ast.walk(branch.test):
        if not (isinstance(sub, ast.Call) and getattr(sub.func, "id", "") == "isinstance" and sub.args):
            continue
        names.add(_guarded_name(sub.args[0]))
    return {name for name in names if name}


def _guarded_name(node: ast.AST) -> str:
    """The name of the value being type-checked, NOT the thing it was read from. Walking the
    whole test for identifiers put `payload` in this set for `payload.get("checkpoint")`, so
    "payload.checkpoint is required" looked like a message about a field inside the guarded
    value and was filed under the softer tier. It is the opposite: checkpoint IS the guarded
    value, and a present, wrong-shaped one is told it is missing."""
    if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "get" and node.args:
        return _fragments(node.args[0])
    if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
        return str(node.slice.value)
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return ""


def absence_worded_type_checks(root: Path) -> list[tuple[str, int, str, str]]:
    """A type check whose message says the field is ABSENT.

    The third shape, and the one that cost the most recently measured phase. A payload that HAS
    the field in the wrong shape is told it is missing, so the model, seeing the field it wrote,
    concludes the fault is elsewhere and rewrites everything around it. One run wrote
    behavior_spec as a prose string where an object was required, spent 17 calls rewriting the
    payload around it, and died at the turn cap with that as its only remaining error.

    Reported when the message is absence-worded and gives the reader NO way to act: it names no
    shape, no command to run, and carries no accepted shape as a sibling key. Any one of those
    three is enough to keep a message useful, so any one of them suppresses the finding.

    Returns (path, line, code, message, tier). Tier "container" means the type check guards a
    value while the message names a field INSIDE it, which usually reads correctly and is kept
    apart rather than mixed into the list a human is meant to act on.
    """
    findings = []
    for path in py_files(root):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, SyntaxError):
            continue
        for branch in _type_checked_ifs(tree):
            guarded = _guard_names(branch)
            for code, message, siblings in _reported_errors(branch):
                if not ABSENCE_WORDED.search(message):
                    continue
                if NAMES_A_SHAPE.search(message) or NAMES_A_COMMAND.search(message):
                    continue
                if siblings & SHAPE_SIBLING_KEYS:
                    continue
                tier = "container" if any(f"{name}." in message for name in guarded if name) else "direct"
                findings.append((str(path.relative_to(root)), branch.lineno, code, message, tier))
    return sorted(findings)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skills", default=str(DEFAULT_SKILLS), help="skills tree to audit")
    args = parser.parse_args()
    root = Path(args.skills).expanduser()
    if not root.is_dir():
        print(f"no such skills directory: {root}")
        return 2

    split = split_codes(root)
    print(f"=== split codes: one error code, several sites reading DIFFERENT payload paths ({len(split)}) ===")
    for code, where in split:
        print(f"\n{code}")
        for rel, line, reads in where:
            print(f"    {rel}:{line}  reads: {reads}")
    if not split:
        print("  none")

    shapes = absence_worded_type_checks(root)
    direct = [f for f in shapes if f[4] == "direct"]
    container = [f for f in shapes if f[4] == "container"]
    print(f"\n=== type checks whose message says the field is ABSENT ({len(direct)}) ===")
    for rel, line, code, message, _ in direct:
        print(f"  {rel}:{line}  {code or '(no code)'}")
        print(f'      "{message}"')
        print("      a present-but-wrong-shape value gets told it is missing; name the shape and what was seen")
    if not direct:
        print("  none")
    print(f"\n=== same, but the guard is a CONTAINER and the message names a field inside it ({len(container)}) ===")
    print("  usually accurate (a wrong-shaped container really has no such field), judge case by case")
    for rel, line, code, message, _ in container:
        print(f"  {rel}:{line}  {code or '(no code)'}")
        print(f'      "{message}"')
    if not container:
        print("  none")

    markers = unproduced_markers(root)
    print(f"\n=== awaited literals nothing produces ({len(markers)}) ===")
    for literal, waiters in markers:
        print(f'  "{literal}"  awaited by: {", ".join(waiters)}')
        print("      nothing in the tree emits this, so the wait can only end in a timeout")
    if not markers:
        print("  none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
