"""Live uPyPI (https://upypi.net) search + package metadata, for the package browser.

Search returns only name+url; rich metadata (description/author/license/chips/fw/deps/
urls) comes from a second call to each package's package.json. Outbound HTTP uses stdlib
urllib to match the rest of the backend (app/auth.py). A failure raises UpypiUnavailable
so the route can degrade to a 502 rather than 500 -- these are live external calls and
must never be assumed reachable.
"""
import json
import logging
import urllib.error
import urllib.parse
import urllib.request

from app.package_store import infer_capabilities

logger = logging.getLogger(__name__)

UPYPI_HOST = "upypi.net"
SEARCH_URL = f"https://{UPYPI_HOST}/api/search"
_TIMEOUT_SECONDS = 10


class UpypiUnavailable(Exception):
    """uPyPI could not be reached or returned an unusable response."""


def _fetch_json(url: str):
    request = urllib.request.Request(url, headers={"user-agent": "mpyhw-api", "accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError) as error:
        logger.warning("upypi fetch failed url=%s err=%s", url, error)
        raise UpypiUnavailable(str(error)) from error


def _is_upypi_url(url: str) -> bool:
    """Only fetch package.json from uPyPI itself -- resolve() takes a caller-supplied url,
    so restrict the host to prevent it being used as an SSRF proxy."""
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    return parsed.scheme == "https" and parsed.netloc == UPYPI_HOST


def search(query: str) -> list[dict]:
    normalized = (query or "").strip()
    if not normalized:
        return []
    url = f"{SEARCH_URL}?{urllib.parse.urlencode({'q': normalized})}"
    data = _fetch_json(url)
    results = data.get("results", []) if isinstance(data, dict) else []
    return [
        {"name": hit["name"], "url": hit["url"]}
        for hit in results
        if isinstance(hit, dict) and hit.get("name") and hit.get("url")
    ]


def resolve(package_url: str) -> dict:
    if not _is_upypi_url(package_url):
        raise UpypiUnavailable("not a upypi url")
    data = _fetch_json(f"{package_url.rstrip('/')}/package.json")
    if not isinstance(data, dict) or not data.get("name"):
        raise UpypiUnavailable("bad package.json")
    return _normalize(data, package_url)


def _normalize(data: dict, package_url: str) -> dict:
    package_json_url = f"{package_url.rstrip('/')}/package.json"
    return {
        "name": data.get("name", ""),
        "version": data.get("version", ""),
        "source": "upypi",
        "description": data.get("description", ""),
        "author": data.get("author", ""),
        "license": data.get("license", ""),
        "chips": data.get("chips", "all"),
        "fw": data.get("fw", "all"),
        "deps": data.get("deps", []),
        "urls": data.get("urls", []),
        "package_json_url": package_json_url,
        "capabilities": infer_capabilities(data),
        "support_level": "installable",
        # uPyPI package.json is mip-compatible, so it installs by URL.
        "install_cmd": f"mpremote mip install {package_json_url}",
        "cached": False,
    }
