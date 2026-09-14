from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base


class RedeemCode(Base):
    __tablename__ = "redeem_codes"
    __table_args__ = (
        UniqueConstraint("code_hash", name="uq_redeem_code_hash"),
        Index("idx_redeem_status", "status", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    code_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="available", nullable=False)
    session_id: Mapped[str | None] = mapped_column(String(100))
    reserved_at: Mapped[datetime | None] = mapped_column(DateTime)
    redeemed_at: Mapped[datetime | None] = mapped_column(DateTime)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    entitlement: Mapped["Entitlement | None"] = relationship(
        back_populates="redeem_code", uselist=False
    )


class Entitlement(Base):
    __tablename__ = "entitlements"
    __table_args__ = (
        UniqueConstraint("redeem_code_id", name="uq_entitlement_redeem_code"),
        UniqueConstraint("token_hash", name="uq_entitlement_token_hash"),
        UniqueConstraint("generation_id", name="uq_entitlement_generation"),
        Index("idx_entitlement_session_status", "session_id", "status", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    redeem_code_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("redeem_codes.id"), nullable=False
    )
    session_id: Mapped[str] = mapped_column(String(100), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False)
    max_styles: Mapped[int] = mapped_column(Integer, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    generation_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime)

    redeem_code: Mapped[RedeemCode] = relationship(back_populates="entitlement")


class GenerationJob(Base):
    __tablename__ = "generation_jobs"
    __table_args__ = (
        UniqueConstraint("entitlement_id", name="uq_generation_entitlement"),
        Index("idx_generation_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    entitlement_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("entitlements.id"), nullable=False
    )
    session_id: Mapped[str] = mapped_column(String(100), nullable=False)
    mode: Mapped[str] = mapped_column(String(16), nullable=False)
    scene_id: Mapped[str | None] = mapped_column(String(80))
    background_id: Mapped[str | None] = mapped_column(String(80))
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    source_path: Mapped[str | None] = mapped_column(String(500))
    source_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    error_code: Mapped[str | None] = mapped_column(String(80))
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    entitlement: Mapped[Entitlement] = relationship()
    styles: Mapped[list["GenerationStyle"]] = relationship(
        back_populates="generation", cascade="all, delete-orphan"
    )
    assets: Mapped[list["Asset"]] = relationship(
        back_populates="generation", cascade="all, delete-orphan"
    )


class GenerationStyle(Base):
    __tablename__ = "generation_styles"
    __table_args__ = (
        UniqueConstraint("generation_id", "style_id", name="uq_generation_style"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    generation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("generation_jobs.id"), nullable=False
    )
    style_id: Mapped[str] = mapped_column(String(80), nullable=False)
    style_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    output_path: Mapped[str | None] = mapped_column(String(500))
    output_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(80))
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)

    generation: Mapped[GenerationJob] = relationship(back_populates="styles")


class StyleVersion(Base):
    __tablename__ = "style_versions"
    __table_args__ = (
        UniqueConstraint("style_id", "version", name="uq_style_version"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    style_id: Mapped[str] = mapped_column(String(80), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    subtitle: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    cover_path: Mapped[str | None] = mapped_column(String(500))
    preview_data: Mapped[str | None] = mapped_column(Text)
    palette_json: Mapped[str | None] = mapped_column(String(255))
    motif: Mapped[str | None] = mapped_column(String(40))
    mode: Mapped[str] = mapped_column(String(16), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    created_by: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)


class BackgroundVersion(Base):
    __tablename__ = "background_versions"
    __table_args__ = (
        UniqueConstraint("background_id", "version", name="uq_background_version"),
        Index("idx_background_published", "status", "enabled", "sort_order"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    background_id: Mapped[str] = mapped_column(String(80), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    subtitle: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    pose_hint: Mapped[str] = mapped_column(Text, nullable=False)
    analysis_prompt: Mapped[str | None] = mapped_column(Text)
    image_path: Mapped[str] = mapped_column(String(500), nullable=False)
    image_mime: Mapped[str] = mapped_column(String(80), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    analysis_status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    created_by: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    analyzed_at: Mapped[datetime | None] = mapped_column(DateTime)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)


class Asset(Base):
    __tablename__ = "assets"
    __table_args__ = (Index("idx_assets_expiry", "expires_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    generation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("generation_jobs.id"), nullable=False
    )
    style_id: Mapped[str] = mapped_column(String(80), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(80), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    generation: Mapped[GenerationJob] = relationship(back_populates="assets")


class Share(Base):
    __tablename__ = "shares"
    __table_args__ = (Index("idx_shares_expiry", "expires_at"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(100), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    images_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class AdminUser(Base):
    __tablename__ = "admin_users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class AdminSession(Base):
    __tablename__ = "admin_sessions"
    __table_args__ = (Index("idx_admin_sessions_expiry", "expires_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("admin_users.id", ondelete="CASCADE"), nullable=False
    )
    csrf_token: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ip_hash: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("idx_audit_created", "created_at"),
        Index("idx_audit_action", "action"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_user_id: Mapped[int | None] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    target_type: Mapped[str] = mapped_column(String(80), nullable=False)
    target_id: Mapped[str | None] = mapped_column(String(120))
    reason: Mapped[str | None] = mapped_column(String(500))
    metadata_json: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class ModelConfig(Base):
    __tablename__ = "model_configs"
    __table_args__ = (
        Index("idx_model_configs_type_enabled", "model_type", "enabled"),
        Index("idx_model_configs_type_default", "model_type", "is_default"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    model_type: Mapped[str] = mapped_column(String(40), nullable=False)
    provider: Mapped[str] = mapped_column(String(80), nullable=False)
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    endpoint: Mapped[str] = mapped_column(String(200), nullable=False)
    model_name: Mapped[str] = mapped_column(String(160), nullable=False)
    api_key: Mapped[str] = mapped_column(Text, nullable=False)
    timeout_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    # Per-line resilience. Nullable so rows created before these columns existed
    # keep working; a NULL falls back to the defaults in app.model_configs.
    max_attempts: Mapped[int | None] = mapped_column(Integer)
    failure_threshold: Mapped[int | None] = mapped_column(Integer)
    cooldown_seconds: Mapped[int | None] = mapped_column(Integer)
    extra_config: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_by: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
