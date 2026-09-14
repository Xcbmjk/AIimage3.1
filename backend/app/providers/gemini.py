from __future__ import annotations

import re
from dataclasses import dataclass

import httpx

from ..config import Settings
from .base import GeneratedImage
from .errors import transient_upstream_error
from .http import post_json, retry_operation
from .images import decode_image_value, data_url, endpoint_url

OUTPUT_DATA_URL = re.compile(
    r"data:(image/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)"
)


def _content(payload: dict[str, object]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return ""


async def _chat_edit(
    settings: Settings,
    content: list[dict[str, object]],
    *,
    transport: httpx.AsyncBaseTransport | None,
) -> tuple[bytes, str]:
    async def request():
        payload = await post_json(
            url=endpoint_url(settings.gemini_image_base_url, settings.gemini_image_endpoint),
            headers={
                "Authorization": f"Bearer {settings.gemini_image_api_key.get_secret_value()}",
                "Content-Type": "application/json",
            },
            payload={
                "model": settings.gemini_image_model,
                "messages": [{"role": "user", "content": content}],
                "modalities": ["text", "image"],
                "stream": False,
            },
            timeout_seconds=settings.ai_request_timeout_ms / 1000,
            provider="gemini-3.1-flash-image",
            transport=transport,
        )
        match = OUTPUT_DATA_URL.search(_content(payload))
        if not match:
            raise transient_upstream_error(
                "gemini-3.1-flash-image",
                "Gemini Edit 返回格式不支持",
            )
        return decode_image_value(
            f"data:{match.group(1)};base64,{match.group(2)}",
            provider="gemini-3.1-flash-image",
        )

    return await retry_operation(request)


def edit_prompt(style_name: str, style_prompt: str) -> str:
    return "\n".join(
        [
            "编辑这张上传的原图。这是图片编辑，不是重新设计构图。",
            "保留同一个人物及其身份特征、面部表情、姿势、身体比例、原始裁剪、镜头角度、服装、背景和物体位置。",
            "不要新增、删除或移动物体，不要发明、替换或改写图片中的文字。只改变视觉渲染方式。",
            f"表现风格：{style_name}。{style_prompt}",
            "只返回编辑后的图片。",
        ]
    )


def compose_prompt(dynamic_prompt: str) -> str:
    return "\n".join(
        [
            "你将看到两张图：第一张是目标背景（含预设人物动作），第二张是游客照片。",
            "把游客照片中的人物合成进第一张背景，替换背景里原本的人物，并复刻其动作、机位与构图。",
            "以背景为唯一场景，保持背景的建筑、地形与光影；只从游客照片取人物身份与外形。",
            dynamic_prompt,
            "只返回合成后的图片。",
        ]
    )


@dataclass
class GeminiProvider:
    settings: Settings
    transport: httpx.AsyncBaseTransport | None = None
    name: str = "gemini-3.1-flash-image"

    async def generate(self, photo, mime_type, prompt, style_id) -> GeneratedImage:
        image, output_mime = await _chat_edit(
            self.settings,
            [
                {
                    "type": "text",
                    "text": edit_prompt(style_id, prompt),
                },
                {
                    "type": "image_url",
                    "image_url": {"url": data_url(photo, mime_type)},
                },
            ],
            transport=self.transport,
        )
        return GeneratedImage(image, output_mime, f"gemini-edit-{style_id}")

    async def compose(
        self,
        background,
        background_mime,
        photo,
        photo_mime,
        prompt,
        background_id,
    ) -> GeneratedImage:
        image, output_mime = await _chat_edit(
            self.settings,
            [
                {"type": "text", "text": compose_prompt(prompt)},
                {
                    "type": "image_url",
                    "image_url": {"url": data_url(background, background_mime)},
                },
                {
                    "type": "image_url",
                    "image_url": {"url": data_url(photo, photo_mime)},
                },
            ],
            transport=self.transport,
        )
        return GeneratedImage(image, output_mime, f"gemini-agent-{background_id}")
