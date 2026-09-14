from __future__ import annotations

from urllib.parse import urljoin, urlsplit, urlunsplit


def endpoint_url(base_url: str, endpoint: str) -> str:
    """Resolve an API endpoint without allowing it to replace the base host."""
    return urljoin(base_url.rstrip("/") + "/", endpoint.lstrip("/"))


def redact_url(value: str) -> str:
    """Return a log-safe URL without query strings, fragments, or credentials."""
    try:
        parsed = urlsplit(value)
        if not parsed.scheme or not parsed.netloc:
            return "[invalid-url]"
        host = parsed.hostname or ""
        if parsed.port is not None:
            host = f"{host}:{parsed.port}"
        return urlunsplit((parsed.scheme, host, parsed.path, "", ""))
    except ValueError:
        return "[invalid-url]"
