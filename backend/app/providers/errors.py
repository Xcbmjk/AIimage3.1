from __future__ import annotations

from dataclasses import dataclass

import httpx


@dataclass
class ProviderError(Exception):
    code: str
    message: str
    retryable: bool = False
    details: dict[str, object] | None = None


# Codes that mean "this vendor could not serve the request" rather than "this
# request is invalid". Only these justify trying a standby line: a rejected
# input would be rejected by every vendor identically. Authentication is
# included on purpose, because the standby row carries its own credentials.
LINE_FAILURE_CODES = frozenset(
    {
        "UPSTREAM_AUTH",
        "UPSTREAM_RATE_LIMIT",
        "UPSTREAM_TIMEOUT",
        "UPSTREAM_TRANSIENT",
        "GENERATION_FAILED",
        "CONFIG_ERROR",
    }
)


def is_line_failure(error: ProviderError) -> bool:
    return error.code in LINE_FAILURE_CODES


def parse_retry_after(response: httpx.Response) -> float | None:
    """Read a numeric Retry-After hint from an upstream response.

    The HTTP-date form is deliberately ignored: none of the configured
    gateways send it, and guessing a delay from clock skew is worse than
    falling back to our own backoff.
    """
    raw = response.headers.get("retry-after")
    if raw is None:
        return None
    try:
        seconds = float(raw.strip())
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    return seconds


def transient_upstream_error(provider: str, message: str) -> ProviderError:
    """An upstream response we could not use, but which usually recovers.

    Truncated payloads, dropped fields, empty ``data[0]`` and gateway
    hiccups all look like this. They must stay retryable: classifying them
    as permanent failures pushed the job into ``uncertain`` and showed the
    visitor "请联系工作人员处理", which is a dead end on an unattended
    kiosk.
    """
    return ProviderError(
        "UPSTREAM_TRANSIENT",
        message,
        retryable=True,
        details={"provider": provider},
    )


def map_provider_status(
    status_code: int,
    provider: str,
    *,
    retry_after_seconds: float | None = None,
) -> ProviderError:
    details: dict[str, object] = {"provider": provider, "upstreamStatus": status_code}
    if retry_after_seconds is not None:
        details["retryAfterSeconds"] = retry_after_seconds
    if status_code in {401, 403}:
        return ProviderError(
            "UPSTREAM_AUTH",
            "AI 服务认证失败，请检查服务端密钥配置",
            details=details,
        )
    if status_code == 429:
        return ProviderError(
            "UPSTREAM_RATE_LIMIT",
            "AI 服务当前繁忙，请稍后重试",
            retryable=True,
            details=details,
        )
    if status_code >= 500:
        return ProviderError(
            "GENERATION_FAILED",
            "AI 服务暂时不可用，请稍后重试",
            retryable=True,
            details=details,
        )
    return ProviderError(
        "UPSTREAM_BAD_RESPONSE",
        "AI 服务返回了无法识别的结果",
        details=details,
    )
