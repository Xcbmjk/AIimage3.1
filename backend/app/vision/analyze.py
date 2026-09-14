from __future__ import annotations

import re

import httpx

from ..model_configs import VisionRuntimeConfig
from ..providers.errors import ProviderError
from ..providers.http import post_json
from ..providers.images import data_url, endpoint_url

ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}
MAX_DYNAMIC_PROMPT_CHARS = 380
MAX_FINAL_PROMPT_CHARS = 1400


def sanitize_dynamic_prompt(value: object) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = re.sub(r"```|[#*_>`]", " ", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:MAX_DYNAMIC_PROMPT_CHARS]


def compose_fallback_prompt(background_name: str, pose_hint: str) -> str:
    return (
        f"复刻背景「{background_name}」中人物的动作与机位：{pose_hint}"
        "将照片中的人物自然置于该背景里，匹配背景的透视、机位、光源方向、"
        "色温、接触阴影与景深。"
    )


def finalize_agent_prompt(dynamic: str) -> str:
    dynamic = sanitize_dynamic_prompt(dynamic)
    identity = (
        "以人物照片为唯一身份来源，严格保留五官、脸型、肤色、年龄感与发型；"
        "画面中只保留一位主要人物，不得出现第二主角。"
    )
    action = dynamic.strip() or "参照背景预设动作自然复刻人物的姿态与朝向。"
    fusion = (
        "以背景图为唯一场景来源，保留背景的建筑、地形、构图与机位；把人物真实地"
        "合成进背景，统一透视、焦距、景深、光源方向、色温、接触阴影与空气透视，"
        "彻底清除背景中原本的人物，禁止贴纸感、白边和悬浮感。"
    )
    quality = (
        "高质量完整画面，脸部清晰，双手与肢体结构正确，无重复人物、无多余肢体、"
        "无文字、无标志、无水印。"
    )
    return "\n".join((identity, action, fusion, quality))[:MAX_FINAL_PROMPT_CHARS]


def _vision_instruction(background_name: str, pose_hint: str) -> str:
    return "\n".join(
        [
            "你是 AI 旅拍的背景视觉理解助手。你将看到一张由管理员上传的旅拍背景参考图。",
            f"本次背景主题：{background_name}。管理员补充动作提示：{pose_hint}。",
            "请只输出一段可直接用于图像编辑模型的中文融合指令，描述如何把游客照片中的人物放入这张背景，并替换背景中原有的人物。",
            "指令需覆盖：背景中人物的肢体动作与朝向、人物在画面中的落位、透视/机位、光源方向与色温、接触阴影与景深融合。",
            "不要输出 JSON、Markdown、列表符号或引号包裹，严格控制在 220 个汉字以内，只输出指令正文。",
        ]
    )


def _response_text(payload: dict[str, object]) -> str:
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
    return content if isinstance(content, str) else ""


async def analyze_background_prompt(
    config: VisionRuntimeConfig,
    *,
    background: bytes,
    mime_type: str,
    background_name: str,
    pose_hint: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    if mime_type not in ALLOWED_MIME:
        raise ProviderError("INVALID_INPUT", "背景分析仅支持 JPEG、PNG 或 WebP 图片")
    payload = await post_json(
        url=endpoint_url(config.base_url, config.endpoint),
        headers={
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
        },
        payload={
            "model": config.model_name,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _vision_instruction(background_name, pose_hint)},
                        {"type": "image_url", "image_url": {"url": data_url(background, mime_type)}},
                    ],
                }
            ],
            "modalities": ["text"],
            "stream": False,
        },
        timeout_seconds=config.timeout_ms / 1000,
        provider="vision",
        transport=transport,
    )
    result = sanitize_dynamic_prompt(_response_text(payload))
    if not result:
        raise ProviderError("UPSTREAM_BAD_RESPONSE", "视觉模型没有返回可用的背景分析结果")
    return result


async def analyze_agent_prompt(
    config: VisionRuntimeConfig,
    *,
    background: bytes,
    background_mime: str,
    photo: bytes,
    photo_mime: str,
    background_name: str,
    pose_hint: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    if background_mime not in ALLOWED_MIME or photo_mime not in ALLOWED_MIME:
        raise ProviderError("INVALID_INPUT", "Agent 分析仅支持 JPEG、PNG 或 WebP 图片")
    payload = await post_json(
        url=endpoint_url(config.base_url, config.endpoint),
        headers={
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
        },
        payload={
            "model": config.model_name,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": _vision_instruction(background_name, pose_hint),
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url(background, background_mime)},
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url(photo, photo_mime)},
                        },
                    ],
                }
            ],
            "modalities": ["text"],
            "stream": False,
        },
        timeout_seconds=config.timeout_ms / 1000,
        provider="vision",
        transport=transport,
    )
    result = sanitize_dynamic_prompt(_response_text(payload))
    if not result:
        raise ProviderError("UPSTREAM_BAD_RESPONSE", "视觉模型没有返回可用的分析结果")
    return finalize_agent_prompt(result)
