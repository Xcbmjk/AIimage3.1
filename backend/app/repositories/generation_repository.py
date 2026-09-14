from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    Asset,
    Entitlement,
    GenerationJob,
    GenerationStyle,
)


class GenerationRepository:
    async def find_entitlement(
        self,
        session: AsyncSession,
        token_hash: str,
        *,
        for_update: bool = False,
    ) -> Entitlement | None:
        statement = select(Entitlement).where(Entitlement.token_hash == token_hash)
        if for_update:
            statement = statement.with_for_update()
        return await session.scalar(statement)

    async def find_job(
        self,
        session: AsyncSession,
        generation_id: str,
        *,
        for_update: bool = False,
    ) -> GenerationJob | None:
        statement = select(GenerationJob).where(GenerationJob.id == generation_id)
        if for_update:
            statement = statement.with_for_update()
        return await session.scalar(statement)

    async def find_job_assets(
        self,
        session: AsyncSession,
        generation_id: str,
    ) -> list[Asset]:
        result = await session.scalars(
            select(Asset)
            .where(Asset.generation_id == generation_id)
            .order_by(Asset.created_at, Asset.id)
        )
        return list(result)

    async def create_job(
        self,
        session: AsyncSession,
        job: GenerationJob,
        styles: list[GenerationStyle],
    ) -> GenerationJob:
        session.add(job)
        session.add_all(styles)
        await session.flush()
        return job

    async def add_asset(self, session: AsyncSession, asset: Asset) -> Asset:
        session.add(asset)
        await session.flush()
        return asset

    async def mark_job(
        self,
        session: AsyncSession,
        job: GenerationJob,
        *,
        status: str,
        error_code: str | None = None,
        completed_at=None,
    ) -> None:
        job.status = status
        job.error_code = error_code
        job.updated_at = job.completed_at = completed_at or job.updated_at
        if status == "processing" and job.started_at is None:
            job.started_at = job.updated_at
        await session.flush()
