from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class CircuitBreaker:
    """In-process failure tracking for one vendor line.

    A line that keeps failing is skipped for a cooldown, so a dead vendor does
    not burn every request's full timeout before the standby row is tried.
    State lives in the process: restarting clears it, which suits a
    single-device kiosk and avoids introducing shared storage only for
    liveness. A line re-enters the rotation automatically once the cooldown
    elapses; the next request is the probe.
    """

    failure_threshold: int = 3
    cooldown_seconds: float = 60.0
    _failures: dict[str, int] = field(default_factory=dict)
    _opened_at: dict[str, float] = field(default_factory=dict)

    def is_open(self, key: str) -> bool:
        opened_at = self._opened_at.get(key)
        if opened_at is None:
            return False
        if time.monotonic() - opened_at >= self.cooldown_seconds:
            # Cooldown elapsed: let one request through and judge it on merit.
            self._failures.pop(key, None)
            self._opened_at.pop(key, None)
            return False
        return True

    def record_success(self, key: str) -> None:
        self._failures.pop(key, None)
        self._opened_at.pop(key, None)

    def record_failure(self, key: str) -> None:
        failures = self._failures.get(key, 0) + 1
        self._failures[key] = failures
        if failures >= self.failure_threshold:
            self._opened_at[key] = time.monotonic()
