import json

import pytest
from fastapi.testclient import TestClient

from app import routes_web
from app.main import app


pytestmark = pytest.mark.no_db

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    routes_web.reset()
    yield
    routes_web.reset()


def test_web_events_accepts_frontend_event():
    response = client.post(
        "/v1/web/events",
        json={"event_type": "idea_submitted", "payload": {"idea": "blink led"}, "locale": "en"},
    )

    assert response.status_code == 204


def test_web_events_accepts_welcome_extension_telemetry(monkeypatch):
    """Pin the VS Code extension's welcome-page telemetry contract. The welcome page has no
    Blockless session yet, so its entry clicks post session-independent events HERE (not the
    trace_id-bound /v1/telemetry). Assert /v1/web/events accepts the three welcome event names
    with source=vscode_extension and hands event_type/payload/source to the store verbatim —
    no allow-list rejection, no trace_id required, and source NOT defaulted to website-home."""
    captured = []

    def _record(event_type, payload, locale, source):
        captured.append({"event_type": event_type, "payload": payload, "locale": locale, "source": source})

    from app import web_store

    monkeypatch.setattr(web_store, "record_web_event", _record)

    welcome = [
        ("welcome_import_session_clicked", "import_session"),
        ("welcome_recent_session_restore_clicked", "recent_session_restore"),
        ("welcome_open_project_folder_clicked", "open_project_folder"),
    ]
    for event_type, entry in welcome:
        payload = {"surface": "welcome_page", "entry": entry, "extension_version": "0.4.0", "has_workspace": True}
        response = client.post(
            "/v1/web/events",
            json={"event_type": event_type, "payload": payload, "source": "vscode_extension"},
        )
        assert response.status_code == 204

    assert [c["event_type"] for c in captured] == [name for name, _ in welcome]
    # source stored, never defaulted to the website funnel; payload preserved verbatim.
    assert all(c["source"] == "vscode_extension" for c in captured)
    assert captured[0]["payload"] == {"surface": "welcome_page", "entry": "import_session", "extension_version": "0.4.0", "has_workspace": True}


def test_web_events_swallows_persistence_failure(monkeypatch):
    # Force the persistence write to fail deterministically (simulating a DB outage /
    # no-DB context) rather than relying on DATABASE_URL being unset in the env -- under
    # `no_db` the conftest leaves DATABASE_URL as-is, so a CI run with a live DB would
    # otherwise let the write succeed and the counter stay 0. The endpoint must still
    # 204, AND the write must have been *attempted* and swallowed (failure counter bumps)
    # rather than silently skipped.
    from app import db, web_store

    def _boom(*_args, **_kwargs):
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(db, "connect", _boom)
    web_store.web_write_failure_count = 0
    response = client.post(
        "/v1/web/events",
        json={"event_type": "buy_link_clicked", "payload": {"vendor": "Adafruit"}, "locale": "en"},
    )

    assert response.status_code == 204
    assert web_store.web_write_failure_count == 1


def test_web_events_validates_payload():
    response = client.post(
        "/v1/web/events",
        json={"event_type": "x" * 65, "payload": {}, "locale": "en"},
    )

    assert response.status_code == 422


def test_web_events_rejects_oversized_body_before_validation():
    response = client.post(
        "/v1/web/events",
        content=json.dumps({"event_type": "idea_submitted", "payload": {"idea": "x" * 5000}, "locale": "en"}),
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 413


def test_web_events_rate_limited_after_threshold(monkeypatch):
    monkeypatch.setenv("MPYHW_WEB_RECOMMEND_RATE", "1")
    body = {"event_type": "idea_submitted", "payload": {}, "locale": "en"}

    assert client.post("/v1/web/events", json=body).status_code == 204
    assert client.post("/v1/web/events", json=body).status_code == 429


def test_removed_website_endpoints_are_gone():
    # recommend/newsletter/uploads/quotes had no remaining caller and were removed.
    for path in ("/v1/web/recommend", "/v1/web/newsletter", "/v1/web/uploads", "/v1/web/quotes"):
        assert client.post(path, json={}).status_code == 404


def test_web_events_allows_block_less_com_cors_preflight():
    response = client.options(
        "/v1/web/events",
        headers={
            "Origin": "https://www.block-less.com",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://www.block-less.com"
