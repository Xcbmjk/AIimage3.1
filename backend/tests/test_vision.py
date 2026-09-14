from __future__ import annotations

import json

import httpx
import pytest

from backend.app.model_configs import VisionRuntimeConfig
from backend.app.vision.analyze import analyze_background_prompt, analyze_agent_prompt
from backend.tests.test_images import image_bytes


def settings() -> VisionRuntimeConfig:
    return VisionRuntimeConfig(
        base_url="https://vision.example/v1",
        api_key="vision-key",
        model_name="vision-model",
        endpoint="/chat/completions",
        timeout_ms=60_000,
    )


@pytest.mark.asyncio
async def test_background_analysis_returns_sanitized_prompt() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        content = payload["messages"][0]["content"]
        assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "```站在画面中央```  保持透视与光影"
                        }
                    }
                ]
            },
        )

    result = await analyze_background_prompt(
        settings(),
        background=image_bytes("JPEG"),
        mime_type="image/jpeg",
        background_name="门前石阶",
        pose_hint="端坐",
        transport=httpx.MockTransport(handler),
    )
    assert result == "站在画面中央 保持透视与光影"


@pytest.mark.asyncio
async def test_agent_analysis_returns_fixed_composition_guards() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": "人物向右走，匹配光线与接触阴影"}}
                ]
            },
        )

    result = await analyze_agent_prompt(
        settings(),
        background=image_bytes("JPEG"),
        background_mime="image/jpeg",
        photo=image_bytes("PNG"),
        photo_mime="image/png",
        background_name="山脊漫步",
        pose_hint="侧身行走",
        transport=httpx.MockTransport(handler),
    )
    assert "唯一身份来源" in result
    assert "人物向右走" in result
    assert len(result) <= 1400
