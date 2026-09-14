from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx

from ..config import Settings
from .base import GeneratedImage
from .errors import ProviderError, transient_upstream_error
from .http import post_json
from .images import decode_image_value, endpoint_url, fetch_image_url

REGION = "cn-north-1"
SERVICE = "cv"
VERSION = "2022-08-31"


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sign(key: bytes, value: str) -> bytes:
    return hmac.new(key, value.encode("utf-8"), hashlib.sha256).digest()


def signed_headers(settings: Settings, body: str, action: str) -> dict[str, str]:
    base = settings.jimeng_base_url
    parsed = httpx.URL(base)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    short_date = timestamp[:8]
    payload_hash = _sha256(body.encode("utf-8"))
    query = urlencode({"Action": action, "Version": VERSION})
    canonical_headers = (
        f"host:{parsed.host}\n"
        f"x-content-sha256:{payload_hash}\n"
        f"x-date:{timestamp}\n"
    )
    header_names = "host;x-content-sha256;x-date"
    canonical_request = (
        f"POST\n{parsed.path or '/'}\n{query}\n{canonical_headers}\n"
        f"{header_names}\n{payload_hash}"
    )
    scope = f"{short_date}/{REGION}/{SERVICE}/request"
    string_to_sign = f"HMAC-SHA256\n{timestamp}\n{scope}\n{_sha256(canonical_request.encode())}"
    date_key = _sign(settings.volc_secret_access_key.get_secret_value().encode(), short_date)
    region_key = _sign(date_key, REGION)
    service_key = _sign(region_key, SERVICE)
    signing_key = _sign(service_key, "request")
    signature = hmac.new(
        signing_key,
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        "Authorization": (
            f"HMAC-SHA256 Credential={settings.volc_access_key_id}/{scope}, "
            f"SignedHeaders={header_names}, Signature={signature}"
        ),
        "Content-Type": "application/json",
        "X-Content-Sha256": payload_hash,
        "X-Date": timestamp,
    }


@dataclass
class JimengProvider:
    settings: Settings
    transport: httpx.AsyncBaseTransport | None = None
    name: str = "jimeng-i2i"

    async def _request(self, action: str, payload: dict[str, object]) -> dict[str, object]:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        return await post_json(
            url=f"{self.settings.jimeng_base_url}?{urlencode({'Action': action, 'Version': VERSION})}",
            headers=signed_headers(self.settings, body, action),
            payload=payload,
            timeout_seconds=self.settings.ai_request_timeout_ms / 1000,
            provider=self.name,
            transport=self.transport,
        )

    async def generate(self, photo, mime_type, prompt, style_id) -> GeneratedImage:
        if mime_type not in {"image/jpeg", "image/png"}:
            raise ProviderError("INVALID_INPUT", "即梦仅支持 JPEG 或 PNG 照片")
        if len(photo) > int(4.7 * 1024 * 1024):
            raise ProviderError("INVALID_INPUT", "即梦输入照片不能超过 4.7MB")
        submitted = await self._request(
            "CVSync2AsyncSubmitTask",
            {
                "req_key": self.settings.jimeng_req_key,
                "binary_data_base64": [
                    __import__("base64").b64encode(photo).decode("ascii")
                ],
                "prompt": prompt,
                "seed": -1,
                "scale": self.settings.jimeng_scale,
                "width": self.settings.jimeng_width,
                "height": self.settings.jimeng_height,
            },
        )
        task = submitted.get("data")
        task_id = task.get("task_id") if isinstance(task, dict) else None
        if not task_id:
            raise transient_upstream_error(self.name, "即梦没有返回任务 ID")

        import asyncio

        deadline = datetime.now(timezone.utc).timestamp() * 1000 + self.settings.jimeng_poll_timeout_ms
        while datetime.now(timezone.utc).timestamp() * 1000 < deadline:
            await asyncio.sleep(self.settings.jimeng_poll_interval_ms / 1000)
            result = await self._request(
                "CVSync2AsyncGetResult",
                {
                    "req_key": self.settings.jimeng_req_key,
                    "task_id": task_id,
                    "req_json": json.dumps(
                        {"return_url": True, "logo_info": {"add_logo": False}},
                        separators=(",", ":"),
                    ),
                },
            )
            data = result.get("data")
            status = data.get("status") if isinstance(data, dict) else None
            if status in {"in_queue", "generating"}:
                continue
            if status in {"not_found", "expired"}:
                raise ProviderError(
                    "GENERATION_FAILED",
                    "即梦任务不存在或已过期，请重试",
                    retryable=True,
                )
            if status == "done":
                base64_values = data.get("binary_data_base64") if isinstance(data, dict) else None
                urls = data.get("image_urls") if isinstance(data, dict) else None
                if isinstance(base64_values, list) and base64_values:
                    image, output_mime = decode_image_value(
                        base64_values[0],
                        default_mime="image/jpeg",
                        provider=self.name,
                    )
                elif isinstance(urls, list) and urls:
                    image, output_mime = await fetch_image_url(
                        str(urls[0]),
                        timeout_seconds=self.settings.ai_request_timeout_ms / 1000,
                        transport=self.transport,
                        provider=self.name,
                    )
                else:
                    raise transient_upstream_error(self.name, "即梦任务完成但没有返回图片")
                return GeneratedImage(image, output_mime, f"jimeng-{style_id}-{task_id}")
            raise transient_upstream_error(self.name, "即梦返回了未知任务状态")
        raise ProviderError("UPSTREAM_TIMEOUT", "即梦生图等待超时，请稍后重试", retryable=True)

    async def compose(self, *args, **kwargs):
        raise ProviderError("CONFIG_ERROR", "当前图像模型不支持 Agent 合成")
