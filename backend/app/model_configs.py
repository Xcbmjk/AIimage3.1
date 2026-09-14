from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .api.errors import ApiError
from .db.models import ModelConfig
from .providers.errors import map_provider_status
from .lib.urls import endpoint_url

VISION_ANALYSIS = "vision_analysis"
IMAGE_GENERATION = "image_generation"
SUPPORTED_MODEL_TYPES = {VISION_ANALYSIS, IMAGE_GENERATION}

# Every image provider implementation shipped in backend/app/providers. The
# `model_configs.provider` column is a free-form vendor label (deepcoding,
# tokenworldai, NewAPI...). A stored value is only treated as an implementation
# selector when it matches one of these keys; anything else follows the
# OpenAI-compatible Images API, which is what the administrator form builds.
PROVIDER_KEYS = frozenset(
    {
        "mock",
        "gpt-image-2",
        "gpt-image-2-url",
        "seedream",
        "jimeng-i2i",
        "gemini-3.1-flash-image",
    }
)
# The subset a database row may actually select, and the only values the admin
# console offers. The product currently targets gpt-image-2 alone, so the other
# implementations stay in the repository for future use but are unreachable
# from configuration: a row naming one degrades to the default implementation
# instead of switching protocols. Keep this in sync with PROVIDER_KEY_OPTIONS
# in src/admin/AdminApp.tsx.
SELECTABLE_PROVIDER_KEYS = frozenset({"mock", "gpt-image-2"})
# Matches the implementation the database path already used: classic mode posts
# the visitor photo to /images/edits. The lookalike ``gpt-image-2-url`` key is a
# different protocol (text-only /images/generations) and must stay opt-in.
DEFAULT_PROVIDER_KEY = "gpt-image-2"
MOCK_PROVIDER_KEY = "mock"

# Per-line resilience defaults, used when a model_configs row leaves the column
# empty. These are deliberately code constants rather than environment settings:
# everything an operator tunes about a vendor line lives in the database row.
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_FAILURE_THRESHOLD = 1
DEFAULT_COOLDOWN_SECONDS = 60.0


@dataclass(frozen=True)
class VisionRuntimeConfig:
    base_url: str
    endpoint: str
    model_name: str
    api_key: str
    timeout_ms: int


@dataclass(frozen=True)
class ImageGenerationRuntimeConfig:
    base_url: str
    generation_endpoint: str
    edit_endpoint: str
    model_name: str
    api_key: str
    size: str
    response_format: str
    timeout_ms: int
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    failure_threshold: int = DEFAULT_FAILURE_THRESHOLD
    cooldown_seconds: float = DEFAULT_COOLDOWN_SECONDS


def validate_model_config_input(
    *,
    name: str,
    model_type: str,
    provider: str,
    base_url: str,
    endpoint: str,
    model_name: str,
    api_key: str,
    timeout_ms: int,
) -> None:
    if model_type not in SUPPORTED_MODEL_TYPES:
        raise ApiError("INVALID_INPUT", "模型类型不受支持", 400)
    parsed = urlparse(base_url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ApiError("INVALID_INPUT", "接口地址必须是 HTTP 或 HTTPS URL", 400)
    if not endpoint.strip().startswith("/"):
        raise ApiError("INVALID_INPUT", "接口路径必须以 / 开头", 400)
    if not name.strip() or not provider.strip() or not model_name.strip() or not api_key.strip():
        raise ApiError("INVALID_INPUT", "模型名称、供应商、模型名和 Key 不能为空", 400)
    if timeout_ms < 1 or timeout_ms > 600_000:
        raise ApiError("INVALID_INPUT", "请求超时必须在 1 到 600000 毫秒之间", 400)


def to_vision_runtime_config(row: ModelConfig) -> VisionRuntimeConfig:
    return VisionRuntimeConfig(
        base_url=row.base_url,
        endpoint=row.endpoint,
        model_name=row.model_name,
        api_key=row.api_key,
        timeout_ms=row.timeout_ms,
    )


def _positive_number(value: object, default: float) -> float:
    """Coerce a stored column to a usable positive number.

    The resilience columns are nullable so rows that predate them keep working:
    a NULL, a non-numeric value or a non-positive one falls back to the code
    default rather than silently disabling the guard it configures.
    """
    if isinstance(value, bool) or value is None:
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def to_image_generation_runtime_config(row: ModelConfig) -> ImageGenerationRuntimeConfig:
    extra = row.extra_config or {}
    return ImageGenerationRuntimeConfig(
        base_url=row.base_url,
        generation_endpoint=str(extra.get("generationEndpoint") or "/images/generations"),
        edit_endpoint=row.endpoint or "/images/edits",
        model_name=row.model_name,
        api_key=row.api_key,
        size=str(extra.get("size") or "2K"),
        response_format="b64_json",
        timeout_ms=row.timeout_ms,
        max_attempts=int(
            _positive_number(row.max_attempts, DEFAULT_MAX_ATTEMPTS)
        ),
        failure_threshold=int(
            _positive_number(row.failure_threshold, DEFAULT_FAILURE_THRESHOLD)
        ),
        cooldown_seconds=_positive_number(
            row.cooldown_seconds, DEFAULT_COOLDOWN_SECONDS
        ),
    )


def resolve_provider_key(row: ModelConfig) -> str:
    """Map a stored configuration row to a provider implementation key.

    The column stays administrator-editable free text so a vendor label such as
    ``deepcoding`` keeps its meaning in the console and in logs. Only values in
    ``SELECTABLE_PROVIDER_KEYS`` select an implementation; every other label —
    including implementations that ship but are not currently offered — is an
    OpenAI-compatible Images API endpoint, matching the shape of the form.
    """
    value = (row.provider or "").strip().lower()
    if value in SELECTABLE_PROVIDER_KEYS:
        return value
    return DEFAULT_PROVIDER_KEY


async def get_default_model_config(
    session: AsyncSession,
    model_type: str,
) -> ModelConfig | None:
    return await session.scalar(
        select(ModelConfig)
        .where(
            ModelConfig.model_type == model_type,
            ModelConfig.enabled.is_(True),
            ModelConfig.is_default.is_(True),
        )
        .order_by(ModelConfig.updated_at.desc())
        .limit(1)
    )


async def get_active_model_configs(
    session: AsyncSession,
    model_type: str,
) -> list[ModelConfig]:
    """Return usable rows ordered primary-first, followers by recency.

    The default row is the primary line. Every other enabled row is a standby
    answer for the same protocol, so a failing vendor can be skipped without an
    administrator editing the database during an incident.
    """
    rows = list(
        (
            await session.scalars(
                select(ModelConfig)
                .where(
                    ModelConfig.model_type == model_type,
                    ModelConfig.enabled.is_(True),
                )
                .order_by(
                    ModelConfig.is_default.desc(),
                    ModelConfig.updated_at.desc(),
                )
            )
        ).all()
    )
    return rows


def agent_configs_available(
    *,
    settings,
    vision_config: ModelConfig | None,
    image_config: ModelConfig | None,
) -> bool:
    """Whether Agent mode can run.

    Tests carry no configuration row, and generation falls back to the mock
    provider there, so Agent is available by construction. Anywhere else the
    administrator must have both a vision row and an image row published.
    """
    if settings.app_env == "test":
        return True
    return vision_config is not None and image_config is not None


async def set_default_model_config(
    session: AsyncSession,
    row: ModelConfig,
) -> None:
    await session.execute(
        update(ModelConfig)
        .where(
            ModelConfig.model_type == row.model_type,
            ModelConfig.id != row.id,
        )
        .values(is_default=False)
    )
    row.is_default = True


def _model_ids(payload: object) -> list[str]:
    values = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(values, list):
        return []
    result: list[str] = []
    for item in values:
        value = item.get("id") if isinstance(item, dict) else item
        if isinstance(value, str) and value.strip():
            result.append(value.strip()[:160])
    return list(dict.fromkeys(result))[:200]


async def fetch_available_models(
    *,
    base_url: str,
    api_key: str,
    timeout_ms: int,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[str]:
    try:
        async with httpx.AsyncClient(
            timeout=timeout_ms / 1000,
            follow_redirects=False,
            transport=transport,
        ) as client:
            response = await client.get(
                endpoint_url(base_url, "/models"),
                headers={"Authorization": f"Bearer {api_key}"},
            )
    except httpx.TimeoutException as error:
        raise ApiError("MODEL_TIMEOUT", "获取模型列表超时", 504, True) from error
    except httpx.NetworkError as error:
        raise ApiError("MODEL_UNAVAILABLE", "模型服务无法连接", 502, True) from error
    if not response.is_success:
        mapped = map_provider_status(response.status_code, "vision")
        raise ApiError(mapped.code, "获取模型列表失败", 502, mapped.retryable)
    try:
        models = _model_ids(response.json())
    except ValueError:
        models = []
    if not models:
        raise ApiError("MODEL_BAD_RESPONSE", "模型服务未返回可用模型", 502)
    return models


async def test_model_connection(
    *,
    base_url: str,
    api_key: str,
    timeout_ms: int,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[str]:
    return await fetch_available_models(
        base_url=base_url,
        api_key=api_key,
        timeout_ms=timeout_ms,
        transport=transport,
    )
