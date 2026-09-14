from __future__ import annotations

from dataclasses import dataclass

from .base import GeneratedImage


@dataclass
class MockProvider:
    name: str = "mock"

    async def generate(
        self,
        photo: bytes,
        mime_type: str,
        prompt: str,
        style_id: str,
    ) -> GeneratedImage:
        return GeneratedImage(photo, mime_type, f"mock-{style_id}")

    async def compose(
        self,
        background: bytes,
        background_mime: str,
        photo: bytes,
        photo_mime: str,
        prompt: str,
        background_id: str,
    ) -> GeneratedImage:
        return GeneratedImage(photo, photo_mime, f"mock-agent-{background_id}")
