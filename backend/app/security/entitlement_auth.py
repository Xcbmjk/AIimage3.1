from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from fastapi import Header
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.errors import ApiError
from ..db.models import Entitlement
from ..repositories.generation_repository import GenerationRepository
from ..security.tokens import hash_token
from ..domain.entitlement_service import utc_now


@dataclass(frozen=True)
class EntitlementPrincipal:
    entitlement: Entitlement
    token_hash: str


async def require_entitlement(
    session: AsyncSession,
    entitlement_token: str | None,
) -> EntitlementPrincipal:
    if not entitlement_token or len(entitlement_token) > 512:
        raise ApiError("UNAUTHORIZED", "体验权益令牌无效", 401)
    repository = GenerationRepository()
    token_hash = hash_token(entitlement_token)
    entitlement = await repository.find_entitlement(session, token_hash)
    if entitlement is None:
        raise ApiError("UNAUTHORIZED", "体验权益令牌无效", 401)
    now = utc_now()
    if entitlement.expires_at <= now:
        if entitlement.status not in {"expired", "revoked"}:
            entitlement.status = "expired"
            await session.commit()
        raise ApiError("ENTITLEMENT_EXPIRED", "体验权益已过期", 410)
    if entitlement.status == "revoked":
        raise ApiError("ENTITLEMENT_REVOKED", "体验权益已失效", 410)
    await session.commit()
    return EntitlementPrincipal(entitlement, token_hash)


def entitlement_header(
    entitlement_token: str | None = Header(
        default=None,
        alias="X-Entitlement-Token",
    ),
) -> str | None:
    return entitlement_token
