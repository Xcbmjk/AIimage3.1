from __future__ import annotations

import json
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.engine import Connection

from .seed import STYLE_PRESETS


def seed_default_styles(connection: Connection) -> int:
    """Insert the built-in styles without touching existing administrator data."""
    table = sa.Table("style_versions", sa.MetaData(), autoload_with=connection)
    inserted = 0
    for sort_order, style in enumerate(STYLE_PRESETS):
        exists = connection.execute(
            sa.select(table.c.id).where(
                table.c.style_id == style.id,
                table.c.version == 1,
            )
        ).first()
        if exists is not None:
            continue

        now = datetime.now(UTC).replace(tzinfo=None)
        connection.execute(
            table.insert().values(
                style_id=style.id,
                version=1,
                name=style.name,
                subtitle=style.subtitle,
                description=style.description,
                prompt=style.prompt,
                cover_path=None,
                preview_data=style.resultImage,
                palette_json=json.dumps(style.palette, ensure_ascii=False),
                motif=style.motif,
                mode=style.mode,
                enabled=True,
                sort_order=sort_order,
                status="published",
                created_by=None,
                created_at=now,
                published_at=now,
            )
        )
        inserted += 1
    return inserted
