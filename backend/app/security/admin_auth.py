from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..api.errors import ApiError
from ..config import Settings
from ..db.models import AdminSession, AdminUser
from ..domain.entitlement_service import utc_now

Role = str
SESSION_TTL = timedelta(hours=8)
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
ROLE_PERMISSIONS: dict[Role, frozenset[str]] = {
    "owner": frozenset(
        {
            "read",
            "retry",
            "style:draft",
            "style:write",
            "code:write",
            "background:draft",
            "background:write",
            "health:read",
            "health:write",
            "audit:read",
            # 删除游客作品是破坏性操作，只给老板
            "artwork:delete",
        }
    ),
    "operator": frozenset(
        {
            "read",
            "retry",
            "style:draft",
            "background:draft",
            "health:read",
            "health:write",
        }
    ),
    "technical": frozenset({"read", "retry", "health:read", "audit:read"}),
}


@dataclass(frozen=True)
class AdminPrincipal:
    username: str
    role: Role
    permissions: frozenset[str]
    session_id: str | None = None
    csrf_token: str | None = None
    user_id: int | None = None


@dataclass(frozen=True)
class AdminLogin:
    principal: AdminPrincipal
    session_id: str
    csrf_token: str


def hash_admin_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=16_384,
        r=8,
        p=1,
        dklen=32,
    ).hex()
    return f"{salt}:{digest}"


def verify_admin_password(password: str, encoded: str) -> bool:
    try:
        salt, expected = encoded.split(":", 1)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt.encode("utf-8"),
            n=16_384,
            r=8,
            p=1,
            dklen=32,
        ).hex()
    except (TypeError, ValueError):
        return False
    return secrets.compare_digest(actual, expected)


class AdminAuth:
    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory

    async def login(self, username: str, password: str, request: Request) -> AdminLogin:
        username = username.strip()
        if not username or not password or len(username) > 80 or len(password) > 256:
            raise ApiError("INVALID_INPUT", "请输入账号和密码", 400)

        user_id: int | None = None
        role: Role | None = None
        async with self.session_factory() as session:
            account = await session.scalar(
                select(AdminUser).where(AdminUser.username == username)
            )
            if (
                account is not None
                and account.active
                and verify_admin_password(password, account.password_hash)
            ):
                user_id = account.id
                role = account.role

        if role is None:
            raise ApiError("ADMIN_UNAUTHORIZED", "账号或密码错误", 401)

        permissions = ROLE_PERMISSIONS.get(role, frozenset({"read"}))
        session_id = secrets.token_hex(32)
        csrf_token = secrets.token_hex(32)
        expires_at = utc_now() + SESSION_TTL
        principal = AdminPrincipal(
            username=username,
            role=role,
            permissions=permissions,
            session_id=session_id,
            csrf_token=csrf_token,
            user_id=user_id,
        )

        async with self.session_factory() as session:
            async with session.begin():
                now = utc_now()
                session.add(
                    AdminSession(
                        id=session_id,
                        user_id=user_id,
                        csrf_token=csrf_token,
                        expires_at=expires_at,
                        created_at=now,
                        last_seen_at=now,
                        ip_hash=None,
                        user_agent=(request.headers.get("User-Agent") or "")[:255] or None,
                    )
                )

        return AdminLogin(
            principal=principal,
            session_id=session_id,
            csrf_token=csrf_token,
        )

    async def authenticate(self, request: Request) -> AdminPrincipal | None:
        cookie_session_id = request.cookies.get("admin_session")
        if cookie_session_id:
            principal = await self._load_database_session(cookie_session_id)
            if principal is not None:
                if request.method in WRITE_METHODS:
                    self._check_csrf(request, principal.csrf_token or "")
                return principal

        configured_token = self.settings.admin_token.get_secret_value()
        supplied_token = request.headers.get("X-Admin-Token", "")
        if configured_token and secrets.compare_digest(supplied_token, configured_token):
            return AdminPrincipal(
                username="bootstrap",
                role="owner",
                permissions=ROLE_PERMISSIONS["owner"],
            )
        return None

    async def logout(self, principal: AdminPrincipal) -> None:
        if not principal.session_id:
            return
        async with self.session_factory() as session:
            row = await session.get(AdminSession, principal.session_id)
            if row is not None:
                await session.delete(row)
                await session.commit()

    def dependency(self) -> Callable:
        async def require_admin(request: Request) -> AdminPrincipal:
            authenticated = await self.authenticate(request)
            if authenticated is None:
                raise ApiError("ADMIN_UNAUTHORIZED", "后台登录已失效", 401)
            return authenticated

        return require_admin

    async def _load_database_session(self, session_id: str) -> AdminPrincipal | None:
        async with self.session_factory() as session:
            result = await session.execute(
                select(AdminSession, AdminUser)
                .join(AdminUser, AdminUser.id == AdminSession.user_id)
                .where(
                    AdminSession.id == session_id,
                    AdminSession.expires_at > utc_now(),
                    AdminUser.active.is_(True),
                )
            )
            row = result.one_or_none()
            if row is None:
                return None
            admin_session, user = row
            admin_session.last_seen_at = utc_now()
            await session.commit()
            return AdminPrincipal(
                username=user.username,
                role=user.role,
                permissions=ROLE_PERMISSIONS.get(user.role, frozenset({"read"})),
                session_id=admin_session.id,
                csrf_token=admin_session.csrf_token,
                user_id=user.id,
            )

    @staticmethod
    def _check_csrf(request: Request, expected: str) -> None:
        supplied = request.headers.get("X-CSRF-Token", "")
        if not expected or not supplied or not secrets.compare_digest(supplied, expected):
            raise ApiError("CSRF_INVALID", "请求安全校验失败，请刷新后台页面后重试", 403)
