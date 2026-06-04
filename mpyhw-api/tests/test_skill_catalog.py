"""Lock in the served-skill surface: the agent sees exactly the upstream project-gen
phase skills, served as-is from the submodule, and never the driver-authoring family.
Pure (no DB) — exercises skill_catalog directly."""

from app import skill_catalog


def test_served_skills_are_exactly_the_project_gen_phase_surface():
    assert skill_catalog.SERVED_SKILLS == (
        "upy-analyze", "upy-select-hw", "upy-scaffold", "upy-generate",
        "upy-wiring", "upy-diagram", "upy-deploy", "upy-deploy-test",
        "upy-autofix", "upy-simulate", "upy-pkg-guide", "upy-project",
    )


def test_driver_authoring_family_is_not_served():
    # These ship in the submodule but belong to a separate driver-publishing flow.
    for name in ["norm-driver", "opt-driver", "slim-driver", "gen-driver", "pack-driver", "fetch-doc", "review"]:
        assert skill_catalog.skill_md_path(name) is None, f"{name} must not be served"


def test_served_skills_resolve_to_real_submodule_files():
    present = skill_catalog.served_skill_names()
    # The submodule is checked out, so every served skill resolves to a SKILL.md.
    assert set(present) == set(skill_catalog.SERVED_SKILLS), f"missing served skills: {set(skill_catalog.SERVED_SKILLS) - set(present)}"


def test_load_skill_body_is_the_raw_upstream_markdown():
    # The body is the upstream SKILL.md verbatim (the contract now matches, so no
    # refining/rewriting). Spot-check upy-generate carries its real methodology.
    body = skill_catalog.skill_md_path("upy-generate").read_text(encoding="utf-8")
    assert body.startswith("---")            # upstream YAML frontmatter, unmodified
    assert "name: upy-generate" in body


def test_skill_description_reads_frontmatter():
    body = "---\nname: x\ndescription: 第四步——业务代码生成。\n---\n# heading\n"
    assert skill_catalog.skill_description(body) == "第四步——业务代码生成。"


def test_skill_md_path_rejects_traversal_and_unknown_names():
    for name in ["../secret", "upy-analyze/../../etc", "does-not-exist"]:
        assert skill_catalog.skill_md_path(name) is None
