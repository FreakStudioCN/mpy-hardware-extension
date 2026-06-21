"""DB-required tests for website data-capture persistence (app/web_store.py).

No `no_db` marker on purpose: these exercise the real INSERTs against the test
Postgres provided by conftest. The best-effort swallow path (no DB) is covered in
test_web_recommend_routes.py.
"""

from app import db, web_store


def test_newsletter_signup_persists_normalized_row():
    web_store.record_newsletter_signup("Maker@Example.com", "en", "website-home")

    with db.connect() as conn:
        rows = db.fetchall(conn, "SELECT email, locale, source FROM newsletter_subscribers")

    assert rows == [{"email": "maker@example.com", "locale": "en", "source": "website-home"}]


def test_newsletter_signup_is_idempotent_on_email():
    web_store.record_newsletter_signup("maker@example.com", "en", "website-home")
    # Same address, different case + source -> normalized collision -> no duplicate row.
    web_store.record_newsletter_signup("MAKER@example.com", "zh", "newsletter-footer")

    with db.connect() as conn:
        count = db.fetchone(conn, "SELECT COUNT(*) AS n FROM newsletter_subscribers WHERE email=?", ("maker@example.com",))

    assert count["n"] == 1


def test_web_event_persists_with_payload():
    web_store.record_web_event("buy_link_clicked", {"vendor": "Adafruit", "idea": "blink led"}, "en", "website-home")

    with db.connect() as conn:
        row = db.fetchone(conn, "SELECT event_type, payload_json, locale, source FROM web_events")

    assert row["event_type"] == "buy_link_clicked"
    assert row["payload_json"] == {"vendor": "Adafruit", "idea": "blink led"}
    assert row["locale"] == "en"
    assert row["source"] == "website-home"
