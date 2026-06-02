"""Minimal HS256 JWT (stdlib only).

The project deliberately avoids third-party HTTP/crypto deps (routes_llm uses
urllib), so the session token is a tiny self-contained HS256 implementation
rather than PyJWT. Enough to sign {sub, login, email, iat, exp} and verify it.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any


class TokenError(Exception):
    """Raised when a token is malformed, mis-signed, or expired."""


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def encode(payload: dict[str, Any], secret: str, ttl_seconds: int, now: int | None = None) -> str:
    issued = int(time.time()) if now is None else now
    body = {**payload, "iat": issued, "exp": issued + ttl_seconds}
    header = {"alg": "HS256", "typ": "JWT"}
    segments = [
        _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8")),
        _b64url_encode(json.dumps(body, separators=(",", ":")).encode("utf-8")),
    ]
    signing_input = ".".join(segments).encode("ascii")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    segments.append(_b64url_encode(signature))
    return ".".join(segments)


def decode(token: str, secret: str, now: int | None = None) -> dict[str, Any]:
    checked_at = int(time.time()) if now is None else now
    try:
        header_b64, payload_b64, signature_b64 = token.split(".")
    except ValueError as error:
        raise TokenError("malformed") from error
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    try:
        given = _b64url_decode(signature_b64)
    except Exception as error:  # noqa: BLE001 - any decode failure is a bad token
        raise TokenError("malformed") from error
    if not hmac.compare_digest(expected, given):
        raise TokenError("bad_signature")
    payload = json.loads(_b64url_decode(payload_b64))
    if int(payload.get("exp", 0)) < checked_at:
        raise TokenError("expired")
    return payload
