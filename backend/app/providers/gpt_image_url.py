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
from .http import post_json, retry_operation
from .images import decode_image_value, endpoint_url


def _decode_first_b64(payload: dict[str, object], provider: str) -> tuple[bytes, str]:
    items = payload.get("data")
    first = items[0] if isinstance(items, list) and items else None
    if not isinstance(first, dict):
        raise transient_upstream_error(provider, "图片模型没有返回图片")
    value = first.get("b64_json")
    if not value:
        raise transient_upstream_error(provider, "图片模型必须返回 data[0].b64_json")
    return decode_image_value(value, provider=provider)


@dataclass
class GptImageUrlProvider:
    settings: Settings
    transport: httpx.AsyncBaseTransport | None = None
    runtime: ImageGenerationRuntimeConfig | None = None
    name: str = "gpt-image-2-url"

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

    async def generate(self, photo, mime_type, prompt, style_id) -> GeneratedImage:
        async def request() -> GeneratedImage:
            payload = await post_json(
                url=endpoint_url(
                    self.config.base_url,
                    self.config.generation_endpoint,
                ),
                headers={
                    "Authorization": f"Bearer {self.config.api_key}"
                },
                payload={
                    "model": self.config.model_name,
                    "prompt": prompt,
                    "size": self.config.size,
                    "n": 1,
                    "response_format": self.config.response_format,
                },
                timeout_seconds=self.config.timeout_ms / 1000,
                provider=self.name,
                transport=self.transport,
            )
            image, output_mime = _decode_first_b64(payload, self.name)
            return GeneratedImage(image, output_mime, f"gpt-url-{style_id}")

        return await retry_operation(request, max_attempts=self.config.max_attempts)

    async def compose(
        self,
        background: bytes,
        background_mime: str,
        photo: bytes,
        photo_mime: str,
        prompt: str,
        background_id: str,
    ) -> GeneratedImage:
        files = [
            ("image[]", (f"background.{background_mime.split('/', 1)[1]}", background, background_mime)),
            ("image[]", (f"photo.{photo_mime.split('/', 1)[1]}", photo, photo_mime)),
        ]
        data = {
            "model": self.config.model_name,
            "prompt": prompt,
            "size": self.config.size,
            "response_format": self.config.response_format,
        }

        async def request() -> GeneratedImage:
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
                    details={"provider": self.name},
                ) from error
            except httpx.NetworkError as error:
                raise ProviderError(
                    "GENERATION_FAILED",
                    "AI 服务暂时不可用，请稍后重试",
                    retryable=True,
                    details={"provider": self.name},
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
                raise transient_upstream_error(
                    self.name,
                    "图片模型返回了无效响应",
                ) from None
            if not isinstance(payload, dict):
                raise transient_upstream_error(self.name, "图片模型返回了无效响应")
            image, output_mime = _decode_first_b64(payload, self.name)
            return GeneratedImage(image, output_mime, f"gpt-url-agent-{background_id}")

        return await retry_operation(request, max_attempts=self.config.max_attempts)
