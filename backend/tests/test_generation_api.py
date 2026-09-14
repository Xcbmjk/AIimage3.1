from __future__ import annotations

import json
import shutil
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.config import Settings
from backend.app.db.base import Base
from backend.app.db.models import BackgroundVersion, Entitlement, ModelConfig
from backend.app.main import create_app
from backend.app.providers.base import GeneratedImage
from backend.app.providers.errors import ProviderError
from backend.app.storage.assets import AssetStore
from backend.app.domain.entitlement_service import utc_now
from backend.app.domain.generation_service import reset_shared_circuit_breaker

SESSION_ID = "11111111-1111-4111-8111-111111111111"
OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222"
GENERATION_ID = "33333333-3333-4333-8333-333333333333"


def multipart(photo: bytes, **fields: str):
    return {
        **{key: (None, value) for key, value in fields.items()},
        "photo": ("photo.png", photo, "image/png"),
    }


async def create_test_client(tmp_path: Path):
    # A fresh app stands in for a fresh process; without this the breaker state
    # left by one case would skip a line that the next case expects to be tried.
    reset_shared_circuit_breaker()
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'generation.sqlite3'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    public_directory = tmp_path / "public"
    public_directory.mkdir()
    shutil.copyfile(
        Path(__file__).parents[2] / "public" / "pixel-leap-logo.webp",
        public_directory / "pixel-leap-logo.webp",
    )
    settings = Settings(
        _env_file=None,
        app_env="test",
        database_url=database_url,
        admin_token="admin-test-token",
        asset_directory=str(tmp_path / "assets"),
        share_directory=str(tmp_path / "shares"),
        static_directory=str(tmp_path / "static"),
        public_directory=str(public_directory),
        storage_min_free_bytes=1,
    )
    app = create_app(settings)
    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://testserver")
    return client, app, engine, lifespan


@pytest.mark.asyncio
async def test_classic_generation_uses_multipart_and_is_idempotent(tmp_path: Path):
    from backend.tests.test_images import image_bytes

    client, app, engine, lifespan = await create_test_client(tmp_path)
    try:
        generated = await client.post(
            "/api/admin/redeem-codes/generate",
            headers={"X-Admin-Token": "admin-test-token"},
            json={"count": 2},
        )
        code = generated.json()["codes"][0]["value"]
        redeemed = await client.post(
            "/api/entitlements/redeem",
            json={"code": code, "sessionId": SESSION_ID},
        )
        token = redeemed.json()["accessToken"]
        photo = image_bytes("PNG")

        result = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                photo,
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                styles=json.dumps([{"id": "ink"}, {"id": "gold"}]),
            ),
        )
        assert result.status_code == 200
        body = result.json()
        assert body["provider"] == "mock"
        assert len(body["assets"]) == 2
        assert all(item["assetId"] for item in body["assets"])

        replay = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                photo,
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                styles=json.dumps([{"id": "ink"}, {"id": "gold"}]),
            ),
        )
        assert replay.status_code == 200
        assert [item["assetId"] for item in replay.json()["assets"]] == [
            item["assetId"] for item in body["assets"]
        ]

        mismatch = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                photo,
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                styles=json.dumps([{"id": "spring"}]),
            ),
        )
        assert mismatch.status_code == 409
        assert mismatch.json()["code"] == "GENERATION_REQUEST_MISMATCH"

        forbidden = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                photo,
                sessionId=OTHER_SESSION_ID,
                generationId="44444444-4444-4444-8444-444444444444",
                styles=json.dumps([{"id": "ink"}]),
            ),
        )
        assert forbidden.status_code == 403
        assert forbidden.json()["code"] == "UNAUTHORIZED"
    finally:
        await client.aclose()
        await lifespan.__aexit__(None, None, None)
        await engine.dispose()


@pytest.mark.asyncio
async def test_classic_generation_uses_database_image_model_config(tmp_path: Path, monkeypatch):
    from backend.tests.test_images import image_bytes

    client, app, engine, lifespan = await create_test_client(tmp_path)
    try:
        generated = await client.post(
            "/api/admin/redeem-codes/generate",
            headers={"X-Admin-Token": "admin-test-token"},
            json={"count": 1},
        )
        code = generated.json()["codes"][0]["value"]
        redeemed = await client.post(
            "/api/entitlements/redeem",
            json={"code": code, "sessionId": SESSION_ID},
        )
        token = redeemed.json()["accessToken"]
        now = utc_now()

        async with app.state.session_factory() as session:
            session.add(
                ModelConfig(
                    id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    name="数据库图片模型",
                    model_type="image_generation",
                    provider="database-provider",
                    base_url="https://gateway.example/v1",
                    endpoint="/images/edits",
                    model_name="database-image-model",
                    api_key="database-key",
                    timeout_ms=300000,
                    extra_config={
                        "generationEndpoint": "/images/generations",
                        "size": "1K",
                        "responseFormat": "b64_json",
                    },
                    enabled=True,
                    is_default=True,
                    created_at=now,
                    updated_at=now,
                )
            )
            await session.commit()

        observed = {}

        async def generate(self, photo, mime_type, prompt, style_id):
            observed.update(
                {
                    "name": self.name,
                    "base_url": self.config.base_url,
                    "endpoint": self.config.generation_endpoint,
                    "model": self.config.model_name,
                    "api_key": self.config.api_key,
                    "size": self.config.size,
                }
            )
            return GeneratedImage(
                image_bytes("PNG"),
                "image/png",
                "database-image-model",
            )

        monkeypatch.setattr("backend.app.providers.gpt_image.GptImageProvider.generate", generate)
        result = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                image_bytes("PNG"),
                sessionId=SESSION_ID,
                generationId="44444444-4444-4444-8444-444444444444",
                styles=json.dumps([{"id": "ink"}]),
            ),
        )
        assert result.status_code == 200
        assert observed == {
            "name": "gpt-image-2",
            "base_url": "https://gateway.example/v1",
            "endpoint": "/images/generations",
            "model": "database-image-model",
            "api_key": "database-key",
            "size": "1K",
        }
    finally:
        await client.aclose()
        await lifespan.__aexit__(None, None, None)
        await engine.dispose()


@pytest.mark.asyncio
async def test_agent_generation_requires_published_analyzed_background(tmp_path: Path):
    from backend.tests.test_images import image_bytes

    client, app, engine, lifespan = await create_test_client(tmp_path)
    try:
        generated = await client.post(
            "/api/admin/redeem-codes/generate",
            headers={"X-Admin-Token": "admin-test-token"},
            json={"count": 1},
        )
        code = generated.json()["codes"][0]["value"]
        redeemed = await client.post(
            "/api/entitlements/redeem",
            json={"code": code, "sessionId": SESSION_ID},
        )
        token = redeemed.json()["accessToken"]

        missing = await client.post(
            "/api/agent/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                image_bytes("PNG"),
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                backgroundId="gate-steps",
            ),
        )
        assert missing.status_code == 400
        assert missing.json()["code"] == "INVALID_INPUT"

        store = AssetStore(app.state.settings)
        background = store.save(
            image_bytes("JPEG"),
            "image/jpeg",
            "background",
            retention_days=30,
        )
        async with app.state.session_factory() as session:
            session.add(
                BackgroundVersion(
                    background_id="gate-steps",
                    version=1,
                    name="门前石阶",
                    subtitle="坐姿 · 正面",
                    description="背景",
                    pose_hint="端坐",
                    analysis_prompt="人物端坐在画面中央，匹配背景透视与光线。",
                    image_path=background.relative_path,
                    image_mime="image/jpeg",
                    enabled=True,
                    sort_order=1,
                    analysis_status="ready",
                    status="published",
                    created_at=utc_now(),
                    published_at=utc_now(),
                    analyzed_at=utc_now(),
                )
            )
            await session.commit()

        result = await client.post(
            "/api/agent/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                image_bytes("PNG"),
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                backgroundId="gate-steps",
            ),
        )
        assert result.status_code == 200
        assert result.json()["prompt"]
        assert len(result.json()["assets"]) == 1
    finally:
        await client.aclose()
        await lifespan.__aexit__(None, None, None)
        await engine.dispose()


@pytest.mark.asyncio
async def test_share_uses_server_assets_and_supports_view_and_download(tmp_path: Path):
    from backend.tests.test_images import image_bytes

    client, app, engine, lifespan = await create_test_client(tmp_path)
    try:
        generated = await client.post(
            "/api/admin/redeem-codes/generate",
            headers={"X-Admin-Token": "admin-test-token"},
            json={"count": 1},
        )
        code = generated.json()["codes"][0]["value"]
        redeemed = await client.post(
            "/api/entitlements/redeem",
            json={"code": code, "sessionId": SESSION_ID},
        )
        token = redeemed.json()["accessToken"]
        result = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                image_bytes("PNG"),
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                styles=json.dumps([{"id": "ink"}]),
            ),
        )
        asset = result.json()["assets"][0]

        shared = await client.post(
            "/api/shares",
            headers={"X-Entitlement-Token": token},
            json={
                "sessionId": SESSION_ID,
                "assets": [{"assetId": asset["assetId"]}],
            },
        )
        assert shared.status_code == 201
        share_url = shared.json()["url"]
        share_id = share_url.rsplit("/", 1)[-1]

        page = await client.get(f"/api/shares/{share_id}")
        assert page.status_code == 200
        assert "焕新造像" in page.text
        assert "保存品牌明信片" in page.text
        assert "/api/shares/assets/pixel-leap-logo.webp" in page.text

        logo = await client.get("/api/shares/assets/pixel-leap-logo.webp")
        assert logo.status_code == 200
        assert logo.headers["content-type"].startswith("image/webp")
        assert logo.content

        image = await client.get(f"/api/shares/{share_id}/images/1")
        assert image.status_code == 200
        # 水印在生成落盘时已烧入（见 generation_service._persist_results），
        # 分享接口直接返回存储内容，与 /api/assets 完全一致。
        assert image.headers["content-type"] == (
            await client.get(f"/api/assets/{asset['assetId']}")
        ).headers["content-type"]
        assert image.content == (
            await client.get(f"/api/assets/{asset['assetId']}")
        ).content

        download = await client.get(f"/api/shares/{share_id}/download/1")
        assert download.status_code == 200
        assert "attachment" in download.headers["content-disposition"]

        rejected = await client.post(
            "/api/shares",
            headers={"X-Entitlement-Token": token},
            json={
                "sessionId": SESSION_ID,
                "assets": [{"assetId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}],
            },
        )
        assert rejected.status_code == 400
        assert rejected.json()["code"] == "INVALID_INPUT"

        client_supplied = await client.post(
            "/api/shares",
            headers={"X-Entitlement-Token": token},
            json={
                "sessionId": SESSION_ID,
                "assets": [
                    {
                        "assetId": asset["assetId"],
                        "imageUrl": "data:image/png;base64,ZmFrZQ==",
                    }
                ],
            },
        )
        assert client_supplied.status_code == 422
    finally:
        await client.aclose()
        await lifespan.__aexit__(None, None, None)
        await engine.dispose()


async def issue_token(client, count: int = 1) -> str:
    generated = await client.post(
        "/api/admin/redeem-codes/generate",
        headers={"X-Admin-Token": "admin-test-token"},
        json={"count": count},
    )
    code = generated.json()["codes"][0]["value"]
    redeemed = await client.post(
        "/api/entitlements/redeem",
        json={"code": code, "sessionId": SESSION_ID},
    )
    return redeemed.json()["accessToken"]


@pytest.mark.asyncio
async def test_partial_success_keeps_delivered_images_and_allows_salvage(
    tmp_path: Path, monkeypatch
):
    """一张失败不应作废已成功的作品，缺失的风格还能免费补画。

    旧实现等四个风格全部成功才落库，任何一张失败都让游客一张都拿不到；
    多风格的整体成功率因此是单张成功率的四次方。
    """
    from backend.tests.test_images import image_bytes

    client, app, engine, lifespan = await create_test_client(tmp_path)
    try:
        token = await issue_token(client)
        photo = image_bytes("PNG")
        calls = {"gold": 0}

        async def generate(self, photo_bytes, mime_type, prompt, style_id):
            if style_id == "gold":
                calls["gold"] += 1
                if calls["gold"] == 1:
                    raise ProviderError(
                        "UPSTREAM_TIMEOUT",
                        "AI 服务等待超时，请稍后重试",
                        retryable=True,
                    )
            return GeneratedImage(photo_bytes, mime_type, f"mock-{style_id}")

        monkeypatch.setattr("backend.app.providers.mock.MockProvider.generate", generate)

        first = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                photo,
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                styles=json.dumps([{"id": "ink"}, {"id": "gold"}]),
            ),
        )
        assert first.status_code == 200
        body = first.json()
        assert [item["styleId"] for item in body["assets"]] == ["ink"]
        assert body["failures"] == [
            {
                "styleId": "gold",
                "code": "UPSTREAM_TIMEOUT",
                "message": "AI 服务等待超时，请稍后重试",
                "retryable": True,
            }
        ]

        # 补画缺失的那张：复用同一个 generationId，不再消耗第二次额度
        second = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                photo,
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                styles=json.dumps([{"id": "gold"}]),
            ),
        )
        assert second.status_code == 200
        salvaged = second.json()
        assert [item["styleId"] for item in salvaged["assets"]] == ["gold"]
        assert not salvaged.get("failures")
    finally:
        await client.aclose()
        await lifespan.__aexit__(None, None, None)
        await engine.dispose()


@pytest.mark.asyncio
async def test_uncertain_job_can_be_retried_instead_of_dead_ending(
    tmp_path: Path, monkeypatch
):
    """不可重试的上游错误不再把任务锁死成「请联系工作人员」。

    旧实现标成 uncertain 后直接返回 409；在无人值守的自助设备上，
    这句话等于把游客卡在机器前。
    """
    from backend.tests.test_images import image_bytes

    client, app, engine, lifespan = await create_test_client(tmp_path)
    try:
        token = await issue_token(client)
        photo = image_bytes("PNG")
        calls = {"count": 0}

        async def generate(self, photo_bytes, mime_type, prompt, style_id):
            calls["count"] += 1
            if calls["count"] == 1:
                raise ProviderError("UPSTREAM_BAD_RESPONSE", "AI 服务返回了无法识别的结果")
            return GeneratedImage(photo_bytes, mime_type, f"mock-{style_id}")

        monkeypatch.setattr("backend.app.providers.mock.MockProvider.generate", generate)

        first = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                photo,
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                styles=json.dumps([{"id": "ink"}]),
            ),
        )
        assert first.status_code == 502
        assert first.json()["code"] == "UPSTREAM_BAD_RESPONSE"

        retry = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                photo,
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                styles=json.dumps([{"id": "ink"}]),
            ),
        )
        assert retry.status_code == 200
        assert len(retry.json()["assets"]) == 1
    finally:
        await client.aclose()
        await lifespan.__aexit__(None, None, None)
        await engine.dispose()


@pytest.mark.asyncio
async def test_all_styles_failing_consumes_nothing_and_stays_retryable(
    tmp_path: Path, monkeypatch
):
    """全部失败时任务整体失败，游客换个风格重来仍能用同一份额度。"""
    from backend.tests.test_images import image_bytes

    client, app, engine, lifespan = await create_test_client(tmp_path)
    try:
        token = await issue_token(client)
        photo = image_bytes("PNG")
        calls = {"count": 0}

        async def generate(self, photo_bytes, mime_type, prompt, style_id):
            calls["count"] += 1
            if calls["count"] <= 2:
                raise ProviderError(
                    "GENERATION_FAILED",
                    "AI 服务暂时不可用，请稍后重试",
                    retryable=True,
                )
            return GeneratedImage(photo_bytes, mime_type, f"mock-{style_id}")

        monkeypatch.setattr("backend.app.providers.mock.MockProvider.generate", generate)

        failed = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                photo,
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                styles=json.dumps([{"id": "ink"}, {"id": "gold"}]),
            ),
        )
        assert failed.status_code == 502
        assert failed.json()["code"] == "GENERATION_FAILED"

        # 换一个风格重试：额度没有被消耗，任务可以重新开始
        retry = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                photo,
                sessionId=SESSION_ID,
                generationId=GENERATION_ID,
                styles=json.dumps([{"id": "ink"}, {"id": "gold"}]),
            ),
        )
        assert retry.status_code == 200
        assert len(retry.json()["assets"]) == 2
    finally:
        await client.aclose()
        await lifespan.__aexit__(None, None, None)
        await engine.dispose()


@pytest.mark.asyncio
async def test_standby_line_serves_when_the_primary_vendor_is_down(
    tmp_path: Path, monkeypatch
):
    """主线路整条不可用时由备用行接管，游客照样拿到作品。

    备用行就是 tokenworldai 这类在库里躺着、默认不启用的配置。它存在的意义
    是厂商宕机时不需要管理员在事故中改数据库。
    """
    from backend.tests.test_images import image_bytes

    client, app, engine, lifespan = await create_test_client(tmp_path)
    try:
        generated = await client.post(
            "/api/admin/redeem-codes/generate",
            headers={"X-Admin-Token": "admin-test-token"},
            json={"count": 1},
        )
        code = generated.json()["codes"][0]["value"]
        redeemed = await client.post(
            "/api/entitlements/redeem",
            json={"code": code, "sessionId": SESSION_ID},
        )
        token = redeemed.json()["accessToken"]
        now = utc_now()

        async with app.state.session_factory() as session:
            session.add_all(
                [
                    ModelConfig(
                        id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                        name="主线路",
                        model_type="image_generation",
                        provider="deepcoding",
                        base_url="https://primary.example/v1",
                        endpoint="/images/edits",
                        model_name="gpt-image-2",
                        api_key="primary-key",
                        timeout_ms=1000,
                        extra_config={"generationEndpoint": "/images/generations"},
                        enabled=True,
                        is_default=True,
                        created_at=now,
                        updated_at=now,
                    ),
                    ModelConfig(
                        id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                        name="备用线路",
                        model_type="image_generation",
                        provider="tokenworldai",
                        base_url="https://standby.example/v1",
                        endpoint="/images/edits",
                        model_name="gpt-image-2",
                        api_key="standby-key",
                        timeout_ms=1000,
                        extra_config={"generationEndpoint": "/images/generations"},
                        enabled=True,
                        is_default=False,
                        created_at=now,
                        updated_at=now,
                    ),
                ]
            )
            await session.commit()

        served: list[str] = []

        async def generate(self, photo, mime_type, prompt, style_id):
            served.append(self.config.base_url)
            if self.config.base_url == "https://primary.example/v1":
                raise ProviderError(
                    "GENERATION_FAILED",
                    "主线路暂不可用",
                    retryable=True,
                )
            return GeneratedImage(image_bytes("PNG"), "image/png", "standby")

        monkeypatch.setattr(
            "backend.app.providers.gpt_image.GptImageProvider.generate", generate
        )

        result = await client.post(
            "/api/generation",
            headers={"X-Entitlement-Token": token},
            files=multipart(
                image_bytes("PNG"),
                sessionId=SESSION_ID,
                generationId="55555555-5555-4555-8555-555555555555",
                styles=json.dumps([{"id": "ink"}]),
            ),
        )

        assert result.status_code == 200
        assert len(result.json()["assets"]) == 1
        assert served == [
            "https://primary.example/v1",
            "https://standby.example/v1",
        ]
        # 两条线路都是同一实现（OpenAI 兼容），所以响应里的 provider 名一致
        assert result.json()["provider"] == "gpt-image-2"
    finally:
        await client.aclose()
        await lifespan.__aexit__(None, None, None)
        await engine.dispose()
