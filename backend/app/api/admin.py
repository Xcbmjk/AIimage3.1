from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..api.errors import ApiError
from ..config import Settings
from ..db.models import (
    AdminUser,
    Asset,
    AuditLog,
    BackgroundVersion,
    Entitlement,
    GenerationJob,
    GenerationStyle,
    ModelConfig,
    RedeemCode,
    StyleVersion,
)
from ..dependencies import create_db_dependency
from ..domain.entitlement_service import utc_now
from ..jobs.generation_queue import GenerationQueue
from ..security.admin_auth import AdminAuth, AdminPrincipal
from ..storage.assets import AssetStore
from ..storage.images import validate_image_bytes
from ..vision.analyze import analyze_background_prompt, compose_fallback_prompt
from ..model_configs import (
    IMAGE_GENERATION,
    MOCK_PROVIDER_KEY,
    SUPPORTED_MODEL_TYPES,
    VISION_ANALYSIS,
    agent_configs_available,
    fetch_available_models,
    get_default_model_config,
    resolve_provider_key,
    set_default_model_config,
    to_vision_runtime_config,
    validate_model_config_input,
)

STYLE_ID_PATTERN = re.compile(r"^[a-z0-9-]{1,80}$")
ASSET_PATH_PATTERN = re.compile(r"^(style|background)/[a-f0-9-]{36}\.(jpg|png|webp)$")
ALLOWED_IMAGE_MIME = {"image/jpeg", "image/png", "image/webp"}


class RetryRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class StyleInput(BaseModel):
    version: int | None = Field(default=None, ge=1)
    styleId: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=120)
    subtitle: str = Field(default="", max_length=255)
    description: str = Field(default="", max_length=2000)
    prompt: str = Field(min_length=1, max_length=12000)
    mode: str
    palette: list[str]
    motif: str = Field(default="", max_length=40)
    previewPath: str | None = Field(default=None, max_length=500)
    previewData: str | None = Field(default=None, max_length=5 * 1024 * 1024)
    sortOrder: int = Field(default=0, ge=0, le=10000)
    enabled: bool = True

    @field_validator("styleId")
    @classmethod
    def valid_style_id(cls, value: str) -> str:
        value = value.strip()
        if not STYLE_ID_PATTERN.fullmatch(value):
            raise ValueError("风格 ID 格式无效")
        return value

    @field_validator("mode")
    @classmethod
    def valid_mode(cls, value: str) -> str:
        if value not in {"realistic", "artistic"}:
            raise ValueError("风格模式无效")
        return value

    @field_validator("palette")
    @classmethod
    def valid_palette(cls, value: list[str]) -> list[str]:
        if len(value) != 3 or any(not re.fullmatch(r"#[0-9a-fA-F]{6}", item) for item in value):
            raise ValueError("调色板必须包含三个颜色")
        return value

    @field_validator("previewPath")
    @classmethod
    def valid_preview_path(cls, value: str | None) -> str | None:
        if value and not (value.startswith("data:") or ASSET_PATH_PATTERN.fullmatch(value)):
            raise ValueError("风格预览图片路径无效")
        return value


class BackgroundInput(BaseModel):
    version: int | None = Field(default=None, ge=1)
    backgroundId: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=120)
    subtitle: str = Field(default="", max_length=255)
    description: str = Field(default="", max_length=2000)
    poseHint: str = Field(min_length=1, max_length=2000)
    imagePath: str = Field(min_length=1, max_length=500)
    sortOrder: int = Field(default=0, ge=0, le=10000)
    enabled: bool = True

    @field_validator("backgroundId")
    @classmethod
    def valid_background_id(cls, value: str) -> str:
        value = value.strip()
        if not STYLE_ID_PATTERN.fullmatch(value):
            raise ValueError("背景 ID 格式无效")
        return value

    @field_validator("imagePath")
    @classmethod
    def valid_image_path(cls, value: str) -> str:
        if not ASSET_PATH_PATTERN.fullmatch(value) or not value.startswith("background/"):
            raise ValueError("背景图片路径无效")
        return value


class VersionRequest(BaseModel):
    version: int = Field(ge=1)


class ModelConfigInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    modelType: str = Field(default=VISION_ANALYSIS, min_length=1, max_length=40)
    provider: str = Field(min_length=1, max_length=80)
    baseUrl: str = Field(min_length=1, max_length=500)
    endpoint: str = Field(default="/chat/completions", min_length=1, max_length=200)
    modelName: str = Field(min_length=1, max_length=160)
    apiKey: str = Field(min_length=1, max_length=10000)
    timeoutMs: int = Field(default=60000, ge=1, le=600000)
    # Per-line resilience. null means "use the code default"; the request budget
    # is finite, so the ranges stay deliberately narrow.
    maxAttempts: int | None = Field(default=None, ge=1, le=5)
    failureThreshold: int | None = Field(default=None, ge=1, le=20)
    cooldownSeconds: int | None = Field(default=None, ge=1, le=3600)
    extraConfig: dict[str, object] | None = None
    enabled: bool = True
    isDefault: bool = False


class ModelConnectionInput(BaseModel):
    modelType: str = Field(default=VISION_ANALYSIS, min_length=1, max_length=40)
    baseUrl: str = Field(min_length=1, max_length=500)
    apiKey: str = Field(min_length=1, max_length=10000)
    timeoutMs: int = Field(default=60000, ge=1, le=600000)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.replace(tzinfo=None).isoformat(timespec="milliseconds") + "Z"


def _require(principal: AdminPrincipal, permission: str) -> None:
    if permission not in principal.permissions:
        raise ApiError("ADMIN_FORBIDDEN", "当前账号无权执行此操作", 403)


def _style_dict(row: StyleVersion, asset_store: AssetStore) -> dict[str, object]:
    try:
        palette = json.loads(row.palette_json or "[]")
    except json.JSONDecodeError:
        palette = []
    preview_path = row.preview_data or row.cover_path
    preview_url = preview_path
    if row.cover_path:
        asset_id = row.cover_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        preview_url = f"/api/admin/style-assets/{asset_id}"
    return {
        "id": row.id,
        "styleId": row.style_id,
        "version": row.version,
        "name": row.name,
        "subtitle": row.subtitle,
        "description": row.description,
        "prompt": row.prompt,
        "mode": row.mode,
        "enabled": row.enabled,
        "sortOrder": row.sort_order,
        "status": row.status,
        "motif": row.motif,
        "paletteJson": json.dumps(palette, ensure_ascii=False),
        "previewPath": preview_path,
        "previewUrl": preview_url,
        "createdAt": _iso(row.created_at),
        "publishedAt": _iso(row.published_at),
    }


def _background_dict(row: BackgroundVersion) -> dict[str, object]:
    asset_id = row.image_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return {
        "id": row.id,
        "backgroundId": row.background_id,
        "version": row.version,
        "name": row.name,
        "subtitle": row.subtitle,
        "description": row.description,
        "poseHint": row.pose_hint,
        "analysisPrompt": row.analysis_prompt,
        "imagePath": row.image_path,
        "imageMime": row.image_mime,
        "enabled": row.enabled,
        "sortOrder": row.sort_order,
        "analysisStatus": row.analysis_status,
        "status": row.status,
        "previewUrl": f"/api/admin/background-assets/{asset_id}",
        "createdAt": _iso(row.created_at),
        "analyzedAt": _iso(row.analyzed_at),
        "publishedAt": _iso(row.published_at),
    }


def _model_config_dict(row: ModelConfig) -> dict[str, object]:
    return {
        "id": row.id,
        "name": row.name,
        "modelType": row.model_type,
        "provider": row.provider,
        "baseUrl": row.base_url,
        "endpoint": row.endpoint,
        "modelName": row.model_name,
        "apiKey": row.api_key,
        "timeoutMs": row.timeout_ms,
        "maxAttempts": row.max_attempts,
        "failureThreshold": row.failure_threshold,
        "cooldownSeconds": row.cooldown_seconds,
        "extraConfig": row.extra_config or {},
        "enabled": row.enabled,
        "isDefault": row.is_default,
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
    }


def _validate_model_type(model_type: str) -> None:
    if model_type not in SUPPORTED_MODEL_TYPES:
        raise ApiError("INVALID_INPUT", "模型类型不受支持", 400)


def _validate_image_config(payload: ModelConfigInput) -> None:
    if payload.modelType != "image_generation":
        return
    extra = payload.extraConfig or {}
    generation_endpoint = str(extra.get("generationEndpoint") or "/images/generations")
    size = str(extra.get("size") or "2K")
    response_format = str(extra.get("responseFormat") or "b64_json")
    if not generation_endpoint.startswith("/"):
        raise ApiError("INVALID_INPUT", "生图接口路径必须以 / 开头", 400)
    if size not in {"1K", "2K", "4K"}:
        raise ApiError("INVALID_INPUT", "图片尺寸必须是 1K、2K 或 4K", 400)
    if response_format != "b64_json":
        raise ApiError("INVALID_INPUT", "图片模型只支持 b64_json 响应", 400)

async def _audit(
    session: AsyncSession,
    principal: AdminPrincipal,
    *,
    action: str,
    target_type: str,
    target_id: str | None = None,
    reason: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    session.add(
        AuditLog(
            actor_user_id=principal.user_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            reason=reason,
            metadata_json=metadata,
            created_at=utc_now(),
        )
    )
    await session.flush()


def create_admin_router(
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
    asset_store: AssetStore,
) -> APIRouter:
    router = APIRouter()
    db = create_db_dependency(session_factory)
    auth = AdminAuth(settings, session_factory)
    require_admin = auth.dependency()
    queue = GenerationQueue()

    @router.get("/api/admin/summary")
    async def summary(
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "read")
        counts = {
            "entitlements": await session.scalar(select(func.count()).select_from(Entitlement)) or 0,
            "activeEntitlements": await session.scalar(
                select(func.count()).select_from(Entitlement).where(Entitlement.status == "active")
            ) or 0,
            "generationTotal": await session.scalar(select(func.count()).select_from(GenerationJob)) or 0,
            "generationSucceeded": await session.scalar(
                select(func.count()).select_from(GenerationJob).where(GenerationJob.status == "succeeded")
            ) or 0,
            "generationFailed": await session.scalar(
                select(func.count()).select_from(GenerationJob).where(
                    GenerationJob.status.in_(["failed", "uncertain"])
                )
            ) or 0,
            "stylesPublished": await session.scalar(
                select(func.count()).select_from(StyleVersion).where(
                    StyleVersion.status == "published", StyleVersion.enabled.is_(True)
                )
            ) or 0,
            "backgroundsPublished": await session.scalar(
                select(func.count()).select_from(BackgroundVersion).where(
                    BackgroundVersion.status == "published",
                    BackgroundVersion.enabled.is_(True),
                    BackgroundVersion.analysis_status == "ready",
                )
            ) or 0,
        }
        latest_jobs = list(
            (
                await session.scalars(
                    select(GenerationJob).order_by(desc(GenerationJob.created_at)).limit(8)
                )
            ).all()
        )
        image_config = await get_default_model_config(session, IMAGE_GENERATION)
        return {
            "provider": (
                resolve_provider_key(image_config)
                if image_config is not None
                else MOCK_PROVIDER_KEY
                if settings.app_env == "test"
                else None
            ),
            "database": "mysql" if settings.mysql_enabled else "sqlite-test",
            "totals": counts,
            "recentGenerations": [_generation_dict(job) for job in latest_jobs],
        }

    @router.get("/api/admin/dashboard")
    async def dashboard(
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "read")
        result = await summary(principal, session)
        result["serverTime"] = _iso(utc_now())
        return result

    @router.get("/api/admin/entitlements")
    async def entitlements(
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "read")
        rows = list(
            (
                await session.scalars(
                    select(Entitlement).order_by(desc(Entitlement.created_at)).limit(200)
                )
            ).all()
        )
        return {
            "entitlements": [
                {
                    "id": row.id,
                    "sessionId": row.session_id,
                    "status": row.status,
                    "maxStyles": row.max_styles,
                    "generationId": row.generation_id,
                    "expiresAt": _iso(row.expires_at),
                    "createdAt": _iso(row.created_at),
                    "consumedAt": _iso(row.consumed_at),
                }
                for row in rows
            ]
        }

    @router.get("/api/admin/generations")
    async def generations(
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "read")
        jobs = list(
            (
                await session.scalars(
                    select(GenerationJob).order_by(desc(GenerationJob.created_at)).limit(200)
                )
            ).all()
        )
        return {"generations": [_generation_dict(job) for job in jobs]}

    @router.get("/api/admin/gallery")
    async def gallery(
        q: str | None = None,
        limit: int = 120,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        """生图作品库：列出已生成的图片及其兑换码前缀。

        兑换码明文不入库（只存哈希），因此这里只能给出前缀，用于和游客手上的
        实体票根核对；需要精确追溯时用会话 ID 或任务 ID 检索。
        """
        _require(principal, "read")
        size = max(1, min(limit, 300))
        statement = (
            select(Asset, GenerationJob, RedeemCode)
            .join(GenerationJob, GenerationJob.id == Asset.generation_id)
            .join(Entitlement, Entitlement.id == GenerationJob.entitlement_id)
            .outerjoin(RedeemCode, RedeemCode.id == Entitlement.redeem_code_id)
            .order_by(desc(Asset.created_at))
            .limit(size)
        )
        keyword = (q or "").strip()
        if keyword:
            pattern = f"%{keyword}%"
            statement = statement.where(
                or_(
                    RedeemCode.code_prefix.ilike(pattern),
                    GenerationJob.session_id.ilike(pattern),
                    Asset.generation_id == keyword,
                    Asset.id == keyword,
                    Asset.style_id.ilike(pattern),
                )
            )
        rows = (await session.execute(statement)).all()
        total_bytes = sum(int(row[0].byte_size) for row in rows)
        return {
            "items": [
                {
                    "assetId": asset.id,
                    "url": f"/api/assets/{asset.id}",
                    "styleId": asset.style_id,
                    "mimeType": asset.mime_type,
                    "byteSize": int(asset.byte_size),
                    "createdAt": _iso(asset.created_at),
                    "expiresAt": _iso(asset.expires_at),
                    "generationId": job.id,
                    "mode": job.mode,
                    "status": job.status,
                    "sessionId": job.session_id,
                    "redeemCodePrefix": code.code_prefix if code is not None else None,
                    "redeemCodeStatus": code.status if code is not None else None,
                }
                for asset, job, code in rows
            ],
            "total": len(rows),
            "totalBytes": total_bytes,
        }

    @router.post("/api/admin/generations/{generation_id}/retry", status_code=202)
    async def retry_generation(
        generation_id: str,
        payload: RetryRequest,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "retry")
        async with session.begin():
            job = await session.get(GenerationJob, generation_id, with_for_update=True)
            if job is None:
                raise ApiError("NOT_FOUND", "生图任务不存在", 404)
            if job.status not in {"failed", "uncertain"}:
                raise ApiError("GENERATION_NOT_RETRYABLE", "仅失败或待核查任务可重试", 409)
            if job.attempts >= 2:
                raise ApiError("RETRY_LIMIT_REACHED", "已达到最多 2 次重试", 409)
            if not await queue.retry(session, generation_id):
                raise ApiError("GENERATION_NOT_RETRYABLE", "任务无法重新加入队列", 409)
            await _audit(
                session,
                principal,
                action="generation.retry_requested",
                target_type="generation",
                target_id=job.id,
                reason=payload.reason,
            )
        return {"accepted": True, "generationId": generation_id, "attempts": job.attempts, "status": "queued"}

    @router.get("/api/admin/styles")
    async def styles(
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "read")
        rows = list(
            (
                await session.scalars(
                    select(StyleVersion).order_by(StyleVersion.sort_order, StyleVersion.style_id, desc(StyleVersion.version))
                )
            ).all()
        )
        return {"styles": [_style_dict(row, asset_store) for row in rows]}

    @router.post("/api/admin/style-assets", status_code=201)
    async def upload_style_asset(
        request: Request,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require_any(principal, "style:draft", "style:write")
        data = await request.body()
        mime = request.headers.get("content-type", "").split(";", 1)[0].lower()
        saved = _save_uploaded_asset(asset_store, data, mime, "style", 5 * 1024 * 1024)
        await _record_asset_audit(session, principal, "style.image_uploaded", saved.id)
        return {"assetId": saved.id, "path": saved.relative_path, "url": f"/api/catalog/style-assets/{saved.id}"}

    @router.get("/api/admin/style-assets/{asset_id}")
    async def admin_style_asset(
        asset_id: str,
        principal: AdminPrincipal = Depends(require_admin),
    ) -> Response:
        _require_any(principal, "style:draft", "style:write", "read")
        for extension in ("jpg", "png", "webp"):
            try:
                saved = asset_store.read(f"style/{asset_id}.{extension}", category="style")
                return Response(
                    content=saved.data,
                    media_type=saved.mime_type,
                    headers={"Cache-Control": "private, max-age=300"},
                )
            except FileNotFoundError:
                continue
        return Response(status_code=404)

    @router.post("/api/admin/styles", status_code=201)
    @router.post("/api/admin/styles/drafts", status_code=201)
    async def create_style(
        payload: StyleInput,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require_any(principal, "style:draft", "style:write")
        async with session.begin():
            latest = await session.scalar(
                select(func.max(StyleVersion.version)).where(StyleVersion.style_id == payload.styleId)
            )
            row = StyleVersion(
                style_id=payload.styleId,
                version=(latest or 0) + 1,
                name=payload.name.strip(),
                subtitle=payload.subtitle.strip(),
                description=payload.description.strip(),
                prompt=payload.prompt.strip(),
                cover_path=payload.previewPath if payload.previewPath and not payload.previewPath.startswith("data:") else None,
                preview_data=payload.previewData or (payload.previewPath if payload.previewPath and payload.previewPath.startswith("data:") else None),
                palette_json=json.dumps(payload.palette, ensure_ascii=False),
                motif=payload.motif.strip(),
                mode=payload.mode,
                enabled=payload.enabled,
                sort_order=payload.sortOrder,
                status="draft",
                created_by=principal.user_id,
                created_at=utc_now(),
            )
            session.add(row)
            await session.flush()
            await _audit(session, principal, action="style.draft_created", target_type="style", target_id=f"{row.style_id}@{row.version}")
        return {"styleId": row.style_id, "version": row.version, "status": row.status}

    @router.put("/api/admin/styles/{style_id}")
    async def update_style(
        style_id: str,
        payload: StyleInput,
        version: int = 0,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require_any(principal, "style:draft", "style:write")
        version = version or payload.version or 0
        if payload.styleId != style_id or version < 1:
            raise ApiError("INVALID_INPUT", "风格 ID 或版本无效", 400)
        async with session.begin():
            row = await session.scalar(
                select(StyleVersion).where(
                    StyleVersion.style_id == style_id, StyleVersion.version == version
                ).with_for_update()
            )
            if row is None:
                raise ApiError("NOT_FOUND", "风格版本不存在", 404)
            if row.status != "draft":
                raise ApiError("STYLE_VERSION_LOCKED", "已发布版本不可直接修改，请新建草稿版本", 409)
            _apply_style(row, payload)
            await _audit(session, principal, action="style.draft_updated", target_type="style", target_id=f"{style_id}@{version}")
        return {"styleId": style_id, "version": version, "status": "draft"}

    @router.delete("/api/admin/styles/{style_id}")
    async def archive_style(
        style_id: str,
        request: Request,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "style:write")
        body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
        async with session.begin():
            rows = list(
                (
                    await session.scalars(
                        select(StyleVersion).where(StyleVersion.style_id == style_id).with_for_update()
                    )
                ).all()
            )
            if not rows:
                raise ApiError("NOT_FOUND", "风格不存在", 404)
            for row in rows:
                row.enabled = False
                row.status = "archived"
            await _audit(session, principal, action="style.archived", target_type="style", target_id=style_id, reason=body.get("reason"))
        return {"styleId": style_id, "status": "archived"}

    @router.post("/api/admin/styles/{style_id}/publish")
    async def publish_style(
        style_id: str,
        payload: VersionRequest,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "style:write")
        async with session.begin():
            target = await session.scalar(
                select(StyleVersion).where(
                    StyleVersion.style_id == style_id, StyleVersion.version == payload.version
                ).with_for_update()
            )
            if target is None:
                raise ApiError("NOT_FOUND", "风格版本不存在", 404)
            for row in (
                await session.scalars(
                    select(StyleVersion).where(
                        StyleVersion.style_id == style_id, StyleVersion.status == "published"
                    ).with_for_update()
                )
            ).all():
                row.status = "archived"
            target.status = "published"
            target.enabled = True
            target.published_at = utc_now()
            await _audit(session, principal, action="style.published", target_type="style", target_id=f"{style_id}@{target.version}")
        return {"styleId": style_id, "version": payload.version, "status": "published"}

    @router.post("/api/admin/styles/{style_id}/rollback")
    async def rollback_style(
        style_id: str,
        payload: VersionRequest,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "style:write")
        async with session.begin():
            target = await session.scalar(
                select(StyleVersion).where(
                    StyleVersion.style_id == style_id, StyleVersion.version == payload.version
                ).with_for_update()
            )
            if target is None:
                raise ApiError("NOT_FOUND", "风格版本不存在", 404)
            rows = (
                await session.scalars(
                    select(StyleVersion).where(StyleVersion.style_id == style_id).with_for_update()
                )
            ).all()
            for row in rows:
                row.status = "published" if row.id == target.id else "archived"
                row.enabled = row.id == target.id
            target.published_at = utc_now()
            await _audit(session, principal, action="style.rolled_back", target_type="style", target_id=f"{style_id}@{target.version}")
        return {"styleId": style_id, "version": payload.version, "status": "published"}

    @router.get("/api/admin/backgrounds")
    async def backgrounds(
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require_any(principal, "background:draft", "background:write", "style:draft", "style:write")
        rows = list(
            (
                await session.scalars(
                    select(BackgroundVersion).order_by(
                        BackgroundVersion.sort_order,
                        BackgroundVersion.background_id,
                        desc(BackgroundVersion.version),
                    )
                )
            ).all()
        )
        return {"backgrounds": [_background_dict(row) for row in rows]}

    @router.get("/api/admin/model-configs")
    async def model_configs(
        model_type: str = VISION_ANALYSIS,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "health:read")
        _validate_model_type(model_type)
        rows = list(
            (
                await session.scalars(
                    select(ModelConfig)
                    .where(ModelConfig.model_type == model_type)
                    .order_by(desc(ModelConfig.updated_at))
                )
            ).all()
        )
        return {"modelConfigs": [_model_config_dict(row) for row in rows]}

    @router.post("/api/admin/model-configs", status_code=201)
    async def create_model_config(
        payload: ModelConfigInput,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "health:write")
        _validate_model_type(payload.modelType)
        _validate_image_config(payload)
        validate_model_config_input(
            name=payload.name,
            model_type=payload.modelType,
            provider=payload.provider,
            base_url=payload.baseUrl,
            endpoint=payload.endpoint,
            model_name=payload.modelName,
            api_key=payload.apiKey,
            timeout_ms=payload.timeoutMs,
        )
        now = utc_now()
        async with session.begin():
            row = ModelConfig(
                id=str(uuid.uuid4()),
                name=payload.name.strip(),
                model_type=payload.modelType,
                provider=payload.provider.strip(),
                base_url=payload.baseUrl.strip().rstrip("/"),
                endpoint=payload.endpoint.strip(),
                model_name=payload.modelName.strip(),
                api_key=payload.apiKey,
                timeout_ms=payload.timeoutMs,
                max_attempts=payload.maxAttempts,
                failure_threshold=payload.failureThreshold,
                cooldown_seconds=payload.cooldownSeconds,
                extra_config=payload.extraConfig,
                enabled=payload.enabled,
                is_default=payload.enabled and payload.isDefault,
                created_by=principal.user_id,
                created_at=now,
                updated_at=now,
            )
            session.add(row)
            await session.flush()
            if row.is_default:
                await set_default_model_config(session, row)
            await _audit(session, principal, action="model_config.created", target_type="model_config", target_id=row.id)
        return _model_config_dict(row)

    @router.put("/api/admin/model-configs/{config_id}")
    async def update_model_config(
        config_id: str,
        payload: ModelConfigInput,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "health:write")
        _validate_model_type(payload.modelType)
        _validate_image_config(payload)
        validate_model_config_input(
            name=payload.name,
            model_type=payload.modelType,
            provider=payload.provider,
            base_url=payload.baseUrl,
            endpoint=payload.endpoint,
            model_name=payload.modelName,
            api_key=payload.apiKey,
            timeout_ms=payload.timeoutMs,
        )
        async with session.begin():
            row = await session.get(ModelConfig, config_id, with_for_update=True)
            if row is None:
                raise ApiError("NOT_FOUND", "模型配置不存在", 404)
            row.name = payload.name.strip()
            row.provider = payload.provider.strip()
            row.base_url = payload.baseUrl.strip().rstrip("/")
            row.endpoint = payload.endpoint.strip()
            row.model_name = payload.modelName.strip()
            row.api_key = payload.apiKey
            row.timeout_ms = payload.timeoutMs
            row.max_attempts = payload.maxAttempts
            row.failure_threshold = payload.failureThreshold
            row.cooldown_seconds = payload.cooldownSeconds
            row.extra_config = payload.extraConfig
            row.enabled = payload.enabled
            row.is_default = payload.enabled and payload.isDefault
            row.updated_at = utc_now()
            if row.is_default:
                await set_default_model_config(session, row)
            await _audit(session, principal, action="model_config.updated", target_type="model_config", target_id=row.id)
        return _model_config_dict(row)

    @router.post("/api/admin/model-configs/{config_id}/default")
    async def default_model_config(
        config_id: str,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "health:write")
        async with session.begin():
            row = await session.get(ModelConfig, config_id, with_for_update=True)
            if row is None or row.model_type not in SUPPORTED_MODEL_TYPES:
                raise ApiError("NOT_FOUND", "模型配置不存在", 404)
            if not row.enabled:
                raise ApiError("INVALID_INPUT", "停用的模型不能设为默认", 409)
            await set_default_model_config(session, row)
            row.updated_at = utc_now()
            await _audit(session, principal, action="model_config.default_changed", target_type="model_config", target_id=row.id)
        return {"id": row.id, "isDefault": True}

    @router.post("/api/admin/model-configs/{config_id}/toggle")
    async def toggle_model_config(
        config_id: str,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "health:write")
        async with session.begin():
            row = await session.get(ModelConfig, config_id, with_for_update=True)
            if row is None or row.model_type not in SUPPORTED_MODEL_TYPES:
                raise ApiError("NOT_FOUND", "模型配置不存在", 404)
            row.enabled = not row.enabled
            if not row.enabled:
                row.is_default = False
            row.updated_at = utc_now()
            await _audit(session, principal, action="model_config.toggled", target_type="model_config", target_id=row.id, metadata={"enabled": row.enabled})
        return {"id": row.id, "enabled": row.enabled, "isDefault": row.is_default}

    @router.post("/api/admin/model-configs/discover")
    async def discover_model_configs(
        payload: ModelConnectionInput,
        principal: AdminPrincipal = Depends(require_admin),
    ) -> dict[str, object]:
        _require(principal, "health:write")
        _validate_model_type(payload.modelType)
        validate_model_config_input(
            name="temporary",
            model_type=payload.modelType,
            provider="temporary",
            base_url=payload.baseUrl,
            endpoint="/models",
            model_name="temporary",
            api_key=payload.apiKey,
            timeout_ms=payload.timeoutMs,
        )
        models = await fetch_available_models(
            base_url=payload.baseUrl,
            api_key=payload.apiKey,
            timeout_ms=payload.timeoutMs,
        )
        return {"models": models}

    @router.post("/api/admin/model-configs/{config_id}/test")
    async def test_model_config(
        config_id: str,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "health:write")
        row = await session.get(ModelConfig, config_id)
        if row is None or row.model_type not in SUPPORTED_MODEL_TYPES:
            raise ApiError("NOT_FOUND", "模型配置不存在", 404)
        models = await fetch_available_models(
            base_url=row.base_url,
            api_key=row.api_key,
            timeout_ms=row.timeout_ms,
        )
        return {"connected": True, "models": models}

    @router.post("/api/admin/background-assets", status_code=201)
    async def upload_background_asset(
        request: Request,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require_any(principal, "background:draft", "background:write", "style:draft", "style:write")
        data = await request.body()
        mime = request.headers.get("content-type", "").split(";", 1)[0].lower()
        saved = _save_uploaded_asset(asset_store, data, mime, "background", 15 * 1024 * 1024)
        await _record_asset_audit(session, principal, "background.image_uploaded", saved.id)
        return {"assetId": saved.id, "path": saved.relative_path, "url": f"/api/catalog/background-assets/{saved.id}"}

    @router.get("/api/admin/background-assets/{asset_id}")
    async def admin_background_asset(
        asset_id: str,
        principal: AdminPrincipal = Depends(require_admin),
    ) -> Response:
        _require_any(principal, "background:draft", "background:write", "style:draft", "style:write")
        for extension in ("jpg", "png", "webp"):
            try:
                saved = asset_store.read(
                    f"background/{asset_id}.{extension}",
                    category="background",
                )
                return Response(
                    content=saved.data,
                    media_type=saved.mime_type,
                    headers={"Cache-Control": "private, max-age=300"},
                )
            except (FileNotFoundError, ValueError):
                continue
        return Response(status_code=404)

    @router.post("/api/admin/backgrounds", status_code=201)
    @router.post("/api/admin/backgrounds/drafts", status_code=201)
    async def create_background(
        payload: BackgroundInput,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require_any(principal, "background:draft", "background:write", "style:draft", "style:write")
        _validate_asset_reference(asset_store, payload.imagePath, "background")
        async with session.begin():
            latest = await session.scalar(
                select(func.max(BackgroundVersion.version)).where(
                    BackgroundVersion.background_id == payload.backgroundId
                )
            )
            row = BackgroundVersion(
                background_id=payload.backgroundId,
                version=(latest or 0) + 1,
                name=payload.name.strip(),
                subtitle=payload.subtitle.strip(),
                description=payload.description.strip() or payload.name.strip(),
                pose_hint=payload.poseHint.strip(),
                image_path=payload.imagePath,
                image_mime=_mime_from_path(payload.imagePath),
                enabled=payload.enabled,
                sort_order=payload.sortOrder,
                analysis_status="pending",
                status="draft",
                created_by=principal.user_id,
                created_at=utc_now(),
            )
            session.add(row)
            await session.flush()
            await _audit(session, principal, action="background.draft_created", target_type="background", target_id=f"{row.background_id}@{row.version}")
        return {"backgroundId": row.background_id, "version": row.version, "status": row.status}

    @router.put("/api/admin/backgrounds/{background_id}")
    async def update_background(
        background_id: str,
        payload: BackgroundInput,
        version: int = 0,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require_any(principal, "background:draft", "background:write", "style:draft", "style:write")
        version = version or payload.version or 0
        if payload.backgroundId != background_id or version < 1:
            raise ApiError("INVALID_INPUT", "背景 ID 或版本无效", 400)
        _validate_asset_reference(asset_store, payload.imagePath, "background")
        async with session.begin():
            row = await session.scalar(
                select(BackgroundVersion).where(
                    BackgroundVersion.background_id == background_id,
                    BackgroundVersion.version == version,
                ).with_for_update()
            )
            if row is None:
                raise ApiError("NOT_FOUND", "背景版本不存在", 404)
            if row.status != "draft":
                raise ApiError("BACKGROUND_VERSION_LOCKED", "已发布版本不可直接修改，请新建草稿版本", 409)
            row.name = payload.name.strip()
            row.subtitle = payload.subtitle.strip()
            row.description = payload.description.strip() or row.name
            row.pose_hint = payload.poseHint.strip()
            row.image_path = payload.imagePath
            row.image_mime = _mime_from_path(payload.imagePath)
            row.enabled = payload.enabled
            row.sort_order = payload.sortOrder
            row.analysis_status = "pending"
            row.analysis_prompt = None
            row.analyzed_at = None
            await _audit(session, principal, action="background.draft_updated", target_type="background", target_id=f"{background_id}@{version}")
        return {"backgroundId": background_id, "version": version, "status": "draft"}

    @router.post("/api/admin/backgrounds/{background_id}/analyze")
    async def analyze_background(
        background_id: str,
        payload: VersionRequest,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require_any(principal, "background:draft", "background:write", "style:draft", "style:write")
        row = await session.scalar(
            select(BackgroundVersion).where(
                BackgroundVersion.background_id == background_id,
                BackgroundVersion.version == payload.version,
            )
        )
        if row is None or row.status != "draft":
            raise ApiError("BACKGROUND_NOT_ANALYZABLE", "仅草稿背景可执行视觉理解", 409)
        row_id = row.id
        try:
            saved = asset_store.read(row.image_path, category="background")
            vision_config = await get_default_model_config(session, VISION_ANALYSIS)
            if settings.app_env == "test":
                prompt = compose_fallback_prompt(row.name, row.pose_hint)
            else:
                if vision_config is None:
                    raise ApiError("VISION_NOT_CONFIGURED", "请先配置默认视觉分析模型", 409)
                prompt = await analyze_background_prompt(
                    to_vision_runtime_config(vision_config),
                    background=saved.data or b"",
                    mime_type=row.image_mime,
                    background_name=row.name,
                    pose_hint=row.pose_hint,
                )
            await session.rollback()
            async with session.begin():
                locked = await session.get(BackgroundVersion, row_id, with_for_update=True)
                if locked is None:
                    raise ApiError("NOT_FOUND", "背景版本不存在", 404)
                locked.analysis_prompt = prompt
                locked.analysis_status = "ready"
                locked.analyzed_at = utc_now()
                await _audit(session, principal, action="background.analyzed", target_type="background", target_id=f"{background_id}@{payload.version}")
            return {
                "backgroundId": background_id,
                "version": payload.version,
                "analysisPrompt": prompt,
                "analysisStatus": "ready",
            }
        except ApiError:
            raise
        except Exception as error:
            await session.rollback()
            async with session.begin():
                locked = await session.get(BackgroundVersion, row_id, with_for_update=True)
                if locked is not None:
                    locked.analysis_status = "failed"
            raise ApiError("ANALYSIS_FAILED", str(error) or "视觉理解失败", 502) from error

    @router.post("/api/admin/backgrounds/{background_id}/publish")
    async def publish_background(
        background_id: str,
        payload: VersionRequest,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "background:write" if "background:write" in principal.permissions else "style:write")
        async with session.begin():
            target = await session.scalar(
                select(BackgroundVersion).where(
                    BackgroundVersion.background_id == background_id,
                    BackgroundVersion.version == payload.version,
                ).with_for_update()
            )
            if target is None:
                raise ApiError("NOT_FOUND", "背景版本不存在", 404)
            if target.analysis_status != "ready":
                raise ApiError("BACKGROUND_NOT_ANALYZED", "请先完成视觉理解再发布", 409)
            rows = (
                await session.scalars(
                    select(BackgroundVersion).where(
                        BackgroundVersion.background_id == background_id
                    ).with_for_update()
                )
            ).all()
            for row in rows:
                row.status = "published" if row.id == target.id else "archived"
                row.enabled = row.id == target.id
            target.published_at = utc_now()
            await _audit(session, principal, action="background.published", target_type="background", target_id=f"{background_id}@{target.version}")
        return {"backgroundId": background_id, "version": payload.version, "status": "published"}

    @router.get("/api/admin/health")
    async def admin_health(
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "health:read")
        vision_config = await get_default_model_config(session, VISION_ANALYSIS)
        image_config = await get_default_model_config(session, IMAGE_GENERATION)
        checks: dict[str, object] = {
            "api": {"status": "ok", "message": "Python API 服务正常"},
            "aiProvider": {
                "status": (
                    "ok"
                    if agent_configs_available(
                        settings=settings,
                        vision_config=vision_config,
                        image_config=image_config,
                    )
                    else "degraded"
                ),
                "details": {
                    "provider": (
                        resolve_provider_key(image_config)
                        if image_config is not None
                        else MOCK_PROVIDER_KEY
                        if settings.app_env == "test"
                        else None
                    ),
                },
            },
            "agentVision": {
                "status": "ok" if vision_config is not None else "degraded",
                "details": {
                    "configured": vision_config is not None,
                    "model": vision_config.model_name if vision_config else None,
                    "provider": vision_config.provider if vision_config else None,
                },
            },
        }
        try:
            await session.execute(select(func.count()).select_from(AdminUser))
            checks["mysql"] = {"status": "ok", "message": "数据库连接正常"}
        except Exception:
            checks["mysql"] = {"status": "down", "message": "数据库连接失败"}
        try:
            settings.ensure_directories()
            checks["storage"] = {"status": "ok", "message": "资产目录可用"}
        except OSError:
            checks["storage"] = {"status": "down", "message": "资产目录不可用"}
        checks["queue"] = {"status": "ok", "message": "任务记录可用"}
        ok = all(value["status"] in {"ok", "degraded"} for value in checks.values() if isinstance(value, dict))
        return {"status": "ok" if ok else "degraded", "ok": ok, "checks": checks}

    @router.get("/api/admin/audit-logs")
    async def audit_logs(
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict[str, object]:
        _require(principal, "audit:read")
        rows = list(
            (
                await session.execute(
                    select(AuditLog, AdminUser.username)
                    .outerjoin(AdminUser, AdminUser.id == AuditLog.actor_user_id)
                    .order_by(desc(AuditLog.created_at))
                    .limit(200)
                )
            ).all()
        )
        return {
            "logs": [
                {
                    "id": log.id,
                    "actor": username or "system",
                    "action": log.action,
                    "targetType": log.target_type,
                    "targetId": log.target_id,
                    "reason": log.reason,
                    "metadata": log.metadata_json,
                    "createdAt": _iso(log.created_at),
                }
                for log, username in rows
            ]
        }

    return router


def _require_any(principal: AdminPrincipal, *permissions: str) -> None:
    if not any(permission in principal.permissions for permission in permissions):
        raise ApiError("ADMIN_FORBIDDEN", "当前账号无权执行此操作", 403)


def _generation_dict(job: GenerationJob) -> dict[str, object]:
    return {
        "id": job.id,
        "sessionId": job.session_id,
        "mode": job.mode,
        "sceneId": job.scene_id,
        "backgroundId": job.background_id,
        "status": job.status,
        "errorCode": job.error_code,
        "attempts": job.attempts,
        "sourcePath": job.source_path,
        "createdAt": _iso(job.created_at),
        "startedAt": _iso(job.started_at),
        "completedAt": _iso(job.completed_at),
        "updatedAt": _iso(job.updated_at),
    }


def _apply_style(row: StyleVersion, payload: StyleInput) -> None:
    row.name = payload.name.strip()
    row.subtitle = payload.subtitle.strip()
    row.description = payload.description.strip()
    row.prompt = payload.prompt.strip()
    row.cover_path = payload.previewPath if payload.previewPath and not payload.previewPath.startswith("data:") else None
    row.preview_data = payload.previewData or (payload.previewPath if payload.previewPath and payload.previewPath.startswith("data:") else None)
    row.palette_json = json.dumps(payload.palette, ensure_ascii=False)
    row.motif = payload.motif.strip()
    row.mode = payload.mode
    row.enabled = payload.enabled
    row.sort_order = payload.sortOrder


def _mime_from_path(path: str) -> str:
    return {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[path.rsplit(".", 1)[-1]]


def _validate_asset_reference(asset_store: AssetStore, path: str, category: str) -> None:
    try:
        asset_store.read(path, category=category)
    except (FileNotFoundError, ValueError):
        raise ApiError("INVALID_INPUT", "图片素材不存在或格式不匹配", 400) from None


def _save_uploaded_asset(
    asset_store: AssetStore,
    data: bytes,
    mime: str,
    category: str,
    max_bytes: int,
):
    if not data or len(data) > max_bytes or mime not in ALLOWED_IMAGE_MIME:
        raise ApiError("INVALID_INPUT", "图片格式或尺寸不符合要求", 400)
    try:
        validate_image_bytes(data, max_bytes)
        return asset_store.save(data, mime, category, retention_days=3650)
    except ApiError:
        raise
    except Exception as error:
        raise ApiError("INVALID_INPUT", "图片格式或尺寸不符合要求", 400) from error


async def _record_asset_audit(
    session: AsyncSession,
    principal: AdminPrincipal,
    action: str,
    asset_id: str,
) -> None:
    async with session.begin():
        await _audit(
            session,
            principal,
            action=action,
            target_type="asset",
            target_id=asset_id,
        )
