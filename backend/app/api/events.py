from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..api.errors import ApiError
from ..logging.json_logger import log_event

CLIENT_EVENTS = frozenset(
    {
        "session.stage_changed",
        "camera.started",
        "camera.fallback",
        "photo.captured",
        "photo.uploaded",
        "styles.updated",
        "generation.started",
        "generation.client_failed",
        "generation.client_succeeded",
        "agent.started",
        "agent.succeeded",
        "agent.failed",
        "share.started",
        "share.completed",
        "session.reset",
    }
)
SENSITIVE_FIELD = re.compile(
    r"photo|image|url|token|key|secret|authorization|prompt|payload|body",
    re.IGNORECASE,
)


class ClientEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: str = Field(min_length=1, max_length=80)
    sessionId: str = Field(min_length=1, max_length=100)
    data: dict[str, Any]

    @field_validator("event")
    @classmethod
    def known_event(cls, value: str) -> str:
        if value not in CLIENT_EVENTS:
            raise ValueError("未知的操作日志事件")
        return value


def _safe_data(data: dict[str, Any]) -> dict[str, str | int | float | bool]:
    safe: dict[str, str | int | float | bool] = {}
    for key, value in list(data.items())[:12]:
        if not isinstance(key, str) or SENSITIVE_FIELD.search(key):
            continue
        if isinstance(value, str) and len(value) <= 120:
            safe[key] = value
        elif isinstance(value, bool):
            safe[key] = value
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            safe[key] = value
    return safe


def create_events_router(logger: logging.Logger) -> APIRouter:
    router = APIRouter()

    @router.post("/api/events", status_code=204, response_class=Response)
    async def record_event(payload: ClientEvent, request: Request) -> Response:
        if not isinstance(payload.data, dict):
            raise ApiError("INVALID_INPUT", "无效的操作日志", 400)
        log_event(
            logger,
            logging.INFO,
            payload.event,
            requestId=request.state.request_id,
            sessionId=payload.sessionId,
            source="browser",
            data=_safe_data(payload.data),
        )
        return Response(status_code=204)

    return router
