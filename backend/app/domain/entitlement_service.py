from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from secrets import choice

from sqlalchemy.ext.asyncio import AsyncSession

from ..api.errors import ApiError
from ..config import Settings
from ..db.models import Entitlement, RedeemCode
from ..repositories.entitlement_repository import EntitlementRepository
from ..security.tokens import generate_access_token, hash_token

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_PATTERN = re.compile(r"^[A-HJ-NP-Z2-9]{8}$")
SESSION_PATTERN = re.compile(
    r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
    re.IGNORECASE,
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def normalize_redeem_code(value: str) -> str:
    return value.strip().upper()


def validate_redeem_code(value: str) -> str:
    normalized = normalize_redeem_code(value)
    if not CODE_PATTERN.fullmatch(normalized):
        raise ApiError("INVALID_INPUT", "兑换码或体验会话无效", 400)
    return normalized


def validate_session_id(value: str) -> str:
    if not SESSION_PATTERN.fullmatch(value) or str(uuid.UUID(value)).lower() != value.lower():
        raise ApiError("INVALID_INPUT", "兑换码或体验会话无效", 400)
    return value


def _redeem_error(status: str) -> ApiError:
    if status == "invalid":
        return ApiError("REDEEM_INVALID", "兑换码不存在", 404)
    if status == "expired":
        return ApiError("REDEEM_EXPIRED", "兑换码已过期", 410)
    if status == "disabled":
        return ApiError("REDEEM_DISABLED", "兑换码已失效", 410)
    return ApiError("REDEEM_USED", "兑换码已使用", 409)


class EntitlementService:
    def __init__(
        self,
        settings: Settings,
        repository: EntitlementRepository | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository or EntitlementRepository()

    async def redeem(
        self,
        session: AsyncSession,
        *,
        code: str,
        session_id: str,
    ) -> tuple[Entitlement, str]:
        normalized = validate_redeem_code(code)
        validate_session_id(session_id)
        code_hash = hash_token(normalized)
        now = utc_now()

        async with session.begin():
            redeem_code = await self.repository.find_redeem_code(
                session, code_hash, for_update=True
            )
            if redeem_code is None:
                raise _redeem_error("invalid")
            if redeem_code.status == "disabled":
                raise _redeem_error("disabled")
            if redeem_code.status in {"redeemed", "reserved"}:
                raise _redeem_error("used")
            if redeem_code.expires_at and redeem_code.expires_at <= now:
                raise _redeem_error("expired")

            access_token = generate_access_token()
            expires_at = now + timedelta(hours=self.settings.entitlement_ttl_hours)
            if redeem_code.expires_at and redeem_code.expires_at < expires_at:
                expires_at = redeem_code.expires_at

            entitlement = Entitlement(
                id=str(uuid.uuid4()),
                redeem_code_id=redeem_code.id,
                session_id=session_id,
                token_hash=hash_token(access_token),
                status="active",
                max_styles=self.settings.max_styles,
                expires_at=expires_at,
                created_at=now,
            )
            redeem_code.status = "redeemed"
            redeem_code.session_id = session_id
            redeem_code.redeemed_at = now
            await self.repository.create_entitlement(session, entitlement)

        return entitlement, access_token

    async def generate_codes(
        self,
        session: AsyncSession,
        *,
        count: int,
        expires_at: datetime | None,
        actor_user_id: int | None = None,
    ) -> list[tuple[RedeemCode, str]]:
        if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 500:
            raise ApiError("INVALID_INPUT", "生成数量或过期时间无效", 400)
        if expires_at is not None:
            expires_at = expires_at.astimezone(timezone.utc).replace(tzinfo=None)
            if expires_at <= utc_now():
                raise ApiError("INVALID_INPUT", "生成数量或过期时间无效", 400)

        generated: list[tuple[RedeemCode, str]] = []
        async with session.begin():
            seen: set[str] = set()
            while len(generated) < count:
                value = "".join(choice(CODE_ALPHABET) for _ in range(8))
                code_hash = hash_token(value)
                if value in seen:
                    continue
                if await self.repository.find_redeem_code(session, code_hash) is not None:
                    continue
                seen.add(value)
                row = RedeemCode(
                    id=str(uuid.uuid4()),
                    code_hash=code_hash,
                    code_prefix=value[:4],
                    status="available",
                    expires_at=expires_at,
                    created_at=utc_now(),
                )
                generated.append((row, value))
            await self.repository.create_redeem_codes(
                session, (row for row, _value in generated)
            )
            await self.repository.add_audit_log(
                session,
                actor_user_id=actor_user_id,
                action="redeem_codes.generated",
                target_type="redeem-code",
                target_id=None,
                reason=f"count={count}",
                created_at=utc_now(),
            )
        return generated
