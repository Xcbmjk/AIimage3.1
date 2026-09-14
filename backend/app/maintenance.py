from __future__ import annotations

import asyncio
import logging

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .db.models import AdminSession, Asset, Share
from .domain.entitlement_service import utc_now
from .jobs.generation_queue import GenerationQueue
from .logging.json_logger import log_event
from .storage.assets import AssetStore


async def run_maintenance(
    session_factory: async_sessionmaker[AsyncSession],
    asset_store: AssetStore,
    logger: logging.Logger | None = None,
    *,
    stale_minutes: int = 15,
    orphan_scan_limit: int = 500,
) -> dict[str, int]:
    """Reclaim expired files/metadata and make abandoned jobs retryable.

    Each operation is bounded and idempotent so a process restart cannot leave
    a second cleanup pass with partially applied state.
    """
    now = utc_now()
    counts = {
        "expiredShares": 0,
        "expiredAssets": 0,
        "expiredAdminSessions": 0,
        "orphanAssets": 0,
        "orphanFiles": 0,
        "recoveredJobs": 0,
    }
    queue = GenerationQueue()
    async with session_factory() as session:
        async with session.begin():
            expired_shares = list(
                (
                    await session.scalars(
                        select(Share).where(Share.expires_at <= now)
                    )
                ).all()
            )
            for share in expired_shares:
                await session.delete(share)
            counts["expiredShares"] = len(expired_shares)

            expired_assets = list(
                (
                    await session.scalars(
                        select(Asset).where(Asset.expires_at <= now)
                    )
                ).all()
            )
            for asset in expired_assets:
                asset_store.remove(asset.file_path)
                await session.delete(asset)
            counts["expiredAssets"] = len(expired_assets)

            result = await session.execute(
                delete(AdminSession).where(AdminSession.expires_at <= now)
            )
            counts["expiredAdminSessions"] = int(result.rowcount or 0)

            counts["recoveredJobs"] = await queue.recover_stale(
                session,
                stale_minutes=stale_minutes,
            )

            candidates = list(
                (
                    await session.scalars(
                        select(Asset)
                        .where(Asset.expires_at > now)
                        .order_by(Asset.created_at)
                        .limit(orphan_scan_limit)
                    )
                ).all()
            )
            for asset in candidates:
                try:
                    asset_store.read(asset.file_path)
                except (FileNotFoundError, OSError, ValueError):
                    await session.delete(asset)
                    counts["orphanAssets"] += 1
            counts["orphanFiles"] = asset_store.cleanup()

    if logger is not None:
        log_event(logger, logging.INFO, "maintenance.completed", **counts)
    return counts


async def maintenance_loop(
    session_factory: async_sessionmaker[AsyncSession],
    asset_store: AssetStore,
    logger: logging.Logger,
    *,
    interval_seconds: int = 3600,
    stale_minutes: int = 15,
) -> None:
    """Run cleanup immediately, then at a bounded interval until cancelled."""
    try:
        while True:
            try:
                await run_maintenance(
                    session_factory,
                    asset_store,
                    logger,
                    stale_minutes=stale_minutes,
                )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log_event(
                    logger,
                    logging.ERROR,
                    "maintenance.failed",
                    reason=type(error).__name__,
                )
            await asyncio.sleep(interval_seconds)
    except asyncio.CancelledError:
        return
