"""Create the entitlement-based application schema.

Revision ID: 001_entitlement_schema
Revises:
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "001_entitlement_schema"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "admin_users",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("username", sa.String(length=80), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("failed_attempts", sa.Integer(), nullable=False),
        sa.Column("locked_until", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username", name="uq_admin_users_username"),
    )
    op.create_table(
        "admin_sessions",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("csrf_token", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
        sa.Column("ip_hash", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=255), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"], ["admin_users.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_admin_sessions_expiry", "admin_sessions", ["expires_at"])
    op.create_table(
        "redeem_codes",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("code_prefix", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("session_id", sa.String(length=100), nullable=True),
        sa.Column("reserved_at", sa.DateTime(), nullable=True),
        sa.Column("redeemed_at", sa.DateTime(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code_hash", name="uq_redeem_code_hash"),
    )
    op.create_index("idx_redeem_status", "redeem_codes", ["status", "expires_at"])
    op.create_table(
        "entitlements",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("redeem_code_id", sa.String(length=36), nullable=False),
        sa.Column("session_id", sa.String(length=100), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("max_styles", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("generation_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["redeem_code_id"], ["redeem_codes.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("redeem_code_id", name="uq_entitlement_redeem_code"),
        sa.UniqueConstraint("token_hash", name="uq_entitlement_token_hash"),
        sa.UniqueConstraint("generation_id", name="uq_entitlement_generation"),
    )
    op.create_index(
        "idx_entitlement_session_status",
        "entitlements",
        ["session_id", "status", "expires_at"],
    )
    op.create_table(
        "generation_jobs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("entitlement_id", sa.String(length=36), nullable=False),
        sa.Column("session_id", sa.String(length=100), nullable=False),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("scene_id", sa.String(length=80), nullable=True),
        sa.Column("background_id", sa.String(length=80), nullable=True),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("source_path", sa.String(length=500), nullable=True),
        sa.Column("source_expires_at", sa.DateTime(), nullable=True),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["entitlement_id"], ["entitlements.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("entitlement_id", name="uq_generation_entitlement"),
    )
    op.create_index("idx_generation_status", "generation_jobs", ["status"])
    op.create_table(
        "generation_styles",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("generation_id", sa.String(length=36), nullable=False),
        sa.Column("style_id", sa.String(length=80), nullable=False),
        sa.Column("style_version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("output_path", sa.String(length=500), nullable=True),
        sa.Column("output_expires_at", sa.DateTime(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["generation_id"], ["generation_jobs.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "generation_id", "style_id", name="uq_generation_style"
        ),
    )
    op.create_table(
        "style_versions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("style_id", sa.String(length=80), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("subtitle", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("cover_path", sa.String(length=500), nullable=True),
        sa.Column("preview_data", sa.Text(), nullable=True),
        sa.Column("palette_json", sa.String(length=255), nullable=True),
        sa.Column("motif", sa.String(length=40), nullable=True),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("style_id", "version", name="uq_style_version"),
    )
    op.create_table(
        "background_versions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("background_id", sa.String(length=80), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("subtitle", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("pose_hint", sa.Text(), nullable=False),
        sa.Column("analysis_prompt", sa.Text(), nullable=True),
        sa.Column("image_path", sa.String(length=500), nullable=False),
        sa.Column("image_mime", sa.String(length=80), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("analysis_status", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("analyzed_at", sa.DateTime(), nullable=True),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("background_id", "version", name="uq_background_version"),
    )
    op.create_index(
        "idx_background_published",
        "background_versions",
        ["status", "enabled", "sort_order"],
    )
    op.create_table(
        "assets",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("generation_id", sa.String(length=36), nullable=False),
        sa.Column("style_id", sa.String(length=80), nullable=False),
        sa.Column("file_path", sa.String(length=500), nullable=False),
        sa.Column("mime_type", sa.String(length=80), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["generation_id"], ["generation_jobs.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_assets_expiry", "assets", ["expires_at"])
    op.create_table(
        "shares",
        sa.Column("id", sa.String(length=40), nullable=False),
        sa.Column("session_id", sa.String(length=100), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("images_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_shares_expiry", "shares", ["expires_at"])
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("actor_user_id", sa.Integer(), nullable=True),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("target_type", sa.String(length=80), nullable=False),
        sa.Column("target_id", sa.String(length=120), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_audit_created", "audit_logs", ["created_at"])
    op.create_index("idx_audit_action", "audit_logs", ["action"])


def downgrade() -> None:
    op.drop_index("idx_audit_action", table_name="audit_logs")
    op.drop_index("idx_audit_created", table_name="audit_logs")
    op.drop_table("audit_logs")
    op.drop_index("idx_shares_expiry", table_name="shares")
    op.drop_table("shares")
    op.drop_index("idx_assets_expiry", table_name="assets")
    op.drop_table("assets")
    op.drop_index("idx_background_published", table_name="background_versions")
    op.drop_table("background_versions")
    op.drop_table("style_versions")
    op.drop_table("generation_styles")
    op.drop_index("idx_generation_status", table_name="generation_jobs")
    op.drop_table("generation_jobs")
    op.drop_index(
        "idx_entitlement_session_status", table_name="entitlements"
    )
    op.drop_table("entitlements")
    op.drop_index("idx_redeem_status", table_name="redeem_codes")
    op.drop_table("redeem_codes")
    op.drop_index("idx_admin_sessions_expiry", table_name="admin_sessions")
    op.drop_table("admin_sessions")
    op.drop_table("admin_users")
