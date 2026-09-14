from __future__ import annotations

from datetime import datetime
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Entitlement, RedeemCode


class EntitlementRepository:
    async def find_redeem_code(
        self,
        session: AsyncSession,
        code_hash: str,
        *,
        for_update: bool = False,
    ) -> RedeemCode | None:
        statement = select(RedeemCode).where(RedeemCode.code_hash == code_hash)
        if for_update:
            statement = statement.with_for_update()
        return await session.scalar(statement)

    async def create_redeem_codes(
        self,
        session: AsyncSession,
        rows: Iterable[RedeemCode],
    ) -> None:
        session.add_all(list(rows))
        await session.flush()

    async def list_redeem_codes(
        self,
        session: AsyncSession,
    ) -> list[RedeemCode]:
        result = await session.scalars(
            select(RedeemCode).order_by(RedeemCode.created_at.desc())
        )
        return list(result)

    async def create_entitlement(
        self,
        session: AsyncSession,
        entitlement: Entitlement,
    ) -> Entitlement:
        session.add(entitlement)
        await session.flush()
        return entitlement

    async def find_entitlement_by_token_hash(
        self,
        session: AsyncSession,
        token_hash: str,
        *,
        for_update: bool = False,
    ) -> Entitlement | None:
        statement = select(Entitlement).where(Entitlement.token_hash == token_hash)
        if for_update:
            statement = statement.with_for_update()
        return await session.scalar(statement)

    async def add_audit_log(
        self,
        session: AsyncSession,
        *,
        actor_user_id: int | None,
        action: str,
        target_type: str,
        target_id: str | None,
        reason: str | None,
        created_at: datetime,
    ) -> None:
        from ..db.models import AuditLog

        session.add(
            AuditLog(
                actor_user_id=actor_user_id,
                action=action,
                target_type=target_type,
                target_id=target_id,
                reason=reason,
                created_at=created_at,
            )
        )
        await session.flush()
