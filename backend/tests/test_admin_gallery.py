"""后台作品库接口：图片必须能关联回兑换码。"""

from __future__ import annotations

import uuid
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.config import Settings
from backend.app.db.base import Base
from backend.app.db.models import (
    Asset,
    Entitlement,
    GenerationJob,
    RedeemCode,
)
from backend.app.domain.entitlement_service import utc_now
from backend.app.main import create_app
from backend.app.security.admin_auth import hash_admin_password
from backend.app.db.models import AdminUser


@pytest.fixture
async def gallery_console(tmp_path: Path):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'admin-gallery.sqlite3'}"
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
        async with app.state.session_factory() as session:
            session.add(
                AdminUser(
                    username="owner",
                    password_hash=hash_admin_password("password"),
                    role="owner",
                    active=True,
                    failed_attempts=0,
                    locked_until=None,
                    created_at=utc_now(),
                    updated_at=utc_now(),
                )
            )
            await session.commit()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as client:
            login = await client.post(
                "/api/admin/auth/login",
                json={"username": "owner", "password": "password"},
            )
            assert login.status_code == 200
            yield client, app
    await engine.dispose()


async def _seed_artwork(app, *, prefix: str, session_id: str, style_id: str) -> str:
    """插入一条完整的「兑换码 → 权益 → 任务 → 资产」链路，返回资产 ID。"""
    code_id = str(uuid.uuid4())
    entitlement_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    asset_id = str(uuid.uuid4())
    now = utc_now()
    async with app.state.session_factory() as session:
        session.add(
            RedeemCode(
                id=code_id,
                code_hash=f"hash-{code_id}",
                code_prefix=prefix,
                status="redeemed",
                session_id=session_id,
                redeemed_at=now,
                expires_at=now + timedelta(days=30),
                created_at=now,
            )
        )
        session.add(
            Entitlement(
                id=entitlement_id,
                redeem_code_id=code_id,
                session_id=session_id,
                token_hash=f"token-{entitlement_id}",
                status="consumed",
                max_styles=4,
                expires_at=now + timedelta(days=30),
                generation_id=job_id,
                created_at=now,
                consumed_at=now,
            )
        )
        session.add(
            GenerationJob(
                id=job_id,
                entitlement_id=entitlement_id,
                session_id=session_id,
                mode="classic",
                request_hash=f"request-{job_id}",
                status="succeeded",
                attempts=1,
                completed_at=now,
                created_at=now,
                updated_at=now,
            )
        )
        session.add(
            Asset(
                id=asset_id,
                generation_id=job_id,
                style_id=style_id,
                file_path=f"output/{asset_id}.jpg",
                mime_type="image/jpeg",
                byte_size=2048,
                expires_at=now + timedelta(days=30),
                created_at=now,
            )
        )
        await session.commit()
    return asset_id


@pytest.mark.asyncio
async def test_admin_gallery_lists_artwork_with_redeem_code(gallery_console):
    client, app = gallery_console
    asset_id = await _seed_artwork(
        app, prefix="HUAN", session_id="session-alpha", style_id="van-gogh"
    )

    listed = await client.get("/api/admin/gallery")
    assert listed.status_code == 200
    payload = listed.json()
    assert payload["total"] == 1
    item = payload["items"][0]
    assert item["assetId"] == asset_id
    assert item["redeemCodePrefix"] == "HUAN"
    assert item["redeemCodeStatus"] == "redeemed"
    assert item["sessionId"] == "session-alpha"
    assert item["styleId"] == "van-gogh"
    assert item["url"] == f"/api/assets/{asset_id}"
    assert payload["totalBytes"] == 2048


@pytest.mark.asyncio
async def test_admin_gallery_searches_by_redeem_code_prefix(gallery_console):
    client, app = gallery_console
    await _seed_artwork(app, prefix="HUAN", session_id="session-alpha", style_id="ink")
    target = await _seed_artwork(app, prefix="VIP9", session_id="session-beta", style_id="oil")

    matched = await client.get("/api/admin/gallery?q=vip9")
    assert matched.status_code == 200
    assert [item["assetId"] for item in matched.json()["items"]] == [target]

    missed = await client.get("/api/admin/gallery?q=ZZZZ")
    assert missed.json()["total"] == 0


@pytest.mark.asyncio
async def test_admin_gallery_requires_auth(gallery_console):
    _client, app = gallery_console
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as anonymous:
        response = await anonymous.get("/api/admin/gallery")
    assert response.status_code in (401, 403)
