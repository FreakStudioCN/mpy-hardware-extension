from pathlib import Path


def test_content_freshness_guard_checks_untracked_files():
    workflow = (Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert "git diff --exit-code -- mpyhw-api/content/packages" in workflow
    assert "git status --porcelain --untracked-files=all -- mpyhw-api/content/packages" in workflow
