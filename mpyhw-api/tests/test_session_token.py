import pytest

from app import session_token


def test_encode_decode_roundtrip():
    token = session_token.encode({"sub": "42", "login": "octocat"}, "secret", 3600, now=1000)
    payload = session_token.decode(token, "secret", now=1000)

    assert payload["sub"] == "42"
    assert payload["login"] == "octocat"
    assert payload["iat"] == 1000
    assert payload["exp"] == 4600


def test_decode_rejects_wrong_secret():
    token = session_token.encode({"sub": "42"}, "secret", 3600, now=1000)

    with pytest.raises(session_token.TokenError):
        session_token.decode(token, "other-secret", now=1000)


def test_decode_rejects_expired_token():
    token = session_token.encode({"sub": "42"}, "secret", 3600, now=1000)

    with pytest.raises(session_token.TokenError):
        session_token.decode(token, "secret", now=5000)


def test_decode_rejects_malformed_token():
    with pytest.raises(session_token.TokenError):
        session_token.decode("not-a-jwt", "secret", now=1000)
