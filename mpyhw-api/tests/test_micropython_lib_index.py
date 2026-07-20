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
    monkeypatch.setattr(mli, "_cache", {"packages": None, "fetched_at": 0.0})


def test_search_filters_and_normalizes(monkeypatch):
    monkeypatch.setattr(mli, "_fetch_index", lambda: INDEX)
    hits = mli.search("aioble")
    assert len(hits) == 1
    hit = hits[0]
    assert hit["name"] == "aioble" and hit["source"] == "micropython_lib"
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

    monkeypatch.setattr(mli, "_cache", {"packages": INDEX["packages"], "fetched_at": 0.0})  # stale

    def _fail():
        raise urllib.error.URLError("down")

    monkeypatch.setattr(mli, "_fetch_index", _fail)
    assert [hit["name"] for hit in mli.search("aioble")] == ["aioble"]


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
