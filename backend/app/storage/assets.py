from __future__ import annotations

import os
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ..api.errors import ApiError
from ..config import Settings
from .images import validate_image_bytes

ALLOWED_MIME = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}
ALLOWED_CATEGORIES = {"source", "output", "style", "background"}


@dataclass(frozen=True)
class StoredAsset:
    id: str
    relative_path: str
    absolute_path: Path
    mime_type: str
    byte_size: int
    expires_at: datetime | None
    data: bytes | None = None


class AssetStore:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.root = Path(settings.asset_directory).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def save(
        self,
        data: bytes,
        mime_type: str,
        category: str,
        *,
        retention_days: int,
    ) -> StoredAsset:
        if category not in ALLOWED_CATEGORIES or mime_type not in ALLOWED_MIME:
            raise ApiError("INVALID_INPUT", "图片格式或存储类别无效", 400)
        info = validate_image_bytes(data, self.settings.ai_max_input_bytes)
        if info.mime_type != mime_type:
            mime_type = info.mime_type
        required = self.settings.storage_min_free_bytes + len(data)
        if self._free_bytes() < required:
            raise ApiError("STORAGE_LOW_SPACE", "服务器存储空间不足", 503, True)
        asset_id = str(uuid.uuid4())
        relative = Path(category) / f"{asset_id}.{ALLOWED_MIME[mime_type]}"
        absolute = self._resolve(relative)
        absolute.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(absolute, flags, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
        except Exception:
            try:
                absolute.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        from datetime import timedelta, timezone

        expires_at = datetime.now(timezone.utc) + timedelta(days=retention_days)
        return StoredAsset(
            id=asset_id,
            relative_path=relative.as_posix(),
            absolute_path=absolute,
            mime_type=mime_type,
            byte_size=len(data),
            expires_at=expires_at,
            data=None,
        )

    def read(self, relative_path: str, *, category: str | None = None) -> StoredAsset:
        if category is not None and category not in ALLOWED_CATEGORIES:
            raise ValueError("invalid asset category")
        candidate = self._resolve(Path(relative_path))
        if category is not None and candidate.parent.name != category:
            raise ValueError("invalid asset category")
        data = candidate.read_bytes()
        suffix = candidate.suffix.lower().lstrip(".")
        mime_type = next(
            (mime for mime, extension in ALLOWED_MIME.items() if extension == suffix),
            None,
        )
        if mime_type is None:
            raise FileNotFoundError(candidate)
        return StoredAsset(
            id=candidate.stem,
            relative_path=candidate.relative_to(self.root).as_posix(),
            absolute_path=candidate,
            mime_type=mime_type,
            byte_size=len(data),
            expires_at=None,
            data=data,
        )

    def remove(self, relative_path: str) -> None:
        self._resolve(Path(relative_path)).unlink(missing_ok=True)

    def cleanup(self, *, older_than_days: int = 31) -> int:
        """Remove old source/output files left without a database record."""
        cutoff = datetime.now().timestamp() - older_than_days * 24 * 60 * 60
        removed = 0
        for category in ("source", "output"):
            directory = self.root / category
            if not directory.is_dir():
                continue
            for candidate in directory.iterdir():
                try:
                    if candidate.is_file() and candidate.stat().st_mtime < cutoff:
                        candidate.unlink()
                        removed += 1
                except OSError:
                    continue
        return removed

    def _resolve(self, relative: Path) -> Path:
        candidate = (self.root / relative).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise ApiError("INVALID_ASSET_PATH", "资产路径无效", 400)
        return candidate

    def _free_bytes(self) -> int:
        return shutil.disk_usage(self.root).free
