from pathlib import Path


def test_content_freshness_guard_is_wired_in_ci():
    """Guard against silently dropping the content-freshness drift check from CI.

    The check has three load-bearing parts: a deterministic re-ingest from the
    pinned submodule, a tracked-diff gate, and an untracked-file gate. If any goes
    missing the committed catalog could drift undetected. Kept as a substring check
    (not YAML parsing) so the test adds no PyYAML dependency to the API runtime.
    """
    workflow = (Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert "ingest_graftsense.py" in workflow, "must re-ingest from the pinned submodule"
    assert "git diff --exit-code -- mpyhw-api/content/packages" in workflow, "must fail on tracked drift"
    assert "git status --porcelain --untracked-files=all -- mpyhw-api/content/packages" in workflow, "must fail on untracked drift"
