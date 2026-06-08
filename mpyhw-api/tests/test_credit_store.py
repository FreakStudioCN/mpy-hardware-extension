from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier

from app import credit_store

USER = {"id": "42", "login": "octocat", "email": None}


def test_record_tokens_charges_cumulatively_not_per_call():
    # 20 small calls of 2000 tokens accumulate to 40000 = 4 credits total, instead of
    # 20 (one per call) under the old ceil-per-call model that burned a day's grant.
    credit_store.ensure_daily_grant(USER, 50)

    charged = sum(credit_store.record_tokens(USER, 2_000) for _ in range(20))

    assert charged == 4


def test_record_tokens_charges_only_on_threshold_crossing():
    credit_store.ensure_daily_grant(USER, 50)

    assert credit_store.record_tokens(USER, 9_000) == 0   # 0 -> 9000: no full credit yet
    assert credit_store.record_tokens(USER, 2_000) == 1   # 9000 -> 11000: crosses 10k
    assert credit_store.record_tokens(USER, 500) == 0     # 11000 -> 11500: no new crossing


def test_record_tokens_preserves_concurrent_small_usage(monkeypatch):
    # Concurrent small turns must add to the same daily tally before deciding
    # whether a whole credit boundary was crossed.
    credit_store.ensure_daily_grant(USER, 50)
    original_fetchone = credit_store.db.fetchone
    unlocked_read_barrier = Barrier(4)

    def slow_token_tally_read(conn, sql, params=()):
        row = original_fetchone(conn, sql, params)
        if "FROM token_tallies" in sql and "last_tally_date" in sql and "FOR UPDATE" not in sql:
            unlocked_read_barrier.wait(timeout=5)
        return row

    monkeypatch.setattr(credit_store.db, "fetchone", slow_token_tally_read)

    with ThreadPoolExecutor(max_workers=20) as pool:
        charged = list(pool.map(lambda _: credit_store.record_tokens(USER, 500), range(40)))

    assert sum(charged) == 2
    with credit_store.db.connect() as conn:
        row = credit_store.db.fetchone(conn, "SELECT total_tokens FROM token_tallies WHERE user_id=?", (USER["id"],))
    assert row["total_tokens"] == 20_000


def test_record_tokens_resets_on_new_utc_day():
    day1 = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
    day2 = datetime(2026, 6, 2, 0, 30, tzinfo=timezone.utc)

    credit_store.ensure_daily_grant(USER, 50, now=day1)
    credit_store.record_tokens(USER, 9_000)
    # A new UTC day zeroes the tally, so the next 2k starts from 0 (no immediate crossing).
    credit_store.ensure_daily_grant(USER, 50, now=day2)
    assert credit_store.record_tokens(USER, 2_000) == 0


def test_first_grant_creates_user_with_full_balance():
    state = credit_store.ensure_daily_grant(USER, 50)

    assert state["balance"] == 50
    assert state["daily_grant"] == 50
    assert state["login"] == "octocat"
    assert state["resets_at"]


def test_first_grant_creates_user_balance_and_ledger_row():
    credit_store.ensure_daily_grant(USER, 50)

    user_row = credit_store.get_user(USER["id"])
    assert user_row["login"] == "octocat"

    ledger = credit_store.ledger_for_user(USER["id"])
    assert ledger == [{"action": "grant", "credits": 50, "balance_after": 50, "status": "posted"}]


def test_debit_subtracts_and_persists():
    credit_store.ensure_daily_grant(USER, 50)

    assert credit_store.debit(USER, 6) == 44
    # Balance persists across reads (durable store, not in-memory).
    assert credit_store.ensure_daily_grant(USER, 50)["balance"] == 44


def test_debit_floors_at_zero():
    credit_store.ensure_daily_grant(USER, 5)

    assert credit_store.debit(USER, 9) == 0


def test_reserve_debits_atomically_and_rejects_when_insufficient():
    credit_store.ensure_daily_grant(USER, 1)

    assert credit_store.reserve(USER, 1) == 0
    assert credit_store.reserve(USER, 1) is None
    assert credit_store.ensure_daily_grant(USER, 50)["balance"] == 0


def test_reserve_caps_concurrent_holds_at_balance():
    # The concurrency bypass: with the old read-then-check pre-flight, N parallel
    # paid requests on a balance of K all passed (K could be 1). The atomic reserve
    # must let at most `balance` holds succeed — proving each in-flight paid turn
    # really costs a credit up front, so balance=K caps concurrency at K.
    credit_store.ensure_daily_grant(USER, 3)

    successes = [credit_store.reserve(USER, 1) for _ in range(5)]

    assert successes == [2, 1, 0, None, None]


def test_refund_returns_a_reserved_credit():
    credit_store.ensure_daily_grant(USER, 5)
    credit_store.reserve(USER, 1)

    assert credit_store.refund(USER, 1) == 5


def test_reserve_debit_and_refund_record_ledger_rows():
    credit_store.ensure_daily_grant(USER, 5)

    credit_store.reserve(USER, 1)
    credit_store.debit(USER, 2)
    credit_store.refund(USER, 1)

    assert credit_store.ledger_for_user(USER["id"]) == [
        {"action": "grant", "credits": 5, "balance_after": 5, "status": "posted"},
        {"action": "reserve", "credits": -1, "balance_after": 4, "status": "reserved"},
        {"action": "debit", "credits": -2, "balance_after": 2, "status": "posted"},
        {"action": "refund", "credits": 1, "balance_after": 3, "status": "posted"},
    ]


def test_daily_reset_refills_on_new_utc_day():
    day1 = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
    day2 = datetime(2026, 6, 2, 0, 30, tzinfo=timezone.utc)

    credit_store.ensure_daily_grant(USER, 50, now=day1)
    credit_store.debit(USER, 40)
    assert credit_store.ensure_daily_grant(USER, 50, now=day1)["balance"] == 10

    # Same UTC day later does not refill; a new day resets to the grant.
    assert credit_store.ensure_daily_grant(USER, 50, now=day2)["balance"] == 50


def test_concurrent_first_grant_creates_exactly_one_row_no_error():
    # Session start fires several authenticated calls at once (the agent turn, the nested
    # generate_code turn, and the webview's /v1/credits poll), all hitting a brand-new
    # user with no credit row yet. The atomic create must let exactly one grant land: no
    # PK-conflict 500, no duplicate grants, and never a missing-row read (which the meter
    # would stream to the UI as a spurious remaining: 0 -> false "running low").
    new_user = {"id": "777", "login": "newcomer", "email": None}

    with ThreadPoolExecutor(max_workers=8) as pool:
        # list() re-raises the first worker exception, so this also asserts no thread 500s.
        results = list(pool.map(lambda _: credit_store.ensure_daily_grant(new_user, 50), range(8)))

    assert all(r["balance"] == 50 for r in results)
    grants = [e for e in credit_store.ledger_for_user("777") if e["action"] == "grant"]
    assert grants == [{"action": "grant", "credits": 50, "balance_after": 50, "status": "posted"}]
