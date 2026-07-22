import pytest
from fastapi.testclient import TestClient

from app import micropython_lib_index as mli
from app.main import app


client = TestClient(app)


INDEX = {
    "packages": [
        {"name": "aioble", "version": "0.6.0", "author": "", "description": "BLE library", "license": "MIT", "path": "micropython/bluetooth/aioble"},
        {"name": "async_aio", "version": "1.0.0", "author": "", "description": "helpers", "license": "MIT", "path": "python-stdlib/async_aio"},
        {"name": "abc", "version": "0.1.0", "author": "", "description": "", "license": "MIT", "path": "python-stdlib/abc"},
    ],
}


@pytest.fixture(autouse=True)
def _reset_cache(monkeypatch):
    monkeypatch.setattr(mli, "_cache", {"packages": None, "fetched_at": 0.0, "failed_at": 0.0})


def test_search_filters_and_normalizes(monkeypatch):
    monkeypatch.setattr(mli, "_fetch_index", lambda: INDEX)
    hits = mli.search("aioble")
    assert len(hits) == 1
    hit = hits[0]
    assert hit["name"] == "aioble" and hit["package_name"] == "aioble" and hit["source"] == "micropython_lib"
    assert hit["install_cmd"] == "mpremote mip install aioble"
    assert hit["repo_url"] == "https://github.com/micropython/micropython-lib/tree/master/micropython/bluetooth/aioble"
    assert hit["version"] == "0.6.0" and hit["license"] == "MIT"


def test_search_ranks_name_prefix_first(monkeypatch):
    monkeypatch.setattr(mli, "_fetch_index", lambda: INDEX)
    names = [hit["name"] for hit in mli.search("aio")]
    # Both names contain "aio"; the prefix match (aioble) must rank ahead of async_aio.
    assert names == ["aioble", "async_aio"]


def test_search_empty_query_returns_catalog(monkeypatch):
    monkeypatch.setattr(mli, "_fetch_index", lambda: INDEX)
    assert {hit["name"] for hit in mli.search("")} == {"aioble", "async_aio", "abc"}


def test_unavailable_when_fetch_fails_and_no_cache(monkeypatch):
    import urllib.error

    def _fail():
        raise urllib.error.URLError("down")

    monkeypatch.setattr(mli, "_fetch_index", _fail)
    with pytest.raises(mli.MicropythonLibUnavailable):
        mli.search("aioble")


def test_serves_stale_cache_on_fetch_failure(monkeypatch):
    import urllib.error

    monkeypatch.setattr(mli, "_cache", {"packages": INDEX["packages"], "fetched_at": 0.0, "failed_at": 0.0})  # stale

    def _fail():
        raise urllib.error.URLError("down")

    monkeypatch.setattr(mli, "_fetch_index", _fail)
    assert [hit["name"] for hit in mli.search("aioble")] == ["aioble"]


def test_malformed_body_is_not_cached_as_empty_success(monkeypatch):
    # A wrong-shaped body (non-dict, or `packages` not a list) is an upstream error, NOT a valid
    # empty catalog that gets served for the whole 6h TTL. With no cache -> raise, not empty 200.
    monkeypatch.setattr(mli, "_fetch_index", lambda: {"packages": None})
    with pytest.raises(mli.MicropythonLibUnavailable):
        mli.search("aioble")
    assert mli._cache["packages"] is None  # must NOT have cached the bad body

    monkeypatch.setattr(mli, "_fetch_index", lambda: ["not", "a", "dict"])
    with pytest.raises(mli.MicropythonLibUnavailable):
        mli.search("aioble")
    assert mli._cache["packages"] is None


def test_unusable_entries_are_dropped_before_caching(monkeypatch):
    # Element-level twin of the body-shape guard: {"packages": [null, ...]} is valid JSON with a
    # list, so it passed the shape check and the null was CACHED -- then every search crashed with
    # AttributeError (persistent 500s) for the whole 6h TTL. "Usable" requires a non-empty str
    # name: a nameless {} would cache as a silently empty catalog, and a null name would str()
    # into the literal "None". All are dropped pre-cache.
    bad = [None, "nope", {}, {"name": None}, {"name": "  "}, {"path": "micropython/x"}]
    monkeypatch.setattr(mli, "_fetch_index", lambda: {"packages": [*bad, INDEX["packages"][0]]})
    assert [hit["name"] for hit in mli.search("aioble")] == ["aioble"]
    assert mli._cache["packages"] == [INDEX["packages"][0]]  # only the usable entry was cached


def test_all_entries_malformed_is_an_upstream_error_not_an_empty_catalog(monkeypatch):
    # A NON-empty packages list with no usable entry is a malformed body: raise (or serve stale),
    # never cache it as a valid empty catalog and serve that for the TTL. [{}] is the sneaky one:
    # dict-shaped, so an is-dict filter alone would cache it and serve empty results for 6h.
    for entries in ([None], [{}], [{"name": None}]):
        monkeypatch.setattr(mli, "_cache", {"packages": None, "fetched_at": 0.0, "failed_at": 0.0})
        monkeypatch.setattr(mli, "_fetch_index", lambda _e=entries: {"packages": _e})
        with pytest.raises(mli.MicropythonLibUnavailable):
            mli.search("aioble")
        assert mli._cache["packages"] is None


def test_backs_off_after_failure_instead_of_refetching_every_request(monkeypatch):
    # A stale-cache + down-upstream must NOT re-hit the 10s urlopen on every request (which
    # pins an anyio worker each time). After one failed fetch, serve stale within the backoff.
    monkeypatch.setattr(mli, "_cache", {"packages": INDEX["packages"], "fetched_at": 0.0, "failed_at": 0.0})  # stale
    import urllib.error
    calls = {"n": 0}

    def _fail():
        calls["n"] += 1
        raise urllib.error.URLError("down")

    monkeypatch.setattr(mli, "_fetch_index", _fail)
    assert [h["name"] for h in mli.search("aioble")] == ["aioble"]  # 1st: fetches, fails, serves stale
    assert [h["name"] for h in mli.search("aioble")] == ["aioble"]  # 2nd: backoff -> serves stale, no fetch
    assert calls["n"] == 1


def test_cold_start_during_outage_backs_off_without_a_cache(monkeypatch):
    # Empty cache + down upstream: the first request fetches & fails, the second must back off
    # (raise) rather than burn another 10s urlopen -- so an outage-on-restart isn't a per-request DoS.
    import urllib.error
    calls = {"n": 0}

    def _fail():
        calls["n"] += 1
        raise urllib.error.URLError("down")

    monkeypatch.setattr(mli, "_fetch_index", _fail)
    with pytest.raises(mli.MicropythonLibUnavailable):
        mli.search("aioble")
    with pytest.raises(mli.MicropythonLibUnavailable):
        mli.search("aioble")
    assert calls["n"] == 1  # the second request backed off instead of refetching


def test_route_returns_results(monkeypatch):
    monkeypatch.setattr(mli, "search", lambda q: [{"name": "aioble", "source": "micropython_lib"}])
    response = client.get("/v1/packages/micropython-lib/search", params={"q": "aioble"})
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "micropython_lib"
    assert body["results"][0]["name"] == "aioble"


def test_route_degrades_to_502(monkeypatch):
    def _unavailable(q):
        raise mli.MicropythonLibUnavailable("down")

    monkeypatch.setattr(mli, "search", _unavailable)
    response = client.get("/v1/packages/micropython-lib/search", params={"q": "aioble"})
    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "upstream_unavailable"


def test_route_not_shadowed_by_name_version(monkeypatch):
    monkeypatch.setattr(mli, "search", lambda q: [])
    response = client.get("/v1/packages/micropython-lib/search", params={"q": "x"})
    assert response.status_code == 200
    assert response.json()["source"] == "micropython_lib"
