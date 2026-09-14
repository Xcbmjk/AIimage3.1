from __future__ import annotations

import base64
import json
from io import BytesIO
from pathlib import Path

import httpx
import pytest
from PIL import Image

from backend.app.config import Settings
from backend.app.model_configs import ImageGenerationRuntimeConfig
from backend.app.providers.factory import create_provider
from backend.app.providers.gemini import GeminiProvider
from backend.app.providers.images import data_url
from backend.app.providers.images import fetch_image_url
from backend.app.providers.mock import MockProvider
from backend.app.providers.errors import ProviderError, parse_retry_after
from backend.app.providers.http import MAX_BACKOFF_SECONDS, backoff_delay
from backend.app.vision.analyze import finalize_agent_prompt
from backend.tests.test_images import image_bytes


def _settings(**values) -> Settings:
    return Settings(
        _env_file=None,
        app_env="test",
        database_url="sqlite+aiosqlite://",
        asset_directory="data/test-assets",
        share_directory="data/test-shares",
        **values,
    )


@pytest.mark.asyncio
async def test_mock_provider_returns_a_real_raster_image() -> None:
    photo = image_bytes("PNG")
    result = await MockProvider().generate(photo, "image/png", "提示词", "ink")
    assert result.data == photo
    assert result.mime_type == "image/png"
    assert result.provider_id == "mock-ink"


@pytest.mark.asyncio
async def test_gpt_url_provider_decodes_base64_response() -> None:
    image = image_bytes("PNG")
    encoded = base64.b64encode(image).decode("ascii")

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-key"
        payload = json.loads(request.content)
        assert payload["model"] == "test-model"
        return httpx.Response(
            200,
            json={"data": [{"b64_json": encoded}]},
        )

    provider = create_provider(
        _settings(
            gpt_image_base_url="https://provider.example/v1",
            gpt_image_api_key="test-key",
            gpt_image_model="test-model",
        ),
        provider_key="gpt-image-2-url",
        transport=httpx.MockTransport(handler),
    )
    result = await provider.generate(image, "image/png", "风格提示", "ink")
    assert result.data == image
    assert result.mime_type == "image/png"


@pytest.mark.asyncio

async def test_gpt_image_provider_uses_b64_json_for_classic_and_agent() -> None:
    background = image_bytes("JPEG")
    photo = image_bytes("PNG")
    output = image_bytes("PNG")
    encoded = base64.b64encode(output).decode("ascii")
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = request.content
        assert request.url.path == "/v1/images/edits"
        assert b"response_format" in body and b"b64_json" in body
        assert b"size" in body and b"2K" in body
        # 经典模式：1张照片使用 image 字段；Agent模式：2张使用 image[] 字段
        if len(requests) == 1:
            assert b'name="image"' in body
            assert body.count(b'name="image"') == 1
            assert b'name="image[]"' not in body
        else:
            assert b'name="image[]"' in body
            assert body.count(b'name="image[]"') == 2
            assert b'name="image"' not in body
        assert b"url" not in body
        return httpx.Response(200, json={"data": [{"b64_json": encoded}]})

    config = ImageGenerationRuntimeConfig(
        base_url="https://provider.example/v1",
        generation_endpoint="/images/generations",
        edit_endpoint="/images/edits",
        model_name="gpt-image-2",
        api_key="test-key",
        size="2K",
        response_format="b64_json",
        timeout_ms=1000,
    )
    provider = create_provider(
        _settings(),
        provider_key="gpt-image-2",
        transport=httpx.MockTransport(handler),
        image_config=config,
    )
    classic = await provider.generate(photo, "image/png", "经典提示", "ink")
    agent = await provider.compose(
        background,
        "image/jpeg",
        photo,
        "image/png",
        "Agent 提示",
        "gate",
    )
    assert classic.data == output
    assert agent.data == output


@pytest.mark.asyncio
async def test_gemini_provider_sends_two_images_for_agent_compose() -> None:
    background = image_bytes("JPEG")
    photo = image_bytes("PNG")
    output = image_bytes("WEBP")

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        content = payload["messages"][0]["content"]
        assert len(content) == 3
        assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
        assert content[2]["image_url"]["url"].startswith("data:image/png;base64,")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": data_url(output, "image/webp"),
                        }
                    }
                ]
            },
        )

    provider = GeminiProvider(
        _settings(
            gemini_image_base_url="https://provider.example/v1",
            gemini_image_api_key="test-key",
        ),
        transport=httpx.MockTransport(handler),
    )
    result = await provider.compose(
        background,
        "image/jpeg",
        photo,
        "image/png",
        "复刻动作并融合光影",
        "gate-steps",
    )
    assert result.data == output
    assert result.mime_type == "image/webp"


@pytest.mark.asyncio
async def test_provider_rejects_non_image_upstream_response(monkeypatch) -> None:
    """上游返回无法解码的内容时应判为可重试的瞬时错误。

    它以前被归为永久失败，会把任务推进 uncertain 并在 kiosk 上显示
    「请联系工作人员处理」——无人值守场景下这是死路。
    """
    monkeypatch.setattr("backend.app.providers.http.backoff_delay", lambda *a, **k: 0.0)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(b"not-image").decode()}]},
        )

    provider = create_provider(
        _settings(
            gpt_image_base_url="https://provider.example/v1",
            gpt_image_api_key="test-key",
        ),
        provider_key="gpt-image-2-url",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderError) as raised:
        await provider.generate(image_bytes("PNG"), "image/png", "提示", "ink")
    assert raised.value.code == "UPSTREAM_TRANSIENT"
    assert raised.value.retryable is True


@pytest.mark.asyncio
async def test_transient_upstream_failure_is_retried_then_succeeds(monkeypatch) -> None:
    """首次返空、第二次正常时应自动恢复，不打扰游客。"""
    monkeypatch.setattr("backend.app.providers.http.backoff_delay", lambda *a, **k: 0.0)
    image = image_bytes("PNG")
    encoded = base64.b64encode(image).decode("ascii")
    attempts = {"count": 0}

    async def handler(_request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] == 1:
            return httpx.Response(200, json={"data": [{"b64_json": ""}]})
        return httpx.Response(200, json={"data": [{"b64_json": encoded}]})

    provider = create_provider(
        _settings(
            gpt_image_base_url="https://provider.example/v1",
            gpt_image_api_key="test-key",
        ),
        provider_key="gpt-image-2-url",
        transport=httpx.MockTransport(handler),
    )
    result = await provider.generate(image, "image/png", "提示", "ink")
    assert result.data == image
    assert attempts["count"] == 2


@pytest.mark.asyncio
async def test_rate_limit_is_retried_and_uses_upstream_hint(monkeypatch) -> None:
    """429 应重试，并把上游的 Retry-After 交给退避函数，而不是固定等 1 秒。"""
    seen: list[float | None] = []

    def fake_delay(attempt: int, *, retry_after_seconds: float | None = None) -> float:
        seen.append(retry_after_seconds)
        return 0.0

    monkeypatch.setattr("backend.app.providers.http.backoff_delay", fake_delay)
    image = image_bytes("PNG")
    encoded = base64.b64encode(image).decode("ascii")
    attempts = {"count": 0}

    async def handler(_request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] == 1:
            return httpx.Response(429, headers={"Retry-After": "3"}, json={})
        return httpx.Response(200, json={"data": [{"b64_json": encoded}]})

    provider = create_provider(
        _settings(
            gpt_image_base_url="https://provider.example/v1",
            gpt_image_api_key="test-key",
        ),
        provider_key="gpt-image-2-url",
        transport=httpx.MockTransport(handler),
    )
    result = await provider.generate(image, "image/png", "提示", "ink")
    assert result.data == image
    assert seen == [3.0]


@pytest.mark.asyncio
async def test_non_retryable_auth_error_fails_immediately(monkeypatch) -> None:
    """密钥配错是确定性故障，不应浪费 3 次尝试和退避时间。"""
    calls = {"count": 0}

    async def handler(_request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(401, json={})

    provider = create_provider(
        _settings(
            gpt_image_base_url="https://provider.example/v1",
            gpt_image_api_key="bad-key",
        ),
        provider_key="gpt-image-2-url",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderError) as raised:
        await provider.generate(image_bytes("PNG"), "image/png", "提示", "ink")
    assert raised.value.code == "UPSTREAM_AUTH"
    assert raised.value.retryable is False
    assert calls["count"] == 1


def test_backoff_delay_grows_caps_and_prefers_retry_after() -> None:
    assert 1.0 <= backoff_delay(0) <= 1.25
    assert MAX_BACKOFF_SECONDS <= backoff_delay(5) <= MAX_BACKOFF_SECONDS * 1.25
    assert backoff_delay(0, retry_after_seconds=3) == 3.0
    assert backoff_delay(0, retry_after_seconds=600) == MAX_BACKOFF_SECONDS


def test_parse_retry_after_accepts_seconds_and_ignores_http_date() -> None:
    assert parse_retry_after(httpx.Response(429, headers={"Retry-After": "5"})) == 5.0
    assert (
        parse_retry_after(
            httpx.Response(429, headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"})
        )
        is None
    )
    assert parse_retry_after(httpx.Response(429)) is None
    assert parse_retry_after(httpx.Response(429, headers={"Retry-After": "0"})) is None


def test_agent_prompt_is_bounded_and_has_fixed_guards() -> None:
    prompt = finalize_agent_prompt("```动作描述``` #额外说明 " + "x" * 1000)
    assert len(prompt) <= 1400
    assert "唯一身份来源" in prompt
    assert "唯一场景来源" in prompt
    assert "无水印" in prompt
    assert "```" not in prompt


@pytest.mark.asyncio
async def test_fetch_image_url_streams_and_validates_response() -> None:
    image = image_bytes("PNG")

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://cdn.example/image.png")
        return httpx.Response(
            200,
            headers={"content-type": "image/png"},
            content=image,
        )

    original = __import__("backend.app.providers.images", fromlist=["socket"]).socket
    class FakeSocket:
        SOCK_STREAM = original.SOCK_STREAM

        @staticmethod
        def getaddrinfo(*args, **kwargs):
            return [(None, None, None, None, ("8.8.8.8", 443))]

    import backend.app.providers.images as images_module

    images_module.socket = FakeSocket
    try:
        data, mime = await fetch_image_url(
            "https://cdn.example/image.png",
            timeout_seconds=1,
            transport=httpx.MockTransport(handler),
        )
    finally:
        images_module.socket = original
    assert data == image
    assert mime == "image/png"


@pytest.mark.asyncio
async def test_fetch_image_url_rejects_redirect_and_private_dns() -> None:
    import backend.app.providers.images as images_module

    original = images_module.socket

    class FakeSocket:
        SOCK_STREAM = original.SOCK_STREAM

        @staticmethod
        def getaddrinfo(*args, **kwargs):
            return [(None, None, None, None, ("127.0.0.1", 443))]

    images_module.socket = FakeSocket
    try:
        with pytest.raises(ProviderError) as raised:
            await fetch_image_url(
                "https://cdn.example/image.png",
                timeout_seconds=1,
                transport=httpx.MockTransport(
                    lambda _request: httpx.Response(
                        302,
                        headers={"location": "https://other.example/image.png"},
                    )
                ),
            )
        assert raised.value.code == "UPSTREAM_BAD_RESPONSE"
    finally:
        images_module.socket = original
