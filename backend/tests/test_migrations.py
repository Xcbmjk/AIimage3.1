from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from backend.app.config import get_settings


def test_initial_alembic_migration_creates_runtime_schema_without_payment_tables(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_path = tmp_path / "migration.sqlite3"
    async_database_url = f"sqlite+aiosqlite:///{database_path}"
    sync_database_url = f"sqlite:///{database_path}"
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("MYSQL_ENABLED", "false")
    monkeypatch.setenv("DATABASE_URL", async_database_url)
    get_settings.cache_clear()

    config = Config("backend/alembic.ini")
    command.upgrade(config, "head")

    engine = create_engine(sync_database_url)
    try:
        database_inspector = inspect(engine)
        tables = set(database_inspector.get_table_names())
        assert {
            "admin_users",
            "admin_sessions",
            "redeem_codes",
            "entitlements",
            "generation_jobs",
            "generation_styles",
            "style_versions",
            "background_versions",
            "assets",
            "shares",
            "audit_logs",
            "alembic_version",
        } <= tables
        assert not {
            "orders",
            "refund_requests",
            "payment_notifications",
            "pricing_versions",
            "mini_program_tokens",
            "approval_requests",
        } & tables

        assert {
            index["name"]
            for index in database_inspector.get_indexes("shares")
        } == {"idx_shares_expiry", "idx_shares_session"}
        share_columns = {
            column["name"]: column["nullable"]
            for column in database_inspector.get_columns("shares")
        }
        assert share_columns["session_id"] is False

        foreign_keys = database_inspector.get_foreign_keys("entitlements")
        assert any(
            foreign_key["referred_table"] == "redeem_codes"
            and foreign_key["constrained_columns"] == ["redeem_code_id"]
            for foreign_key in foreign_keys
        )
        assert len(database_inspector.get_indexes("audit_logs")) == 2
    finally:
        engine.dispose()
        get_settings.cache_clear()
