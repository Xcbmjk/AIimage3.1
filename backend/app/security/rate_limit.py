from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    retry_after: int = 0


class InMemoryRateLimiter:
    """Process-local sliding-window limiter for the single-device API runtime."""

    def __init__(self) -> None:
        self._events: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, scope: str, key: str, *, limit: int, window_seconds: int) -> RateLimitResult:
        now = time.monotonic()
        bucket_key = (scope, key)
        with self._lock:
            events = self._events[bucket_key]
            cutoff = now - window_seconds
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= limit:
                retry_after = max(1, int(events[0] + window_seconds - now + 0.999))
                return RateLimitResult(False, retry_after)
            events.append(now)
            return RateLimitResult(True)

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
