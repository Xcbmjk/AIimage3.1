from __future__ import annotations

import asyncio
import time
from pathlib import Path
from shutil import disk_usage

from fastapi import APIRouter
from sqlalchemy import text

from ..config import Settings
from ..model_configs import (
    IMAGE_GENERATION,
    MOCK_PROVIDER_KEY,
    VISION_ANALYSIS,
    agent_configs_available,
    get_active_model_configs,
    get_default_model_config,
    resolve_provider_key,
)


def create_health_router(
    settings: Settings,
    session_factory,
) -> APIRouter:
    router = APIRouter()

    async def timed_database_check() -> dict[str, object]:
        started = time.perf_counter()
        try:
            async with session_factory() as session:
                await asyncio.wait_for(session.execute(text("SELECT 1")), timeout=1.5)
            return {
                "status": "ok",
                "message": "数据库连接正常",
                "latencyMs": round((time.perf_counter() - started) * 1000),
                "details": {"database": settings.mysql_database},
            }
        except asyncio.TimeoutError:
            return {
                "status": "down",
                "message": "数据库检查超时",
                "latencyMs": round((time.perf_counter() - started) * 1000),
                "details": {"code": "MYSQL_TIMEOUT"},
            }
        except Exception:
            return {
                "status": "down",
                "message": "数据库连接失败",
                "latencyMs": round((time.perf_counter() - started) * 1000),
                "details": {"code": "MYSQL_UNAVAILABLE"},
            }

    def storage_check() -> dict[str, object]:
        started = time.perf_counter()
        try:
            settings.ensure_directories()
            asset_path = Path(settings.asset_directory)
            available = disk_usage(asset_path).free
            status = "ok" if available >= settings.storage_min_free_bytes else "degraded"
            message = "资产目录可用" if status == "ok" else "可用空间低于保留阈值"
            return {
                "status": status,
                "message": message,
                "latencyMs": round((time.perf_counter() - started) * 1000),
                "details": {
                    "availableBytes": available,
                    "minimumFreeBytes": settings.storage_min_free_bytes,
                },
            }
        except OSError:
            return {
                "status": "down",
                "message": "资产目录不可用",
                "latencyMs": round((time.perf_counter() - started) * 1000),
            }

    @router.get("/api/health")
    async def health() -> dict:
        database = await timed_database_check()
        storage = storage_check()
        vision_config = None
        image_config = None
        standby_lines = 0
        if database["status"] == "ok":
            try:
                async with session_factory() as session:
                    vision_config = await get_default_model_config(session, VISION_ANALYSIS)
                    image_config = await get_default_model_config(session, IMAGE_GENERATION)
                    image_lines = await get_active_model_configs(session, IMAGE_GENERATION)
                    standby_lines = max(len(image_lines) - 1, 0)
            except Exception:
                vision_config = None
                image_config = None
                standby_lines = 0
        checks = {
            "api": {"status": "ok", "message": "Python API 服务正常"},
            "database": database,
            "mysql": database,
            "storage": storage,
            "aiProvider": {
                "status": (
                    "ok"
                    if agent_configs_available(
                        settings=settings,
                        vision_config=vision_config,
                        image_config=image_config,
                    )
                    else "degraded"
                ),
                "details": {
                    "provider": (
                        resolve_provider_key(image_config)
                        if image_config is not None
                        else MOCK_PROVIDER_KEY
                        if settings.app_env == "test"
                        else None
                    ),
                    "standbyLines": standby_lines,
                },
            },
            "agentVision": {
                "status": "ok" if vision_config is not None else "degraded",
                "details": {
                    "configured": vision_config is not None,
                    "model": vision_config.model_name if vision_config else None,
                    "provider": vision_config.provider if vision_config else None,
                },
            },
            "imageGeneration": {
                "status": "ok" if image_config is not None else "degraded",
                "details": {
                    "configured": image_config is not None,
                    "model": image_config.model_name if image_config else None,
                    "provider": image_config.provider if image_config else None,
                    "implementation": (
                        resolve_provider_key(image_config) if image_config else None
                    ),
                    "standbyLines": standby_lines,
                    "classicEndpoint": (
                        (image_config.extra_config or {}).get("generationEndpoint")
                        if image_config
                        else None
                    ),
                    "editEndpoint": image_config.endpoint if image_config else None,
                    "responseFormat": (
                        (image_config.extra_config or {}).get("responseFormat", "b64_json")
                        if image_config
                        else None
                    ),
                },
            },
            "queue": {
                "status": "ok" if database["status"] == "ok" else "degraded",
                "message": "持久化任务状态可用" if database["status"] == "ok" else "数据库不可用，任务状态检查暂停",
            },
        }
        blocking = any(item["status"] == "down" for item in checks.values())
        degraded = any(item["status"] == "degraded" for item in checks.values())
        return {
            "status": "down" if blocking else "degraded" if degraded else "ok",
            "ok": not blocking,
            "checks": checks,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    return router
