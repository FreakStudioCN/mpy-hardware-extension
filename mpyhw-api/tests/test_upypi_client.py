import pytest
from fastapi.testclient import TestClient

from app import upypi_client
from app.main import app


client = TestClient(app)


SEARCH_RESPONSE = {
    "query": "bmp280",
    "results": [
        {"name": "bmp280", "url": "https://upypi.net/pkgs/bmp280/1.0.0"},
        {"name": "bmp280_driver", "url": "https://upypi.net/pkgs/bmp280_driver/1.0.0"},
        {"name": "no_url"},  # incomplete: must be dropped
    ],
}

PACKAGE_JSON = {
    "name": "bmp280",
    "version": "1.0.0",
    "description": "BMP280 temperature and pressure sensor driver for MicroPython",
    "author": "leezisheng",
    "license": "MIT",
    "chips": "all",
    "fw": "all",
    "deps": [["https://upypi.net/pkgs/ws61_driver/1.0.0", "latest"]],
    "urls": [["bmp280.py", "code/bmp280.py"]],
}


def test_search_parses_results_and_drops_incomplete(monkeypatch):
    monkeypatch.setattr(upypi_client, "_fetch_json", lambda url: SEARCH_RESPONSE)
    results = upypi_client.search("bmp280")
    assert results == [
        {"name": "bmp280", "url": "https://upypi.net/pkgs/bmp280/1.0.0"},
        {"name": "bmp280_driver", "url": "https://upypi.net/pkgs/bmp280_driver/1.0.0"},
    ]


def test_search_empty_query_does_not_fetch(monkeypatch):
    def _boom(url):
        raise AssertionError("must not fetch on empty query")

    monkeypatch.setattr(upypi_client, "_fetch_json", _boom)
    assert upypi_client.search("   ") == []


def test_resolve_normalizes_package_json(monkeypatch):
    monkeypatch.setattr(upypi_client, "_fetch_json", lambda url: PACKAGE_JSON)
    record = upypi_client.resolve("https://upypi.net/pkgs/bmp280/1.0.0")
    assert record["source"] == "upypi"
    assert record["name"] == "bmp280" and record["version"] == "1.0.0"
    assert record["author"] == "leezisheng" and record["license"] == "MIT"
    assert record["urls"] == [["bmp280.py", "code/bmp280.py"]]
    assert record["package_json_url"] == "https://upypi.net/pkgs/bmp280/1.0.0/package.json"
    assert record["install_cmd"] == "mpremote mip install https://upypi.net/pkgs/bmp280/1.0.0/package.json"
    assert "temperature_sensing" in record["capabilities"]
    assert record["cached"] is False


def test_resolve_rejects_non_upypi_url(monkeypatch):
    # SSRF guard: a caller-supplied url must be on upypi.net over https.
    monkeypatch.setattr(upypi_client, "_fetch_json", lambda url: PACKAGE_JSON)
    for bad in ("https://evil.example/pkgs/x/1.0", "http://upypi.net/pkgs/x/1.0", "file:///etc/passwd"):
        with pytest.raises(upypi_client.UpypiUnavailable):
            upypi_client.resolve(bad)


def test_fetch_failure_raises_unavailable(monkeypatch):
    import urllib.error

    def _raise(*args, **kwargs):
        raise urllib.error.URLError("boom")

    monkeypatch.setattr(upypi_client.urllib.request, "urlopen", _raise)
    with pytest.raises(upypi_client.UpypiUnavailable):
        upypi_client._fetch_json("https://upypi.net/api/search?q=x")


def test_route_upypi_search_returns_results(monkeypatch):
    monkeypatch.setattr(upypi_client, "search", lambda q: [{"name": "bmp280", "url": "https://upypi.net/pkgs/bmp280/1.0.0"}])
    response = client.get("/v1/packages/upypi/search", params={"q": "bmp280"})
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "upypi"
    assert body["results"][0]["name"] == "bmp280"


def test_route_upypi_search_degrades_to_502(monkeypatch):
    def _unavailable(q):
        raise upypi_client.UpypiUnavailable("down")

    monkeypatch.setattr(upypi_client, "search", _unavailable)
    response = client.get("/v1/packages/upypi/search", params={"q": "bmp280"})
    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "upstream_unavailable"


def test_route_upypi_resolve_returns_normalized(monkeypatch):
    monkeypatch.setattr(upypi_client, "resolve", lambda url: {"name": "bmp280", "source": "upypi"})
    response = client.get("/v1/packages/upypi/resolve", params={"url": "https://upypi.net/pkgs/bmp280/1.0.0"})
    assert response.status_code == 200
    assert response.json()["source"] == "upypi"


def test_upypi_search_route_not_shadowed_by_name_version(monkeypatch):
    # /v1/packages/upypi/search must hit the upypi route, not /{name}/{version} (which
    # would 404 package_not_found for name="upypi", version="search").
    monkeypatch.setattr(upypi_client, "search", lambda q: [])
    response = client.get("/v1/packages/upypi/search", params={"q": "x"})
    assert response.status_code == 200
    assert response.json()["source"] == "upypi"
