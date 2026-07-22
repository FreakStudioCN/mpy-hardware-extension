import urllib.request

from app import safe_http


def test_cross_host_redirect_is_blocked():
    # SSRF defense: a redirect to a different host must not be followed (returns None so
    # urllib surfaces the 3xx as an error instead of fetching the new host).
    handler = safe_http._SameHostRedirectHandler()
    request = urllib.request.Request("https://upypi.net/pkgs/x/1.0")
    assert handler.redirect_request(request, None, 302, "Found", {}, "https://evil.example/internal") is None


def test_same_host_redirect_is_allowed():
    handler = safe_http._SameHostRedirectHandler()
    request = urllib.request.Request("https://upypi.net/pkgs/x/1.0")
    result = handler.redirect_request(request, None, 302, "Found", {}, "https://upypi.net/pkgs/x/1.0/")
    assert result is not None and result.full_url == "https://upypi.net/pkgs/x/1.0/"


def test_scheme_downgrade_redirect_is_blocked():
    # https -> http on the SAME host silently drops TLS on the metadata that decides what gets
    # installed; refuse it even though the authority is unchanged.
    handler = safe_http._SameHostRedirectHandler()
    request = urllib.request.Request("https://upypi.net/pkgs/x/1.0")
    assert handler.redirect_request(request, None, 302, "Found", {}, "http://upypi.net/pkgs/x/1.0") is None
