from __future__ import annotations

import argparse
import asyncio
import getpass
import sys
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .config import get_settings
from .db.models import AdminUser
from .db.session import create_engine, create_session_factory
from .domain.entitlement_service import utc_now
from .legacy_import import import_legacy_file
from .security.admin_auth import hash_admin_password


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="焕新造像管理员账号工具")
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create-user", help="创建数据库管理员账号")
    create.add_argument("--username", required=True, help="管理员账号")
    create.add_argument(
        "--role",
        choices=("owner", "operator", "technical"),
        default="owner",
        help="管理员角色",
    )
    legacy = subparsers.add_parser(
        "import-legacy", help="导入可安全映射的非支付旧数据 JSON"
    )
    legacy.add_argument("--input", required=True, help="旧数据 JSON 文件")
    legacy.add_argument(
        "--dry-run", action="store_true", help="只校验并统计，不写入数据库"
    )
    return parser.parse_args()


async def create_user(username: str, role: str) -> None:
    settings = get_settings()
    username = username.strip()
    if not username or len(username) > 80:
        raise ValueError("账号长度必须为 1 到 80 个字符")

    password = getpass.getpass("管理员密码: ")
    confirmation = getpass.getpass("再次输入密码: ")
    if not password or len(password) > 256:
        raise ValueError("密码长度必须为 1 到 256 个字符")
    if password != confirmation:
        raise ValueError("两次输入的密码不一致")

    engine = create_engine(settings)
    try:
        session_factory = create_session_factory(engine)
        async with session_factory() as session:
            existing = await session.scalar(
                select(AdminUser).where(AdminUser.username == username)
            )
            if existing is not None:
                raise ValueError(f"管理员账号已存在: {username}")

            now: datetime = utc_now()
            session.add(
                AdminUser(
                    username=username,
                    password_hash=hash_admin_password(password),
                    role=role,
                    active=True,
                    failed_attempts=0,
                    locked_until=None,
                    created_at=now,
                    updated_at=now,
                )
            )
            try:
                await session.commit()
            except IntegrityError as error:
                await session.rollback()
                raise ValueError(f"管理员账号已存在: {username}") from error
    finally:
        await engine.dispose()

    print(f"已创建管理员账号: {username} ({role})")


async def import_legacy(input_path: str, dry_run: bool) -> None:
    settings = get_settings()
    engine = create_engine(settings)
    try:
        session_factory = create_session_factory(engine)
        result = await import_legacy_file(
            session_factory,
            input_path,
            asset_root=settings.asset_directory,
            dry_run=dry_run,
        )
    finally:
        await engine.dispose()
    print(result.as_dict())


def main() -> int:
    args = parse_args()
    try:
        if args.command == "create-user":
            asyncio.run(create_user(args.username, args.role))
        elif args.command == "import-legacy":
            asyncio.run(import_legacy(args.input, args.dry_run))
    except (OSError, ValueError) as error:
        print(f"错误: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
