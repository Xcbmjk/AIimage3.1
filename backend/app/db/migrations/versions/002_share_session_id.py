"""Add the owning kiosk session to share records.

Revision ID: 002_share_session_id
Revises: 001_entitlement_schema
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "002_share_session_id"
down_revision: Union[str, None] = "001_entitlement_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _index_exists(table_name: str, index_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    if not _column_exists("shares", "session_id"):
        op.add_column(
            "shares",
            sa.Column("session_id", sa.String(length=100), nullable=True),
        )
    if not _index_exists("shares", "idx_shares_session"):
        op.create_index("idx_shares_session", "shares", ["session_id"])


def downgrade() -> None:
    if _index_exists("shares", "idx_shares_session"):
        op.drop_index("idx_shares_session", table_name="shares")
    if _column_exists("shares", "session_id"):
        op.drop_column("shares", "session_id")
