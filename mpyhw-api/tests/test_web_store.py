"""DB-required tests for /v1/web/events persistence (app/web_store.py).

No `no_db` marker on purpose: these exercise the real INSERT against the test
Postgres provided by conftest. The best-effort swallow path (no DB) is covered in
test_web_events_route.py.
"""

from app import db, web_store


def test_web_event_persists_with_payload():
    web_store.record_web_event("buy_link_clicked", {"vendor": "Adafruit", "idea": "blink led"}, "en", "website-home")

    with db.connect() as conn:
        row = db.fetchone(conn, "SELECT event_type, payload_json, locale, source FROM web_events")

    assert row["event_type"] == "buy_link_clicked"
    assert row["payload_json"] == {"vendor": "Adafruit", "idea": "blink led"}
    assert row["locale"] == "en"
    assert row["source"] == "website-home"
