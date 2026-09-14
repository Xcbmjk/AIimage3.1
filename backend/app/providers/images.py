from __future__ import annotations

import base64
import binascii
import asyncio
import ipaddress
import socket
from urllib.parse import urlparse

import httpx

from ..api.errors import ApiError
from ..lib.urls import endpoint_url
from ..storage.images import validate_image_bytes
from .errors import ProviderError, transient_upstream_error

ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}
MAX_OUTPUT_BYTES = 15 * 1024 * 1024
MAX_RESPONSE_BYTES = 22 * 1024 * 1024


def data_url(data: bytes, mime_type: str) -> str:
    if mime_type not in ALLOWED_MIME:
        raise ProviderError("INVALID_INPUT", "只支持 JPEG、PNG 或 WebP 图片")
    return f"data:{mime_type};base64,{base64.b64encode(data).decode('ascii')}"


def decode_image_value(
    value: object,
    *,
    default_mime: str = "image/png",
    max_bytes: int = MAX_OUTPUT_BYTES,
    provider: str = "",
) -> tuple[bytes, str]:
    """Turn an upstream image field into validated bytes.

    A payload we cannot decode is treated as a transient upstream problem,
    not a permanent one: truncated base64 and half-written responses are
    the common cause and the next attempt usually succeeds. Only the
    oversize case is deterministic, so it stays non-retryable.
    """
    if not isinstance(value, str) or not value:
        raise transient_upstream_error(provider, "AI 服务没有返回图片")
    if value.startswith("data:"):
        head, separator, encoded = value.partition(",")
        if not separator or ";base64" not in head:
            raise transient_upstream_error(provider, "AI 服务返回了无效图片")
        mime_type = head[5:].split(";", 1)[0]
    else:
        mime_type = default_mime
        encoded = value
    if mime_type == "image/jpg":
        mime_type = "image/jpeg"
    if mime_type not in ALLOWED_MIME:
        raise transient_upstream_error(provider, "AI 服务返回了不支持的图片")
    if len(encoded) > ((max_bytes * 4) // 3) + 8:
        raise ProviderError("UPSTREAM_BAD_RESPONSE", "AI 服务返回图片过大")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise transient_upstream_error(provider, "AI 服务返回了无效图片") from None
    try:
        info = validate_image_bytes(decoded, max_bytes)
    except ApiError:
        raise transient_upstream_error(provider, "AI 服务返回了无效图片") from None
    if info.mime_type != mime_type:
        raise transient_upstream_error(provider, "AI 服务返回图片格式不匹配")
    return decoded, info.mime_type


def _private_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return True
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
        or address.is_reserved
    )


def _safe_hostname(hostname: str) -> bool:
    normalized = hostname.lower().rstrip(".")
    if normalized in {"localhost", "metadata.google.internal"}:
        return False
    if normalized.endswith((".localhost", ".local")):
        return False
    try:
        ipaddress.ip_address(normalized)
    except ValueError:
        return True
    return not _private_address(normalized)


async def fetch_image_url(
    url: str,
    *,
    timeout_seconds: float,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[bytes, str]:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or not _safe_hostname(parsed.hostname):
        raise ProviderError("UPSTREAM_BAD_RESPONSE", "AI 服务图片地址不安全")
    try:
        addresses = await asyncio.to_thread(
            socket.getaddrinfo,
            parsed.hostname,
            parsed.port or 443,
            type=socket.SOCK_STREAM,
        )
    except OSError:
        raise ProviderError("UPSTREAM_BAD_RESPONSE", "AI 服务图片地址不安全") from None
    if not addresses or any(_private_address(item[4][0]) for item in addresses):
        raise ProviderError("UPSTREAM_BAD_RESPONSE", "AI 服务图片地址不安全")

    try:
        async with httpx.AsyncClient(
            timeout=timeout_seconds,
            follow_redirects=False,
            transport=transport,
        ) as client:
            async with client.stream("GET", url) as response:
                if 300 <= response.status_code < 400:
                    raise ProviderError("UPSTREAM_BAD_RESPONSE", "AI 服务图片重定向被拒绝")
                if response.status_code < 200 or response.status_code >= 300:
                    raise transient_upstream_error(provider, "AI 服务图片下载失败")
                declared = response.headers.get("content-type", "").split(";", 1)[0]
                if declared not in ALLOWED_MIME:
                    raise transient_upstream_error(
                        provider,
                        "AI 服务返回的不是受支持的图片",
                    )
                content_length = response.headers.get("content-length")
                if content_length:
                    try:
                        if int(content_length) > MAX_OUTPUT_BYTES:
                            raise ProviderError(
                                "UPSTREAM_BAD_RESPONSE",
                                "AI 服务返回图片过大",
                            )
                    except ValueError:
                        pass
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_OUTPUT_BYTES:
                        raise ProviderError(
                            "UPSTREAM_BAD_RESPONSE",
                            "AI 服务返回图片过大",
                        )
                    chunks.append(chunk)
    except (httpx.TimeoutException, httpx.NetworkError) as error:
        raise ProviderError(
            "UPSTREAM_TIMEOUT",
            "AI 服务图片下载超时，请稍后重试",
            retryable=True,
        ) from error
    content = b"".join(chunks)
    try:
        info = validate_image_bytes(content, MAX_OUTPUT_BYTES)
    except ApiError:
        raise transient_upstream_error(provider, "AI 服务返回了无效图片") from None
    if info.mime_type != declared:
        raise transient_upstream_error(provider, "AI 服务返回图片格式不匹配")
    return content, info.mime_type
