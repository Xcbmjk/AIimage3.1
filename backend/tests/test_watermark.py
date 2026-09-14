"""底部品牌水印的单元测试。"""

from __future__ import annotations

import io

from PIL import Image

from backend.app.domain.watermark import WATERMARK_TEXT, apply_footer_watermark


def _solid_png(width: int = 768, height: int = 1152, color: tuple[int, int, int] = (240, 235, 220)) -> bytes:
    image = Image.new("RGB", (width, height), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_watermark_keeps_dimensions_and_outputs_jpeg() -> None:
    data, mime = apply_footer_watermark(_solid_png())
    assert mime == "image/jpeg"
    with Image.open(io.BytesIO(data)) as result:
        assert result.format == "JPEG"
        assert result.size == (768, 1152)


def test_watermark_darkens_bottom_and_draws_text() -> None:
    source = _solid_png()  # 亮色背景，方便断言变暗
    data, _ = apply_footer_watermark(source)
    with Image.open(io.BytesIO(data)) as result:
        pixels = result.convert("RGB").load()
        width, height = result.size
        # 底边应被渐变衬底明显压暗
        bottom_pixel = pixels[width // 2, height - 2]
        assert sum(bottom_pixel) < 3 * 120
        # 顶部不应受影响（JPEG 有损压缩允许 ±3 色漂）
        top_pixel = pixels[width // 2, 2]
        assert all(abs(channel - expected) <= 3 for channel, expected in zip(top_pixel, (240, 235, 220)))


def test_watermark_text_centered_near_bottom() -> None:
    data, _ = apply_footer_watermark(_solid_png())
    with Image.open(io.BytesIO(data)) as result:
        gray = result.convert("L")
        width, height = gray.size
        band_top = height - round(height * 0.14)
        band = gray.crop((0, band_top, width, height))
        pixels = band.load()
        bright_columns = [x for x in range(width) if any(pixels[x, y] > 220 for y in range(band.height))]
        assert bright_columns, "水印文字应包含白色像素"
        center_of_text = (bright_columns[0] + bright_columns[-1]) / 2
        assert abs(center_of_text - width / 2) < width * 0.05


def test_watermark_skips_tiny_images() -> None:
    data, mime = apply_footer_watermark(_solid_png(width=64, height=64))
    assert mime == "image/jpeg"
    with Image.open(io.BytesIO(data)) as result:
        assert result.size == (64, 64)
        # 过小图不加水印：角落保持纯色（JPEG 有损压缩允许 ±3 色漂）
        pixel = result.convert("RGB").getpixel((1, 62))
        assert all(abs(channel - expected) <= 3 for channel, expected in zip(pixel, (240, 235, 220)))


def test_watermark_text_constant() -> None:
    assert WATERMARK_TEXT == "像素跃迁 · RENOVLEAP 01"
