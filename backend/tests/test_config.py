from backend.app.config import Settings


def test_runtime_requires_mysql_including_development():
    try:
        Settings(
            _env_file=None,
            APP_ENV="development",
            MYSQL_ENABLED=False,
        )
    except ValueError as error:
        assert "MYSQL_ENABLED" in str(error)
    else:
        raise AssertionError("runtime settings should reject SQLite fallback")


def test_sqlite_is_allowed_only_for_explicit_test_fixtures():
    settings = Settings(
        _env_file=None,
        APP_ENV="test",
        DATABASE_URL="sqlite+aiosqlite://",
        MYSQL_ENABLED=False,
    )

    assert settings.database_url_value == "sqlite+aiosqlite://"


def test_runtime_rejects_sqlite_database_url():
    try:
        Settings(
            _env_file=None,
            APP_ENV="development",
            MYSQL_ENABLED=True,
            DATABASE_URL="sqlite+aiosqlite:///./data/aiaimage.sqlite3",
        )
    except ValueError as error:
        assert "mysql+aiomysql" in str(error)
    else:
        raise AssertionError("runtime settings should reject SQLite URL")


def test_production_requires_mysql_and_a_strong_session_secret():
    try:
        Settings(
            _env_file=None,
            APP_ENV="production",
            MYSQL_ENABLED=False,
            ADMIN_SESSION_SECRET="short",
        )
    except ValueError as error:
        assert "MYSQL_ENABLED" in str(error)
    else:
        raise AssertionError("production settings should be rejected")


def test_environment_cannot_select_the_image_provider():
    """供应商由数据库决定，环境变量不再承载这个选择。

    ``AI_PROVIDER`` 曾被 Settings 读取并参与选择 provider 实现类，而运行时
    真正生效的是 model_configs 里的默认行。两者不一致时，排查会指向错误的
    方向。现在该字段即使出现在环境里也不会被读取。
    """
    settings = Settings(
        _env_file=None,
        APP_ENV="test",
        DATABASE_URL="sqlite+aiosqlite://",
        MYSQL_ENABLED=False,
        AI_PROVIDER="gemini-3.1-flash-image",
    )

    assert not hasattr(settings, "ai_provider")
