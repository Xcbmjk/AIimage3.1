from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse


@dataclass
class ApiError(Exception):
    code: str
    message: str
    status_code: int = 400
    retryable: bool = False


def api_error_response(error: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={
            "code": error.code,
            "message": error.message,
            "retryable": error.retryable,
        },
    )


async def api_error_handler(_request: Request, error: ApiError) -> JSONResponse:
    return api_error_response(error)
