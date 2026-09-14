from __future__ import annotations

from dataclasses import dataclass, field

from ..model_configs import DEFAULT_COOLDOWN_SECONDS, DEFAULT_FAILURE_THRESHOLD
from .base import GeneratedImage, ImageProvider
from .circuit import CircuitBreaker
from .errors import ProviderError, is_line_failure


@dataclass(frozen=True)
class GenerationLine:
    """One configured vendor row plus the breaker key that tracks it.

    ``failure_threshold`` and ``cooldown_seconds`` come from the row, so the
    administrator tunes degradation in the console rather than in the
    environment. The defaults keep hand-built lines (tests, tooling) working.
    """

    key: str
    provider: ImageProvider
    failure_threshold: int = DEFAULT_FAILURE_THRESHOLD
    cooldown_seconds: float = DEFAULT_COOLDOWN_SECONDS


@dataclass
class FailoverImageProvider:
    """Serves a request from the first configured line that answers.

    Lines are tried in the order the administrator ranked them: the default row
    first, then the remaining enabled rows by recency. Only failures that
    belong to the vendor move to the next line. A rejected request is raised
    immediately, because every vendor would reject it identically and burning
    the standby on it would only add latency.
    """

    lines: list[GenerationLine]
    breaker: CircuitBreaker
    _served_by: str | None = field(default=None)

    @property
    def name(self) -> str:
        if self._served_by is not None:
            return self._served_by
        return self.lines[0].provider.name if self.lines else "unconfigured"

    async def generate(
        self,
        photo: bytes,
        mime_type: str,
        prompt: str,
        style_id: str,
    ) -> GeneratedImage:
        return await self._dispatch("generate", photo, mime_type, prompt, style_id)

    async def compose(
        self,
        background: bytes,
        background_mime: str,
        photo: bytes,
        photo_mime: str,
        prompt: str,
        background_id: str,
    ) -> GeneratedImage:
        return await self._dispatch(
            "compose",
            background,
            background_mime,
            photo,
            photo_mime,
            prompt,
            background_id,
        )

    async def _dispatch(self, method: str, *args: object) -> GeneratedImage:
        cooling_down = 0
        last_line_error: ProviderError | None = None
        for line in self.lines:
            if self.breaker.is_open(line.key):
                cooling_down += 1
                continue
            try:
                result: GeneratedImage = await getattr(line.provider, method)(*args)
            except ProviderError as error:
                if not is_line_failure(error):
                    raise
                self.breaker.record_failure(
                    line.key,
                    failure_threshold=line.failure_threshold,
                    cooldown_seconds=line.cooldown_seconds,
                )
                last_line_error = error
                continue
            self.breaker.record_success(line.key)
            self._served_by = line.provider.name
            return result
        if last_line_error is not None:
            raise last_line_error
        raise ProviderError(
            "UPSTREAM_TRANSIENT",
            "所有图片线路都在冷却中，请稍后重试",
            retryable=True,
            details={"coolingDownLines": cooling_down},
        )
