from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .db.models import (
    AdminUser,
    Asset,
    BackgroundVersion,
    Entitlement,
    GenerationJob,
    GenerationStyle,
    RedeemCode,
    Share,
    StyleVersion,
)
from .domain.entitlement_service import utc_now

HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")
SESSION_ID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
STYLE_STATUSES = {"draft", "published", "archived"}
BACKGROUND_STATUSES = {"draft", "published", "archived"}
ANALYSIS_STATUSES = {"pending", "ready", "failed"}
REDEEM_STATUSES = {"available", "reserved", "redeemed", "disabled"}
GENERATION_STATUSES = {
    "queued",
    "processing",
    "succeeded",
    "failed",
    "uncertain",
    "cancelled",
}
GENERATION_STYLE_STATUSES = {"queued", "processing", "succeeded", "failed", "uncertain"}


@dataclass
class ImportStats:
    imported: dict[str, int] = field(default_factory=dict)
    skipped: dict[str, int] = field(default_factory=dict)
    failed: dict[str, int] = field(default_factory=dict)

    def add(self, bucket: str, kind: str, count: int = 1) -> None:
        values = getattr(self, bucket)
        values[kind] = values.get(kind, 0) + count

    def as_dict(self) -> dict[str, dict[str, int]]:
        return {"imported": self.imported, "skipped": self.skipped, "failed": self.failed}


def _date(value: Any, default: datetime | None = None) -> datetime | None:
    if not isinstance(value, str) or not value:
        return default
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return default
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def _record_list(payload: dict[str, Any], *names: str) -> list[dict[str, Any]]:
    for name in names:
        value = payload.get(name)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _text(item: dict[str, Any], *names: str) -> str:
    for name in names:
        value = item.get(name)
        if value is not None:
            return str(value).strip()
    return ""


def _int(item: dict[str, Any], *names: str, default: int = 0) -> int:
    for name in names:
        value = item.get(name)
        if value is not None:
            try:
                return int(value)
            except (TypeError, ValueError):
                return default
    return default


def _safe_uuid(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return str(uuid.UUID(text))
    except ValueError:
        return None


def _positive_int(value: Any, *, default: int | None = None) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 1 else default


def _non_negative_int(value: Any, *, default: int = 0) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def _valid_session_id(value: Any) -> str | None:
    text = str(value or "").strip()
    return text if SESSION_ID.fullmatch(text) else None


def _valid_hash(value: Any) -> str | None:
    text = str(value or "").strip()
    return text if HEX64.fullmatch(text) else None


def _safe_asset_path(value: Any, asset_root: Path | None) -> str | None:
    path = str(value or "").strip().replace("\\", "/")
    if not path or path.startswith("/") or ".." in Path(path).parts:
        return None
    if not path.startswith(("source/", "output/")):
        return None
    if asset_root is not None:
        candidate = (asset_root / path).resolve()
        if asset_root.resolve() not in candidate.parents or not candidate.is_file():
            return None
    return path


async def _exists(session: AsyncSession, model: type[Any], key: Any) -> bool:
    return await session.scalar(select(model).where(model.id == key)) is not None


async def import_legacy_payload(
    session_factory: async_sessionmaker[AsyncSession],
    payload: dict[str, Any],
    *,
    asset_root: str | Path | None = None,
    dry_run: bool = False,
) -> ImportStats:
    """Import records that have a direct representation in the Python schema.

    Legacy payment orders, mini-program tokens, and file-only shares are
    intentionally counted as skipped because they cannot be mapped safely.
    """
    stats = ImportStats()
    now = utc_now()
    resolved_asset_root = Path(asset_root).resolve() if asset_root is not None else None
    redeem_ids: set[str] = set()
    entitlement_ids: set[str] = set()
    generation_ids: set[str] = set()
    asset_ids: set[str] = set()
    style_keys: set[tuple[str, int]] = set()
    background_keys: set[tuple[str, int]] = set()
    redeem_hashes: set[str] = set()
    admin_names: set[str] = set()
    async with session_factory() as session:
        await session.begin()
        with session.no_autoflush:
            for item in _record_list(payload, "styles", "styleVersions"):
                style_id = str(item.get("styleId") or item.get("id") or "").strip()
                version = _positive_int(item.get("version") or 1)
                status = _text(item, "status") or "draft"
                sort_order = _non_negative_int(item.get("sortOrder"))
                if (
                    not style_id
                    or len(style_id) > 80
                    or version is None
                    or not item.get("name")
                    or not item.get("prompt")
                    or status not in STYLE_STATUSES
                ):
                    stats.add("failed", "styles")
                    continue
                style_key = (style_id, version)
                if style_key in style_keys:
                    stats.add("skipped", "styles")
                    continue
                if await session.scalar(
                    select(StyleVersion).where(
                        StyleVersion.style_id == style_id,
                        StyleVersion.version == version,
                    )
                ):
                    style_keys.add(style_key)
                    stats.add("skipped", "styles")
                    continue
                style_keys.add(style_key)
                if not dry_run:
                    session.add(
                        StyleVersion(
                            style_id=style_id,
                            version=version,
                            name=str(item["name"])[:120],
                            subtitle=str(item.get("subtitle") or "")[:255],
                            description=str(item.get("description") or ""),
                            prompt=str(item["prompt"]),
                            cover_path=item.get("coverPath"),
                            preview_data=item.get("previewData"),
                            palette_json=item.get("paletteJson"),
                            motif=item.get("motif"),
                            mode=str(item.get("mode") or "realistic"),
                            enabled=bool(item.get("enabled", True)),
                            sort_order=sort_order,
                            status=status,
                            created_by=item.get("createdBy"),
                            created_at=_date(item.get("createdAt"), now) or now,
                            published_at=_date(item.get("publishedAt")),
                        )
                    )
                stats.add("imported", "styles")

            for item in _record_list(payload, "backgrounds", "backgroundVersions"):
                background_id = str(item.get("backgroundId") or item.get("id") or "").strip()
                version = _positive_int(item.get("version") or 1)
                image_path = str(item.get("imagePath") or "").strip()
                status = _text(item, "status") or "draft"
                analysis_status = _text(item, "analysisStatus") or "pending"
                image_mime = _text(item, "imageMime") or "image/jpeg"
                if (
                    not background_id
                    or len(background_id) > 80
                    or version is None
                    or not item.get("name")
                    or not image_path
                    or _safe_asset_path(image_path, resolved_asset_root) is None
                    or image_mime not in {"image/jpeg", "image/png", "image/webp"}
                    or status not in BACKGROUND_STATUSES
                    or analysis_status not in ANALYSIS_STATUSES
                ):
                    stats.add("failed", "backgrounds")
                    continue
                background_key = (background_id, version)
                if background_key in background_keys:
                    stats.add("skipped", "backgrounds")
                    continue
                if await session.scalar(
                    select(BackgroundVersion).where(
                        BackgroundVersion.background_id == background_id,
                        BackgroundVersion.version == version,
                    )
                ):
                    background_keys.add(background_key)
                    stats.add("skipped", "backgrounds")
                    continue
                background_keys.add(background_key)
                if not dry_run:
                    session.add(
                        BackgroundVersion(
                            background_id=background_id,
                            version=version,
                            name=str(item["name"])[:120],
                            subtitle=str(item.get("subtitle") or "")[:255],
                            description=str(item.get("description") or ""),
                            pose_hint=str(item.get("poseHint") or item.get("pose_hint") or ""),
                            analysis_prompt=item.get("analysisPrompt"),
                            image_path=image_path,
                            image_mime=image_mime,
                            enabled=bool(item.get("enabled", True)),
                            sort_order=int(item.get("sortOrder") or 0),
                            analysis_status=analysis_status,
                            status=status,
                            created_by=item.get("createdBy"),
                            created_at=_date(item.get("createdAt"), now) or now,
                            analyzed_at=_date(item.get("analyzedAt")),
                            published_at=_date(item.get("publishedAt")),
                        )
                    )
                stats.add("imported", "backgrounds")

            for item in _record_list(payload, "redeemCodes", "codes"):
                code_id = str(item.get("id") or "").strip()
                code_hash = _valid_hash(item.get("codeHash") or item.get("code_hash"))
                status = _text(item, "status") or "available"
                if (
                    not code_id
                    or len(code_id) > 36
                    or code_hash is None
                    or status not in REDEEM_STATUSES
                ):
                    stats.add("failed", "redeemCodes")
                    continue
                if code_hash in redeem_hashes:
                    stats.add("skipped", "redeemCodes")
                    continue
                if await _exists(session, RedeemCode, code_id) or await session.scalar(
                    select(RedeemCode).where(RedeemCode.code_hash == code_hash)
                ):
                    redeem_hashes.add(code_hash)
                    redeem_ids.add(code_id)
                    stats.add("skipped", "redeemCodes")
                    continue
                redeem_hashes.add(code_hash)
                if not dry_run:
                    session.add(
                        RedeemCode(
                            id=code_id,
                            code_hash=code_hash,
                            code_prefix=str(item.get("codePrefix") or item.get("prefix") or "")[:16],
                            status=status,
                            session_id=item.get("sessionId"),
                            reserved_at=_date(item.get("reservedAt")),
                            redeemed_at=_date(item.get("redeemedAt")),
                            expires_at=_date(item.get("expiresAt")),
                            created_at=_date(item.get("createdAt"), now) or now,
                        )
                    )
                redeem_ids.add(code_id)
                stats.add("imported", "redeemCodes")

            for item in _record_list(payload, "adminUsers", "admins"):
                username = str(item.get("username") or "").strip()
                password_hash = str(item.get("passwordHash") or "").strip()
                role = _text(item, "role") or "operator"
                if (
                    not username
                    or len(username) > 80
                    or not password_hash
                    or len(password_hash) > 255
                    or role not in {"owner", "operator", "technical"}
                    or username in admin_names
                ):
                    stats.add("failed", "adminUsers")
                    continue
                if await session.scalar(select(AdminUser).where(AdminUser.username == username)):
                    admin_names.add(username)
                    stats.add("skipped", "adminUsers")
                    continue
                admin_names.add(username)
                if not dry_run:
                    session.add(
                        AdminUser(
                            username=username[:80],
                            password_hash=password_hash[:255],
                            role=role,
                            active=bool(item.get("active", True)),
                            failed_attempts=0,
                            locked_until=None,
                            created_at=_date(item.get("createdAt"), now) or now,
                            updated_at=_date(item.get("updatedAt"), now) or now,
                        )
                    )
                stats.add("imported", "adminUsers")

            # Entitlements and generation records are accepted only when their
            # foreign-key chain is explicit in the export. Payment orders
            # without that chain remain skipped rather than being guessed.
            for item in _record_list(payload, "entitlements", "experienceEntitlements"):
                entitlement_id = _safe_uuid(item.get("id") or item.get("entitlementId"))
                code_id = _text(item, "redeemCodeId", "redeem_code_id", "codeId", "code_id")
                session_id = _text(item, "sessionId", "session_id")
                token_hash = _text(item, "tokenHash", "token_hash")
                if (
                    entitlement_id is None
                    or not code_id
                    or code_id not in redeem_ids
                    or not session_id
                    or len(token_hash) != 64
                ):
                    stats.add("skipped", "entitlements")
                    continue
                if await _exists(session, Entitlement, entitlement_id):
                    entitlement_ids.add(entitlement_id)
                    stats.add("skipped", "entitlements")
                    continue
                generation_id = _safe_uuid(
                    item.get("generationId") or item.get("generation_id")
                )
                if not dry_run:
                    session.add(
                        Entitlement(
                            id=entitlement_id,
                            redeem_code_id=code_id,
                            session_id=session_id[:100],
                            token_hash=token_hash,
                            status=_text(item, "status") or "active",
                            max_styles=max(
                                1,
                                _int(item, "maxStyles", "max_styles", default=4),
                            ),
                            expires_at=_date(
                                item.get("expiresAt") or item.get("expires_at"),
                                now,
                            )
                            or now,
                            generation_id=generation_id,
                            created_at=_date(
                                item.get("createdAt") or item.get("created_at"),
                                now,
                            )
                            or now,
                            consumed_at=_date(
                                item.get("consumedAt") or item.get("consumed_at")
                            ),
                        )
                    )
                entitlement_ids.add(entitlement_id)
                stats.add("imported", "entitlements")

            for item in _record_list(payload, "orders", "paymentOrders"):
                payment_mode = _text(item, "paymentMode", "payment_mode")
                access_hash = _text(item, "accessTokenHash", "access_token_hash")
                code_id = _text(item, "redeemCodeId", "redeem_code_id", "codeId", "code_id")
                generation = item.get("generation")
                generation_id = (
                    _safe_uuid(generation.get("id"))
                    if isinstance(generation, dict)
                    else None
                )
                entitlement_id = _safe_uuid(item.get("entitlementId"))
                if (
                    payment_mode != "voucher"
                    or len(access_hash) != 64
                    or code_id not in redeem_ids
                    or not entitlement_id
                ):
                    stats.add("skipped", "paymentOrders")
                    continue
                if await _exists(session, Entitlement, entitlement_id):
                    stats.add("skipped", "paymentOrders")
                    continue
                if not dry_run:
                    session.add(
                        Entitlement(
                            id=entitlement_id,
                            redeem_code_id=code_id,
                            session_id=_text(item, "sessionId", "session_id")[:100],
                            token_hash=access_hash,
                            status="consumed" if generation_id else "active",
                            max_styles=max(
                                1,
                                _int(item, "maxStyles", "max_styles", default=4),
                            ),
                            expires_at=_date(
                                item.get("accessExpiresAt")
                                or item.get("access_expires_at"),
                                now,
                            )
                            or now,
                            generation_id=generation_id,
                            created_at=_date(
                                item.get("createdAt") or item.get("created_at"),
                                now,
                            )
                            or now,
                            consumed_at=_date(
                                item.get("paidAt") or item.get("paid_at")
                            ),
                        )
                    )
                entitlement_ids.add(entitlement_id)
                stats.add("imported", "entitlements")

            for item in _record_list(payload, "generationJobs", "generations"):
                generation_id = _safe_uuid(item.get("id") or item.get("generationId"))
                entitlement_id = _safe_uuid(
                    item.get("entitlementId") or item.get("entitlement_id")
                )
                request_hash = _text(item, "requestHash", "request_hash")
                session_id = _text(item, "sessionId", "session_id")
                if (
                    generation_id is None
                    or entitlement_id not in entitlement_ids
                    or len(request_hash) != 64
                    or not session_id
                ):
                    stats.add("skipped", "generationJobs")
                    continue
                if await _exists(session, GenerationJob, generation_id):
                    generation_ids.add(generation_id)
                    stats.add("skipped", "generationJobs")
                    continue
                if not dry_run:
                    session.add(
                        GenerationJob(
                            id=generation_id,
                            entitlement_id=entitlement_id,
                            session_id=session_id[:100],
                            mode=_text(item, "mode") or "classic",
                            scene_id=_text(item, "sceneId", "scene_id") or None,
                            background_id=_text(item, "backgroundId", "background_id") or None,
                            request_hash=request_hash,
                            status=_text(item, "status") or "failed",
                            source_path=_safe_asset_path(
                                item.get("sourcePath") or item.get("source_path"),
                                resolved_asset_root,
                            ),
                            source_expires_at=_date(
                                item.get("sourceExpiresAt")
                                or item.get("source_expires_at")
                            ),
                            error_code=_text(item, "errorCode", "error_code") or None,
                            attempts=max(0, _int(item, "attempts")),
                            started_at=_date(item.get("startedAt") or item.get("started_at")),
                            completed_at=_date(
                                item.get("completedAt") or item.get("completed_at")
                            ),
                            created_at=_date(
                                item.get("createdAt") or item.get("created_at"),
                                now,
                            )
                            or now,
                            updated_at=_date(
                                item.get("updatedAt") or item.get("updated_at"),
                                now,
                            )
                            or now,
                        )
                    )
                generation_ids.add(generation_id)
                stats.add("imported", "generationJobs")

            for item in _record_list(payload, "generationStyles", "stylesGenerated"):
                generation_id = _safe_uuid(
                    item.get("generationId") or item.get("generation_id")
                )
                style_id = _text(item, "styleId", "style_id")
                if (
                    generation_id is None
                    or generation_id not in generation_ids
                    or not style_id
                ):
                    stats.add("skipped", "generationStyles")
                    continue
                if await session.scalar(
                    select(GenerationStyle).where(
                        GenerationStyle.generation_id == generation_id,
                        GenerationStyle.style_id == style_id,
                    )
                ):
                    stats.add("skipped", "generationStyles")
                    continue
                if not dry_run:
                    session.add(
                        GenerationStyle(
                            generation_id=generation_id,
                            style_id=style_id[:80],
                            style_version=max(
                                1,
                                _int(item, "styleVersion", "style_version", default=1),
                            ),
                            status=_text(item, "status") or "succeeded",
                            output_path=_safe_asset_path(
                                item.get("outputPath") or item.get("output_path"),
                                resolved_asset_root,
                            ),
                            output_expires_at=_date(
                                item.get("outputExpiresAt")
                                or item.get("output_expires_at")
                            ),
                            attempts=max(0, _int(item, "attempts")),
                            error_code=_text(item, "errorCode", "error_code") or None,
                            started_at=_date(item.get("startedAt") or item.get("started_at")),
                            completed_at=_date(
                                item.get("completedAt") or item.get("completed_at")
                            ),
                        )
                    )
                stats.add("imported", "generationStyles")

            for item in _record_list(payload, "assets"):
                asset_id = _safe_uuid(item.get("id") or item.get("assetId"))
                generation_id = _safe_uuid(
                    item.get("generationId") or item.get("generation_id")
                )
                file_path = _safe_asset_path(
                    item.get("filePath") or item.get("file_path"),
                    resolved_asset_root,
                )
                mime_type = _text(item, "mimeType", "mime_type")
                if (
                    asset_id is None
                    or generation_id is None
                    or generation_id not in generation_ids
                    or file_path is None
                    or mime_type not in {"image/jpeg", "image/png", "image/webp"}
                ):
                    stats.add("skipped", "assets")
                    continue
                if await _exists(session, Asset, asset_id):
                    asset_ids.add(asset_id)
                    stats.add("skipped", "assets")
                    continue
                if not dry_run:
                    session.add(
                        Asset(
                            id=asset_id,
                            generation_id=generation_id,
                            style_id=_text(item, "styleId", "style_id")[:80],
                            file_path=file_path,
                            mime_type=mime_type,
                            byte_size=max(0, _int(item, "byteSize", "byte_size")),
                            expires_at=_date(
                                item.get("expiresAt") or item.get("expires_at"),
                                now,
                            )
                            or now,
                            created_at=_date(
                                item.get("createdAt") or item.get("created_at"),
                                now,
                            )
                            or now,
                        )
                    )
                stats.add("imported", "assets")
                asset_ids.add(asset_id)

            for item in _record_list(payload, "shares"):
                share_id = _text(item, "id")
                session_id = _text(item, "sessionId", "session_id")
                images = item.get("images")
                image_ids = [
                    _safe_uuid(image.get("assetId"))
                    for image in images
                ] if isinstance(images, list) else []
                if (
                    not re.fullmatch(r"[A-Za-z0-9_-]{24}", share_id)
                    or not session_id
                    or not image_ids
                    or any(asset_id is None for asset_id in image_ids)
                    or any(asset_id not in asset_ids for asset_id in image_ids)
                ):
                    stats.add("skipped", "shares")
                    continue
                if await _exists(session, Share, share_id):
                    stats.add("skipped", "shares")
                    continue
                if not dry_run:
                    session.add(
                        Share(
                            id=share_id,
                            session_id=session_id,
                            expires_at=_date(item.get("expiresAt"), now) or now,
                            images_json=[
                                {"assetId": asset_id}
                                for asset_id in image_ids
                                if asset_id is not None
                            ],
                            created_at=_date(
                                item.get("createdAt") or item.get("created_at"),
                                now,
                            )
                            or now,
                        )
                    )
                stats.add("imported", "shares")

            stats.add("skipped", "miniProgramTokens", len(_record_list(payload, "miniTokens", "miniProgramTokens")))

        if dry_run:
            await session.rollback()
        else:
            await session.commit()
    return stats


async def import_legacy_file(
    session_factory: async_sessionmaker[AsyncSession],
    input_path: str | Path,
    *,
    asset_root: str | Path | None = None,
    dry_run: bool = False,
) -> ImportStats:
    path = Path(input_path).resolve()
    with path.open("r", encoding="utf-8") as stream:
        payload = json.load(stream)
    if not isinstance(payload, dict):
        raise ValueError("legacy input must be a JSON object")
    return await import_legacy_payload(
        session_factory,
        payload,
        asset_root=asset_root,
        dry_run=dry_run,
    )
