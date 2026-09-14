from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.config import Settings
from backend.app.db.base import Base
from backend.app.db.models import RedeemCode
from backend.app.main import create_app
from backend.app.security.tokens import hash_token


@pytest.fixture
async def client(tmp_path: Path):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'api.sqlite3'}"
    engine = create_async_engine(
        database_url,
    )
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
        ) as test_client:
            yield test_client, app
    await engine.dispose()


@pytest.mark.asyncio
async def test_admin_can_generate_and_guest_can_redeem_once(client):
    test_client, app = client
    unauthorized = await test_client.post(
        "/api/admin/redeem-codes/generate",
        json={"count": 1},
    )
    assert unauthorized.status_code == 401
    assert unauthorized.json()["code"] == "ADMIN_UNAUTHORIZED"

    generated = await test_client.post(
        "/api/admin/redeem-codes/generate",
        headers={"X-Admin-Token": "admin-test-token"},
        json={"count": 2},
    )
    assert generated.status_code == 201
    codes = generated.json()["codes"]
    assert len(codes) == 2
    assert all("value" in item for item in codes)

    listed = await test_client.get(
        "/api/admin/redeem-codes",
        headers={"X-Admin-Token": "admin-test-token"},
    )
    assert listed.status_code == 200
    assert all("value" not in item for item in listed.json()["codes"])

    redeemed = await test_client.post(
        "/api/entitlements/redeem",
        json={
            "code": codes[0]["value"].lower(),
            "sessionId": "11111111-1111-4111-8111-111111111111",
        },
    )
    assert redeemed.status_code == 200
    body = redeemed.json()
    assert body["accessToken"]
    assert body["entitlement"]["status"] == "used"
    assert body["entitlement"]["maxStyles"] == 4

    duplicate = await test_client.post(
        "/api/entitlements/redeem",
        json={
            "code": codes[0]["value"],
            "sessionId": "22222222-2222-4222-8222-222222222222",
        },
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "REDEEM_USED"

    session_factory: async_sessionmaker[AsyncSession] = app.state.session_factory
    async with session_factory() as session:
        row = await session.scalar(
            select(RedeemCode).where(RedeemCode.id == codes[0]["id"])
        )
        assert row is not None
        assert row.code_hash == hash_token(codes[0]["value"])
        assert codes[0]["value"] not in row.code_hash


@pytest.mark.asyncio
async def test_legacy_external_claim_endpoint_is_not_available(client):
    test_client, _app = client

    response = await test_client.post("/api/redeem-codes/claim", json={})

    assert response.status_code == 404
