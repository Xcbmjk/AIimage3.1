from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.api.admin_redeem_codes import _secure_cookies
from backend.app.config import Settings
from backend.app.db.base import Base
from backend.app.db.models import AdminUser
from backend.app.main import create_app
from backend.app.security.admin_auth import hash_admin_password
from backend.app.domain.entitlement_service import utc_now


@pytest.fixture
async def admin_client(tmp_path: Path):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'admin.sqlite3'}"
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
                    password_hash=hash_admin_password("db-password"),
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
            yield client
    await engine.dispose()


@pytest.mark.asyncio
async def test_admin_login_restores_account_session_and_csrf(admin_client):
    unauthorized = await admin_client.get("/api/admin/auth/me")
    assert unauthorized.status_code == 401

    invalid = await admin_client.post(
        "/api/admin/auth/login",
        json={"username": "owner", "password": "wrong-password"},
    )
    assert invalid.status_code == 401
    assert invalid.json()["code"] == "ADMIN_UNAUTHORIZED"

    token_is_not_a_database_password = await admin_client.post(
        "/api/admin/auth/login",
        json={"username": "owner", "password": "admin-test-token"},
    )
    assert token_is_not_a_database_password.status_code == 401

    login = await admin_client.post(
        "/api/admin/auth/login",
        json={"username": "owner", "password": "db-password"},
    )
    assert login.status_code == 200
    assert login.json()["user"] == {"username": "owner", "role": "owner"}
    assert admin_client.cookies.get("admin_session")
    csrf = admin_client.cookies.get("admin_csrf")
    assert csrf

    me = await admin_client.get("/api/admin/auth/me")
    assert me.status_code == 200
    assert me.json()["user"] == {"username": "owner", "role": "owner"}
    assert "code:write" in me.json()["permissions"]

    missing_csrf = await admin_client.post(
        "/api/admin/redeem-codes/generate",
        json={"count": 1},
    )
    assert missing_csrf.status_code == 403
    assert missing_csrf.json()["code"] == "CSRF_INVALID"

    generated = await admin_client.post(
        "/api/admin/redeem-codes/generate",
        headers={"X-CSRF-Token": csrf},
        json={"count": 1},
    )
    assert generated.status_code == 201

    logout_without_csrf = await admin_client.post("/api/admin/auth/logout")
    assert logout_without_csrf.status_code == 403

    logout = await admin_client.post(
        "/api/admin/auth/logout",
        headers={"X-CSRF-Token": csrf},
    )
    assert logout.status_code == 204
    assert (await admin_client.get("/api/admin/auth/me")).status_code == 401


def test_admin_cookie_security_follows_public_url():
    http_settings = Settings(
        _env_file=None,
        app_env="production",
        mysql_enabled=True,
        mysql_host="127.0.0.1",
        mysql_user="aiimage-py",
        mysql_password="password",
        mysql_database="aiaimage",
        ai_provider="gemini-3.1-flash-image",
        gemini_image_base_url="https://image.example/v1",
        gemini_image_api_key="key",
        gemini_image_model="model",
        admin_session_secret="x" * 32,
        public_base_url="http://203.0.113.10:8787",
    )
    https_settings = http_settings.model_copy(
        update={"public_base_url": "https://kiosk.example"}
    )

    assert _secure_cookies(http_settings) is False
    assert _secure_cookies(https_settings) is True
