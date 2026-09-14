"""Add extensible model configuration records.

Revision ID: 004_model_configs
Revises: 003_seed_default_styles
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "004_model_configs"
down_revision: Union[str, None] = "003_seed_default_styles"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "model_configs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("model_type", sa.String(length=40), nullable=False),
        sa.Column("provider", sa.String(length=80), nullable=False),
        sa.Column("base_url", sa.String(length=500), nullable=False),
        sa.Column("endpoint", sa.String(length=200), nullable=False),
        sa.Column("model_name", sa.String(length=160), nullable=False),
        sa.Column("api_key", sa.Text(), nullable=False),
        sa.Column("timeout_ms", sa.Integer(), nullable=False),
        sa.Column("extra_config", sa.JSON(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_model_configs_type_enabled",
        "model_configs",
        ["model_type", "enabled"],
    )
    op.create_index(
        "idx_model_configs_type_default",
        "model_configs",
        ["model_type", "is_default"],
    )


def downgrade() -> None:
    op.drop_index("idx_model_configs_type_default", table_name="model_configs")
    op.drop_index("idx_model_configs_type_enabled", table_name="model_configs")
    op.drop_table("model_configs")
