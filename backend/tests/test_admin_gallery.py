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


async def _seed_artwork(
    app, *, prefix: str, session_id: str, styles: tuple[str, ...] = ("ink",)
) -> list[str]:
    """插入一条「兑换码 → 权益 → 任务 → 资产」链路，一次任务可有多张图。

    返回本次任务下所有资产 ID（按 styles 顺序）。
    """
    code_id = str(uuid.uuid4())
    entitlement_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    asset_ids = [str(uuid.uuid4()) for _ in styles]
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
        for index, (asset_id, style_id) in enumerate(zip(asset_ids, styles)):
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
    return asset_ids


@pytest.mark.asyncio
async def test_admin_gallery_lists_artwork_with_redeem_code(gallery_console):
    client, app = gallery_console
    asset_id = (
        await _seed_artwork(
            app, prefix="HUAN", session_id="session-alpha", styles=("van-gogh",)
        )
    )[0]

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
    await _seed_artwork(app, prefix="HUAN", session_id="session-alpha", styles=("ink",))
    target = (
        await _seed_artwork(app, prefix="VIP9", session_id="session-beta", styles=("oil",))
    )[0]

    matched = await client.get("/api/admin/gallery?q=vip9")
    assert matched.status_code == 200
    assert [item["assetId"] for item in matched.json()["items"]] == [target]

    missed = await client.get("/api/admin/gallery?q=ZZZZ")
    assert missed.json()["total"] == 0


@pytest.mark.asyncio
async def test_admin_gallery_delete_removes_asset_and_file(gallery_console, tmp_path: Path):
    client, app = gallery_console
    asset_id = (
        await _seed_artwork(app, prefix="DEL1", session_id="session-delta")
    )[0]
    stored = tmp_path / "assets" / "output" / f"{asset_id}.jpg"
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_bytes(b"fake-jpeg")

    response = await client.request(
        "DELETE",
        f"/api/admin/gallery/{asset_id}",
        json={"reason": "游客要求删除"},
        headers={"X-CSRF-Token": client.cookies["admin_csrf"]},
    )
    assert response.status_code == 200
    assert response.json() == {
        "deleted": True,
        "assetId": asset_id,
        "generationId": response.json()["generationId"],
        "count": 1,
    }
    assert not stored.exists()

    listed = await client.get("/api/admin/gallery")
    assert listed.json()["total"] == 0

    audit = await client.get("/api/admin/audit-logs")
    actions = [log["action"] for log in audit.json()["logs"]]
    assert "gallery.asset_deleted" in actions


@pytest.mark.asyncio
async def test_admin_gallery_delete_generation_scope(gallery_console):
    client, app = gallery_console
    job_assets = await _seed_artwork(
        app, prefix="GRP1", session_id="session-group", styles=("ink", "oil")
    )
    other = (
        await _seed_artwork(app, prefix="KEEP", session_id="session-keep", styles=("oil",))
    )[0]

    response = await client.request(
        "DELETE",
        f"/api/admin/gallery/{job_assets[0]}",
        json={"reason": "整组清理", "scope": "generation"},
        headers={"X-CSRF-Token": client.cookies["admin_csrf"]},
    )
    assert response.status_code == 200
    assert response.json()["count"] == 2

    remaining = await client.get("/api/admin/gallery")
    assert [item["assetId"] for item in remaining.json()["items"]] == [other]


@pytest.mark.asyncio
async def test_admin_gallery_delete_requires_owner(gallery_console):
    client, app = gallery_console
    asset_id = (
        await _seed_artwork(app, prefix="OPS1", session_id="session-ops")
    )[0]
    async with app.state.session_factory() as session:
        session.add(
            AdminUser(
                username="operator",
                password_hash=hash_admin_password("password"),
                role="operator",
                active=True,
                failed_attempts=0,
                locked_until=None,
                created_at=utc_now(),
                updated_at=utc_now(),
            )
        )
        await session.commit()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as operator_client:
        login = await operator_client.post(
            "/api/admin/auth/login",
            json={"username": "operator", "password": "password"},
        )
        assert login.status_code == 200
        response = await operator_client.request(
            "DELETE",
            f"/api/admin/gallery/{asset_id}",
            json={"reason": "运营尝试删除"},
            headers={"X-CSRF-Token": operator_client.cookies["admin_csrf"]},
        )
    assert response.status_code == 403

    still_there = await client.get("/api/admin/gallery?q=OPS1")
    assert still_there.json()["total"] == 1


@pytest.mark.asyncio
async def test_admin_gallery_requires_auth(gallery_console):
    _client, app = gallery_console
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as anonymous:
        response = await anonymous.get("/api/admin/gallery")
    assert response.status_code in (401, 403)
