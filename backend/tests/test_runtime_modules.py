from __future__ import annotations

from datetime import datetime, timedelta
import json
import os

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.config import Settings
from backend.app.db.base import Base
from backend.app.db.models import (
    Asset,
    Entitlement,
    GenerationJob,
    GenerationStyle,
    RedeemCode,
    StyleVersion,
)
from backend.app.legacy_import import import_legacy_payload
from backend.app.lib.urls import endpoint_url, redact_url
from backend.app.jobs.generation_queue import GenerationQueue
from backend.app.jobs.generation_worker import GenerationWorker
from backend.app.security.rate_limit import InMemoryRateLimiter
from backend.app.domain.entitlement_service import utc_now
from backend.app.maintenance import run_maintenance
from backend.app.storage.assets import AssetStore


def test_url_helpers_strip_sensitive_parts() -> None:
    assert endpoint_url("https://provider.example/v1", "/chat/completions") == (
        "https://provider.example/v1/chat/completions"
    )
    assert redact_url("https://user:secret@example.com:443/a?token=secret#fragment") == (
        "https://example.com:443/a"
    )
    assert redact_url("not-a-url") == "[invalid-url]"


def test_rate_limiter_sliding_window() -> None:
    limiter = InMemoryRateLimiter()
    assert limiter.check("scope", "client", limit=2, window_seconds=60).allowed
    assert limiter.check("scope", "client", limit=2, window_seconds=60).allowed
    limited = limiter.check("scope", "client", limit=2, window_seconds=60)
    assert not limited.allowed
    assert limited.retry_after >= 1


@pytest.mark.asyncio
async def test_legacy_import_skips_payment_records_and_is_idempotent(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'legacy.sqlite3'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    payload = {
        "styles": [
            {
                "styleId": "legacy-ink",
                "version": 1,
                "name": "旧风格",
                "prompt": "保留人物面部",
                "createdAt": "2026-09-10T00:00:00Z",
            }
        ],
        "redeemCodes": [
            {
                "id": "code-1",
                "codeHash": "a" * 64,
                "codePrefix": "ABCD",
                "createdAt": "2026-09-10T00:00:00Z",
            }
        ],
        "orders": [{"id": "payment-1"}],
    }
    first = await import_legacy_payload(sessions, payload)
    second = await import_legacy_payload(sessions, payload)
    assert first.imported == {"styles": 1, "redeemCodes": 1}
    assert first.skipped == {"paymentOrders": 1, "miniProgramTokens": 0}
    assert second.skipped["styles"] == 1
    assert second.skipped["redeemCodes"] == 1
    async with sessions() as session:
        assert await session.scalar(select(StyleVersion.style_id)) == "legacy-ink"
        assert await session.scalar(select(RedeemCode.code_hash)) == "a" * 64
    await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_imports_entitlement_generation_and_existing_asset_chain(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'legacy-chain.sqlite3'}"
    asset_root = tmp_path / "assets"
    output_path = asset_root / "output"
    output_path.mkdir(parents=True)
    (output_path / "existing.png").write_bytes(b"image")
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    code_id = "code-chain"
    entitlement_id = "11111111-1111-4111-8111-111111111111"
    generation_id = "33333333-3333-4333-8333-333333333333"
    asset_id = "44444444-4444-4444-8444-444444444444"
    payload = {
        "redeemCodes": [
            {
                "id": code_id,
                "codeHash": "c" * 64,
                "codePrefix": "CHAIN",
            }
        ],
        "entitlements": [
            {
                "id": entitlement_id,
                "redeemCodeId": code_id,
                "sessionId": "22222222-2222-4222-8222-222222222222",
                "tokenHash": "d" * 64,
                "expiresAt": "2027-09-10T00:00:00Z",
            }
        ],
        "generationJobs": [
            {
                "id": generation_id,
                "entitlementId": entitlement_id,
                "sessionId": "22222222-2222-4222-8222-222222222222",
                "requestHash": "e" * 64,
                "status": "succeeded",
            }
        ],
        "generationStyles": [
            {
                "generationId": generation_id,
                "styleId": "ink",
                "status": "succeeded",
            }
        ],
        "assets": [
            {
                "id": asset_id,
                "generationId": generation_id,
                "styleId": "ink",
                "filePath": "output/existing.png",
                "mimeType": "image/png",
                "byteSize": 5,
                "expiresAt": "2027-09-10T00:00:00Z",
            }
        ],
    }
    result = await import_legacy_payload(
        sessions,
        payload,
        asset_root=asset_root,
    )
    assert result.imported == {
        "redeemCodes": 1,
        "entitlements": 1,
        "generationJobs": 1,
        "generationStyles": 1,
        "assets": 1,
    }
    async with sessions() as session:
        assert await session.get(Entitlement, entitlement_id) is not None
        assert await session.get(GenerationJob, generation_id) is not None
        assert await session.scalar(select(GenerationStyle.style_id)) == "ink"
        assert await session.get(Asset, asset_id) is not None

    second = await import_legacy_payload(
        sessions,
        payload,
        asset_root=asset_root,
    )
    assert second.skipped["redeemCodes"] == 1
    assert second.skipped["entitlements"] == 1
    assert second.skipped["generationJobs"] == 1
    assert second.skipped["assets"] == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_import_rejects_unverified_asset_path(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'legacy-path.sqlite3'}"
    asset_root = tmp_path / "assets"
    asset_root.mkdir()
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    payload = {
        "redeemCodes": [{"id": "code", "codeHash": "f" * 64}],
        "entitlements": [
            {
                "id": "11111111-1111-4111-8111-111111111111",
                "redeemCodeId": "code",
                "sessionId": "22222222-2222-4222-8222-222222222222",
                "tokenHash": "a" * 64,
            }
        ],
        "generationJobs": [
            {
                "id": "33333333-3333-4333-8333-333333333333",
                "entitlementId": "11111111-1111-4111-8111-111111111111",
                "sessionId": "22222222-2222-4222-8222-222222222222",
                "requestHash": "b" * 64,
            }
        ],
        "assets": [
            {
                "id": "44444444-4444-4444-8444-444444444444",
                "generationId": "33333333-3333-4333-8333-333333333333",
                "styleId": "ink",
                "filePath": "../outside.png",
                "mimeType": "image/png",
            }
        ],
    }
    result = await import_legacy_payload(
        sessions,
        payload,
        asset_root=asset_root,
    )
    assert result.skipped["assets"] == 1
    async with sessions() as session:
        assert await session.scalar(select(Asset)) is None
    await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_import_rejects_invalid_values_and_duplicate_rows_without_partial_commit(
    tmp_path,
) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'legacy-validation.sqlite3'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    payload = {
        "styles": [
            {
                "styleId": "duplicate",
                "version": 1,
                "name": "有效风格",
                "prompt": "有效提示词",
            },
            {
                "styleId": "duplicate",
                "version": 1,
                "name": "重复风格",
                "prompt": "重复提示词",
            },
            {
                "styleId": "bad-status",
                "version": 0,
                "name": "非法状态",
                "prompt": "提示词",
                "status": "published-now",
            },
        ],
        "redeemCodes": [
            {"id": "code-a", "codeHash": "a" * 64},
            {"id": "code-b", "codeHash": "a" * 64},
        ],
    }

    result = await import_legacy_payload(sessions, payload)

    assert result.imported == {"styles": 1, "redeemCodes": 1}
    assert result.skipped == {"styles": 1, "redeemCodes": 1, "miniProgramTokens": 0}
    assert result.failed == {"styles": 1}
    async with sessions() as session:
        assert await session.scalar(select(StyleVersion.style_id)) == "duplicate"
        assert await session.scalar(select(RedeemCode.id)) == "code-a"
    await engine.dispose()


def test_logger_trims_old_lines_and_redacts_long_values(tmp_path) -> None:
    log_path = tmp_path / "generation.log"
    old = (datetime.now().astimezone() - timedelta(days=20)).isoformat()
    recent = datetime.now().astimezone().isoformat()
    log_path.write_text(
        "\n".join(
            [
                json.dumps({"timestamp": old, "event": "old"}),
                json.dumps({"timestamp": recent, "event": "recent"}),
                "malformed",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    from backend.app.logging.json_logger import _safe_value, _trim_log_file

    _trim_log_file(log_path, 14)
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert all(json.loads(line)["event"] != "old" for line in lines)
    assert len(_safe_value("x" * 600)) == 503


@pytest.mark.asyncio
async def test_maintenance_cleans_old_unreferenced_asset_files(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'maintenance-files.sqlite3'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    settings = Settings(
        _env_file=None,
        app_env="test",
        database_url=database_url,
        asset_directory=str(tmp_path / "assets"),
        share_directory=str(tmp_path / "shares"),
        storage_min_free_bytes=1,
    )
    store = AssetStore(settings)
    orphan = store.root / "output" / "orphan.png"
    orphan.parent.mkdir(parents=True, exist_ok=True)
    orphan.write_bytes(b"stale")
    old = datetime.now().timestamp() - 32 * 24 * 60 * 60
    os.utime(orphan, (old, old))

    counts = await run_maintenance(sessions, store, stale_minutes=15)

    assert counts["orphanFiles"] == 1
    assert not orphan.exists()
    await engine.dispose()


@pytest.mark.asyncio
async def test_generation_queue_claims_and_recovers_jobs(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'queue.sqlite3'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    now = utc_now()
    async with sessions() as session:
        session.add(
            GenerationJob(
                id="33333333-3333-4333-8333-333333333333",
                entitlement_id="11111111-1111-4111-8111-111111111111",
                session_id="22222222-2222-4222-8222-222222222222",
                mode="classic",
                scene_id="portrait-only",
                request_hash="a" * 64,
                status="queued",
                attempts=0,
                created_at=now,
                updated_at=now,
            )
        )
        await session.commit()

    queue = GenerationQueue()
    async with sessions() as session:
        claimed = await queue.claim(session)
        assert [job.status for job in claimed] == ["processing"]
        assert claimed[0].attempts == 1
        await session.commit()

    async with sessions() as session:
        recovered = await queue.recover_stale(session, stale_minutes=0)
        assert recovered == 1
        await session.commit()

    async with sessions() as session:
        job = await session.get(
            GenerationJob,
            "33333333-3333-4333-8333-333333333333",
        )
        assert job is not None
        assert job.status == "queued"
    await engine.dispose()


@pytest.mark.asyncio
async def test_generation_queue_updates_details_and_retries(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'queue-retry.sqlite3'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    now = utc_now()
    async with sessions() as session:
        session.add(
            GenerationJob(
                id="33333333-3333-4333-8333-333333333333",
                entitlement_id="11111111-1111-4111-8111-111111111111",
                session_id="22222222-2222-4222-8222-222222222222",
                mode="classic",
                request_hash="b" * 64,
                status="queued",
                attempts=0,
                created_at=now,
                updated_at=now,
                styles=[
                    GenerationStyle(
                        generation_id="33333333-3333-4333-8333-333333333333",
                        style_id="ink",
                        status="queued",
                        attempts=0,
                    )
                ],
            )
        )
        await session.commit()

    queue = GenerationQueue()
    async with sessions() as session:
        assert len(await queue.claim(session)) == 1
        await queue.fail(session, "33333333-3333-4333-8333-333333333333", "UPSTREAM_TIMEOUT")
        await session.commit()

    async with sessions() as session:
        job = await session.get(GenerationJob, "33333333-3333-4333-8333-333333333333")
        detail = await session.scalar(select(GenerationStyle))
        assert job is not None and job.status == "failed"
        assert detail is not None and detail.status == "failed"
        assert await queue.retry(session, job.id)
        await session.commit()

    async with sessions() as session:
        job = await session.get(GenerationJob, "33333333-3333-4333-8333-333333333333")
        detail = await session.scalar(select(GenerationStyle))
        assert job is not None and job.status == "queued"
        assert detail is not None and detail.status == "queued"
        assert len(await queue.claim(session, generation_id=job.id)) == 1
        await queue.complete(session, job.id)
        await session.commit()

    async with sessions() as session:
        job = await session.get(GenerationJob, "33333333-3333-4333-8333-333333333333")
        detail = await session.scalar(select(GenerationStyle))
        assert job is not None and job.status == "succeeded"
        assert detail is not None and detail.status == "succeeded"
    await engine.dispose()


@pytest.mark.asyncio
async def test_generation_worker_consumes_persisted_retry_job(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'worker.sqlite3'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    settings = Settings(
        _env_file=None,
        app_env="test",
        database_url=database_url,
        asset_directory=str(tmp_path / "assets"),
        share_directory=str(tmp_path / "shares"),
        storage_min_free_bytes=1,
    )
    from backend.tests.test_images import image_bytes

    store = __import__(
        "backend.app.storage.assets",
        fromlist=["AssetStore"],
    ).AssetStore(settings)
    source = store.save(image_bytes("PNG"), "image/png", "source", retention_days=1)
    now = utc_now()
    code_id = "worker-code"
    entitlement_id = "55555555-5555-4555-8555-555555555555"
    generation_id = "66666666-6666-4666-8666-666666666666"
    async with sessions() as session:
        session.add(
            RedeemCode(
                id=code_id,
                code_hash="1" * 64,
                code_prefix="WORKER",
                status="redeemed",
                created_at=now,
            )
        )
        session.add(
            Entitlement(
                id=entitlement_id,
                redeem_code_id=code_id,
                session_id="77777777-7777-4777-8777-777777777777",
                token_hash="2" * 64,
                status="active",
                max_styles=4,
                expires_at=now + timedelta(days=1),
                generation_id=generation_id,
                created_at=now,
            )
        )
        session.add(
            GenerationJob(
                id=generation_id,
                entitlement_id=entitlement_id,
                session_id="77777777-7777-4777-8777-777777777777",
                mode="classic",
                scene_id="portrait-only",
                request_hash="3" * 64,
                status="queued",
                source_path=source.relative_path,
                source_expires_at=source.expires_at.replace(tzinfo=None),
                attempts=0,
                created_at=now,
                updated_at=now,
                styles=[
                    GenerationStyle(
                        generation_id=generation_id,
                        style_id="ink",
                        style_version=1,
                        status="queued",
                        attempts=0,
                    )
                ],
            )
        )
        await session.commit()

    worker = GenerationWorker(settings, sessions, store)
    assert await worker.run_once()
    async with sessions() as session:
        job = await session.get(GenerationJob, generation_id)
        entitlement = await session.get(Entitlement, entitlement_id)
        assets = list((await session.scalars(select(Asset))).all())
        assert job is not None and job.status == "succeeded"
        assert entitlement is not None and entitlement.status == "consumed"
        assert len(assets) == 1
        assert store.read(assets[0].file_path).data == store.read(source.relative_path).data
    await engine.dispose()
