"""Single source of truth for which upstream skills the build agent sees.

The skills live in the vendored submodule (third_party/MicroPython_Skills),
laid out one directory per skill (`<name>/SKILL.md`). Only the project-gen
("一句话造硬件") path is surfaced here; the driver-authoring family
(norm/opt/slim/gen/pack), low-level mpremote how-tos, review, and fetch-doc
ship in the submodule but belong to a separate driver-publishing workflow and
are NOT served to the consumer agent.
"""

import functools
from pathlib import Path


# skill_catalog.py is at mpyhw-api/app/; the submodule sits at the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_ROOT = _REPO_ROOT / "third_party" / "MicroPython_Skills"

# Ordered project-gen surface (matches the upstream phase pipeline).
SERVED_SKILLS = (
    "upy-analyze",
    "upy-select-hw",
    "upy-scaffold",
    "upy-generate",
    "upy-wiring",
    "upy-diagram",
    "upy-deploy",
    "upy-deploy-test",
    "upy-autofix",
    "upy-simulate",
    "upy-pkg-guide",
    "upy-project",
)

PHASE_BY_SKILL = {
    "upy-analyze": "analyze",
    "upy-select-hw": "select-hw",
    "upy-scaffold": "scaffold",
    "upy-generate": "generate",
    "upy-wiring": "wiring",
    "upy-diagram": "diagram",
    "upy-deploy": "deploy",
    "upy-deploy-test": "deploy-test",
    "upy-autofix": "autofix",
    "upy-simulate": "simulate",
    "upy-pkg-guide": "pkg-guide",
    "upy-project": "project",
}

SKILL_BY_PHASE = {phase: skill for skill, phase in PHASE_BY_SKILL.items()}


def skill_md_path(name: str) -> Path | None:
    """Resolve a served skill's SKILL.md, or None if not served / missing.

    Membership in SERVED_SKILLS also gates path traversal: an arbitrary name
    can never escape the submodule because it must match the whitelist first.
    """
    if name not in SERVED_SKILLS:
        return None
    path = SKILLS_ROOT / name / "SKILL.md"
    return path if path.is_file() else None


def served_skill_names() -> list[str]:
    """Served skills that are actually present (submodule checked out)."""
    return [name for name in SERVED_SKILLS if skill_md_path(name) is not None]


def served_phase_names() -> list[str]:
    """Product phase names that have an upstream source present."""
    return [PHASE_BY_SKILL[name] for name in served_skill_names()]


def served_phases() -> list[str]:
    """Phases the protocol can drive (have a present SKILL.md). Alias kept stable
    for the protocol path now that the sanitized phase_profile is gone."""
    return served_phase_names()


@functools.cache
def skill_md_body(phase: str) -> str | None:
    """The FULL verbatim SKILL.md for a product phase, or None if not served / missing.

    This is the core of the protocol rewrite: the cloud LLM now reads the real
    skill (not a sanitized profile), and a server-side adapter preamble tells it
    to express the skill's intent through protocol tools instead of local shell.

    Cached per process: the submodule is pinned per deployment, so reading once
    keeps the system-prompt bytes stable across a session (prefix-cache friendly)
    and avoids a disk read on every turn.
    """
    skill = SKILL_BY_PHASE.get(phase)
    if skill is None:
        return None
    path = skill_md_path(skill)
    if path is None:
        return None
    return path.read_text(encoding="utf-8")


def skill_description(body: str) -> str:
    """First line of the SKILL.md YAML frontmatter `description:`.

    Falls back to the first heading / non-empty line when there is no
    frontmatter description.
    """
    lines = body.splitlines()
    if lines and lines[0].strip() == "---":
        for line in lines[1:]:
            if line.strip() == "---":
                break
            if line.startswith("description:"):
                return line.split(":", 1)[1].strip()
    for line in lines:
        stripped = line.strip()
        if stripped and stripped != "---":
            return stripped.lstrip("# ").strip()
    return ""
