from __future__ import annotations

import json
from dataclasses import asdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..catalog.seed import (
    BACKGROUND_PRESETS,
    STYLE_PRESETS,
    background_public_dict,
    style_public_dict,
)
from ..config import Settings
from ..db.models import BackgroundVersion, StyleVersion
from ..model_configs import (
    IMAGE_GENERATION,
    MOCK_PROVIDER_KEY,
    VISION_ANALYSIS,
    agent_configs_available,
    get_default_model_config,
    resolve_provider_key,
)


class CatalogService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def styles(self, session: AsyncSession | None) -> list[dict[str, object]]:
        if session is None:
            return [style_public_dict(style) for style in STYLE_PRESETS]
        rows = list(
            (
                await session.scalars(
                    select(StyleVersion)
                    .where(StyleVersion.status == "published", StyleVersion.enabled.is_(True))
                    .order_by(StyleVersion.sort_order, StyleVersion.style_id)
                )
            ).all()
        )
        if not rows:
            return [style_public_dict(style) for style in STYLE_PRESETS]
        return [self._style_row(row) for row in rows]

    async def backgrounds(self, session: AsyncSession | None) -> list[dict[str, object]]:
        if session is None:
            return []
        rows = list(
            (
                await session.scalars(
                    select(BackgroundVersion)
                    .where(
                        BackgroundVersion.status == "published",
                        BackgroundVersion.enabled.is_(True),
                        BackgroundVersion.analysis_status == "ready",
                    )
                    .order_by(
                        BackgroundVersion.sort_order,
                        BackgroundVersion.background_id,
                        BackgroundVersion.version.desc(),
                    )
                )
            ).all()
        )
        result: list[dict[str, object]] = []
        seen: set[str] = set()
        for row in rows:
            if row.background_id in seen:
                continue
            seen.add(row.background_id)
            result.append(self._background_row(row))
        return result

    async def catalog(self, session: AsyncSession | None) -> dict[str, object]:
        backgrounds = await self.backgrounds(session)
        vision_config = (
            await get_default_model_config(session, VISION_ANALYSIS)
            if session is not None
            else None
        )
        image_config = (
            await get_default_model_config(session, IMAGE_GENERATION)
            if session is not None
            else None
        )
        agent_enabled = (
            agent_configs_available(
                settings=self.settings,
                vision_config=vision_config,
                image_config=image_config,
            )
            and bool(backgrounds)
        )
        image_provider = (
            resolve_provider_key(image_config)
            if image_config is not None
            else MOCK_PROVIDER_KEY
            if self.settings.app_env == "test"
            else None
        )
        return {
            "styles": await self.styles(session),
            "backgrounds": backgrounds,
            "product": {
                "maxStyles": self.settings.max_styles,
                "shareExpiryHours": self.settings.share_expiry_hours,
            },
            "runtime": {
                "generationMode": "mock" if image_provider == MOCK_PROVIDER_KEY else "api",
                "agentEnabled": agent_enabled,
            },
        }

    @staticmethod
    def _style_row(row: StyleVersion) -> dict[str, object]:
        try:
            palette = json.loads(row.palette_json or "[]")
        except json.JSONDecodeError:
            palette = []
        if not isinstance(palette, list) or len(palette) != 3:
            palette = ["#35574a", "#c8a96b", "#edf1e8"]
        return {
            "id": row.style_id,
            "name": row.name,
            "subtitle": row.subtitle,
            "description": row.description,
            "palette": palette,
            "motif": row.motif or row.name[:1],
            "resultImage": (
                row.preview_data
                if row.preview_data and row.preview_data.startswith("data:")
                else f"/api/catalog/style-assets/{row.id}"
            ),
            "mode": row.mode,
        }

    @staticmethod
    def _background_row(row: BackgroundVersion) -> dict[str, object]:
        asset_id = row.image_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        return {
            "id": row.background_id,
            "name": row.name,
            "subtitle": row.subtitle,
            "description": row.description,
            "poseHint": row.pose_hint,
            "imageMime": row.image_mime,
            "previewImage": f"/api/catalog/background-assets/{asset_id}",
        }
