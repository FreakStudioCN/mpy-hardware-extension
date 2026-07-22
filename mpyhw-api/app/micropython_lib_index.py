"""Official micropython-lib package index (the mip v2 index), for the package browser.

Searchable catalog of the official runtime packages. Fetched from micropython.org and
cached in-process; micropython-lib installs by name (`mpremote mip install <name>`), so
there is no per-package metadata fetch like uPyPI needs. Outbound HTTP uses stdlib urllib
to match the rest of the backend.
"""
import http.client
import json
import logging
import time
import urllib.request

from app import safe_http

logger = logging.getLogger(__name__)

INDEX_URL = "https://micropython.org/pi/v2/index.json"
_CACHE_TTL_SECONDS = 6 * 60 * 60
_TIMEOUT_SECONDS = 10
# After a failed refetch, keep serving the stale copy WITHOUT re-hitting upstream for this
# window. Without it, a stale-cache-with-down-upstream retries the 10s urlopen on EVERY request,
# and the sync route pins an anyio threadpool worker each time -> one outage degrades the whole API.
_FAILURE_BACKOFF_SECONDS = 60

# ponytail: in-process cache. Refetches once per TTL (or on restart) -- fine for a ~128
# package index. Serves the stale copy if a later refetch fails (with backoff).
_cache: dict = {"packages": None, "fetched_at": 0.0, "failed_at": 0.0}


class MicropythonLibUnavailable(Exception):
    """The official index could not be reached and no cached copy is available."""


def _fetch_index() -> dict:
    request = urllib.request.Request(INDEX_URL, headers={"user-agent": "mpyhw-api", "accept": "application/json"})
    with safe_http.urlopen_same_host(request, _TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def _packages() -> list[dict]:
    now = time.time()
    if _cache["packages"] is not None:
        fresh = (now - _cache["fetched_at"]) < _CACHE_TTL_SECONDS
        backing_off = (now - _cache["failed_at"]) < _FAILURE_BACKOFF_SECONDS
        if fresh or backing_off:  # fresh, or a stale copy inside the post-failure backoff window
            return _cache["packages"]
    elif (now - _cache["failed_at"]) < _FAILURE_BACKOFF_SECONDS:
        # Cold start during an outage (empty cache): back off too, or every request burns a 10s
        # urlopen + an anyio threadpool worker while upstream is down.
        raise MicropythonLibUnavailable("micropython-lib index unavailable (backing off)")
    try:
        data = _fetch_index()
    # OSError subsumes URLError + socket timeout; HTTPException covers a truncated body;
    # ValueError a malformed JSON body. Any of them serves stale (with backoff), or raises.
    except (OSError, ValueError, http.client.HTTPException) as error:
        logger.warning("micropython-lib index fetch failed: %s", error)
        return _serve_stale_or_raise(now, str(error))
    # A wrong-shaped body (non-dict, or `packages` not a list) is an UPSTREAM error, not a valid
    # empty catalog -- never cache it as an empty success and serve it for the whole 6h TTL.
    if not isinstance(data, dict) or not isinstance(data.get("packages"), list):
        logger.warning("micropython-lib index body malformed: %r", type(data))
        return _serve_stale_or_raise(now, "malformed index body")
    # Element-level guard (same class as the body-shape one): a non-dict entry (e.g.
    # {"packages": [null]}) cached as-is would crash every search with AttributeError for
    # the whole TTL -- persistent 500s instead of one 502. "Usable" requires a non-empty
    # string name, not just a dict: a nameless {} would otherwise cache as a silently
    # EMPTY catalog for the TTL, and a null name would str() into the literal "None".
    # Drop unusable entries before caching; a non-empty list with NO usable entry is a
    # malformed body, not an empty catalog (mirrors upypi_client.search's hit filter).
    packages = [pkg for pkg in data["packages"] if _usable(pkg)]
    if data["packages"] and not packages:
        logger.warning("micropython-lib index entries all malformed")
        return _serve_stale_or_raise(now, "malformed index entries")
    _cache["packages"] = packages
    _cache["fetched_at"] = now
    _cache["failed_at"] = 0.0  # a success clears the backoff window
    return packages


def _usable(pkg) -> bool:
    """An index entry the browser can actually serve: a dict with a non-empty str name
    (micropython-lib installs by name, so a nameless record is unusable by definition)."""
    return isinstance(pkg, dict) and isinstance(pkg.get("name"), str) and bool(pkg["name"].strip())


def _serve_stale_or_raise(now: float, reason: str) -> list[dict]:
    _cache["failed_at"] = now  # start/refresh the backoff window
    if _cache["packages"] is not None:
        return _cache["packages"]  # serve stale on failure
    raise MicropythonLibUnavailable(reason)


def _normalize(pkg: dict) -> dict:
    name = str(pkg.get("name", ""))
    path = str(pkg.get("path", ""))
    return {
        "name": name,
        # `package_name` mirrors `name` for the manifest contract (driver.package_name);
        # the browser UI reads `name`. Both point at the same value.
        "package_name": name,
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
