from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, Header, UploadFile
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..api.errors import ApiError
from ..config import Settings
from ..db.models import Asset
from ..dependencies import create_db_dependency
from ..domain.generation_service import GenerationResult, GenerationService
from ..model_configs import (
    DEFAULT_PROVIDER_KEY,
    IMAGE_GENERATION,
    VISION_ANALYSIS,
    agent_configs_available,
    get_default_model_config,
)
from ..providers.factory import create_provider
from ..repositories.generation_repository import GenerationRepository
from ..security.entitlement_auth import require_entitlement
from ..storage.assets import AssetStore
from ..storage.images import validate_image_bytes


def _session_id(value: str) -> str:
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        raise ApiError("INVALID_INPUT", "体验会话无效", 400) from None
    if str(parsed) != value.lower():
        raise ApiError("INVALID_INPUT", "体验会话无效", 400)
    return value


def _generation_id(value: str) -> str:
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        raise ApiError("INVALID_INPUT", "生图任务 ID 无效", 400) from None
    if str(parsed) != value.lower():
        raise ApiError("INVALID_INPUT", "生图任务 ID 无效", 400)
    return value


async def _read_photo(photo: UploadFile, max_bytes: int) -> tuple[bytes, str]:
    content = await photo.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise ApiError("INVALID_INPUT", "照片尺寸过大，请重新拍摄", 400)
    info = validate_image_bytes(content, max_bytes)
    return content, info.mime_type


def _response(result: GenerationResult) -> dict[str, object]:
    data: dict[str, object] = {
        "provider": result.provider,
        "assets": result.assets,
    }
    if result.prompt is not None:
        data["prompt"] = result.prompt
    if result.failures:
        # Partial success: the visitor still gets the images that landed,
        # and the client can offer a retry for the ones that did not.
        data["failures"] = result.failures
    return data


def create_generation_router(
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
    asset_store: AssetStore,
) -> APIRouter:
    router = APIRouter()
    db = create_db_dependency(session_factory)
    # Only a transport carrier and a last-resort name now: the vendor actually
    # used is resolved per request from the database inside GenerationService.
    provider = create_provider(settings, provider_key=DEFAULT_PROVIDER_KEY)
    service = GenerationService(settings, provider, asset_store)
    repository = GenerationRepository()

    @router.post("/api/generation")
    async def generation(
        photo: UploadFile = File(...),
        session_id: str = Form(..., alias="sessionId"),
        generation_id: str = Form(..., alias="generationId"),
        styles: str = Form(...),
        entitlement_token: str | None = Header(
            default=None,
            alias="X-Entitlement-Token",
        ),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _session_id(session_id)
        _generation_id(generation_id)
        try:
            parsed_styles = json.loads(styles)
        except json.JSONDecodeError:
            raise ApiError("INVALID_INPUT", "风格参数无效", 400) from None
        if not isinstance(parsed_styles, list) or not all(
            isinstance(item, dict) and isinstance(item.get("id"), str)
            for item in parsed_styles
        ):
            raise ApiError("INVALID_INPUT", "风格参数无效", 400)
        content, mime_type = await _read_photo(photo, settings.ai_max_input_bytes)
        principal = await require_entitlement(session, entitlement_token)
        if principal.entitlement.session_id != session_id:
            raise ApiError("UNAUTHORIZED", "体验权益令牌与会话不匹配", 403)
        result = await service.generate_classic(
            session,
            entitlement=principal.entitlement,
            session_id=session_id,
            generation_id=generation_id,
            photo=content,
            photo_mime=mime_type,
            style_ids=[item["id"] for item in parsed_styles],
        )
        return _response(result)

    @router.post("/api/agent/generation")
    async def agent_generation(
        photo: UploadFile = File(...),
        session_id: str = Form(..., alias="sessionId"),
        generation_id: str = Form(..., alias="generationId"),
        background_id: str = Form(..., alias="backgroundId"),
        entitlement_token: str | None = Header(
            default=None,
            alias="X-Entitlement-Token",
        ),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _session_id(session_id)
        _generation_id(generation_id)
        content, mime_type = await _read_photo(photo, settings.ai_max_input_bytes)
        principal = await require_entitlement(session, entitlement_token)
        if principal.entitlement.session_id != session_id:
            raise ApiError("UNAUTHORIZED", "体验权益令牌与会话不匹配", 403)
        vision_config = await get_default_model_config(session, VISION_ANALYSIS)
        image_config = await get_default_model_config(session, IMAGE_GENERATION)
        if not agent_configs_available(
            settings=settings,
            vision_config=vision_config,
            image_config=image_config,
        ):
            raise ApiError("CONFIG_ERROR", "当前配置未启用 Agent 智能生图", 503)
        result = await service.generate_agent(
            session,
            entitlement=principal.entitlement,
            session_id=session_id,
            generation_id=generation_id,
            photo=content,
            photo_mime=mime_type,
            background_id=background_id,
        )
        return _response(result)

    @router.get("/api/assets/{asset_id}")
    async def asset(asset_id: str) -> Response:
        try:
            value = uuid.UUID(asset_id)
        except ValueError:
            return Response(status_code=404)
        async with session_factory() as session:
            row = await session.get(Asset, str(value))
        if row is None or row.expires_at <= datetime.now(timezone.utc).replace(tzinfo=None):
            return Response(status_code=404)
        try:
            saved = asset_store.read(row.file_path)
        except FileNotFoundError:
            return Response(status_code=404)
        return Response(
            content=saved.data,
            media_type=saved.mime_type,
            headers={"Cache-Control": "private, max-age=3600"},
        )

    return router
