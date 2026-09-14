"""分享图片品牌水印。

游客在手机上保存图片（微信长按、下载）之前，后端统一在图片底部叠加
「像素跃迁 · RENOVLEAP 01」水印条：白色加粗文字 + 自下而上的黑色渐变
衬底，保证任何亮度的照片上都清晰可读。水印在读取时动态合成，
原图资产保持干净，亭机大屏展示不受影响。
"""

from __future__ import annotations

import io
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WATERMARK_TEXT = "像素跃迁 · RENOVLEAP 01"

# 文字字号 = 图宽 × 3.9%（与设计稿 760×1140 中 30px 字号一致）
_FONT_SIZE_RATIO = 0.039
# 文字垂直中心距底边 = 图高 × 8.8%（设计稿中文字中心 y≈1040 / 1140）
_TEXT_BOTTOM_OFFSET_RATIO = 0.088
# 底部渐变衬底从 80% 高度处开始，底边最深 alpha≈65%
_GRADIENT_START_RATIO = 0.80
_GRADIENT_MAX_ALPHA = 165

# 常见平台的中文字体候选，取第一个可用的（生产环境为 Windows）
_FONT_CANDIDATES = (
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/System/Library/Fonts/PingFang.ttc",
)

_JPEG_QUALITY = 92


@lru_cache(maxsize=8)
def _load_font(size: int) -> ImageFont.FreeTypeFont | None:
    for candidate in _FONT_CANDIDATES:
        path = Path(candidate)
        if not path.is_file():
            continue
        try:
            return ImageFont.truetype(str(path), size)
        except OSError:  # pragma: no cover - 字体文件损坏时尝试下一个
            continue
    return None


def _encode_jpeg(image: Image.Image) -> tuple[bytes, str]:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=_JPEG_QUALITY)
    return buffer.getvalue(), "image/jpeg"


def apply_footer_watermark(data: bytes) -> tuple[bytes, str]:
    """为图片字节叠加底部品牌水印，返回 ``(图片字节, mime_type)``。

    统一输出 JPEG；过小的图片（不足 200px）视为非作品图，原样返回。
    """
    with Image.open(io.BytesIO(data)) as opened:
        image = opened.convert("RGB")
    width, height = image.size
    if width < 200 or height < 200:
        return _encode_jpeg(image)

    font = _load_font(max(14, round(width * _FONT_SIZE_RATIO)))

    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    # 渐变衬底：先用 1×N 的 alpha 斜坡生成，再拉伸到整行，避免逐行绘制
    gradient_top = round(height * _GRADIENT_START_RATIO)
    bar_height = height - gradient_top
    if bar_height > 1:
        ramp = bytes(
            round(_GRADIENT_MAX_ALPHA * index / (bar_height - 1))
            for index in range(bar_height)
        )
        alpha_mask = Image.frombytes("L", (1, bar_height), ramp).resize((width, bar_height))
        gradient_bar = Image.new("RGBA", (width, bar_height), (0, 0, 0, 255))
        gradient_bar.putalpha(alpha_mask)
        overlay.paste(gradient_bar, (0, gradient_top))

    draw = ImageDraw.Draw(overlay)
    if font is not None:
        left, top, right, bottom = draw.textbbox((0, 0), WATERMARK_TEXT, font=font)
        text_width = right - left
        text_height = bottom - top
        center_x = width / 2
        center_y = height - round(height * _TEXT_BOTTOM_OFFSET_RATIO)
        draw.text(
            (center_x - text_width / 2 - left, center_y - text_height / 2 - top),
            WATERMARK_TEXT,
            font=font,
            fill=(255, 255, 255, 255),
        )

    composited = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    return _encode_jpeg(composited)
