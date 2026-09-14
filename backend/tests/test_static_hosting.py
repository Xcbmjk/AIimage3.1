from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from backend.app.config import Settings
from backend.app.main import create_app


@pytest.mark.asyncio
async def test_python_static_hosting_routes_admin_to_admin_app(tmp_path: Path):
    static_directory = tmp_path / "dist"
    (static_directory / "admin").mkdir(parents=True)
    (static_directory / "assets").mkdir()
    (static_directory / "index.html").write_text(
        '<div id="root">visitor</div>',
        encoding="utf-8",
    )
    (static_directory / "admin" / "index.html").write_text(
        '<div id="admin-root">admin</div>',
        encoding="utf-8",
    )

    settings = Settings(
        _env_file=None,
        app_env="test",
        admin_token="admin-test-token",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'api.sqlite3'}",
        asset_directory=str(tmp_path / "assets-store"),
        share_directory=str(tmp_path / "shares"),
        static_directory=str(static_directory),
        public_directory=str(tmp_path / "public"),
    )
    app = create_app(settings)

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            admin = await client.get("/admin")
            admin_slash = await client.get("/admin/")
            admin_deep_link = await client.get("/admin/redeem-codes")
            visitor = await client.get("/")

    assert admin.status_code == 200
    assert 'id="admin-root"' in admin.text
    assert admin_slash.status_code == 200
    assert 'id="admin-root"' in admin_slash.text
    assert admin_deep_link.status_code == 200
    assert 'id="admin-root"' in admin_deep_link.text
    assert visitor.status_code == 200
    assert 'id="root"' in visitor.text
