"""Seed the default non-payment catalog styles.

Revision ID: 003_seed_default_styles
Revises: 002_share_session_id
"""

from typing import Sequence, Union

from alembic import op

from backend.app.catalog.seed_db import seed_default_styles


revision: str = "003_seed_default_styles"
down_revision: Union[str, None] = "002_share_session_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    seed_default_styles(op.get_bind())


def downgrade() -> None:
    # Seed data is content and may have been edited from the admin console.
    # Never delete it during a schema downgrade.
    pass
