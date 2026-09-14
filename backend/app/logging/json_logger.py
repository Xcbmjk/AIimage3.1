from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "event": record.getMessage(),
        }
        extra = getattr(record, "event_data", None)
        if isinstance(extra, dict):
            payload.update(extra)
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def configure_logging(
    level: str,
    file_path: str,
    *,
    retention_days: int = 14,
) -> logging.Logger:
    logger = logging.getLogger("shan_jing")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.handlers.clear()
    formatter = JsonFormatter()
    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    logger.addHandler(stream)
    path = Path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _trim_log_file(path, retention_days)
    file_handler = logging.FileHandler(path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    logger.propagate = False
    return logger


def log_event(logger: logging.Logger, level: int, event: str, **data: Any) -> None:
    logger.log(
        level,
        event,
        extra={"event_data": {key: _safe_value(value) for key, value in data.items()}},
    )


def _trim_log_file(path: Path, retention_days: int) -> None:
    if not path.is_file():
        return
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    retained: list[str] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                value = json.loads(line).get("timestamp")
                timestamp = datetime.fromisoformat(
                    str(value).replace("Z", "+00:00")
                )
            except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
                continue
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            if timestamp >= cutoff:
                retained.append(line)
        path.write_text(
            f"{chr(10).join(retained)}{chr(10) if retained else ''}",
            encoding="utf-8",
        )
    except OSError:
        return


def _safe_value(value: Any) -> Any:
    if isinstance(value, BaseException):
        return {"name": type(value).__name__, "message": str(value)[:500]}
    if isinstance(value, str):
        return value if len(value) <= 500 else f"{value[:500]}..."
    return value
