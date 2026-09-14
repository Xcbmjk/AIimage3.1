from __future__ import annotations

import logging

import httpx
import pytest

from backend.app.config import Settings
from backend.app.main import create_app


def test_safe_data_filters_sensitive_and_unbounded_values():
    from backend.app.api.events import _safe_data

    assert _safe_data(
        {
            "durationMs": 42,
            "source": "camera",
            "photoBytes": 1024,
            "imageUrl": "https://example.test/photo.png",
            "accessToken": "not-for-logs",
            "prompt": "not-for-logs",
            "long": "x" * 121,
            "nested": {"value": "not-for-logs"},
        }
    ) == {"durationMs": 42, "source": "camera"}


@pytest.mark.asyncio
async def test_events_accept_allowlisted_input_and_log_safe_metadata(tmp_path, monkeypatch):
    from backend.app.api import events

    captured: list[tuple[logging.Logger, int, str, dict]] = []

    def capture(logger, level, event, **data):
        captured.append((logger, level, event, data))

    monkeypatch.setattr(events, "log_event", capture)
    settings = Settings(
        _env_file=None,
        app_env="test",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'events.sqlite3'}",
        asset_directory=str(tmp_path / "assets"),
        share_directory=str(tmp_path / "shares"),
        static_directory=str(tmp_path / "static"),
        public_directory=str(tmp_path / "public"),
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            accepted = await client.post(
                "/api/events",
                json={
                    "event": "generation.started",
                    "sessionId": "session-1",
                    "data": {
                        "styleCount": 2,
                        "imageUrl": "https://private.example.test/photo.png",
                        "token": "private-token",
                    },
                },
            )
            unknown = await client.post(
                "/api/events",
                json={"event": "anything.else", "sessionId": "session-1", "data": {}},
            )
            extra = await client.post(
                "/api/events",
                json={
                    "event": "session.reset",
                    "sessionId": "session-1",
                    "data": {},
                    "photo": "not-accepted",
                },
            )

    assert accepted.status_code == 204
    assert unknown.status_code == 422
    assert extra.status_code == 422
    assert len(captured) == 1
    _, level, event, data = captured[0]
    assert level == logging.INFO
    assert event == "generation.started"
    assert data["sessionId"] == "session-1"
    assert data["data"] == {"styleCount": 2}
