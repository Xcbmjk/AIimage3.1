from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image

from backend.app.api.errors import ApiError
from backend.app.storage.images import validate_image_bytes


def image_bytes(image_format: str, size: tuple[int, int] = (32, 48)) -> bytes:
    output = BytesIO()
    Image.new("RGB", size, (24, 80, 64)).save(output, format=image_format)
    return output.getvalue()


def test_validate_image_uses_decoded_format_not_declared_mime() -> None:
    info = validate_image_bytes(image_bytes("PNG"), 1024 * 1024)
    assert info.mime_type == "image/png"
    assert info.width == 32
    assert info.height == 48


def test_validate_image_rejects_corrupt_and_oversized_input() -> None:
    with pytest.raises(ApiError) as corrupt:
        validate_image_bytes(b"image/png\x00not-an-image", 1024 * 1024)
    assert corrupt.value.code == "INVALID_INPUT"

    data = image_bytes("JPEG")
    with pytest.raises(ApiError) as oversized:
        validate_image_bytes(data, len(data) - 1)
    assert oversized.value.code == "INVALID_INPUT"


def test_validate_image_rejects_pixel_bombs() -> None:
    with pytest.raises(ApiError) as raised:
        validate_image_bytes(image_bytes("PNG", (7000, 7000)), 100 * 1024 * 1024)
    assert raised.value.code == "INVALID_INPUT"
