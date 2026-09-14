from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.api.errors import ApiError
from backend.app.config import Settings
from backend.app.storage.assets import AssetStore
from backend.tests.test_images import image_bytes


def test_asset_store_writes_uuid_paths_and_reads_content(tmp_path: Path) -> None:
    settings = Settings(
        _env_file=None,
        app_env="test",
        asset_directory=str(tmp_path / "assets"),
        share_directory=str(tmp_path / "shares"),
        storage_min_free_bytes=1,
    )
    store = AssetStore(settings)
    data = image_bytes("PNG")

    saved = store.save(data, "image/png", "source", retention_days=1)
    assert saved.relative_path.startswith("source/")
    assert saved.absolute_path.exists()
    assert store.read(saved.relative_path).data == data


def test_asset_store_rejects_path_traversal(tmp_path: Path) -> None:
    settings = Settings(
        _env_file=None,
        app_env="test",
        asset_directory=str(tmp_path / "assets"),
        share_directory=str(tmp_path / "shares"),
        storage_min_free_bytes=1,
    )
    store = AssetStore(settings)
    with pytest.raises(ApiError) as raised:
        store.read("../outside.png")
    assert raised.value.code == "INVALID_ASSET_PATH"
