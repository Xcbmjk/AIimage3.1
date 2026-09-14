from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class GeneratedImage:
    data: bytes
    mime_type: str
    provider_id: str


class ImageProvider(Protocol):
    name: str

    async def generate(
        self,
        photo: bytes,
        mime_type: str,
        prompt: str,
        style_id: str,
    ) -> GeneratedImage:
        ...

    async def compose(
        self,
        background: bytes,
        background_mime: str,
        photo: bytes,
        photo_mime: str,
        prompt: str,
        background_id: str,
    ) -> GeneratedImage:
        ...
