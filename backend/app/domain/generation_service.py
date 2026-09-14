from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.errors import ApiError
from ..catalog.seed import BACKGROUND_PRESETS, STYLE_PRESETS
from ..config import Settings
from ..db.models import (
    Asset,
    Entitlement,
    GenerationJob,
    GenerationStyle,
    StyleVersion,
)
from ..model_configs import (
    DEFAULT_COOLDOWN_SECONDS,
    DEFAULT_FAILURE_THRESHOLD,
    IMAGE_GENERATION,
    MOCK_PROVIDER_KEY,
    get_active_model_configs,
    resolve_provider_key,
    to_image_generation_runtime_config,
)
from ..providers.base import GeneratedImage, ImageProvider
from ..providers.circuit import CircuitBreaker
from ..providers.errors import ProviderError
from ..providers.factory import create_provider
from ..providers.failover import FailoverImageProvider, GenerationLine
from ..repositories.generation_repository import GenerationRepository
from ..jobs.generation_queue import GenerationQueue
from ..storage.assets import AssetStore
from ..storage.images import validate_image_bytes
from ..vision.analyze import compose_fallback_prompt, finalize_agent_prompt
from .entitlement_service import utc_now
from .portrait_prompt import compose_portrait_prompt


@dataclass(frozen=True)
class GenerationResult:
    provider: str
    assets: list[dict[str, object]]
    prompt: str | None = None
    failures: list[dict[str, object]] = field(default_factory=list)


def _failure_payload(style_id: str, error: ProviderError) -> dict[str, object]:
    return {
        "styleId": style_id,
        "code": error.code,
        "message": error.message,
        "retryable": error.retryable,
    }


_shared_breaker: CircuitBreaker | None = None


def shared_circuit_breaker() -> CircuitBreaker:
    """One breaker per process, so a failing vendor stays skipped.

    The request path and the retry worker both use it. A breaker rebuilt per
    request would forget every failure the moment the response was written.
    Threshold and cooldown arrive per line from the database row, so the values
    here are only the fallback for a line constructed without them.
    """
    global _shared_breaker
    if _shared_breaker is None:
        _shared_breaker = CircuitBreaker(
            failure_threshold=DEFAULT_FAILURE_THRESHOLD,
            cooldown_seconds=DEFAULT_COOLDOWN_SECONDS,
        )
    return _shared_breaker


def reset_shared_circuit_breaker() -> None:
    """Drop breaker state. A fresh app instance is a fresh process, so tests
    call this between cases to keep one case's failures out of the next."""
    global _shared_breaker
    _shared_breaker = None


def request_hash(
    session_id: str,
    photo: bytes,
    *,
    mode: str,
    values: list[str],
) -> str:
    digest = hashlib.sha256()
    digest.update(session_id.encode())
    digest.update(b"\0")
    digest.update(photo)
    digest.update(b"\0")
    digest.update(mode.encode())
    digest.update(b"\0")
    digest.update(",".join(sorted(values)).encode())
    return digest.hexdigest()


def _asset_response(asset: Asset, settings: Settings) -> dict[str, object]:
    return {
        "id": asset.id,
        "assetId": asset.id,
        "styleId": asset.style_id,
        "imageUrl": f"{settings.public_base_url.rstrip('/')}/api/assets/{asset.id}",
    }


class GenerationService:
    def __init__(
        self,
        settings: Settings,
        provider: ImageProvider,
        asset_store: AssetStore,
        repository: GenerationRepository | None = None,
        breaker: CircuitBreaker | None = None,
    ) -> None:
        self.settings = settings
        self.provider = provider
        self.asset_store = asset_store
        self.repository = repository or GenerationRepository()
        self.queue = GenerationQueue()
        self.breaker = breaker or shared_circuit_breaker()

    async def generate_classic(
        self,
        session: AsyncSession,
        *,
        entitlement: Entitlement,
        session_id: str,
        generation_id: str,
        photo: bytes,
        photo_mime: str,
        style_ids: list[str],
    ) -> GenerationResult:
        if len(style_ids) < 1 or len(style_ids) > entitlement.max_styles:
            raise ApiError("INVALID_INPUT", "请提供 1–4 种有效风格", 400)
        entitlement_token_hash = entitlement.token_hash
        entitlement_id = entitlement.id
        if len(set(style_ids)) != len(style_ids):
            raise ApiError("INVALID_INPUT", "包含不可用的创作风格", 400)
        database_styles = list(
            (
                await session.scalars(
                    select(StyleVersion)
                    .where(
                        StyleVersion.status == "published",
                        StyleVersion.enabled.is_(True),
                        StyleVersion.style_id.in_(style_ids),
                    )
                )
            ).all()
        )
        if database_styles:
            style_by_id = {style.style_id: style for style in database_styles}
            if len(style_by_id) != len(style_ids):
                raise ApiError("INVALID_INPUT", "包含不可用的创作风格", 400)
            prompts = [style_by_id[style_id].prompt for style_id in style_ids]
            versions = [style_by_id[style_id].version for style_id in style_ids]
        else:
            styles = [
                next((style for style in STYLE_PRESETS if style.id == value), None)
                for value in style_ids
            ]
            if any(style is None for style in styles):
                raise ApiError("INVALID_INPUT", "包含不可用的创作风格", 400)
            prompts = [
                compose_portrait_prompt(style)
                for style in styles
                if style is not None
            ]
            versions = [1] * len(style_ids)
        # End the catalog lookup transaction before reserving the entitlement.
        await session.rollback()
        return await self._run(
            session,
            entitlement=entitlement,
            session_id=session_id,
            generation_id=generation_id,
            photo=photo,
            photo_mime=photo_mime,
            mode="classic",
            values=style_ids,
            scene_id="portrait-only",
            background_id=None,
            prompts=prompts,
            style_ids=style_ids,
            style_versions=versions,
            entitlement_token_hash=entitlement_token_hash,
            entitlement_id=entitlement_id,
        )

    async def generate_agent(
        self,
        session: AsyncSession,
        *,
        entitlement: Entitlement,
        session_id: str,
        generation_id: str,
        photo: bytes,
        photo_mime: str,
        background_id: str,
    ) -> GenerationResult:
        background = await self._find_background(session, background_id)
        if background is None:
            raise ApiError("INVALID_INPUT", "包含不可用的背景素材", 400)
        entitlement_token_hash = entitlement.token_hash
        entitlement_id = entitlement.id
        try:
            stored = self.asset_store.read(background.image_path)
        except (FileNotFoundError, ValueError):
            raise ApiError("INVALID_INPUT", "背景图片不存在", 400) from None
        prompt = finalize_agent_prompt(
            background.analysis_prompt
            or compose_fallback_prompt(background.name, background.pose_hint)
        )
        background_version = background.version
        # The catalog lookup starts an implicit read transaction. End it before
        # _run() opens the write transaction that reserves the entitlement.
        await session.rollback()
        return await self._run(
            session,
            entitlement=entitlement,
            session_id=session_id,
            generation_id=generation_id,
            photo=photo,
            photo_mime=photo_mime,
            mode="agent",
            values=[background_id],
            scene_id=None,
            background_id=background_id,
            prompts=[prompt],
            style_ids=[background_id],
            style_versions=[background_version],
            background=(stored.data or b"", stored.mime_type),
            prompt=prompt,
            entitlement_token_hash=entitlement_token_hash,
            entitlement_id=entitlement_id,
        )

    async def process_queued_job(
        self,
        session: AsyncSession,
        *,
        generation_id: str,
    ) -> GenerationResult | None:
        """Resume a queued retry using only persisted task metadata and assets."""
        async with session.begin():
            job = await self.repository.find_job(session, generation_id, for_update=True)
            if job is None or job.status != "processing":
                return None
            entitlement = await session.get(Entitlement, job.entitlement_id)
            entitlement_id = job.entitlement_id
            details = list(
                (
                    await session.scalars(
                        select(GenerationStyle)
                        .where(GenerationStyle.generation_id == generation_id)
                        .order_by(GenerationStyle.id)
                    )
                ).all()
            )
            source_path = job.source_path
            mode = job.mode
            style_specs = [
                (detail.style_id, detail.style_version)
                for detail in details
            ]
            background_id = job.background_id
        if entitlement is None or not source_path or not details:
            async with session.begin():
                await self.queue.fail(session, generation_id, "GENERATION_METADATA_MISSING")
            return None
        try:
            source = self.asset_store.read(source_path, category="source")
            photo = source.data or b""
            if mode == "agent":
                if not background_id:
                    raise ProviderError("INVALID_INPUT", "背景素材信息缺失")
                background_row = await self._find_background(session, background_id)
                if background_row is None:
                    raise ProviderError("INVALID_INPUT", "背景素材已不可用")
                background_asset = self.asset_store.read(
                    background_row.image_path,
                    category="background",
                )
                prompts = [
                    finalize_agent_prompt(
                        background_row.analysis_prompt
                        or compose_fallback_prompt(
                            background_row.name,
                            background_row.pose_hint,
                        )
                    )
                ]
                background = (
                    background_asset.data or b"",
                    background_asset.mime_type,
                )
            else:
                style_ids = [style_id for style_id, _ in style_specs]
                style_versions = [version for _, version in style_specs]
                rows = list(
                    (
                        await session.scalars(
                            select(StyleVersion).where(
                                StyleVersion.style_id.in_(style_ids),
                                StyleVersion.version.in_(style_versions),
                                StyleVersion.status.in_(["published", "archived"]),
                            )
                        )
                    ).all()
                )
                by_key = {(row.style_id, row.version): row for row in rows}
                prompts = []
                for style_id, version in zip(style_ids, style_versions):
                    row = by_key.get((style_id, version))
                    if row is not None:
                        prompts.append(row.prompt)
                        continue
                    fixture = next(
                        (style for style in STYLE_PRESETS if style.id == style_id),
                        None,
                    )
                    if fixture is None:
                        raise ProviderError("INVALID_INPUT", "风格素材已不可用")
                    prompts.append(compose_portrait_prompt(fixture))
                background = None
            await session.rollback()
            provider = await self._provider_for(session)
            results: list[tuple[str, GeneratedImage]] = []
            failures: list[tuple[str, ProviderError]] = []
            style_ids = [style_id for style_id, _ in style_specs]
            for index, style_id in enumerate(style_ids):
                try:
                    if background is None:
                        result = await provider.generate(
                            photo,
                            source.mime_type,
                            prompts[index],
                            style_id,
                        )
                    else:
                        result = await provider.compose(
                            background[0],
                            background[1],
                            photo,
                            source.mime_type,
                            prompts[index],
                            style_id,
                        )
                except ProviderError as error:
                    failures.append((style_id, error))
                    continue
                results.append((style_id, result))
        except ProviderError as error:
            await session.rollback()
            async with session.begin():
                await self.queue.fail(
                    session,
                    generation_id,
                    error.code,
                    uncertain=not error.retryable,
                )
            return None
        if not results:
            error = failures[0][1]
            async with session.begin():
                await self.queue.fail(
                    session,
                    generation_id,
                    error.code,
                    uncertain=not error.retryable,
                )
            return None
        try:
            await session.rollback()
            persisted = await self._persist_results(
                session,
                generation_id=generation_id,
                results=results,
                failures=[(style_id, error.code) for style_id, error in failures],
                entitlement_id=entitlement_id,
            )
        except Exception:
            await session.rollback()
            async with session.begin():
                await self.queue.fail(session, generation_id, "ASSET_PERSIST_FAILED")
            return None
        return GenerationResult(
            provider.name,
            [_asset_response(asset, self.settings) for asset in persisted],
            failures=[
                _failure_payload(style_id, error) for style_id, error in failures
            ],
        )

    async def _run(
        self,
        session: AsyncSession,
        *,
        entitlement: Entitlement,
        session_id: str,
        generation_id: str,
        photo: bytes,
        photo_mime: str,
        mode: str,
        values: list[str],
        scene_id: str | None,
        background_id: str | None,
        prompts: list[str],
        style_ids: list[str],
        style_versions: list[int] | None = None,
        background: tuple[bytes, str] | None = None,
        prompt: str | None = None,
        entitlement_token_hash: str | None = None,
        entitlement_id: str | None = None,
    ) -> GenerationResult:
        locked_entitlement_id = entitlement_id or entitlement.id
        fingerprint = request_hash(
            session_id,
            photo,
            mode=mode,
            values=values,
        )
        now = utc_now()
        async with session.begin():
            locked = await self.repository.find_entitlement(
                session,
                entitlement_token_hash or entitlement.token_hash,
                for_update=True,
            )
            if locked is None or locked.session_id != session_id:
                raise ApiError("UNAUTHORIZED", "体验权益令牌无效", 401)
            if locked.expires_at <= now:
                locked.status = "expired"
                raise ApiError("ENTITLEMENT_EXPIRED", "体验权益已过期", 410)
            if locked.generation_id and locked.generation_id != generation_id:
                raise ApiError(
                    "GENERATION_ALREADY_CONSUMED",
                    "本次体验权益已经用于其他生图任务",
                    409,
                )
            job = await self.repository.find_job(session, generation_id, for_update=True)
            if job is not None:
                if job.entitlement_id != locked.id:
                    raise ApiError(
                        "GENERATION_REQUEST_MISMATCH",
                        "该生图任务的照片或选项与首次请求不一致",
                        409,
                    )
                same_request = job.request_hash == fingerprint
                salvage = not same_request and await self._is_salvage_request(
                    session,
                    job,
                    mode=mode,
                    style_ids=style_ids,
                )
                if not same_request and not salvage:
                    raise ApiError(
                        "GENERATION_REQUEST_MISMATCH",
                        "该生图任务的照片或选项与首次请求不一致",
                        409,
                    )
                if job.status == "processing":
                    raise ApiError(
                        "GENERATION_IN_PROGRESS",
                        "生图任务正在处理，请稍后查询结果",
                        409,
                        True,
                    )
                if job.status == "succeeded" and same_request:
                    assets = await self.repository.find_job_assets(session, job.id)
                    return GenerationResult(
                        await self._active_provider_name(session),
                        [_asset_response(asset, self.settings) for asset in assets],
                    )
                if job.status not in {"queued", "failed", "uncertain", "succeeded"}:
                    raise ApiError(
                        "GENERATION_ALREADY_CONSUMED",
                        "本次生图任务状态无法自动重试，请联系现场工作人员处理",
                        409,
                    )
                # A transient upstream failure must not strand the visitor in
                # front of the kiosk. Previously `uncertain` jumped straight to
                # "请联系工作人员", and the `failed` branch called claim() on a
                # job whose status was already `failed`, so claim never matched
                # and the retry silently never happened.
                retrying = job.status != "queued"
                if retrying and job.attempts >= self.settings.max_generation_attempts:
                    raise ApiError(
                        "GENERATION_ATTEMPTS_EXHAUSTED",
                        "本次生图多次未能完成，请联系现场工作人员",
                        409,
                    )
                if retrying:
                    job.status = "queued"
                    job.error_code = None
                    job.completed_at = None
                    job.updated_at = utc_now()
                    await session.flush()
                claimed = await self.queue.claim(
                    session,
                    generation_id=generation_id,
                    style_ids=style_ids if salvage else None,
                )
                if not claimed:
                    raise ApiError(
                        "GENERATION_IN_PROGRESS",
                        "生图任务正在排队，请稍后重试",
                        409,
                        True,
                    )
            if job is None and locked.generation_id:
                raise ApiError(
                    "GENERATION_ALREADY_CONSUMED",
                    "本次体验权益已经用于其他生图任务",
                    409,
                )
            if job is None:
                source = self.asset_store.save(
                    photo,
                    photo_mime,
                    "source",
                    retention_days=1,
                )
                job = GenerationJob(
                    id=generation_id,
                    entitlement_id=locked.id,
                    session_id=session_id,
                    mode=mode,
                    scene_id=scene_id,
                    background_id=background_id,
                    request_hash=fingerprint,
                    status="queued",
                    source_path=source.relative_path,
                    source_expires_at=source.expires_at,
                    attempts=0,
                    started_at=None,
                    created_at=now,
                    updated_at=now,
                )
                details = [
                    GenerationStyle(
                        generation_id=generation_id,
                        style_id=style_id,
                        style_version=(style_versions or [1] * len(style_ids))[index],
                        status="queued",
                        attempts=0,
                    )
                    for index, style_id in enumerate(style_ids)
                ]
                await self.queue.enqueue(session, job, details)
                claimed = await self.queue.claim(
                    session,
                    generation_id=generation_id,
                )
                if not claimed:
                    raise ApiError("GENERATION_IN_PROGRESS", "生图任务正在排队，请稍后重试", 409, True)

        provider = await self._provider_for(session)
        await session.rollback()
        results: list[tuple[str, GeneratedImage]] = []
        failures: list[tuple[str, ProviderError]] = []
        for index, style_id in enumerate(style_ids):
            # Each image stands on its own: one upstream hiccup must not
            # discard the images that already succeeded. With four styles
            # the old all-or-nothing loop turned a 90% per-image success
            # rate into a 66% chance of showing the visitor nothing.
            try:
                if background is None:
                    result = await provider.generate(
                        photo,
                        photo_mime,
                        prompts[index],
                        style_id,
                    )
                else:
                    result = await provider.compose(
                        background[0],
                        background[1],
                        photo,
                        photo_mime,
                        prompts[index],
                        style_id,
                    )
            except ProviderError as error:
                failures.append((style_id, error))
                continue
            results.append((style_id, result))

        if not results:
            error = failures[0][1]
            async with session.begin():
                await self.queue.fail(
                    session,
                    generation_id,
                    error.code,
                    uncertain=not error.retryable,
                )
            raise ApiError(error.code, error.message, 502, error.retryable) from error

        try:
            await session.rollback()
            persisted = await self._persist_results(
                session,
                generation_id=generation_id,
                results=results,
                failures=[(style_id, error.code) for style_id, error in failures],
                entitlement_id=locked_entitlement_id,
                entitlement_token_hash=entitlement_token_hash or entitlement.token_hash,
            )
        except Exception:
            await session.rollback()
            async with session.begin():
                await self.queue.fail(
                    session,
                    generation_id,
                    "ASSET_PERSIST_FAILED",
                )
            raise

        return GenerationResult(
            provider.name,
            [_asset_response(asset, self.settings) for asset in persisted],
            prompt,
            [_failure_payload(style_id, error) for style_id, error in failures],
        )

    async def _active_provider_name(self, session: AsyncSession) -> str:
        """Name the vendor a fresh request would use, for replay reporting.

        Best effort on purpose: replaying an already-finished job must not fail
        because an administrator edited the configuration in the meantime.
        """
        rows = await get_active_model_configs(session, IMAGE_GENERATION)
        if not rows:
            return self.provider.name
        return create_provider(
            self.settings,
            provider_key=resolve_provider_key(rows[0]),
            image_config=to_image_generation_runtime_config(rows[0]),
        ).name

    async def _provider_for(self, session: AsyncSession) -> ImageProvider:
        """Resolve the vendor line for this request from the database.

        The environment no longer selects a provider: rows in ``model_configs``
        are the only source. The default row leads, and every other enabled row
        is a standby for the same protocol, wrapped so a failing vendor is
        skipped without an operator touching anything mid-incident.
        """
        rows = await get_active_model_configs(session, IMAGE_GENERATION)
        if not rows:
            if self.settings.app_env == "test":
                return create_provider(
                    self.settings,
                    provider_key=MOCK_PROVIDER_KEY,
                )
            raise ApiError(
                "CONFIG_ERROR",
                "尚未配置可用的图片模型，请在后台添加配置并设为默认",
                503,
            )
        transport = getattr(self.provider, "transport", None)
        lines: list[GenerationLine] = []
        for row in rows:
            image_config = to_image_generation_runtime_config(row)
            lines.append(
                GenerationLine(
                    key=row.id,
                    provider=create_provider(
                        self.settings,
                        provider_key=resolve_provider_key(row),
                        transport=transport,
                        image_config=image_config,
                    ),
                    failure_threshold=image_config.failure_threshold,
                    cooldown_seconds=image_config.cooldown_seconds,
                )
            )
        if len(lines) == 1:
            return lines[0].provider
        return FailoverImageProvider(lines, self.breaker)

    async def _is_salvage_request(
        self,
        session: AsyncSession,
        job: GenerationJob,
        *,
        mode: str,
        style_ids: list[str],
    ) -> bool:
        """Whether this request only re-runs styles that previously failed.

        The client keeps the original generation id when retrying, so the
        allowance already consumed by the delivered images still covers the
        salvage and the visitor does not pay twice for one session.
        """
        if job.mode != mode:
            return False
        failed = set(
            (
                await session.scalars(
                    select(GenerationStyle.style_id).where(
                        GenerationStyle.generation_id == job.id,
                        GenerationStyle.status == "failed",
                    )
                )
            ).all()
        )
        if not failed:
            return False
        requested = set(style_ids)
        return bool(requested) and requested <= failed

    async def _persist_results(
        self,
        session: AsyncSession,
        *,
        generation_id: str,
        results: list[tuple[str, GeneratedImage]],
        failures: list[tuple[str, str]] | None = None,
        entitlement_id: str,
        entitlement_token_hash: str | None = None,
    ) -> list[Asset]:
        """Store every image that succeeded and record why the rest did not.

        The job counts as delivered as soon as one image lands, which is what
        consumes the visitor's allowance. Styles that failed keep their own
        ``failed`` status plus error code so a salvage retry can pick up just
        those instead of redoing the whole set.
        """
        persisted: list[Asset] = []
        saved_paths: list[str] = []
        failed_styles = failures or []
        async with session.begin():
            completed = await self.repository.find_job(
                session,
                generation_id,
                for_update=True,
            )
            if completed is None:
                raise ApiError("GENERATION_FAILED", "生图任务不存在", 500)
            for style_id, result in results:
                saved = self.asset_store.save(
                    result.data,
                    result.mime_type,
                    "output",
                    retention_days=30,
                )
                saved_paths.append(saved.relative_path)
                asset = Asset(
                    id=saved.id,
                    generation_id=generation_id,
                    style_id=style_id,
                    file_path=saved.relative_path,
                    mime_type=saved.mime_type,
                    byte_size=saved.byte_size,
                    expires_at=saved.expires_at.replace(tzinfo=None),
                    created_at=utc_now(),
                )
                persisted.append(asset)
                await self.repository.add_asset(session, asset)
            completed.status = "succeeded"
            completed.completed_at = utc_now()
            completed.updated_at = completed.completed_at
            succeeded_style_ids = [style_id for style_id, _ in results]
            await session.execute(
                update(GenerationStyle)
                .where(
                    GenerationStyle.generation_id == generation_id,
                    GenerationStyle.style_id.in_(succeeded_style_ids),
                )
                .values(
                    status="succeeded",
                    error_code=None,
                    completed_at=completed.completed_at,
                )
            )
            for style_id, code in failed_styles:
                await session.execute(
                    update(GenerationStyle)
                    .where(
                        GenerationStyle.generation_id == generation_id,
                        GenerationStyle.style_id == style_id,
                    )
                    .values(
                        status="failed",
                        error_code=code,
                        completed_at=completed.completed_at,
                    )
                )
            entitlement_row = await session.get(Entitlement, entitlement_id, with_for_update=True)
            if entitlement_row is None:
                raise ApiError("GENERATION_FAILED", "体验权益不存在", 500)
            entitlement_row.generation_id = generation_id
            entitlement_row.status = "consumed"
            entitlement_row.consumed_at = completed.completed_at
            await session.flush()
        return persisted

    async def _find_background(self, session: AsyncSession, background_id: str):
        from ..db.models import BackgroundVersion

        return await session.scalar(
            select(BackgroundVersion)
            .where(
                BackgroundVersion.background_id == background_id,
                BackgroundVersion.status == "published",
                BackgroundVersion.enabled.is_(True),
                BackgroundVersion.analysis_status == "ready",
            )
            .order_by(BackgroundVersion.version.desc())
        )
