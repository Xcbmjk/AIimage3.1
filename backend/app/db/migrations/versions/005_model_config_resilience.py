"""Move per-vendor resilience settings onto the configuration row.

Revision ID: 005_model_config_resilience
Revises: 004_model_configs
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "005_model_config_resilience"
down_revision: Union[str, None] = "004_model_configs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable on purpose: rows created before this revision keep working and
    # fall back to the defaults in app.model_configs.
    op.add_column(
        "model_configs",
        sa.Column("max_attempts", sa.Integer(), nullable=True),
    )
    op.add_column(
        "model_configs",
        sa.Column("failure_threshold", sa.Integer(), nullable=True),
    )
    op.add_column(
        "model_configs",
        sa.Column("cooldown_seconds", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("model_configs", "cooldown_seconds")
    op.drop_column("model_configs", "failure_threshold")
    op.drop_column("model_configs", "max_attempts")
