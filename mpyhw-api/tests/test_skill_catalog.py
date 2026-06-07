"""Lock in the upstream skill adapter surface.

The submodule stays the knowledge source, but the product agent consumes sanitized
phase profiles instead of raw SKILL.md bodies.
"""

from app import skill_catalog


def test_served_phases_are_product_workflow_names():
    assert skill_catalog.served_phase_names() == [
        "analyze", "select-hw", "scaffold", "generate", "wiring", "diagram",
        "deploy", "deploy-test", "autofix", "simulate", "pkg-guide", "project",
    ]


def test_driver_authoring_family_is_not_served():
    # These ship in the submodule but belong to a separate driver-publishing flow.
    for name in ["norm-driver", "opt-driver", "slim-driver", "gen-driver", "pack-driver", "fetch-doc", "review"]:
        assert skill_catalog.skill_md_path(name) is None, f"{name} must not be served"


def test_served_skills_resolve_to_real_submodule_files():
    present = skill_catalog.served_skill_names()
    # The submodule is checked out, so every served skill resolves to a SKILL.md.
    assert set(present) == set(skill_catalog.SERVED_SKILLS), f"missing served skills: {set(skill_catalog.SERVED_SKILLS) - set(present)}"


def test_phase_profile_sanitizes_raw_upstream_markdown():
    profile = skill_catalog.phase_profile("diagram")

    assert profile["phase"] == "diagram"
    assert profile["source"] == "sanitized_skill_profile"
    serialized = str(profile)
    assert "SKILL.md" not in serialized
    assert "mpremote" not in serialized
    assert "python " not in serialized
    assert "scripts/" not in serialized
    assert "third_party" not in serialized
    assert "C:/Users/" not in serialized


def test_skill_description_reads_frontmatter():
    body = "---\nname: x\ndescription: 第四步——业务代码生成。\n---\n# heading\n"
    assert skill_catalog.skill_description(body) == "第四步——业务代码生成。"


def test_skill_md_path_rejects_traversal_and_unknown_names():
    for name in ["../secret", "upy-analyze/../../etc", "does-not-exist"]:
        assert skill_catalog.skill_md_path(name) is None


def test_phase_profile_rejects_upstream_names_and_unknown_phases():
    assert skill_catalog.phase_profile("upy-diagram") is None
    assert skill_catalog.phase_profile("../diagram") is None
