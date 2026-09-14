from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class CircuitBreaker:
    """In-process failure tracking for vendor lines.

    A line that keeps failing is skipped for a cooldown, so a dead vendor does
    not burn every request's full timeout before the standby row is tried.
    State lives in the process: restarting clears it, which suits a
    single-device kiosk and avoids introducing shared storage only for
    liveness. A line re-enters the rotation automatically once the cooldown
    elapses; the next request is the probe.

    Threshold and cooldown are per call here because they are configured per
    ``model_configs`` row, while one breaker instance is shared across every
    line and every request. The constructor values are the fallback used when
    a caller does not supply the row's settings.
    """

    failure_threshold: int = 3
    cooldown_seconds: float = 60.0
    _failures: dict[str, int] = field(default_factory=dict)
    # key -> (opened_at_monotonic, cooldown_seconds). The cooldown is captured
    # when the line opens so a later configuration change cannot retroactively
    # reopen or extend an in-flight window.
    _opened_at: dict[str, tuple[float, float]] = field(default_factory=dict)

    def is_open(self, key: str) -> bool:
        opened = self._opened_at.get(key)
        if opened is None:
            return False
        opened_at, cooldown = opened
        if time.monotonic() - opened_at >= cooldown:
            # Cooldown elapsed: let one request through and judge it on merit.
            self._failures.pop(key, None)
            self._opened_at.pop(key, None)
            return False
        return True

    def record_success(self, key: str) -> None:
        self._failures.pop(key, None)
        self._opened_at.pop(key, None)

    def record_failure(
        self,
        key: str,
        *,
        failure_threshold: int | None = None,
        cooldown_seconds: float | None = None,
    ) -> None:
        threshold = (
            failure_threshold
            if failure_threshold is not None
            else self.failure_threshold
        )
        cooldown = (
            cooldown_seconds if cooldown_seconds is not None else self.cooldown_seconds
        )
        failures = self._failures.get(key, 0) + 1
        self._failures[key] = failures
        if failures >= threshold:
            self._opened_at[key] = (time.monotonic(), cooldown)
