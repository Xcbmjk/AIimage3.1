from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from ..config import Settings


def create_engine(settings: Settings) -> AsyncEngine:
    database_url = settings.database_url_value
    if settings.app_env != "test" and not database_url.startswith("mysql+aiomysql://"):
        raise ValueError("运行时数据库必须是远程 MySQL（mysql+aiomysql）")

    kwargs: dict[str, object] = {}
    if database_url.startswith("mysql+aiomysql://"):
        kwargs.update(
            pool_size=settings.mysql_connection_limit,
            max_overflow=0,
            pool_recycle=1800,
        )
    else:
        kwargs["pool_pre_ping"] = True
    return create_async_engine(database_url, **kwargs)


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def session_dependency(
    factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    async with factory() as session:
        yield session
