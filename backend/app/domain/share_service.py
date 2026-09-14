from __future__ import annotations

import re
import secrets
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.errors import ApiError
from ..config import Settings
from ..db.models import Asset, GenerationJob, Share
from ..domain.entitlement_service import utc_now
from ..repositories.share_repository import ShareRepository

SHARE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{24}$")


class ShareService:
    """Owns share records and their server-side asset references."""

    def __init__(
        self,
        settings: Settings,
        repository: ShareRepository | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository or ShareRepository()

    async def create(
        self,
        session: AsyncSession,
        *,
        session_id: str,
        asset_ids: list[str],
    ) -> Share:
        rows = list(
            (
                await session.scalars(
                    select(Asset)
                    .join(GenerationJob, GenerationJob.id == Asset.generation_id)
                    .where(
                        Asset.id.in_(asset_ids),
                        GenerationJob.session_id == session_id,
                        GenerationJob.status == "succeeded",
                        Asset.expires_at > utc_now(),
                    )
                )
            ).all()
        )
        by_id = {row.id: row for row in rows}
        if len(by_id) != len(asset_ids):
            raise ApiError("INVALID_INPUT", "作品不存在、已过期或不属于当前体验", 400)

        now = utc_now()
        share = Share(
            id=secrets.token_urlsafe(18),
            session_id=session_id,
            expires_at=now + timedelta(hours=self.settings.share_expiry_hours),
            images_json=[
                {"assetId": by_id[asset_id].id, "styleId": by_id[asset_id].style_id}
                for asset_id in asset_ids
            ],
            created_at=now,
        )
        await self.repository.create(session, share)
        return share

    async def find_asset(
        self,
        session: AsyncSession,
        *,
        share_id: str,
        index: int,
    ) -> tuple[Share, Asset] | None:
        if not SHARE_ID_PATTERN.fullmatch(share_id) or index < 1:
            return None
        share = await self.repository.get(session, share_id)
        if share is None or share.expires_at <= utc_now():
            return None
        if index > len(share.images_json):
            return None
        item = share.images_json[index - 1]
        asset_id = item.get("assetId") if isinstance(item, dict) else None
        if not isinstance(asset_id, str):
            return None
        asset = await session.scalar(
            select(Asset).where(
                Asset.id == asset_id,
                Asset.expires_at > utc_now(),
            )
        )
        return (share, asset) if asset is not None else None

    @staticmethod
    def is_valid_id(value: str) -> bool:
        return bool(SHARE_ID_PATTERN.fullmatch(value))
