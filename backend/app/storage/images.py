from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PIL import Image, UnidentifiedImageError

from ..api.errors import ApiError

MAX_DIMENSION = 12_000
MAX_PIXELS = 40_000_000
MIME_BY_FORMAT = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}


@dataclass(frozen=True)
class ImageInfo:
    mime_type: str
    width: int
    height: int
    byte_size: int


def validate_image_bytes(data: bytes, max_bytes: int) -> ImageInfo:
    if not data or len(data) > max_bytes:
        raise ApiError("INVALID_INPUT", "图片大小不符合要求", 400)
    try:
        with Image.open(BytesIO(data)) as image:
            image.verify()
        with Image.open(BytesIO(data)) as image:
            image.load()
            image_format = image.format or ""
            mime_type = MIME_BY_FORMAT.get(image_format)
            width, height = image.size
    except (UnidentifiedImageError, OSError, ValueError):
        raise ApiError("INVALID_INPUT", "图片格式或尺寸无效", 400) from None
    if (
        mime_type is None
        or width < 1
        or height < 1
        or width > MAX_DIMENSION
        or height > MAX_DIMENSION
        or width * height > MAX_PIXELS
    ):
        raise ApiError("INVALID_INPUT", "图片格式或尺寸无效", 400)
    return ImageInfo(mime_type, width, height, len(data))
