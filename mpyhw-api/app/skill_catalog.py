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

PHASE_PROFILES = {
    "analyze": {
        "goal": "Understand the user's device intent and produce the initial manifest requirements and physical devices.",
        "execution_mode": "cloud-only",
        "decision_rules": ["Clarify ambiguous physical behavior with ask_user.", "Use propose_manifest for devices; the host owns component confirmation."],
        "tools": ["ask_user", "propose_manifest"],
        "inputs": ["user_intent", "available_boards"],
        "outputs": ["project-manifest.json"],
        "failure_strategy": ["Ask one product-level clarification when the requested hardware behavior is unclear."],
    },
    "select-hw": {
        "goal": "Choose board, packages, and pinout from structured board/package context.",
        "execution_mode": "cloud-only",
        "decision_rules": ["Fetch board and driver context before assigning pins.", "Prefer supported board pins and generatable package contexts."],
        "tools": ["query_board_profile", "resolve_package_candidates", "get_package_context", "propose_manifest", "run_validate"],
        "inputs": ["project-manifest.json", "board_profile", "driver_context"],
        "outputs": ["mcu", "pinout", "bom"],
        "failure_strategy": ["Revise the manifest when run_validate reports schema errors."],
    },
    "scaffold": {
        "goal": "Create the deterministic firmware project skeleton locally.",
        "execution_mode": "local deterministic",
        "decision_rules": ["Call run_validate first.", "Use run_scaffold after selected hardware is present."],
        "tools": ["run_validate", "run_scaffold"],
        "inputs": ["project-manifest.json"],
        "outputs": ["firmware/"],
        "failure_strategy": ["Use run_triage for local scaffold failures."],
    },
    "generate": {
        "goal": "Generate MicroPython code from the manifest and verified driver context.",
        "execution_mode": "hybrid",
        "decision_rules": ["Generate only files needed by the manifest.", "Audit generated code before any device action."],
        "tools": ["generate_code", "audit_code", "run_static_check", "run_simulate", "run_triage"],
        "inputs": ["project-manifest.json", "board_profile", "driver_context"],
        "outputs": ["firmware/main.py", "firmware/lib/", "test/pc/"],
        "failure_strategy": ["Run local static check and triage, then revise code from structured findings."],
    },
    "wiring": {
        "goal": "Render wiring from manifest devices and pinout.",
        "execution_mode": "local deterministic",
        "decision_rules": ["Do not invent a separate wiring object when the manifest can derive it."],
        "tools": ["run_validate", "render_wiring"],
        "inputs": ["project-manifest.json", "docs/wiring.json"],
        "outputs": ["docs/wiring.md"],
        "failure_strategy": ["Fix schema errors and re-render."],
    },
    "diagram": {
        "goal": "Produce the software architecture diagram from generated project files.",
        "execution_mode": "hybrid",
        "decision_rules": ["Read workspace files when needed.", "Validate diagram JSON before rendering."],
        "tools": ["read_workspace_file", "write_project_file", "run_validate", "render_diagram"],
        "inputs": ["firmware/", "project-manifest.json"],
        "outputs": ["docs/diagram.json", "docs/diagram.md"],
        "failure_strategy": ["Use validation output to revise diagram JSON."],
    },
    "deploy": {
        "goal": "Install packages, upload firmware, reset the board, and read runtime markers.",
        "execution_mode": "local deterministic",
        "decision_rules": ["Let the host deploy checkpoint gate the first device action.", "Keep device ports private to the runner."],
        "tools": ["install_package", "write_main_py", "run_flash_device", "read_serial_until"],
        "inputs": ["firmware/", "package_json_url"],
        "outputs": ["runtime_observation"],
        "failure_strategy": ["Run run_triage after deploy failures and run_hardware_sanity after repeated failures."],
    },
    "deploy-test": {
        "goal": "Verify flashed firmware against expected runtime markers.",
        "execution_mode": "local deterministic",
        "decision_rules": ["Treat serial timeouts as runtime failures, not success."],
        "tools": ["read_serial_until", "run_hardware_sanity"],
        "inputs": ["expected_markers"],
        "outputs": ["runtime_observation"],
        "failure_strategy": ["Collect hardware sanity facts before asking the cloud to revise."],
    },
    "autofix": {
        "goal": "Repair generation or runtime failures from local facts.",
        "execution_mode": "hybrid",
        "decision_rules": ["Use local triage and hardware sanity facts before changing code."],
        "tools": ["run_triage", "run_hardware_sanity", "generate_code", "audit_code", "run_static_check"],
        "inputs": ["triage_result", "hardware_sanity_result", "runtime_observation"],
        "outputs": ["revised_firmware"],
        "failure_strategy": ["Stop after bounded repeated runtime failures and return structured findings."],
    },
    "simulate": {
        "goal": "Run PC-side tests for business logic without hardware.",
        "execution_mode": "local deterministic",
        "decision_rules": ["Use simulation for host-testable logic before flashing."],
        "tools": ["run_simulate", "run_triage"],
        "inputs": ["test/pc/"],
        "outputs": ["pytest_summary"],
        "failure_strategy": ["Revise generated tests or code from pytest output."],
    },
    "pkg-guide": {
        "goal": "Explain package constraints from structured package intelligence.",
        "execution_mode": "cloud-only",
        "decision_rules": ["Do not invent APIs for installable-only packages."],
        "tools": ["search_packages", "resolve_package_candidates", "get_package_context"],
        "inputs": ["package_index", "driver_context"],
        "outputs": ["package_choice"],
        "failure_strategy": ["Ask user for manual-driver tradeoff when no generatable package exists."],
    },
    "project": {
        "goal": "Keep project artifacts aligned with the canonical manifest contract.",
        "execution_mode": "hybrid",
        "decision_rules": ["The manifest schema is the source of truth."],
        "tools": ["propose_manifest", "write_project_file", "run_validate"],
        "inputs": ["project-manifest.json"],
        "outputs": ["validated_project"],
        "failure_strategy": ["Use validation findings to revise the manifest."],
    },
}


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


def phase_profile(phase: str) -> dict | None:
    """Return the sanitized profile for a product phase.

    This intentionally does not parse or return raw SKILL.md content. The upstream
    skill remains the source identity, while the cloud-visible profile is a stable
    product contract without command snippets, install instructions, or paths.
    """
    skill = SKILL_BY_PHASE.get(phase)
    if skill is None or skill_md_path(skill) is None:
        return None
    base = PHASE_PROFILES.get(phase)
    if base is None:
        return None
    return {
        "phase": phase,
        "source": "sanitized_skill_profile",
        "goal": base["goal"],
        "execution_mode": base["execution_mode"],
        "decision_rules": list(base["decision_rules"]),
        "tools": list(base["tools"]),
        "inputs": list(base["inputs"]),
        "outputs": list(base["outputs"]),
        "failure_strategy": list(base["failure_strategy"]),
    }


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
