from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings
from ..db.models import BackgroundVersion, StyleVersion
from ..dependencies import create_db_dependency
from ..domain.catalog_service import CatalogService
from ..storage.assets import AssetStore


def create_catalog_router(
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
    asset_store: AssetStore,
) -> APIRouter:
    router = APIRouter()
    db = create_db_dependency(session_factory)
    service = CatalogService(settings)

    @router.get("/api/catalog")
    async def catalog(session: AsyncSession = Depends(db)) -> dict[str, object]:
        result = await service.catalog(session)
        return result

    @router.get("/api/catalog/style-assets/{asset_id}")
    async def style_asset(
        asset_id: str,
        session: AsyncSession = Depends(db),
    ) -> Response:
        row = await session.scalar(
            select(StyleVersion).where(
                StyleVersion.id == int(asset_id) if asset_id.isdigit() else False,
                StyleVersion.status == "published",
                StyleVersion.enabled.is_(True),
            )
        )
        if row is None or not row.cover_path:
            return Response(status_code=404)
        try:
            saved = asset_store.read(row.cover_path, category="style")
        except FileNotFoundError:
            return Response(status_code=404)
        return Response(
            content=saved.data,
            media_type=saved.mime_type,
            headers={"Cache-Control": "public, max-age=300"},
        )

    @router.get("/api/catalog/background-assets/{asset_id}")
    async def background_asset(
        asset_id: str,
        session: AsyncSession = Depends(db),
    ) -> Response:
        rows = list(
            (
                await session.scalars(
                    select(BackgroundVersion).where(
                        BackgroundVersion.status == "published",
                        BackgroundVersion.enabled.is_(True),
                        BackgroundVersion.analysis_status == "ready",
                    )
                )
            ).all()
        )
        row = next(
            (
                candidate
                for candidate in rows
                if candidate.image_path.rsplit("/", 1)[-1].rsplit(".", 1)[0] == asset_id
            ),
            None,
        )
        if row is None:
            return Response(status_code=404)
        try:
            saved = asset_store.read(row.image_path)
        except FileNotFoundError:
            return Response(status_code=404)
        return Response(
            content=saved.data,
            media_type=saved.mime_type,
            headers={"Cache-Control": "public, max-age=300"},
        )

    return router
