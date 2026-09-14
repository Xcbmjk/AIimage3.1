from __future__ import annotations

import asyncio
import json
import random
from collections.abc import Awaitable, Callable, Mapping
from typing import TypeVar

import httpx

from .errors import (
    ProviderError,
    map_provider_status,
    parse_retry_after,
    transient_upstream_error,
)

MAX_RESPONSE_BYTES = 22 * 1024 * 1024

MAX_ATTEMPTS = 3
BASE_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 8.0
JITTER_RATIO = 0.25

T = TypeVar("T")


def backoff_delay(attempt: int, *, retry_after_seconds: float | None = None) -> float:
    """Delay before the next attempt.

    A numeric Retry-After from upstream wins, capped so a hostile value
    cannot stall the visitor for minutes. Otherwise exponential backoff
    with jitter, which avoids every kiosk retrying in lockstep.
    """
    if retry_after_seconds is not None:
        return min(retry_after_seconds, MAX_BACKOFF_SECONDS)
    ceiling = min(BASE_BACKOFF_SECONDS * (2**attempt), MAX_BACKOFF_SECONDS)
    return ceiling + random.uniform(0, ceiling * JITTER_RATIO)


async def post_json(
    *,
    url: str,
    headers: Mapping[str, str],
    payload: Mapping[str, object],
    timeout_seconds: float,
    provider: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, object]:
    try:
        async with httpx.AsyncClient(
            timeout=timeout_seconds,
            follow_redirects=False,
            transport=transport,
        ) as client:
            response = await client.post(url, headers=dict(headers), json=dict(payload))
    except httpx.TimeoutException as error:
        raise ProviderError(
            "UPSTREAM_TIMEOUT",
            "AI 服务等待超时，请稍后重试",
            retryable=True,
            details={"provider": provider},
        ) from error
    except httpx.NetworkError as error:
        raise ProviderError(
            "GENERATION_FAILED",
            "AI 服务暂时不可用，请稍后重试",
            retryable=True,
            details={"provider": provider},
        ) from error

    if not response.is_success:
        raise map_provider_status(
            response.status_code,
            provider,
            retry_after_seconds=parse_retry_after(response),
        )
    if len(response.content) > MAX_RESPONSE_BYTES:
        raise ProviderError("UPSTREAM_BAD_RESPONSE", "AI 服务返回内容过大")
    try:
        value = response.json()
    except (ValueError, json.JSONDecodeError):
        raise transient_upstream_error(provider, "AI 服务返回了无效响应") from None
    if not isinstance(value, dict):
        raise transient_upstream_error(provider, "AI 服务返回了无效响应")
    return value


def retryable(error: BaseException) -> bool:
    return isinstance(error, ProviderError) and error.retryable


async def retry_operation(
    operation: Callable[[], Awaitable[T]],
    *,
    max_attempts: int = MAX_ATTEMPTS,
) -> T:
    """Run an upstream call with bounded backoff.

    Only errors marked retryable are retried; a bad API key or a malformed
    prompt fails immediately instead of burning the whole timeout budget.
    ``max_attempts`` comes from the configured vendor row, because it is part
    of the request's total time budget: every extra attempt costs another full
    ``timeout_ms`` before the request can move to the standby line.
    """
    attempts = max(1, int(max_attempts))
    for attempt in range(attempts):
        try:
            return await operation()
        except ProviderError as error:
            if attempt == attempts - 1 or not retryable(error):
                raise
            retry_after = (error.details or {}).get("retryAfterSeconds")
            hint = retry_after if isinstance(retry_after, (int, float)) else None
            await asyncio.sleep(backoff_delay(attempt, retry_after_seconds=hint))
    raise AssertionError("unreachable: retry loop must return or raise")
