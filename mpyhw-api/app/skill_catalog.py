"""Single source of truth for which upstream skills the build agent sees.

The skills live in the vendored submodule (third_party/MicroPython_Skills),
laid out one directory per skill (`<name>/SKILL.md`). Only the project-gen
("一句话造硬件") path is surfaced here; the driver-authoring family
(norm/opt/slim/gen/pack), low-level mpremote how-tos, review, and fetch-doc
ship in the submodule but belong to a separate driver-publishing workflow and
are NOT served to the consumer agent.
"""

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
