from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier

import pytest

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


def test_reserve_and_debit_accumulate_global_daily_spend():
    # The global free-tier budget breaker tracks every credit that leaves a balance:
    # reserve (1) + debit (3) == 4 against today's global tally.
    credit_store.ensure_daily_grant(USER, 50)

    credit_store.reserve(USER, 1)
    credit_store.debit(USER, 3)

    assert credit_store.global_spend_today() == 4


def test_reserve_alone_counts_toward_global_spend():
    # A turn that disconnects before metering never calls debit, yet the user still
    # lost the reserved credit and DeepSeek still billed the input. Counting at reserve
    # (not only at debit) keeps the breaker honest against disconnect-amplification.
    credit_store.ensure_daily_grant(USER, 50)

    credit_store.reserve(USER, 1)

    assert credit_store.global_spend_today() == 1


def test_refund_decrements_global_daily_spend():
    # A reserved-then-refunded turn (zero billable tokens / pre-stream upstream error)
    # nets zero against the global budget, mirroring the user's own balance.
    credit_store.ensure_daily_grant(USER, 50)

    credit_store.reserve(USER, 1)
    credit_store.refund(USER, 1)

    assert credit_store.global_spend_today() == 0


def test_global_spend_resets_across_utc_day_boundary():
    # No reset job: the tally is keyed by UTC date, so the day after spend reads zero.
    credit_store.ensure_daily_grant(USER, 50)
    credit_store.reserve(USER, 1)
    credit_store.debit(USER, 2)

    now = credit_store._now()
    assert credit_store.global_spend_today(now=now) == 3
    assert credit_store.global_spend_today(now=now + timedelta(days=1)) == 0


def test_global_spend_rolls_back_with_the_failed_balance_op(monkeypatch):
    # The counter increments in the SAME transaction as the balance change, so a
    # failure later in that transaction (here the ledger insert) rolls back the bump
    # too — the global tally never drifts above credits actually committed.
    credit_store.ensure_daily_grant(USER, 50)
    credit_store.reserve(USER, 1)
    assert credit_store.global_spend_today() == 1

    original_execute = credit_store.db.execute

    def fail_on_ledger_insert(conn, sql, params=()):
        if "INSERT INTO credit_ledger" in sql:
            raise RuntimeError("boom")
        return original_execute(conn, sql, params)

    monkeypatch.setattr(credit_store.db, "execute", fail_on_ledger_insert)
    with pytest.raises(RuntimeError):
        credit_store.debit(USER, 3)

    # global_spend_today only SELECTs, so it runs fine through the patched execute;
    # it must read 1 (the reserve), proving the failed debit's +3 bump rolled back.
    assert credit_store.global_spend_today() == 1


def test_user_spend_today_nets_debit_and_reserve_minus_refund_excludes_grant():
    # Sign semantics from credit_ledger: debit/reserve are negative, refund positive,
    # grant excluded entirely (a refill must never read as spend).
    credit_store.ensure_daily_grant(USER, 50)  # grant, excluded

    credit_store.reserve(USER, 5)  # -5
    credit_store.debit(USER, 3)    # -3
    credit_store.refund(USER, 4)   # +4

    assert credit_store.user_spend_today(USER) == 4  # 5 + 3 - 4


def test_user_spend_today_excludes_admin_set():
    # An admin topping up (or setting) the balance is not spend — the cap must bind
    # even after a top-up, so admin_set must never count toward it.
    credit_store.ensure_daily_grant(USER, 50)
    credit_store.set_balance(USER, 20)  # admin_set: credits = 20-50 = -30, excluded

    assert credit_store.user_spend_today(USER) == 0


def test_user_spend_today_floors_at_zero_when_refunds_exceed_spend():
    credit_store.ensure_daily_grant(USER, 50)
    credit_store.refund(USER, 10)  # +10 with no offsetting debit/reserve today

    assert credit_store.user_spend_today(USER) == 0


def test_user_spend_today_resets_across_utc_day_boundary():
    credit_store.ensure_daily_grant(USER, 50)
    credit_store.reserve(USER, 1)
    credit_store.debit(USER, 2)

    now = credit_store._now()
    assert credit_store.user_spend_today(USER, now=now) == 3
    assert credit_store.user_spend_today(USER, now=now + timedelta(days=1)) == 0


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


def test_unlimited_account_gets_unlimited_grant_by_login_or_email():
    # Comped accounts are hardcoded (not env): the grant must resolve for them by
    # GitHub login or email, case-insensitively, without any deploy configuration.
    unlimited = credit_store.UNLIMITED_DAILY_GRANT
    assert credit_store.grant_for({"id": "9", "login": "ersonp", "email": None}) == unlimited
    assert credit_store.grant_for({"id": "9", "login": "ErsonP", "email": None}) == unlimited
    assert credit_store.grant_for({"id": "9", "login": "other", "email": "ErsonPereiraCR7@gmail.com"}) == unlimited
    assert credit_store.grant_for({"id": "9", "login": "leezisheng", "email": None}) == unlimited
    assert credit_store.grant_for({"id": "1", "login": "octocat", "email": None}) == credit_store.DAILY_GRANT


def test_unlimited_account_spend_never_touches_global_budget():
    # An unlimited account must not be able to burn the free tier's daily global
    # budget: none of reserve/debit/refund may move the global tally. All three must
    # skip together — if reserve skipped but refund decremented, a reserve+refund
    # cycle would push the tally toward the floor and weaken the breaker.
    user = {"id": "88", "login": "ersonp", "email": None}
    credit_store.ensure_daily_grant(user, credit_store.grant_for(user))

    credit_store.reserve(user, 1)
    credit_store.debit(user, 3)
    credit_store.refund(user, 1)

    assert credit_store.global_spend_today() == 0
    # The user's own ledger/balance accounting stays real for audit.
    balance = credit_store.ensure_daily_grant(user, credit_store.grant_for(user))["balance"]
    assert balance == credit_store.UNLIMITED_DAILY_GRANT - 3


def test_grant_for_resolves_login_override_else_default(monkeypatch):
    # Per-user override is keyed by lowercased GitHub login; everyone else gets the global.
    # The fixture login must be a NON-comped one: grant_for checks is_unlimited() first and
    # returns UNLIMITED_DAILY_GRANT without ever consulting the override table, so a real login
    # here silently stops testing the override branch the moment that account gets comped.
    override_login = "grant-override-fixture"
    assert override_login not in credit_store.UNLIMITED_ACCOUNTS, "fixture login must not be a comped account"
    monkeypatch.setattr(credit_store, "_GRANT_OVERRIDES", {override_login: 500})
    assert credit_store.grant_for({"id": "9", "login": override_login}) == 500
    assert credit_store.grant_for({"id": "9", "login": "Grant-Override-Fixture"}) == 500  # case-insensitive
    assert credit_store.grant_for({"id": "1", "login": "octocat"}) == credit_store.DAILY_GRANT
    assert credit_store.grant_for({"id": "2", "login": None}) == credit_store.DAILY_GRANT


def test_comped_account_outranks_a_per_login_grant_override(monkeypatch):
    # The precedence that made the fixture above collide, pinned so it reads as a deliberate rule
    # rather than an accident: is_unlimited() is checked first, so a comped login gets
    # UNLIMITED_DAILY_GRANT even when a numeric override names that same login.
    # (is_unlimited matches login OR email against one set, so any member works as the login here.)
    comped = next(iter(credit_store.UNLIMITED_ACCOUNTS))
    monkeypatch.setattr(credit_store, "_GRANT_OVERRIDES", {comped.lower(): 500})
    assert credit_store.grant_for({"id": "9", "login": comped}) == credit_store.UNLIMITED_DAILY_GRANT


def test_parse_grant_overrides_lowercases_and_coerces_int():
    assert credit_store._parse_grant_overrides("") == {}
    assert credit_store._parse_grant_overrides('{"XinruiLi-Git": "500"}') == {"xinruili-git": 500}
