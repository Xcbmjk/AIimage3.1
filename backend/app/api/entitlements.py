from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings
from ..dependencies import create_db_dependency
from ..domain.entitlement_service import EntitlementService


class RedeemRequest(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    sessionId: str = Field(min_length=1, max_length=100)


def _iso(value: datetime) -> str:
    return value.replace(tzinfo=None).isoformat(timespec="milliseconds") + "Z"


def create_entitlement_router(
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
) -> APIRouter:
    router = APIRouter()
    db = create_db_dependency(session_factory)
    service = EntitlementService(settings)

    @router.post("/api/entitlements/redeem", status_code=200)
    async def redeem(
        payload: RedeemRequest,
        session: AsyncSession = Depends(db),
    ) -> dict:
        entitlement, access_token = await service.redeem(
            session,
            code=payload.code,
            session_id=payload.sessionId,
        )
        return {
            "accessToken": access_token,
            "entitlement": {
                "code": payload.code.strip().upper(),
                "status": "used",
                "maxStyles": entitlement.max_styles,
                "expiresAt": _iso(entitlement.expires_at),
                "sessionId": entitlement.session_id,
            },
        }

    return router
