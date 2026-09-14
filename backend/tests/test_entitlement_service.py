from __future__ import annotations

from datetime import timedelta
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from backend.app.api.errors import ApiError
from backend.app.config import Settings
from backend.app.db.base import Base
from backend.app.db.models import Entitlement, RedeemCode
from backend.app.domain.entitlement_service import (
    EntitlementService,
    utc_now,
)
from backend.app.repositories.entitlement_repository import EntitlementRepository
from backend.app.security.tokens import hash_token


@pytest.fixture
async def database():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    yield factory
    await engine.dispose()


def settings() -> Settings:
    return Settings(
        _env_file=None,
        app_env="test",
        database_url="sqlite+aiosqlite://",
        asset_directory="data/test-assets",
        share_directory="data/test-shares",
    )


@pytest.mark.asyncio
async def test_redeem_creates_one_entitlement_and_stores_only_hash(database):
    service = EntitlementService(settings())
    now = utc_now()
    raw_code = "ABCD2345"
    async with database() as session:
        session.add(
            RedeemCode(
                id="code-1",
                code_hash=hash_token(raw_code),
                code_prefix=raw_code[:4],
                status="available",
                created_at=now,
            )
        )
        await session.commit()

    async with database() as session:
        entitlement, token = await service.redeem(
            session,
            code=f" {raw_code.lower()} ",
            session_id="11111111-1111-4111-8111-111111111111",
        )
        assert entitlement.status == "active"
        assert entitlement.max_styles == 4
        assert entitlement.token_hash == hash_token(token)
        assert token != raw_code

    async with database() as session:
        code = await session.scalar(select(RedeemCode).where(RedeemCode.id == "code-1"))
        stored = await session.scalar(
            select(Entitlement).where(Entitlement.redeem_code_id == "code-1")
        )
        assert code is not None and code.status == "redeemed"
        assert stored is not None and stored.token_hash != token
        assert token not in stored.token_hash


@pytest.mark.asyncio
async def test_redeem_rejects_used_expired_and_disabled_codes(database):
    service = EntitlementService(settings())
    now = utc_now()
    rows = [
        ("used", "ABCD2346", "redeemed", None),
        ("expired", "ABCD2347", "available", now - timedelta(minutes=1)),
        ("disabled", "ABCD2348", "disabled", None),
    ]
    async with database() as session:
        session.add_all(
            [
                RedeemCode(
                    id=identifier,
                    code_hash=hash_token(code),
                    code_prefix=code[:4],
                    status=status,
                    expires_at=expires_at,
                    created_at=now,
                )
                for identifier, code, status, expires_at in rows
            ]
        )
        await session.commit()

    expected = {
        "ABCD2346": ("REDEEM_USED", 409),
        "ABCD2347": ("REDEEM_EXPIRED", 410),
        "ABCD2348": ("REDEEM_DISABLED", 410),
    }
    for code, (error_code, status_code) in expected.items():
        async with database() as session:
            with pytest.raises(ApiError) as raised:
                await service.redeem(
                    session,
                    code=code,
                    session_id="11111111-1111-4111-8111-111111111111",
                )
        assert raised.value.code == error_code
        assert raised.value.status_code == status_code


@pytest.mark.asyncio
async def test_generate_codes_returns_plaintext_only_to_caller(database):
    service = EntitlementService(settings(), EntitlementRepository())
    async with database() as session:
        generated = await service.generate_codes(
            session,
            count=5,
            expires_at=None,
        )

    assert len(generated) == 5
    values = [value for _row, value in generated]
    assert len(set(values)) == 5
    assert all(len(value) == 8 for value in values)
    async with database() as session:
        rows = list((await session.scalars(select(RedeemCode))).all())
        assert len(rows) == 5
        assert all(value not in row.code_hash for value, row in zip(values, rows))
