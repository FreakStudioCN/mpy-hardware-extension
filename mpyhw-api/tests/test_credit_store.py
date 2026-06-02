from datetime import datetime, timezone

from app import credit_store

USER = {"id": "42", "login": "octocat", "email": None}


def test_credits_for_tokens_rounds_up():
    assert credit_store.credits_for_tokens(0) == 0
    assert credit_store.credits_for_tokens(1) == 1
    assert credit_store.credits_for_tokens(10_000) == 1
    assert credit_store.credits_for_tokens(10_001) == 2
    assert credit_store.credits_for_tokens(55_000) == 6


def test_first_grant_creates_user_with_full_balance():
    state = credit_store.ensure_daily_grant(USER, 50)

    assert state["balance"] == 50
    assert state["daily_grant"] == 50
    assert state["login"] == "octocat"
    assert state["resets_at"]


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


def test_daily_reset_refills_on_new_utc_day():
    day1 = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
    day2 = datetime(2026, 6, 2, 0, 30, tzinfo=timezone.utc)

    credit_store.ensure_daily_grant(USER, 50, now=day1)
    credit_store.debit(USER, 40)
    assert credit_store.ensure_daily_grant(USER, 50, now=day1)["balance"] == 10

    # Same UTC day later does not refill; a new day resets to the grant.
    assert credit_store.ensure_daily_grant(USER, 50, now=day2)["balance"] == 50
