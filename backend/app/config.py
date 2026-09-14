from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env.local", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        populate_by_name=True,
    )

    app_env: Literal["development", "production", "test"] = Field(
        default="development", validation_alias="APP_ENV"
    )
    api_host: str = Field(default="0.0.0.0", validation_alias="API_HOST")
    api_port: int = Field(default=8787, validation_alias="API_PORT")
    cors_origins: str = Field(
        default="capacitor://localhost,http://localhost",
        validation_alias="CORS_ORIGINS",
    )

    admin_token: SecretStr = Field(default=SecretStr(""), validation_alias="ADMIN_TOKEN")
    admin_session_secret: SecretStr = Field(
        default=SecretStr("change-me-in-production"),
        validation_alias="ADMIN_SESSION_SECRET",
    )

    # The application always runs against MySQL. SQLite is reserved for test
    # fixtures that pass an explicit test-only database URL.
    mysql_enabled: bool = Field(default=True, validation_alias="MYSQL_ENABLED")
    mysql_host: str = Field(default="127.0.0.1", validation_alias="MYSQL_HOST")
    mysql_port: int = Field(default=3306, validation_alias="MYSQL_PORT")
    mysql_user: str = Field(default="root", validation_alias="MYSQL_USER")
    mysql_password: SecretStr = Field(default=SecretStr(""), validation_alias="MYSQL_PASSWORD")
    mysql_database: str = Field(default="aiaimage", validation_alias="MYSQL_DATABASE")
    mysql_connection_limit: int = Field(
        default=10, validation_alias="MYSQL_CONNECTION_LIMIT"
    )
    database_url: str | None = Field(default=None, validation_alias="DATABASE_URL")

    ai_request_timeout_ms: int = Field(
        default=120_000, validation_alias="AI_REQUEST_TIMEOUT_MS"
    )
    ai_max_input_bytes: int = Field(
        default=10 * 1024 * 1024, validation_alias="AI_MAX_INPUT_BYTES"
    )
    max_styles: int = Field(default=4, validation_alias="MAX_STYLES")
    entitlement_ttl_hours: int = Field(
        default=24, validation_alias="ENTITLEMENT_TTL_HOURS"
    )
    share_expiry_hours: int = Field(
        default=24, validation_alias="SHARE_EXPIRY_HOURS"
    )

    log_level: Literal["debug", "info", "warn", "error"] = Field(
        default="info", validation_alias="LOG_LEVEL"
    )
    log_file: str = Field(
        default="logs/generation.log", validation_alias="LOG_FILE"
    )
    log_retention_days: int = Field(
        default=14, validation_alias="LOG_RETENTION_DAYS"
    )
    asset_directory: str = Field(
        default="data/assets", validation_alias="ASSET_DIRECTORY"
    )
    share_directory: str = Field(
        default="data/shares", validation_alias="SHARE_DIRECTORY"
    )
    storage_min_free_bytes: int = Field(
        default=512 * 1024 * 1024, validation_alias="STORAGE_MIN_FREE_BYTES"
    )
    public_base_url: str = Field(
        default="http://127.0.0.1:8787", validation_alias="PUBLIC_BASE_URL"
    )
    static_directory: str = Field(default="dist", validation_alias="STATIC_DIRECTORY")
    public_directory: str = Field(default="public", validation_alias="PUBLIC_DIRECTORY")
    maintenance_interval_seconds: int = Field(
        default=3600, validation_alias="MAINTENANCE_INTERVAL_SECONDS"
    )
    generation_stale_minutes: int = Field(
        default=15, validation_alias="GENERATION_STALE_MINUTES"
    )
    generation_worker_interval_seconds: int = Field(
        default=1, validation_alias="GENERATION_WORKER_INTERVAL_SECONDS"
    )
    max_generation_attempts: int = Field(
        default=3, validation_alias="MAX_GENERATION_ATTEMPTS"
    )

    gpt_image_base_url: str = Field(default="", validation_alias="GPT_IMAGE_BASE_URL")
    gpt_image_api_key: SecretStr = Field(
        default=SecretStr(""), validation_alias="GPT_IMAGE_API_KEY"
    )
    gpt_image_model: str = Field(
        default="gpt-image-2", validation_alias="GPT_IMAGE_MODEL"
    )
    gpt_image_endpoint: str = Field(
        default="/images/edits", validation_alias="GPT_IMAGE_ENDPOINT"
    )
    gpt_image_size: str = Field(default="1024x1536", validation_alias="GPT_IMAGE_SIZE")
    gpt_image_response_format: str = Field(
        default="b64_json", validation_alias="GPT_IMAGE_RESPONSE_FORMAT"
    )

    ark_base_url: str = Field(
        default="https://ark.cn-beijing.volces.com/api/v3",
        validation_alias="ARK_BASE_URL",
    )
    ark_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="ARK_API_KEY")
    ark_seedream_model: str = Field(default="", validation_alias="ARK_SEEDREAM_MODEL")
    ark_image_endpoint: str = Field(
        default="/images/generations", validation_alias="ARK_IMAGE_ENDPOINT"
    )
    ark_image_size: str = Field(default="1024x1536", validation_alias="ARK_IMAGE_SIZE")
    ark_response_format: str = Field(
        default="b64_json", validation_alias="ARK_RESPONSE_FORMAT"
    )
    ark_watermark: bool = Field(default=False, validation_alias="ARK_WATERMARK")

    volc_access_key_id: str = Field(
        default="", validation_alias="VOLC_ACCESS_KEY_ID"
    )
    volc_secret_access_key: SecretStr = Field(
        default=SecretStr(""), validation_alias="VOLC_SECRET_ACCESS_KEY"
    )
    jimeng_base_url: str = Field(
        default="https://visual.volcengineapi.com",
        validation_alias="JIMENG_BASE_URL",
    )
    jimeng_req_key: str = Field(
        default="jimeng_i2i_v30", validation_alias="JIMENG_REQ_KEY"
    )
    jimeng_scale: float = Field(default=0.5, validation_alias="JIMENG_SCALE")
    jimeng_width: int = Field(default=1024, validation_alias="JIMENG_WIDTH")
    jimeng_height: int = Field(default=1536, validation_alias="JIMENG_HEIGHT")
    jimeng_poll_interval_ms: int = Field(
        default=2000, validation_alias="JIMENG_POLL_INTERVAL_MS"
    )
    jimeng_poll_timeout_ms: int = Field(
        default=300_000, validation_alias="JIMENG_POLL_TIMEOUT_MS"
    )

    gemini_image_base_url: str = Field(
        default="https://deepcoding.sbs/v1",
        validation_alias="GEMINI_IMAGE_BASE_URL",
    )
    gemini_image_api_key: SecretStr = Field(
        default=SecretStr(""), validation_alias="GEMINI_IMAGE_API_KEY"
    )
    gemini_image_model: str = Field(
        default="gemini-3.1-flash-image", validation_alias="GEMINI_IMAGE_MODEL"
    )
    gemini_image_endpoint: str = Field(
        default="/chat/completions", validation_alias="GEMINI_IMAGE_ENDPOINT"
    )

    @property
    def origins(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def database_url_value(self) -> str:
        if self.database_url:
            return self.database_url
        if self.mysql_enabled:
            password = self.mysql_password.get_secret_value()
            return (
                f"mysql+aiomysql://{self.mysql_user}:{password}"
                f"@{self.mysql_host}:{self.mysql_port}/{self.mysql_database}"
            )
        if self.app_env == "test":
            return "sqlite+aiosqlite:///./data/aiaimage-test.sqlite3"
        raise ValueError("运行时必须启用远程 MySQL，请设置 MYSQL_ENABLED=true")

    @field_validator(
        "api_port",
        "mysql_port",
        "mysql_connection_limit",
        "ai_request_timeout_ms",
        "ai_max_input_bytes",
        "max_styles",
        "entitlement_ttl_hours",
        "share_expiry_hours",
        "log_retention_days",
        "storage_min_free_bytes",
        "maintenance_interval_seconds",
        "generation_stale_minutes",
        "generation_worker_interval_seconds",
        "max_generation_attempts",
    )
    @classmethod
    def positive_integer(cls, value: int) -> int:
        if value < 1:
            raise ValueError("must be a positive integer")
        return value

    @field_validator("max_styles")
    @classmethod
    def max_styles_limit(cls, value: int) -> int:
        if value > 4:
            raise ValueError("MAX_STYLES must not exceed 4")
        return value

    @model_validator(mode="after")
    def validate_selected_provider(self) -> "Settings":
        if self.jimeng_scale < 0 or self.jimeng_scale > 1:
            raise ValueError("JIMENG_SCALE must be between 0 and 1")
        for value, name in (
            (self.jimeng_width, "JIMENG_WIDTH"),
            (self.jimeng_height, "JIMENG_HEIGHT"),
            (self.jimeng_poll_interval_ms, "JIMENG_POLL_INTERVAL_MS"),
            (self.jimeng_poll_timeout_ms, "JIMENG_POLL_TIMEOUT_MS"),
        ):
            if value < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.jimeng_width > 12_000 or self.jimeng_height > 12_000:
            raise ValueError("JIMENG_WIDTH and JIMENG_HEIGHT must not exceed 12000")
        if self.jimeng_poll_timeout_ms < self.jimeng_poll_interval_ms:
            raise ValueError(
                "JIMENG_POLL_TIMEOUT_MS must be greater than JIMENG_POLL_INTERVAL_MS"
            )
        if self.log_level not in {"debug", "info", "warn", "error"}:
            raise ValueError("LOG_LEVEL must be debug, info, warn, or error")
        if self.app_env != "test":
            if not self.mysql_enabled:
                raise ValueError("运行时必须设置 MYSQL_ENABLED=true，禁止使用 SQLite")
            if self.database_url and not self.database_url.startswith("mysql+aiomysql://"):
                raise ValueError(
                    "运行时 DATABASE_URL 必须使用 mysql+aiomysql，禁止使用 SQLite"
                )
        if self.app_env == "production":
            if len(self.admin_session_secret.get_secret_value().encode()) < 32:
                raise ValueError(
                    "production ADMIN_SESSION_SECRET must be at least 32 bytes"
                )
        return self

    def ensure_directories(self) -> None:
        for value in (self.asset_directory, self.share_directory):
            Path(value).mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_directories()
    return settings
