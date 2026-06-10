from fastapi.testclient import TestClient
from datetime import datetime, timedelta, timezone

from app import analytics, credit_store, db
from app.main import app


client = TestClient(app)


def test_telemetry_accepts_valid_event_batch():
    response = client.post("/v1/telemetry", json={"events": [event("tool_dispatch", {"tool": "search_packages"})]})

    assert response.status_code == 204
    rows = analytics.telemetry_events(trace_id="trace-1")
    assert rows == [{"event_type": "tool_dispatch", "payload": {"tool": "search_packages"}, "user_id": None}]


def test_telemetry_rejects_oversized_batch():
    # Backstop only: a batch over the raised 256KB cap is still refused.
    response = client.post("/v1/telemetry", json={"events": [event("tool_dispatch", {"blob": "x" * 300_000})]})

    assert response.status_code == 413
    assert response.json()["detail"]["error"] == "payload_too_large"


def test_telemetry_truncates_oversized_field_instead_of_dropping():
    # Under the 256KB batch cap but over the 48KB per-field budget: stored truncated,
    # flagged, never dropped — so a serial flood can't lose the event.
    response = client.post("/v1/telemetry", json={"events": [event("runtime_error", {"error": "y" * 60_000})]})

    assert response.status_code == 204
    payload = analytics.telemetry_events(trace_id="trace-1")[0]["payload"]
    assert len(payload["error"]) < 60_000
    assert payload["_truncated"] is True


def test_telemetry_field_guard_counts_utf8_bytes_not_chars():
    # 20k CJK chars = 60KB UTF-8 but only 20k code points: a char-based check would wave
    # it past the 48KB per-field budget. Guard on real byte size so CJK intent/serial
    # can't smuggle 3x the documented budget into storage.
    response = client.post("/v1/telemetry", json={"events": [event("runtime_error", {"error": "晶" * 20_000})]})

    assert response.status_code == 204
    payload = analytics.telemetry_events(trace_id="trace-1")[0]["payload"]
    assert len(payload["error"].encode("utf-8")) <= 48 * 1024
    assert len(payload["error"]) < 20_000
    assert payload["_truncated"] is True


def test_telemetry_batch_guard_counts_utf8_bytes_not_chars():
    # 100k CJK chars = ~300KB UTF-8 but ~100k code points: a char-based size check slips
    # past the 256KB backstop. Reject on real byte size.
    response = client.post("/v1/telemetry", json={"events": [event("runtime_error", {"error": "晶" * 100_000})]})

    assert response.status_code == 413
    assert response.json()["detail"]["error"] == "payload_too_large"


def test_telemetry_rejects_unknown_event_type():
    response = client.post("/v1/telemetry", json={"events": [event("unknown", {})]})

    assert response.status_code == 422


def test_telemetry_allows_64kb_batches():
    response = client.post("/v1/telemetry", json={"events": [event("code_generated", {"blob": "x" * 5000})]})

    assert response.status_code == 204


def test_telemetry_stores_raw_payload_fields():
    # Raw storage (no hashing/dropping): a trace must be replayable, so the actual
    # code, prompt, and serial survive verbatim.
    response = client.post(
        "/v1/telemetry",
        json={"events": [event("code_generated", {"code": "print('secret')", "prompt": "make a secret sensor", "serial_log": "secret data"})]},
    )

    assert response.status_code == 204
    payload = analytics.telemetry_events(trace_id="trace-1")[0]["payload"]
    assert payload["code"] == "print('secret')"
    assert payload["prompt"] == "make a secret sensor"
    assert payload["serial_log"] == "secret data"
    assert "code_sha256" not in payload
    assert "intent_hash" not in payload


def test_telemetry_ingests_diagnostic_events_queryable_by_trace():
    client.post("/v1/telemetry", json={"events": [
        event("tool_dispatch", {"tool": "write_main_py"}),
        event("runtime_error", {"error_kind": "runtime_error", "error": "ImportError: ssd1306", "lines": ["MPYHW_READY"]}),
        event("audit_failed", {"error_kind": "audit_failed", "disallowed_imports": ["socket"]}),
        event("serial_output", {"lines": ["MPYHW_READY", "TEMP_C=24.0"]}),
    ]})

    rows = analytics.telemetry_events(trace_id="trace-1")
    assert [r["event_type"] for r in rows] == ["tool_dispatch", "runtime_error", "audit_failed", "serial_output"]
    runtime = next(r for r in rows if r["event_type"] == "runtime_error")
    assert runtime["payload"]["error"] == "ImportError: ssd1306"


def test_admin_sessions_returns_full_trace(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    client.post("/v1/telemetry", json={"events": [
        event("session_started", {"board_id": "esp32-c3"}),
        event("runtime_error", {"error_kind": "runtime_error", "error": "boom"}),
        event("session_finished", {"terminal": "repair_exhausted"}),
    ]})

    response = client.get("/v1/admin/sessions/trace-1", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    body = response.json()
    assert body["session"]["terminal"] == "repair_exhausted"
    assert body["session"]["repair_count"] == 1  # the runtime_error event incremented it
    assert [e["event_type"] for e in body["events"]] == ["session_started", "runtime_error", "session_finished"]
    assert body["llm_turns"] == []


def test_admin_sessions_requires_token(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")

    response = client.get("/v1/admin/sessions/trace-1")

    assert response.status_code == 401
    assert response.json()["detail"]["error"] == "admin_unauthorized"


def test_admin_metrics_returns_operational_snapshot(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    client.post("/v1/telemetry", json={"events": [event("auth_completed", {}), event("session_started", {}), event("serial_marker_seen", {})]})

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    body = response.json()
    assert body["active_sse_count"] == 0
    assert body["daily_active_users"] >= 0
    assert "activation_funnel" in body


def test_admin_metrics_rejects_without_token(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")

    response = client.get("/v1/admin/metrics")

    assert response.status_code == 401
    assert response.json()["detail"]["error"] == "admin_unauthorized"


def test_admin_metrics_rejects_wrong_token(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "nope"})

    assert response.status_code == 401
    assert response.json()["detail"]["error"] == "admin_unauthorized"


def test_admin_metrics_disabled_when_secret_unset(monkeypatch):
    monkeypatch.delenv("MPYHW_ADMIN_TOKEN", raising=False)

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "anything"})

    assert response.status_code == 401
    assert response.json()["detail"]["error"] == "admin_disabled"


def test_admin_set_credits_tops_up_existing_user_idempotently(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    credit_store.ensure_daily_grant({"id": "555", "login": "Xinruili-Git", "email": None}, 50)

    # Case-insensitive login match; set-to-target lands exactly 500...
    r1 = client.post("/v1/admin/credits", json={"login": "xinruili-git", "balance": 500}, headers={"X-Admin-Token": "s3cret"})
    assert r1.status_code == 200
    assert r1.json()["balance"] == 500

    # ...and re-running is idempotent (still 500, not 950).
    r2 = client.post("/v1/admin/credits", json={"login": "xinruili-git", "balance": 500}, headers={"X-Admin-Token": "s3cret"})
    assert r2.json()["balance"] == 500
    assert credit_store.get_user("555")  # user row untouched


def test_admin_set_credits_404_for_unknown_login(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")

    response = client.post("/v1/admin/credits", json={"login": "nobody-here", "balance": 500}, headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "user_not_found"


def test_admin_set_credits_requires_token(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")

    response = client.post("/v1/admin/credits", json={"login": "xinruili-git", "balance": 500})

    assert response.status_code == 401
    assert response.json()["detail"]["error"] == "admin_unauthorized"


def test_telemetry_rejects_malformed_timestamp():
    response = client.post("/v1/telemetry", json={"events": [event("tool_dispatch", {}, timestamp="not-a-date")]})

    assert response.status_code == 422


def test_telemetry_accepts_iso8601_millis_z():
    # The real client sends new Date().toISOString() -> e.g. "2026-06-03T10:00:00.000Z".
    response = client.post("/v1/telemetry", json={"events": [event("tool_dispatch", {}, timestamp="2026-06-03T10:00:00.000Z")]})

    assert response.status_code == 204


def test_admin_metrics_survives_session_with_client_timestamps(monkeypatch):
    # A finished session with the client's millis-Z timestamps must not break the
    # ended_at::timestamptz - started_at::timestamptz cast in metrics_snapshot.
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    client.post(
        "/v1/telemetry",
        json={"events": [
            event("session_started", {}, timestamp="2026-06-03T10:00:00.000Z"),
            event("session_finished", {}, timestamp="2026-06-03T10:00:05.000Z"),
        ]},
    )

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    assert response.json()["session_duration_ms"]["p50"] == 5000


def test_admin_metrics_uses_session_finished_terminal_payload(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    client.post(
        "/v1/telemetry",
        json={"events": [
            event("session_started", {}, timestamp="2026-06-03T10:00:00.000Z"),
            event("session_finished", {"terminal": "generated"}, timestamp="2026-06-03T10:00:05.000Z"),
        ]},
    )

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    assert response.json()["session_terminal_distribution"] == {"generated": 1}


def test_admin_metrics_counts_daily_users_in_current_utc_day(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    now = datetime.now(timezone.utc)
    old = now - timedelta(days=2)
    with db.connect() as conn:
        db.execute(conn, "INSERT INTO users(id, gh_user_id, login, email, created_at, last_seen_at) VALUES(?,?,?,?,?,?)", ("old", "old", "old", None, old.isoformat(), old.isoformat()))
        db.execute(conn, "INSERT INTO users(id, gh_user_id, login, email, created_at, last_seen_at) VALUES(?,?,?,?,?,?)", ("new", "new", "new", None, now.isoformat(), now.isoformat()))
        db.execute(conn, "INSERT INTO users(id, gh_user_id, login, email, created_at, last_seen_at) VALUES(?,?,?,?,?,?)", ("returning", "returning", "returning", None, old.isoformat(), now.isoformat()))
        conn.commit()

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    body = response.json()
    assert body["daily_active_users"] == 2
    assert body["new_users_day"] == 1
    assert body["returning_users_day"] == 1


def test_admin_metrics_averages_credits_by_user_day(monkeypatch):
    monkeypatch.setenv("MPYHW_ADMIN_TOKEN", "s3cret")
    now = datetime.now(timezone.utc)
    with db.connect() as conn:
        for uid in ("a", "b"):
            db.execute(conn, "INSERT INTO users(id, gh_user_id, login, email, created_at, last_seen_at) VALUES(?,?,?,?,?,?)", (uid, uid, uid, None, now.isoformat(), now.isoformat()))
        db.execute(conn, "INSERT INTO credit_ledger(user_id, action, credits, balance_after, status, created_at) VALUES(?,?,?,?,?,?)", ("a", "debit", -1, 49, "posted", now.isoformat()))
        db.execute(conn, "INSERT INTO credit_ledger(user_id, action, credits, balance_after, status, created_at) VALUES(?,?,?,?,?,?)", ("a", "debit", -3, 46, "posted", now.isoformat()))
        db.execute(conn, "INSERT INTO credit_ledger(user_id, action, credits, balance_after, status, created_at) VALUES(?,?,?,?,?,?)", ("b", "debit", -2, 48, "posted", now.isoformat()))
        conn.commit()

    response = client.get("/v1/admin/metrics", headers={"X-Admin-Token": "s3cret"})

    assert response.status_code == 200
    assert response.json()["credits_per_user_day"] == 3


def event(event_type, payload, timestamp="2026-06-01T00:00:00Z"):
    return {"trace_id": "trace-1", "event_type": event_type, "timestamp": timestamp, "payload": payload}
