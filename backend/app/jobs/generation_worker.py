from __future__ import annotations

import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings
from ..domain.generation_service import GenerationService
from ..logging.json_logger import log_event
from ..model_configs import DEFAULT_PROVIDER_KEY
from ..providers.factory import create_provider
from ..storage.assets import AssetStore
from .generation_queue import GenerationQueue


class GenerationWorker:
    """Consumes durable retry jobs without storing photos or prompts in memory."""

    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        asset_store: AssetStore,
        logger: logging.Logger | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.logger = logger
        self.queue = GenerationQueue()
        self.service = GenerationService(
            settings,
            create_provider(settings, provider_key=DEFAULT_PROVIDER_KEY),
            asset_store,
        )

    async def run_once(self) -> bool:
        async with self.session_factory() as session:
            async with session.begin():
                jobs = await self.queue.claim(session, limit=1)
                if not jobs:
                    return False
                generation_id = jobs[0].id
            await self.service.process_queued_job(
                session,
                generation_id=generation_id,
            )
        return True

    async def run(
        self,
        stop_event: asyncio.Event,
        *,
        interval_seconds: float = 1.0,
    ) -> None:
        while not stop_event.is_set():
            try:
                processed = await self.run_once()
                if not processed:
                    await asyncio.wait_for(
                        stop_event.wait(),
                        timeout=interval_seconds,
                    )
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if self.logger is not None:
                    log_event(
                        self.logger,
                        logging.ERROR,
                        "generation.worker_failed",
                        reason=type(error).__name__,
                    )
                await asyncio.sleep(interval_seconds)
