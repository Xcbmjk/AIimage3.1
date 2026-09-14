from __future__ import annotations

from dataclasses import dataclass

import httpx
import pytest

from backend.app.config import Settings
from backend.app.db.models import ModelConfig
from backend.app.model_configs import (
    DEFAULT_COOLDOWN_SECONDS,
    DEFAULT_FAILURE_THRESHOLD,
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_PROVIDER_KEY,
    PROVIDER_KEYS,
    SELECTABLE_PROVIDER_KEYS,
    resolve_provider_key,
    to_image_generation_runtime_config,
)
from backend.app.providers.base import GeneratedImage
from backend.app.providers.circuit import CircuitBreaker
from backend.app.providers.errors import ProviderError
from backend.app.providers.failover import FailoverImageProvider, GenerationLine
from backend.app.providers.factory import create_provider
from backend.app.providers.http import retry_operation


def _settings(**values) -> Settings:
    return Settings(
        _env_file=None,
        app_env="test",
        database_url="sqlite+aiosqlite://",
        asset_directory="data/test-assets",
        share_directory="data/test-shares",
        **values,
    )


def _row(provider: str) -> ModelConfig:
    return ModelConfig(provider=provider)


def _image_row(**overrides) -> ModelConfig:
    values = {
        "provider": "deepcoding",
        "base_url": "https://example.com/v1",
        "endpoint": "/images/edits",
        "model_name": "gpt-image-2",
        "api_key": "test-key",
        "timeout_ms": 120000,
        "extra_config": {},
    }
    values.update(overrides)
    return ModelConfig(**values)


@dataclass
class _StubProvider:
    """A vendor line that either succeeds or raises a scripted error."""

    name: str
    error: ProviderError | None = None
    calls: int = 0

    async def generate(
        self,
        photo: bytes,
        mime_type: str,
        prompt: str,
        style_id: str,
    ) -> GeneratedImage:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return GeneratedImage(b"image-bytes", "image/png", f"{self.name}-{style_id}")

    async def compose(
        self,
        background: bytes,
        background_mime: str,
        photo: bytes,
        photo_mime: str,
        prompt: str,
        background_id: str,
    ) -> GeneratedImage:
        return await self.generate(photo, photo_mime, prompt, background_id)


def test_implementation_key_is_used_when_the_row_names_a_selectable_one() -> None:
    for key in SELECTABLE_PROVIDER_KEYS:
        assert resolve_provider_key(_row(key)) == key
    # The console stores free text; casing should not change which line runs.
    assert resolve_provider_key(_row("Mock")) == "mock"


def test_shipped_but_unoffered_implementations_degrade_to_the_default() -> None:
    """产品当前只适配 gpt-image-2。

    其他实现仍留在仓库里以备将来使用，但配置里写它们时不能真的切换协议：
    统一落到默认实现，避免运维以为换掉了厂商。
    """
    for key in PROVIDER_KEYS - SELECTABLE_PROVIDER_KEYS:
        assert resolve_provider_key(_row(key)) == DEFAULT_PROVIDER_KEY
    # 尤其是形近的 gpt-image-2-url：它走纯文生图、不传游客照片。
    assert resolve_provider_key(_row(" gpt-image-2-url ")) == DEFAULT_PROVIDER_KEY


def test_vendor_label_falls_back_to_openai_compatible_implementation() -> None:
    """deepcoding 这类店名描述的是同一个 OpenAI 兼容协议。

    后台表单产出的就是这种配置，所以未命中实现 key 的名称必须落到默认实现，
    而不是让请求失败。
    """
    for label in ("deepcoding", "tokenworldai", "NewAPI", "database-provider", ""):
        assert resolve_provider_key(_row(label)) == DEFAULT_PROVIDER_KEY


def test_factory_degrades_instead_of_raising_on_an_unknown_key() -> None:
    provider = create_provider(_settings(), provider_key="not-a-real-provider")
    assert provider.name == DEFAULT_PROVIDER_KEY


def test_circuit_breaker_opens_at_threshold_and_resets_on_success() -> None:
    breaker = CircuitBreaker(failure_threshold=2, cooldown_seconds=60)
    assert breaker.is_open("line") is False
    breaker.record_failure("line")
    assert breaker.is_open("line") is False
    breaker.record_failure("line")
    assert breaker.is_open("line") is True
    breaker.record_success("line")
    assert breaker.is_open("line") is False


def test_circuit_breaker_lets_a_probe_through_after_cooldown() -> None:
    breaker = CircuitBreaker(failure_threshold=1, cooldown_seconds=0)
    breaker.record_failure("line")
    # Cooldown already elapsed, so the next request is the probe.
    assert breaker.is_open("line") is False


@pytest.mark.asyncio
async def test_primary_vendor_failure_moves_to_the_standby_line() -> None:
    primary = _StubProvider(
        "primary",
        ProviderError("GENERATION_FAILED", "上游 5xx", retryable=True),
    )
    standby = _StubProvider("standby")
    provider = FailoverImageProvider(
        [GenerationLine("primary-row", primary), GenerationLine("standby-row", standby)],
        CircuitBreaker(failure_threshold=3, cooldown_seconds=60),
    )

    result = await provider.generate(b"photo", "image/png", "提示", "ink")

    assert result.provider_id == "standby-ink"
    assert primary.calls == 1
    assert standby.calls == 1
    # The reported name follows whichever line actually served the request.
    assert provider.name == "standby"


@pytest.mark.asyncio
async def test_invalid_input_is_raised_without_burning_the_standby_line() -> None:
    """请求本身的问题换供应商也一样被拒，不该浪费备用线路和它的延迟。"""
    primary = _StubProvider(
        "primary",
        ProviderError("INVALID_INPUT", "风格素材已不可用"),
    )
    standby = _StubProvider("standby")
    provider = FailoverImageProvider(
        [GenerationLine("primary-row", primary), GenerationLine("standby-row", standby)],
        CircuitBreaker(failure_threshold=3, cooldown_seconds=60),
    )

    with pytest.raises(ProviderError) as raised:
        await provider.generate(b"photo", "image/png", "提示", "ink")

    assert raised.value.code == "INVALID_INPUT"
    assert standby.calls == 0


@pytest.mark.asyncio
async def test_all_lines_cooling_down_raises_a_retryable_error() -> None:
    breaker = CircuitBreaker(failure_threshold=1, cooldown_seconds=60)
    breaker.record_failure("primary-row")
    breaker.record_failure("standby-row")
    provider = FailoverImageProvider(
        [
            GenerationLine("primary-row", _StubProvider("primary")),
            GenerationLine("standby-row", _StubProvider("standby")),
        ],
        breaker,
    )

    with pytest.raises(ProviderError) as raised:
        await provider.generate(b"photo", "image/png", "提示", "ink")

    assert raised.value.code == "UPSTREAM_TRANSIENT"
    assert raised.value.retryable is True


@pytest.mark.asyncio
async def test_repeated_vendor_failures_open_the_circuit_and_skip_the_line() -> None:
    failing = _StubProvider(
        "primary",
        ProviderError("UPSTREAM_TIMEOUT", "超时", retryable=True),
    )
    standby = _StubProvider("standby")
    breaker = CircuitBreaker(failure_threshold=2, cooldown_seconds=60)
    provider = FailoverImageProvider(
        [
            GenerationLine(
                "primary-row",
                failing,
                failure_threshold=2,
                cooldown_seconds=60,
            ),
            GenerationLine("standby-row", standby),
        ],
        breaker,
    )

    await provider.generate(b"photo", "image/png", "提示", "ink")
    await provider.generate(b"photo", "image/png", "提示", "ink")
    assert breaker.is_open("primary-row") is True

    # Once open, the dead line is skipped instead of paying its timeout again.
    await provider.generate(b"photo", "image/png", "提示", "ink")
    assert failing.calls == 2
    assert standby.calls == 3


@pytest.mark.asyncio
async def test_line_defaults_open_on_the_first_vendor_failure() -> None:
    """默认阈值是 1，不是 3。

    一个请求里每个风格只贡献一次线路失败，阈值定高了前几个风格都会在死线路上
    把重试预算烧完，备用线路根本轮不到。默认值必须让降级在第一次失败就发生。
    """
    assert DEFAULT_FAILURE_THRESHOLD == 1
    failing = _StubProvider(
        "primary",
        ProviderError("UPSTREAM_TIMEOUT", "超时", retryable=True),
    )
    standby = _StubProvider("standby")
    provider = FailoverImageProvider(
        [GenerationLine("primary-row", failing), GenerationLine("standby-row", standby)],
        CircuitBreaker(),
    )

    await provider.generate(b"photo", "image/png", "提示", "ink")

    # The next style skips the dead line entirely.
    await provider.generate(b"photo", "image/png", "提示", "ink")
    assert failing.calls == 1
    assert standby.calls == 2


def test_factory_reuses_the_supplied_transport() -> None:
    """Transport injection is how tests intercept upstream calls."""
    transport = httpx.MockTransport(lambda request: httpx.Response(200))
    provider = create_provider(
        _settings(),
        provider_key="gpt-image-2",
        transport=transport,
    )
    assert provider.transport is transport


def test_row_resilience_columns_reach_the_runtime_config() -> None:
    """重试与熔断参数来自数据库行，不再来自环境变量。"""
    config = to_image_generation_runtime_config(
        _image_row(max_attempts=2, failure_threshold=5, cooldown_seconds=30)
    )

    assert config.max_attempts == 2
    assert config.failure_threshold == 5
    assert config.cooldown_seconds == 30.0


def test_row_resilience_columns_fall_back_to_code_defaults_when_null() -> None:
    """存量行这三列为 NULL，必须回落到代码默认值而不是报错。"""
    config = to_image_generation_runtime_config(_image_row())

    assert config.max_attempts == DEFAULT_MAX_ATTEMPTS
    assert config.failure_threshold == DEFAULT_FAILURE_THRESHOLD
    assert config.cooldown_seconds == DEFAULT_COOLDOWN_SECONDS


def test_non_positive_resilience_values_do_not_disable_the_guard() -> None:
    """0 或负数会被清洗成默认值，而不是让重试与熔断静默失效。"""
    config = to_image_generation_runtime_config(
        _image_row(max_attempts=0, failure_threshold=-1, cooldown_seconds=0)
    )

    assert config.max_attempts == DEFAULT_MAX_ATTEMPTS
    assert config.failure_threshold == DEFAULT_FAILURE_THRESHOLD
    assert config.cooldown_seconds == DEFAULT_COOLDOWN_SECONDS


@pytest.mark.asyncio
async def test_retry_operation_honours_the_row_attempt_budget() -> None:
    """行里的重试次数直接决定上游被调用几次。"""
    calls = 0

    async def _always_fails() -> str:
        nonlocal calls
        calls += 1
        raise ProviderError("UPSTREAM_TRANSIENT", "瞬时错误", retryable=True)

    with pytest.raises(ProviderError):
        await retry_operation(_always_fails, max_attempts=2)

    assert calls == 2
