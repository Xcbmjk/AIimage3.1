from __future__ import annotations

from dataclasses import dataclass

import httpx

from ..config import Settings
from .base import GeneratedImage
from .errors import ProviderError, transient_upstream_error
from .http import post_json, retry_operation
from .images import data_url, decode_image_value, endpoint_url, fetch_image_url


@dataclass
class SeedreamProvider:
    settings: Settings
    transport: httpx.AsyncBaseTransport | None = None
    name: str = "seedream"

    async def generate(self, photo, mime_type, prompt, style_id) -> GeneratedImage:
        async def request() -> GeneratedImage:
            payload = await post_json(
                url=endpoint_url(self.settings.ark_base_url, self.settings.ark_image_endpoint),
                headers={
                    "Authorization": f"Bearer {self.settings.ark_api_key.get_secret_value()}",
                    "Content-Type": "application/json",
                },
                payload={
                    "model": self.settings.ark_seedream_model,
                    "prompt": prompt,
                    "image": data_url(photo, mime_type),
                    "size": self.settings.ark_image_size,
                    "response_format": self.settings.ark_response_format,
                    "watermark": self.settings.ark_watermark,
                },
                timeout_seconds=self.settings.ai_request_timeout_ms / 1000,
                provider=self.name,
                transport=self.transport,
            )
            items = payload.get("data") or payload.get("images")
            first = items[0] if isinstance(items, list) and items else None
            if not isinstance(first, dict):
                raise transient_upstream_error(self.name, "Seedream 没有返回图片")
            if first.get("b64_json"):
                image, output_mime = decode_image_value(
                    first["b64_json"],
                    provider=self.name,
                )
            elif first.get("url"):
                image, output_mime = await fetch_image_url(
                    str(first["url"]),
                    timeout_seconds=self.settings.ai_request_timeout_ms / 1000,
                    transport=self.transport,
                    provider=self.name,
                )
            else:
                raise transient_upstream_error(self.name, "Seedream 返回格式不支持")
            return GeneratedImage(image, output_mime, f"seedream-{style_id}")

        return await retry_operation(request)

    async def compose(self, *args, **kwargs):
        raise ProviderError("CONFIG_ERROR", "当前图像模型不支持 Agent 合成")
