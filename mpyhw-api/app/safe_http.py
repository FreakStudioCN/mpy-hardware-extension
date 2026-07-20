"""Shared outbound-HTTP helper for the package-source clients (uPyPI, micropython-lib).

Blocks cross-host redirects: a caller-supplied or upstream URL must not be redirected to a
different host (SSRF defense). A blocked redirect surfaces as an HTTPError (an OSError), so
callers degrade through their normal error path.
"""
import urllib.parse
import urllib.request


class _SameHostRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlparse(newurl).netloc != urllib.parse.urlparse(req.full_url).netloc:
            return None  # do not follow a cross-host redirect
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SameHostRedirectHandler)


def urlopen_same_host(request: urllib.request.Request, timeout: float):
    """Open a request, refusing to follow redirects to a different host."""
    return _opener.open(request, timeout=timeout)
