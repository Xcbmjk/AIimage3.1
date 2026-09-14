from __future__ import annotations

import hashlib
import hmac
import secrets


def generate_access_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def token_matches(value: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_token(value), expected_hash)
