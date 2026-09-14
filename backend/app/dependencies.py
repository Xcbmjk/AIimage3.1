from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .config import Settings, get_settings
from .db.session import session_dependency


def settings_dependency() -> Settings:
    return get_settings()


def create_db_dependency(factory: async_sessionmaker[AsyncSession]):
    async def dependency():
        async for session in session_dependency(factory):
            yield session

    return dependency


SettingsDependency = Annotated[Settings, Depends(settings_dependency)]
