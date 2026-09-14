from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import GenerationJob, GenerationStyle
from ..domain.entitlement_service import utc_now


class GenerationQueue:
    """Persistence boundary for queued generation jobs."""

    async def enqueue(
        self,
        session: AsyncSession,
        job: GenerationJob,
        styles: list[GenerationStyle] | None = None,
    ) -> GenerationJob:
        job.status = "queued"
        job.updated_at = job.updated_at or utc_now()
        session.add(job)
        if styles:
            session.add_all(styles)
        await session.flush()
        return job

    async def claim(
        self,
        session: AsyncSession,
        *,
        limit: int = 1,
        generation_id: str | None = None,
        style_ids: list[str] | None = None,
    ) -> list[GenerationJob]:
        """Move queued jobs to processing.

        ``style_ids`` narrows the style bookkeeping to a subset, which is how
        a salvage retry re-runs only the images that failed without
        disturbing the ones already delivered.
        """
        if limit < 1:
            return []
        statement = select(GenerationJob).where(GenerationJob.status == "queued")
        if generation_id is not None:
            statement = statement.where(GenerationJob.id == generation_id)
        statement = (
            statement.order_by(GenerationJob.created_at, GenerationJob.id)
            .limit(limit)
            .with_for_update()
        )
        jobs = list((await session.scalars(statement)).all())
        now = utc_now()
        for job in jobs:
            job.status = "processing"
            job.attempts += 1
            job.started_at = now
            job.completed_at = None
            job.updated_at = now
        if jobs:
            job_ids = [job.id for job in jobs]
            style_statement = (
                update(GenerationStyle)
                .where(GenerationStyle.generation_id.in_(job_ids))
            )
            if style_ids is not None:
                style_statement = style_statement.where(
                    GenerationStyle.style_id.in_(style_ids)
                )
            await session.execute(
                style_statement.values(
                    status="processing",
                    attempts=GenerationStyle.attempts + 1,
                    started_at=now,
                    completed_at=None,
                    error_code=None,
                )
            )
        await session.flush()
        return jobs

    async def retry(
        self,
        session: AsyncSession,
        generation_id: str,
        *,
        max_attempts: int = 2,
    ) -> bool:
        """Put a failed task back in the durable queue for a worker."""
        job = await session.scalar(
            select(GenerationJob)
            .where(GenerationJob.id == generation_id)
            .with_for_update()
        )
        if job is None or job.status not in {"failed", "uncertain"}:
            return False
        if job.attempts >= max_attempts:
            return False
        job.status = "queued"
        job.error_code = None
        job.completed_at = None
        job.updated_at = utc_now()
        await session.execute(
            update(GenerationStyle)
            .where(GenerationStyle.generation_id == generation_id)
            .values(status="queued", error_code=None, completed_at=None)
        )
        await session.flush()
        return True

    async def complete(self, session: AsyncSession, generation_id: str) -> None:
        now = utc_now()
        await session.execute(
            update(GenerationJob)
            .where(GenerationJob.id == generation_id)
            .values(
                status="succeeded",
                error_code=None,
                completed_at=now,
                updated_at=now,
            )
        )
        await session.execute(
            update(GenerationStyle)
            .where(GenerationStyle.generation_id == generation_id)
            .values(
                status="succeeded",
                error_code=None,
                completed_at=now,
            )
        )
        await session.flush()

    async def fail(
        self,
        session: AsyncSession,
        generation_id: str,
        error_code: str,
        *,
        uncertain: bool = False,
    ) -> None:
        now = utc_now()
        await session.execute(
            update(GenerationJob)
            .where(GenerationJob.id == generation_id)
            .values(
                status="uncertain" if uncertain else "failed",
                error_code=error_code,
                completed_at=now,
                updated_at=now,
            )
        )
        await session.execute(
            update(GenerationStyle)
            .where(GenerationStyle.generation_id == generation_id)
            .values(
                status="uncertain" if uncertain else "failed",
                error_code=error_code,
                completed_at=now,
            )
        )
        await session.flush()

    async def recover_stale(
        self,
        session: AsyncSession,
        *,
        stale_minutes: int = 15,
    ) -> int:
        cutoff = utc_now() - timedelta(minutes=stale_minutes)
        stale_ids = list(
            (
                await session.scalars(
                    select(GenerationJob.id).where(
                        GenerationJob.status == "processing",
                        GenerationJob.started_at.is_not(None),
                        GenerationJob.started_at < cutoff,
                    )
                )
            ).all()
        )
        if not stale_ids:
            return 0
        result = await session.execute(
            update(GenerationJob)
            .where(
                GenerationJob.id.in_(stale_ids),
            )
            .values(status="queued", updated_at=utc_now(), error_code=None)
        )
        await session.execute(
            update(GenerationStyle)
            .where(
                GenerationStyle.generation_id.in_(stale_ids)
            )
            .values(
                status="queued",
                error_code=None,
                started_at=None,
                completed_at=None,
            )
        )
        await session.flush()
        return int(result.rowcount or 0)
