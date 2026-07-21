"""Shared outbound-HTTP helper for the package-source clients (uPyPI, micropython-lib).

Blocks cross-host redirects: a caller-supplied or upstream URL must not be redirected to a
different host (SSRF defense). A blocked redirect surfaces as an HTTPError (an OSError), so
callers degrade through their normal error path.
"""
import urllib.parse
import urllib.request


class _SameHostRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old = urllib.parse.urlparse(req.full_url)
        new = urllib.parse.urlparse(newurl)
        # Refuse a cross-host redirect (SSRF) AND a scheme downgrade: https -> http on the same
        # host silently drops TLS on the metadata that decides what gets installed.
        if new.netloc != old.netloc or new.scheme != old.scheme:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SameHostRedirectHandler)


def urlopen_same_host(request: urllib.request.Request, timeout: float):
    """Open a request, refusing to follow redirects to a different host."""
    return _opener.open(request, timeout=timeout)
