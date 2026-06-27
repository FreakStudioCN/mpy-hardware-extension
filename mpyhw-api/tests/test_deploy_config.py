from pathlib import Path

import pytest

pytestmark = pytest.mark.no_db

ROOT = Path(__file__).resolve().parents[2]


def test_render_blueprint_includes_browser_oauth_env_vars():
    render_yaml = (ROOT / "render.yaml").read_text(encoding="utf-8")

    for key in [
        "MPYHW_PUBLIC_API_BASE",
        "MPYHW_BROWSER_AUTH_REDIRECT_ORIGINS",
        "MPYHW_GITHUB_CLIENT_ID",
        "MPYHW_GITHUB_CLIENT_SECRET",
    ]:
        assert f"key: {key}" in render_yaml

    assert "value: https://blockless-api.onrender.com" in render_yaml
    assert "value: https://block-less.com" in render_yaml


def test_env_example_documents_browser_oauth_env_vars():
    env_example = (ROOT / "mpyhw-api" / ".env.example").read_text(encoding="utf-8", errors="replace")

    for key in [
        "MPYHW_PUBLIC_API_BASE=https://blockless-api.onrender.com",
        "MPYHW_BROWSER_AUTH_REDIRECT_ORIGINS=https://block-less.com,http://127.0.0.1:8098",
        "MPYHW_GITHUB_CLIENT_ID=",
        "MPYHW_GITHUB_CLIENT_SECRET=",
    ]:
        assert key in env_example