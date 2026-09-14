from __future__ import annotations

from io import BytesIO
from pathlib import Path

import httpx
import pytest
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.config import Settings
from backend.app.db.base import Base
from backend.app.db.models import AdminUser, BackgroundVersion, ModelConfig, StyleVersion
from backend.app.domain.entitlement_service import utc_now
from backend.app.main import create_app
from backend.app.security.admin_auth import hash_admin_password


def image_bytes(image_format: str = "PNG") -> bytes:
    output = BytesIO()
    Image.new("RGB", (32, 48), (24, 80, 64)).save(output, format=image_format)
    return output.getvalue()


@pytest.fixture
async def admin_console(tmp_path: Path):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'admin-console.sqlite3'}"
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
            transport=transport,
            base_url="http://testserver",
        ) as client:
            login = await client.post(
                "/api/admin/auth/login",
                json={"username": "owner", "password": "password"},
            )
            assert login.status_code == 200
            yield client, app
    await engine.dispose()


@pytest.mark.asyncio
async def test_admin_console_style_crud_publish_and_audit(admin_console):
    client, app = admin_console
    csrf = client.cookies["admin_csrf"]

    uploaded = await client.post(
        "/api/admin/style-assets",
        headers={"Content-Type": "image/png", "X-CSRF-Token": csrf},
        content=image_bytes(),
    )
    assert uploaded.status_code == 201
    asset_path = uploaded.json()["path"]

    created = await client.post(
        "/api/admin/styles",
        headers={"X-CSRF-Token": csrf},
        json={
            "styleId": "console-style",
            "name": "控制台风格",
            "subtitle": "测试",
            "description": "测试风格",
            "prompt": "保留人物身份并使用测试风格",
            "mode": "realistic",
            "palette": ["#35574a", "#c8a96b", "#edf1e8"],
            "previewPath": asset_path,
            "sortOrder": 1,
            "enabled": True,
        },
    )
    assert created.status_code == 201
    assert created.json()["version"] == 1

    listed = await client.get("/api/admin/styles")
    assert listed.status_code == 200
    assert listed.json()["styles"][0]["styleId"] == "console-style"

    published = await client.post(
        "/api/admin/styles/console-style/publish",
        headers={"X-CSRF-Token": csrf},
        json={"version": 1},
    )
    assert published.status_code == 200

    catalog = await client.get("/api/catalog")
    assert catalog.status_code == 200
    assert [style["id"] for style in catalog.json()["styles"]] == ["console-style"]

    asset = await client.get("/api/admin/style-assets/" + asset_path.rsplit("/", 1)[-1].split(".", 1)[0])
    assert asset.status_code == 200
    assert asset.headers["content-type"].startswith("image/png")

    audit = await client.get("/api/admin/audit-logs")
    assert audit.status_code == 200
    assert any(item["action"] == "style.published" for item in audit.json()["logs"])


@pytest.mark.asyncio
async def test_admin_console_background_upload_analyze_and_publish(admin_console):
    client, _app = admin_console
    csrf = client.cookies["admin_csrf"]

    uploaded = await client.post(
        "/api/admin/background-assets",
        headers={"Content-Type": "image/jpeg", "X-CSRF-Token": csrf},
        content=image_bytes("JPEG"),
    )
    assert uploaded.status_code == 201

    created = await client.post(
        "/api/admin/backgrounds",
        headers={"X-CSRF-Token": csrf},
        json={
            "backgroundId": "console-background",
            "name": "控制台背景",
            "subtitle": "站立",
            "description": "测试背景",
            "poseHint": "人物站在画面中央",
            "imagePath": uploaded.json()["path"],
            "sortOrder": 1,
            "enabled": True,
        },
    )
    assert created.status_code == 201

    analyzed = await client.post(
        "/api/admin/backgrounds/console-background/analyze",
        headers={"X-CSRF-Token": csrf},
        json={"version": 1},
    )
    assert analyzed.status_code == 200
    assert analyzed.json()["analysisStatus"] == "ready"

    published = await client.post(
        "/api/admin/backgrounds/console-background/publish",
        headers={"X-CSRF-Token": csrf},
        json={"version": 1},
    )
    assert published.status_code == 200

    catalog = await client.get("/api/catalog")
    assert [item["id"] for item in catalog.json()["backgrounds"]] == ["console-background"]


@pytest.mark.asyncio
async def test_non_owner_cannot_publish_style(tmp_path: Path):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'operator.sqlite3'}"
    engine = create_async_engine(database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    settings = Settings(
        _env_file=None,
        app_env="test",
        database_url=database_url,
        asset_directory=str(tmp_path / "assets"),
        share_directory=str(tmp_path / "shares"),
        static_directory=str(tmp_path / "static"),
        public_directory=str(tmp_path / "public"),
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with app.state.session_factory() as session:
            now = utc_now()
            session.add(
                AdminUser(
                    username="operator",
                    password_hash=hash_admin_password("password"),
                    role="operator",
                    active=True,
                    failed_attempts=0,
                    locked_until=None,
                    created_at=now,
                    updated_at=now,
                )
            )
            session.add(
                StyleVersion(
                    style_id="operator-style",
                    version=1,
                    name="运营风格",
                    subtitle="",
                    description="",
                    prompt="提示",
                    palette_json='["#35574a","#c8a96b","#edf1e8"]',
                    motif="山",
                    mode="realistic",
                    enabled=True,
                    sort_order=1,
                    status="draft",
                    created_at=now,
                )
            )
            await session.commit()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            login = await client.post(
                "/api/admin/auth/login",
                json={"username": "operator", "password": "password"},
            )
            assert login.status_code == 200
            response = await client.post(
                "/api/admin/styles/operator-style/publish",
                headers={"X-CSRF-Token": client.cookies["admin_csrf"]},
                json={"version": 1},
            )
            assert response.status_code == 403
    await engine.dispose()


@pytest.mark.asyncio
async def test_admin_vision_model_config_crud_and_default(admin_console):
    client, _app = admin_console
    csrf = client.cookies["admin_csrf"]
    payload = {
        "name": "NewAPI 视觉",
        "modelType": "vision_analysis",
        "provider": "NewAPI",
        "baseUrl": "https://gateway.example/v1",
        "endpoint": "/chat/completions",
        "modelName": "vision-model",
        "apiKey": "test-key",
        "timeoutMs": 60000,
        "enabled": True,
        "isDefault": True,
    }
    created = await client.post(
        "/api/admin/model-configs",
        headers={"X-CSRF-Token": csrf},
        json=payload,
    )
    assert created.status_code == 201
    config = created.json()
    assert config["modelType"] == "vision_analysis"
    assert config["apiKey"] == "test-key"
    assert config["isDefault"] is True

    listed = await client.get("/api/admin/model-configs?model_type=vision_analysis")
    assert listed.status_code == 200
    assert listed.json()["modelConfigs"][0]["modelName"] == "vision-model"

    health = await client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["checks"]["agentVision"]["details"]["model"] == "vision-model"

    toggled = await client.post(
        f"/api/admin/model-configs/{config['id']}/toggle",
        headers={"X-CSRF-Token": csrf},
    )
    assert toggled.status_code == 200
    assert toggled.json()["enabled"] is False

    default = await client.post(
        f"/api/admin/model-configs/{config['id']}/default",
        headers={"X-CSRF-Token": csrf},
    )
    assert default.status_code == 409


@pytest.mark.asyncio
async def test_admin_image_model_config_accepts_images_api_settings(admin_console):
    client, _app = admin_console
    csrf = client.cookies["admin_csrf"]
    response = await client.post(
        "/api/admin/model-configs",
        headers={"X-CSRF-Token": csrf},
        json={
            "name": "NewAPI 图片",
            "modelType": "image_generation",
            "provider": "NewAPI",
            "baseUrl": "https://gateway.example/v1",
            "endpoint": "/images/edits",
            "modelName": "gpt-image-2",
            "apiKey": "test-key",
            "timeoutMs": 300000,
            "extraConfig": {
                "generationEndpoint": "/images/generations",
                "size": "2K",
                "responseFormat": "b64_json",
            },
            "enabled": True,
            "isDefault": True,
        },
    )
    assert response.status_code == 201
    assert response.json()["modelType"] == "image_generation"
    assert response.json()["extraConfig"]["size"] == "2K"

    health = await client.get("/api/health")
    assert health.json()["checks"]["imageGeneration"]["details"] == {
        "configured": True,
        "model": "gpt-image-2",
        "provider": "NewAPI",
        # 供应商名保持管理员填写的内容，实现类另算：未命中已知实现 key 的
        # 店名统一按 OpenAI 兼容协议处理。
        "implementation": "gpt-image-2",
        "standbyLines": 0,
        "classicEndpoint": "/images/generations",
        "editEndpoint": "/images/edits",
        "responseFormat": "b64_json",
    }
    assert health.json()["checks"]["aiProvider"]["details"]["provider"] == "gpt-image-2"

    listed = await client.get("/api/admin/model-configs?model_type=image_generation")
    assert listed.status_code == 200
    assert listed.json()["modelConfigs"][0]["modelName"] == "gpt-image-2"


@pytest.mark.asyncio
async def test_newapi_model_list_response_is_parsed():
    from backend.app.model_configs import fetch_available_models

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        assert request.headers["Authorization"] == "Bearer test-key"
        return httpx.Response(
            200,
            json={"data": [{"id": "vision-a"}, {"id": "vision-b"}, {"id": "vision-a"}]},
        )

    models = await fetch_available_models(
        base_url="https://gateway.example/v1",
        api_key="test-key",
        timeout_ms=1000,
        transport=httpx.MockTransport(handler),
    )
    assert models == ["vision-a", "vision-b"]
