from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..api.errors import ApiError
from ..config import Settings
from ..dependencies import create_db_dependency
from ..domain.entitlement_service import EntitlementService
from ..security.admin_auth import AdminAuth, AdminPrincipal


class GenerateCodesRequest(BaseModel):
    count: int = Field(default=1, ge=1, le=500)
    expiresAt: datetime | None = None

    @field_validator("expiresAt")
    @classmethod
    def expiration_must_be_timezone_aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("expiresAt must include a timezone")
        return value


class AdminLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.replace(tzinfo=None).isoformat(timespec="milliseconds") + "Z"


def _secure_cookies(settings: Settings) -> bool:
    # The deployment target currently uses HTTP; Secure must follow the public URL.
    return settings.public_base_url.lower().startswith("https://")


def create_admin_redeem_codes_router(
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
) -> APIRouter:
    router = APIRouter()
    db = create_db_dependency(session_factory)
    auth = AdminAuth(settings, session_factory)
    require_admin = auth.dependency()
    service = EntitlementService(settings)

    @router.post("/api/admin/auth/login")
    async def login(
        payload: AdminLoginRequest,
        request: Request,
        response: Response,
    ) -> dict[str, object]:
        result = await auth.login(payload.username, payload.password, request)
        secure = _secure_cookies(settings)
        response.set_cookie(
            "admin_session",
            result.session_id,
            max_age=8 * 60 * 60,
            httponly=True,
            samesite="strict",
            secure=secure,
            path="/",
        )
        response.set_cookie(
            "admin_csrf",
            result.csrf_token,
            max_age=8 * 60 * 60,
            httponly=False,
            samesite="strict",
            secure=secure,
            path="/",
        )
        return {
            "user": {
                "username": result.principal.username,
                "role": result.principal.role,
            },
            "csrf": result.csrf_token,
        }

    @router.get("/api/admin/auth/me")
    async def me(principal: AdminPrincipal = Depends(require_admin)) -> dict[str, object]:
        return {
            "user": {
                "username": principal.username,
                "role": principal.role,
            },
            "permissions": sorted(principal.permissions),
        }

    @router.post("/api/admin/auth/logout", status_code=204, response_model=None)
    async def logout(
        response: Response,
        principal: AdminPrincipal = Depends(require_admin),
    ) -> None:
        await auth.logout(principal)
        response.delete_cookie("admin_session", path="/")
        response.delete_cookie("admin_csrf", path="/")

    @router.post("/api/admin/redeem-codes/generate", status_code=201)
    async def generate(
        payload: GenerateCodesRequest,
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict:
        if "code:write" not in principal.permissions:
            raise ApiError("ADMIN_FORBIDDEN", "当前账号无权执行此操作", 403)
        generated = await service.generate_codes(
            session,
            count=payload.count,
            expires_at=payload.expiresAt,
        )
        return {
            "codes": [
                {
                    "id": row.id,
                    "value": value,
                    "createdAt": _iso(row.created_at),
                    "expiresAt": _iso(row.expires_at),
                }
                for row, value in generated
            ]
        }

    @router.get("/api/admin/redeem-codes")
    async def list_codes(
        principal: AdminPrincipal = Depends(require_admin),
        session: AsyncSession = Depends(db),
    ) -> dict:
        if "code:write" not in principal.permissions:
            raise ApiError("ADMIN_FORBIDDEN", "当前账号无权执行此操作", 403)
        rows = await service.repository.list_redeem_codes(session)
        return {
            "codes": [
                {
                    "id": row.id,
                    "prefix": row.code_prefix,
                    "status": row.status,
                    "sessionId": row.session_id,
                    "reservedAt": _iso(row.reserved_at),
                    "redeemedAt": _iso(row.redeemed_at),
                    "expiresAt": _iso(row.expires_at),
                    "createdAt": _iso(row.created_at),
                }
                for row in rows
            ]
        }

    return router
