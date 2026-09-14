from __future__ import annotations

from dataclasses import dataclass

import httpx

from ..config import Settings
from ..model_configs import ImageGenerationRuntimeConfig
from .base import GeneratedImage
from .errors import (
    ProviderError,
    map_provider_status,
    parse_retry_after,
    transient_upstream_error,
)
from .http import retry_operation
from .images import decode_image_value, endpoint_url


@dataclass
class GptImageProvider:
    settings: Settings
    transport: httpx.AsyncBaseTransport | None = None
    runtime: ImageGenerationRuntimeConfig | None = None
    name: str = "gpt-image-2"

    @property
    def config(self) -> ImageGenerationRuntimeConfig:
        if self.runtime is not None:
            return self.runtime
        return ImageGenerationRuntimeConfig(
            base_url=self.settings.gpt_image_base_url,
            generation_endpoint="/images/generations",
            edit_endpoint=self.settings.gpt_image_endpoint,
            model_name=self.settings.gpt_image_model,
            api_key=self.settings.gpt_image_api_key.get_secret_value(),
            size=self.settings.gpt_image_size,
            response_format="b64_json",
            timeout_ms=self.settings.ai_request_timeout_ms,
        )

    async def _post(self, files, data: dict[str, str]) -> dict[str, object]:
        """One multipart attempt against the edit endpoint."""
        try:
            async with httpx.AsyncClient(
                timeout=self.config.timeout_ms / 1000,
                follow_redirects=False,
                transport=self.transport,
            ) as client:
                response = await client.post(
                    endpoint_url(self.config.base_url, self.config.edit_endpoint),
                    headers={"Authorization": f"Bearer {self.config.api_key}"},
                    files=files,
                    data=data,
                )
        except httpx.TimeoutException as error:
            raise ProviderError(
                "UPSTREAM_TIMEOUT",
                "AI 服务等待超时，请稍后重试",
                retryable=True,
                details={"provider": self.config.model_name},
            ) from error
        except httpx.NetworkError as error:
            raise ProviderError(
                "GENERATION_FAILED",
                "AI 服务暂时不可用，请稍后重试",
                retryable=True,
                details={"provider": self.config.model_name},
            ) from error
        if not response.is_success:
            raise map_provider_status(
                response.status_code,
                self.name,
                retry_after_seconds=parse_retry_after(response),
            )
        try:
            payload = response.json()
        except ValueError:
            raise transient_upstream_error(self.name, "GPT Image 2 返回了无效响应") from None
        if not isinstance(payload, dict):
            raise transient_upstream_error(self.name, "GPT Image 2 返回了无效响应")
        return payload

    def _decode(self, payload: dict[str, object]) -> tuple[bytes, str]:
        items = payload.get("data")
        first = items[0] if isinstance(items, list) and items else None
        if not isinstance(first, dict):
            raise transient_upstream_error(self.name, "GPT Image 2 没有返回图片")
        value = first.get("b64_json")
        if not value:
            raise transient_upstream_error(
                self.name,
                "图片模型必须返回 data[0].b64_json",
            )
        return decode_image_value(value, provider=self.name)

    async def generate(
        self,
        photo: bytes,
        mime_type: str,
        prompt: str,
        style_id: str,
    ) -> GeneratedImage:
        """经典模式：上传用户照片 + 风格提示词，调用图片编辑端点"""

        async def request() -> GeneratedImage:
            payload = await self._post(
                {
                    "image": (
                        f"source.{mime_type.split('/', 1)[1]}",
                        photo,
                        mime_type,
                    )
                },
                {
                    "model": self.config.model_name,
                    "prompt": prompt,
                    "size": self.config.size,
                    "quality": "low",
                    "response_format": self.config.response_format,
                },
            )
            image, output_mime = self._decode(payload)
            return GeneratedImage(image, output_mime, f"gpt-{style_id}")

        return await retry_operation(request)

    async def compose(
        self,
        background: bytes,
        background_mime: str,
        photo: bytes,
        photo_mime: str,
        prompt: str,
        background_id: str,
    ) -> GeneratedImage:
        """Agent 模式：上传背景 + 用户照片，调用图片编辑端点"""
        files = [
            ("image[]", (f"background.{background_mime.split('/', 1)[1]}", background, background_mime)),
            ("image[]", (f"photo.{photo_mime.split('/', 1)[1]}", photo, photo_mime)),
        ]

        async def request() -> GeneratedImage:
            payload = await self._post(
                files,
                {
                    "model": self.config.model_name,
                    "prompt": prompt,
                    "size": self.config.size,
                    "response_format": self.config.response_format,
                },
            )
            image, output_mime = self._decode(payload)
            return GeneratedImage(image, output_mime, f"gpt-agent-{background_id}")

        return await retry_operation(request)
