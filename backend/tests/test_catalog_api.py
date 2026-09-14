from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.config import Settings
from backend.app.db.base import Base
from backend.app.db.models import BackgroundVersion, ModelConfig
from backend.app.domain.entitlement_service import utc_now
from backend.app.main import create_app


@pytest.mark.asyncio
async def test_catalog_has_no_payment_or_prompt_fields(tmp_path: Path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'catalog.sqlite3'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    settings = Settings(
        _env_file=None,
        app_env="test",
        database_url=database_url,
        admin_token="admin-test-token",
        asset_directory=str(tmp_path / "assets"),
        share_directory=str(tmp_path / "shares"),
        static_directory=str(tmp_path / "static"),
        public_directory=str(tmp_path / "public"),
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            response = await client.get("/api/catalog")
    await engine.dispose()

    assert response.status_code == 200
    body = response.json()
    assert len(body["styles"]) == 5
    assert "pricing" not in body
    assert "paymentMode" not in body["runtime"]
    assert all("prompt" not in style for style in body["styles"])


@pytest.mark.asyncio
async def test_catalog_enables_agent_from_database_models(tmp_path: Path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'catalog-agent.sqlite3'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    settings = Settings(
        _env_file=None,
        app_env="test",
        ai_provider="gpt-image-2-url",
        gpt_image_base_url="https://gateway.example/v1",
        gpt_image_api_key="env-fallback-key",
        database_url=database_url,
        admin_token="admin-test-token",
        asset_directory=str(tmp_path / "assets"),
        share_directory=str(tmp_path / "shares"),
        static_directory=str(tmp_path / "static"),
        public_directory=str(tmp_path / "public"),
    )
    app = create_app(settings)
    now = utc_now()
    async with app.router.lifespan_context(app):
        async with app.state.session_factory() as session:
            session.add_all(
                [
                    ModelConfig(
                        id="11111111-1111-4111-8111-111111111111",
                        name="视觉模型",
                        model_type="vision_analysis",
                        provider="database",
                        base_url="https://vision.example/v1",
                        endpoint="/chat/completions",
                        model_name="vision-model",
                        api_key="vision-key",
                        timeout_ms=60000,
                        enabled=True,
                        is_default=True,
                        created_at=now,
                        updated_at=now,
                    ),
                    ModelConfig(
                        id="22222222-2222-4222-8222-222222222222",
                        name="图片模型",
                        model_type="image_generation",
                        provider="database",
                        base_url="https://image.example/v1",
                        endpoint="/images/edits",
                        model_name="image-model",
                        api_key="image-key",
                        timeout_ms=300000,
                        extra_config={"generationEndpoint": "/images/generations"},
                        enabled=True,
                        is_default=True,
                        created_at=now,
                        updated_at=now,
                    ),
                    BackgroundVersion(
                        background_id="agent-background",
                        version=1,
                        name="动作背景",
                        subtitle="",
                        description="背景",
                        pose_hint="正常站立",
                        image_path="background/33333333-3333-4333-8333-333333333333.jpg",
                        image_mime="image/jpeg",
                        enabled=True,
                        sort_order=1,
                        analysis_status="ready",
                        status="published",
                        created_at=now,
                        analyzed_at=now,
                        published_at=now,
                    ),
                ]
            )
            await session.commit()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            response = await client.get("/api/catalog")
    await engine.dispose()

    assert response.status_code == 200
    assert response.json()["runtime"]["agentEnabled"] is True
