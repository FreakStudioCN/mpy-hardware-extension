"""Lock in the upstream skill adapter surface.

The submodule stays the knowledge source. Under the protocol rewrite the cloud
agent consumes the FULL verbatim SKILL.md (via skill_md_body), not a sanitized
phase profile — a server-side adapter preamble translates its intent into the 6
protocol tools.
"""

from app import skill_catalog


def test_served_phases_are_v0_plugin_chain():
    # V0: the 6 protocol-native -plugin skills. Phase tokens are the exact
    # `next_phase` values upstream emits (analyze/select-hw use short names; the
    # rest use the full plugin dir name — upstream is inconsistent).
    assert skill_catalog.served_phase_names() == [
        "analyze", "select-hw", "upy-flash-mpy-firmware-plugin",
        "upy-scaffold-plugin", "upy-generate-plugin", "upy-deploy-plugin",
    ]


def test_driver_authoring_family_is_not_served():
    # These ship in the submodule but belong to a separate driver-publishing flow.
    for name in ["norm-driver", "opt-driver", "slim-driver", "gen-driver", "pack-driver", "fetch-doc", "review"]:
        assert skill_catalog.skill_md_path(name) is None, f"{name} must not be served"


def test_served_skills_resolve_to_real_submodule_files():
    present = skill_catalog.served_skill_names()
    assert set(present) == set(skill_catalog.SERVED_SKILLS), f"missing served skills: {set(skill_catalog.SERVED_SKILLS) - set(present)}"


def test_skill_md_body_returns_full_raw_markdown():
    # The whole point of the rewrite: the model now sees the REAL SKILL.md, including
    # its local-agent phrasing (the adapter preamble tells it to translate that into
    # protocol tools). So the raw body MUST still contain the markdown — not a profile.
    body = skill_catalog.skill_md_body("analyze")
    assert body and "# " in body  # a heading -> real markdown body
    assert "SKILL" in body or "Skill" in body or "skill" in body
    # carries forward verbatim (no sanitization stripping mpremote/scripts/paths)
    deploy = skill_catalog.skill_md_body("upy-deploy-plugin")
    assert deploy and ("mpremote" in deploy or "```" in deploy)


def test_skill_md_body_rejects_unknown_phases():
    assert skill_catalog.skill_md_body("upy-diagram") is None
    assert skill_catalog.skill_md_body("../diagram") is None
    assert skill_catalog.skill_md_body("not-a-phase") is None


def test_skill_description_reads_frontmatter():
    body = "---\nname: x\ndescription: 第四步——业务代码生成。\n---\n# heading\n"
    assert skill_catalog.skill_description(body) == "第四步——业务代码生成。"


def test_skill_md_path_rejects_traversal_and_unknown_names():
    for name in ["../secret", "upy-analyze/../../etc", "does-not-exist"]:
        assert skill_catalog.skill_md_path(name) is None
