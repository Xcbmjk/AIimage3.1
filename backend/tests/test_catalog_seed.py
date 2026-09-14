from pathlib import Path

from sqlalchemy import create_engine, func, select

from backend.app.catalog.seed_db import seed_default_styles
from backend.app.db.base import Base
from backend.app.db.models import StyleVersion


def test_default_style_seed_is_idempotent(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'catalog-seed.sqlite3'}")
    Base.metadata.create_all(engine)

    with engine.begin() as connection:
        assert seed_default_styles(connection) == 5
        assert seed_default_styles(connection) == 0
        count = connection.scalar(select(func.count()).select_from(StyleVersion))
        published = connection.scalar(
            select(func.count())
            .select_from(StyleVersion)
            .where(StyleVersion.status == "published")
        )

    assert count == 5
    assert published == 5
