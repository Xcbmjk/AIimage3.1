from __future__ import annotations

import httpx

from ..config import Settings
from ..model_configs import (
    DEFAULT_PROVIDER_KEY,
    PROVIDER_KEYS,
    ImageGenerationRuntimeConfig,
)
from .base import ImageProvider
from .gemini import GeminiProvider
from .gpt_image import GptImageProvider
from .gpt_image_url import GptImageUrlProvider
from .jimeng import JimengProvider
from .mock import MockProvider
from .seedream import SeedreamProvider


def create_provider(
    settings: Settings,
    *,
    provider_key: str,
    transport: httpx.AsyncBaseTransport | None = None,
    image_config: ImageGenerationRuntimeConfig | None = None,
) -> ImageProvider:
    """Build the implementation named by a database configuration row.

    ``provider_key`` comes from ``resolve_provider_key``, so the environment no
    longer decides which vendor is used. A value that does not name a shipped
    implementation falls back to the OpenAI-compatible default rather than
    raising ``KeyError``: an administrator typo degrades to the protocol the
    console form already targets instead of taking generation down.
    """
    key = (provider_key or "").strip().lower()
    if key not in PROVIDER_KEYS:
        key = DEFAULT_PROVIDER_KEY
    providers: dict[str, ImageProvider] = {
        "mock": MockProvider(),
        "gpt-image-2": GptImageProvider(settings, transport, image_config),
        "gpt-image-2-url": GptImageUrlProvider(settings, transport, image_config),
        "seedream": SeedreamProvider(settings, transport),
        "jimeng-i2i": JimengProvider(settings, transport),
        "gemini-3.1-flash-image": GeminiProvider(settings, transport),
    }
    return providers[key]
