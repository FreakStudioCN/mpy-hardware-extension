"""skill_catalog's phase mapping must agree with contracts/phase_aliases.json.

The contract file is the single source of truth shared with the extension
(test/phase-aliases-contract.test.ts). The Python side serves each phase from
exactly one skill; every canonical phase must be an alias key that maps to
itself, and PHASE_BY_SKILL's values must be exactly the canonical phases plus
the on-demand optional_phases (gen-driver/wiring/diagram).
"""
import json
from pathlib import Path

from app import skill_catalog

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "phase_aliases.json").read_text(encoding="utf-8")
)


def test_phase_by_skill_values_are_exactly_the_served_phases():
    # The 6 sequential canonical phases plus the on-demand optional flows (gen-driver/wiring/
    # diagram). Optional phases stay OUT of canonical_phases (not in the next_phase chain) but ARE
    # served, so PHASE_BY_SKILL's values must be canonical + optional.
    expected = CONTRACT["canonical_phases"] + CONTRACT["optional_phases"]
    assert sorted(skill_catalog.PHASE_BY_SKILL.values()) == sorted(expected)


def test_every_served_skill_dir_is_a_known_alias_of_its_phase():
    for skill, phase in skill_catalog.PHASE_BY_SKILL.items():
        assert CONTRACT["aliases"].get(skill) == phase, f"{skill} missing/mismatched in contract aliases"


def test_canonical_phases_map_to_themselves_in_aliases():
    for phase in CONTRACT["canonical_phases"]:
        assert CONTRACT["aliases"].get(phase) == phase
