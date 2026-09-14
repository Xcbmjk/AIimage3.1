from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Share


class ShareRepository:
    async def get(self, session: AsyncSession, share_id: str) -> Share | None:
        return await session.scalar(select(Share).where(Share.id == share_id))

    async def create(self, session: AsyncSession, share: Share) -> Share:
        session.add(share)
        await session.flush()
        return share
