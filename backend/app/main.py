from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.errors import ApiError, api_error_handler
from .api.admin_redeem_codes import create_admin_redeem_codes_router
from .api.admin import create_admin_router
from .api.catalog import create_catalog_router
from .api.entitlements import create_entitlement_router
from .api.events import create_events_router
from .api.generation import create_generation_router
from .api.health import create_health_router
from .api.shares import create_share_router
from .config import Settings, get_settings
from .db.session import create_engine, create_session_factory
from .logging.json_logger import configure_logging, log_event
from .maintenance import maintenance_loop
from .jobs.generation_worker import GenerationWorker
from .security.rate_limit import InMemoryRateLimiter
from .storage.assets import AssetStore


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or get_settings()
    engine = create_engine(config)
    session_factory = create_session_factory(engine)
    logger = configure_logging(
        config.log_level,
        config.log_file,
        retention_days=config.log_retention_days,
    )
    asset_store = AssetStore(config)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = config
        app.state.engine = engine
        app.state.session_factory = session_factory
        app.state.logger = logger
        maintenance_task = None
        worker_task = None
        worker_stop_event = asyncio.Event()
        if config.app_env != "test":
            maintenance_task = asyncio.create_task(
                maintenance_loop(
                    session_factory,
                    asset_store,
                    logger,
                    interval_seconds=config.maintenance_interval_seconds,
                    stale_minutes=config.generation_stale_minutes,
                )
            )
            worker = GenerationWorker(
                config,
                session_factory,
                asset_store,
                logger,
            )
            worker_task = asyncio.create_task(
                worker.run(
                    worker_stop_event,
                    interval_seconds=config.generation_worker_interval_seconds,
                )
            )
        app.state.maintenance_task = maintenance_task
        app.state.generation_worker_task = worker_task
        yield
        if worker_task is not None:
            worker_stop_event.set()
            await worker_task
        if maintenance_task is not None:
            maintenance_task.cancel()
            await maintenance_task
        await engine.dispose()

    app = FastAPI(title="山境造像 API", lifespan=lifespan)
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Content-Type",
            "X-Entitlement-Token",
            "X-Request-ID",
            "X-Admin-Token",
            "X-CSRF-Token",
        ],
    )

    limiter = InMemoryRateLimiter()
    limits = {
        "/api/generation": (6, 60),
        "/api/agent/generation": (6, 60),
        "/api/shares": (10, 60),
        "/api/admin/auth/login": (10, 15 * 60),
    }

    @app.middleware("http")
    async def rate_limit(request: Request, call_next):
        policy = limits.get(request.url.path)
        if policy is not None:
            host = request.client.host if request.client else "unknown"
            scope = request.url.path
            result = limiter.check(
                scope,
                host,
                limit=policy[0],
                window_seconds=policy[1],
            )
            if not result.allowed:
                response = JSONResponse(
                    status_code=429,
                    content={
                        "code": "RATE_LIMITED",
                        "message": "请求过于频繁，请稍后重试",
                        "retryable": True,
                    },
                    headers={"Retry-After": str(result.retry_after)},
                )
                return response
        return await call_next(request)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        if request.method == "POST" and request.url.path == "/api/redeem-codes/claim":
            return JSONResponse(
                status_code=404,
                content={
                    "code": "NOT_FOUND",
                    "message": "外部兑换码领取接口不存在",
                    "retryable": False,
                },
            )
        incoming = request.headers.get("X-Request-ID", "")
        request_id = incoming if 0 < len(incoming) <= 100 and all(
            character.isalnum() or character in "._:-" for character in incoming
        ) else str(uuid.uuid4())
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        log_event(
            logger,
            logging.INFO,
            "http.request_completed",
            requestId=request_id,
            method=request.method,
            path=request.url.path,
            statusCode=response.status_code,
            durationMs=round((time.perf_counter() - started) * 1000),
        )
        return response

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    app.include_router(create_health_router(config, session_factory))
    app.include_router(create_events_router(logger))
    app.include_router(create_entitlement_router(config, session_factory))
    app.include_router(create_admin_redeem_codes_router(config, session_factory))
    app.include_router(create_admin_router(config, session_factory, asset_store))
    app.include_router(create_catalog_router(config, session_factory, asset_store))
    app.include_router(create_generation_router(config, session_factory, asset_store))
    app.include_router(create_share_router(config, session_factory, asset_store))

    public_directory = Path(config.public_directory)
    if public_directory.exists():
        app.mount("/public", StaticFiles(directory=public_directory), name="public")

    static_directory = Path(config.static_directory)
    if static_directory.exists():
        app.mount("/assets", StaticFiles(directory=static_directory / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def frontend_fallback(path: str):
            if path.startswith("api/"):
                return JSONResponse(
                    status_code=404,
                    content={"code": "NOT_FOUND", "message": "接口不存在", "retryable": False},
                )
            if path == "admin" or path.startswith("admin/"):
                admin_path = path.removeprefix("admin/") if path != "admin" else ""
                admin_candidate = static_directory / "admin" / admin_path
                if (
                    admin_path
                    and admin_candidate.is_file()
                    and static_directory in admin_candidate.resolve().parents
                ):
                    return FileResponse(admin_candidate)
                admin_index = static_directory / "admin" / "index.html"
                if admin_index.exists():
                    return FileResponse(admin_index)
            candidate = static_directory / path
            if candidate.is_file() and static_directory in candidate.resolve().parents:
                return FileResponse(candidate)
            index = static_directory / "index.html"
            if index.exists():
                return FileResponse(index)
            return JSONResponse(status_code=404, content={"message": "页面不存在"})

    return app


app = create_app()
