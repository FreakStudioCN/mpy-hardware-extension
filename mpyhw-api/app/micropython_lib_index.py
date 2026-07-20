"""Official micropython-lib package index (the mip v2 index), for the package browser.

Searchable catalog of the official runtime packages. Fetched from micropython.org and
cached in-process; micropython-lib installs by name (`mpremote mip install <name>`), so
there is no per-package metadata fetch like uPyPI needs. Outbound HTTP uses stdlib urllib
to match the rest of the backend.
"""
import json
import logging
import time
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

INDEX_URL = "https://micropython.org/pi/v2/index.json"
_CACHE_TTL_SECONDS = 6 * 60 * 60
_TIMEOUT_SECONDS = 10

# ponytail: in-process cache. Refetches once per TTL (or on restart) -- fine for a ~128
# package index. Serves the stale copy if a later refetch fails.
_cache: dict = {"packages": None, "fetched_at": 0.0}


class MicropythonLibUnavailable(Exception):
    """The official index could not be reached and no cached copy is available."""


def _fetch_index() -> dict:
    request = urllib.request.Request(INDEX_URL, headers={"user-agent": "mpyhw-api", "accept": "application/json"})
    with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def _packages() -> list[dict]:
    now = time.time()
    if _cache["packages"] is not None and (now - _cache["fetched_at"]) < _CACHE_TTL_SECONDS:
        return _cache["packages"]
    try:
        data = _fetch_index()
    except (urllib.error.URLError, ValueError) as error:
        logger.warning("micropython-lib index fetch failed: %s", error)
        if _cache["packages"] is not None:
            return _cache["packages"]  # serve stale on failure
        raise MicropythonLibUnavailable(str(error)) from error
    packages = data.get("packages", []) if isinstance(data, dict) else []
    _cache["packages"] = packages
    _cache["fetched_at"] = now
    return packages


def _normalize(pkg: dict) -> dict:
    name = str(pkg.get("name", ""))
    path = str(pkg.get("path", ""))
    return {
        "name": name,
        "version": pkg.get("version", ""),
        "source": "micropython_lib",
        "description": pkg.get("description", ""),
        "author": pkg.get("author", ""),
        "license": pkg.get("license", ""),
        "chips": "all",
        "fw": "all",
        "deps": [],
        "package_json_url": "",
        "repo_url": f"https://github.com/micropython/micropython-lib/tree/master/{path}" if path else "",
        "install_cmd": f"mpremote mip install {name}",
        "support_level": "installable",
        "cached": True,
    }


def search(query: str, limit: int = 20) -> list[dict]:
    terms = [term for term in (query or "").lower().split() if term]
    hits = []
    for pkg in _packages():
        name = str(pkg.get("name", ""))
        if not name:
            continue
        haystack = f"{name} {pkg.get('description', '')}".lower()
        if terms and not all(term in haystack for term in terms):
            continue
        hits.append(_normalize(pkg))
    # Name-prefix matches first (a query for "aio" surfaces "aioble" ahead of a description
    # hit), then alphabetical -- deterministic.
    prefix = (query or "").strip().lower()
    hits.sort(key=lambda hit: (not hit["name"].lower().startswith(prefix), hit["name"]))
    return hits[:limit]
