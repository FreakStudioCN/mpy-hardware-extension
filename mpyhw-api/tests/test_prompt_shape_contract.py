"""The injected phase_complete skeletons must agree with the validators they were copied from.

prompt_assembly.py teaches the model a payload shape so the phase stops discovering its own
contract by trial and error. The values in those skeletons -- the optional next phases, the git
permission type, the deploy evidence filenames -- are constants in the plugin scripts, and the
comments above each skeleton say so. But prompt_assembly imports nothing from those scripts: the
values are TRANSCRIBED, and the scripts live in a submodule that moves on its own (the pin just
advanced nine commits in one bump).

That is the failure this repository keeps paying for. A hand-kept copy of somebody else's
constant drifts silently, and it has already happened with the telemetry event allowlist (three
times), _PROJECT_ROOT_SCRIPTS, and both toolchain version constants. Here the drift would be
worse than silent, it would be actively misleading: the injection would confidently teach the
model a shape the gate rejects, which is precisely the trial-and-error loop it exists to end,
and every test would stay green because both halves are internally consistent.

So derive the constants from the vendored scripts and compare. A pin move that changes a
required artifact or an accepted phase fails HERE, at the bump, instead of on a hardware run.
"""

import ast
import pathlib

import pytest

from app import prompt_assembly

SKILLS_ROOT = pathlib.Path(__file__).resolve().parents[2] / "third_party" / "MicroPython_Skills"
_CONSISTENCY = SKILLS_ROOT / "upy-generate-plugin" / "scripts" / "check_phase_complete_consistency.py"
_DEPLOY_MANIFEST = SKILLS_ROOT / "upy-deploy-plugin" / "scripts" / "deploy_manifest.py"


def _module_constant(path: pathlib.Path, name: str):
    """A module-level literal constant, read without importing the script.

    ast rather than import: these scripts pull in siblings from their own plugin dir and are
    written to be run, not imported, so importing one to read a set would couple this test to
    whatever else it does at module scope.
    """
    assert path.is_file(), f"{path} is missing -- is the skills submodule checked out?"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == name:
                return ast.literal_eval(node.value)
    raise AssertionError(f"{name} is no longer a module-level constant in {path.name}")


def _generate_payload():
    return prompt_assembly._GENERATE_PAYLOAD_SHAPE["payload"]


def _deploy_payload():
    return prompt_assembly._DEPLOY_PAYLOAD_SHAPE["payload"]


@pytest.mark.no_db
def test_the_generate_skeleton_offers_the_optional_phases_the_checker_requires():
    required = _module_constant(_CONSISTENCY, "REQUIRED_OPTIONAL_PHASES")
    offered = _generate_payload()["optional_next_phases"]

    assert set(offered) == set(required), (
        "the injected optional_next_phases and check_phase_complete_consistency.py's "
        f"REQUIRED_OPTIONAL_PHASES disagree: injected {sorted(offered)}, required {sorted(required)}"
    )


@pytest.mark.no_db
def test_the_generate_skeleton_uses_a_git_permission_type_the_checker_accepts():
    accepted = _module_constant(_CONSISTENCY, "GIT_PERMISSION_TYPES")
    used = {entry["type"] for entry in _generate_payload()["permissions"]}

    assert used <= set(accepted), (
        f"the injected permission types {sorted(used)} are not all in GIT_PERMISSION_TYPES "
        f"{sorted(accepted)} -- the skeleton would teach a permission the checker rejects"
    )


@pytest.mark.no_db
def test_the_deploy_skeleton_lists_every_artifact_a_success_payload_must_carry():
    # The whole point of the deploy injection: a success that names fewer artifacts than
    # deploy_manifest.py requires is refused, and the model then hand-writes the missing
    # evidence file -- the forgery path this branch's own loop guards exist to close.
    required = _module_constant(_DEPLOY_MANIFEST, "SUCCESS_REQUIRED_ARTIFACT_BASENAMES")
    listed = {pathlib.PurePosixPath(a["path"]).name for a in _deploy_payload()["artifacts"]}

    assert set(required) <= listed, (
        f"the deploy skeleton omits required artifacts: {sorted(set(required) - listed)}"
    )


@pytest.mark.no_db
def test_the_deploy_skeleton_satisfies_every_keyword_matched_artifact_group():
    # Three artifacts are matched by keyword rather than by exact name (the serial capture, the
    # final reset, the log report), so a skeleton can satisfy the basename check above and still
    # leave a whole group unnamed.
    groups = _module_constant(_DEPLOY_MANIFEST, "SUCCESS_REQUIRED_ARTIFACT_KEYWORDS")
    paths = [a["path"].lower() for a in _deploy_payload()["artifacts"]]

    unmatched = [
        label for label, keywords in groups.items()
        if not any(keyword in path for path in paths for keyword in keywords)
    ]
    assert not unmatched, (
        f"the deploy skeleton names no artifact for {unmatched}; deploy_manifest.py matches those "
        "groups by keyword, so a success payload built from this skeleton would be refused"
    )
