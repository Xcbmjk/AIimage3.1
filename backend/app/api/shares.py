from __future__ import annotations

import html
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, Header
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..api.errors import ApiError
from ..config import Settings
from ..db.models import Share
from ..dependencies import create_db_dependency
from ..domain.entitlement_service import utc_now
from ..domain.share_service import SHARE_ID_PATTERN, ShareService
from ..security.entitlement_auth import require_entitlement
from ..storage.assets import AssetStore

class ShareAssetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assetId: str = Field(min_length=1, max_length=40)

    @field_validator("assetId")
    @classmethod
    def asset_id_must_be_uuid(cls, value: str) -> str:
        try:
            parsed = uuid.UUID(value)
        except ValueError:
            raise ValueError("assetId must be a UUID") from None
        return str(parsed)


class CreateShareRequest(BaseModel):
    sessionId: str = Field(min_length=1, max_length=100)
    assets: list[ShareAssetRequest] = Field(min_length=1, max_length=4)

    @field_validator("assets")
    @classmethod
    def assets_must_be_unique(cls, value: list[ShareAssetRequest]) -> list[ShareAssetRequest]:
        ids = [item.assetId for item in value]
        if len(ids) != len(set(ids)):
            raise ValueError("assets must be unique")
        return value


def _iso(value: datetime) -> str:
    return value.replace(tzinfo=None).isoformat(timespec="milliseconds") + "Z"


def _not_found() -> Response:
    return Response(status_code=404)


def _expired_page() -> str:
    return (
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>作品已失效</title></head><body><main><h1>作品已失效</h1>"
        "<p>保存期限已结束，请重新体验生成。</p></main></body></html>"
    )


def _share_page(settings: Settings, share: Share) -> str:
    image_count = len(share.images_json)
    cards = "".join(
        f"<article class='postcard'><div class='photo-mat'><img src='/api/shares/{html.escape(share.id)}/images/{index}' "
        f"alt='AI 旅拍作品 {index}'></div><div class='postcard-signature'>"
        f"<div class='brand-lockup'><img src='/api/shares/assets/pixel-leap-logo.webp' alt='像素跃迁 Logo'>"
        "<span><b>像素跃迁</b><small>PIXEL LEAP</small></span></div>"
        "<div class='postmark'><i>焕新</i><span>RENEWAL<br>PORTRAIT</span></div></div>"
        f"<div class='actions'><button type='button' data-postcard='{index}'>保存品牌明信片</button>"
        f"<a href='/api/shares/{html.escape(share.id)}/download/{index}'>下载无损原图</a></div>"
        "<p>明信片版只增加品牌留白，原图内容不做修改</p></article>"
        for index in range(1, image_count + 1)
    )
    expiry = html.escape(_iso(share.expires_at))
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>焕新造像 · 保存作品</title>
<style>
*{{box-sizing:border-box}}body{{margin:0;background:#09241f;color:#f8eed7;font-family:"Noto Serif SC","Microsoft YaHei",serif}}
main{{width:min(100% - 32px,680px);margin:0 auto;padding:36px 0 48px}}
header{{text-align:center;margin-bottom:28px}}header:before{{content:"PIXEL LEAP · AI PORTRAIT";display:block;margin-bottom:14px;color:#d1b679;font:10px Arial,sans-serif;letter-spacing:3px}}
h1{{margin:0 0 10px;font-weight:500;letter-spacing:6px}}header p,footer,.postcard>p{{color:#c9b994;font-size:12px;letter-spacing:1px}}
.postcard{{margin:0 0 32px;padding:13px 13px 20px;background:#f4eddd;color:#163a34;box-shadow:0 24px 70px rgba(0,0,0,.35)}}
.photo-mat{{padding:6px;background:#fff;box-shadow:0 2px 10px rgba(31,43,35,.12)}}.photo-mat>img{{display:block;width:100%;height:auto;background:#ddd}}
.postcard-signature{{display:flex;align-items:center;justify-content:space-between;min-height:92px;padding:16px 8px 10px}}
.brand-lockup{{display:flex;align-items:center;gap:10px}}.brand-lockup>img{{width:46px;height:46px;object-fit:contain}}
.brand-lockup span{{display:flex;flex-direction:column;text-align:left}}.brand-lockup b{{font-size:17px;letter-spacing:4px}}.brand-lockup small{{margin-top:3px;color:#6d796e;font:8px Arial,sans-serif;letter-spacing:2px}}
.postmark{{display:flex;align-items:center;gap:8px;color:#b64932}}.postmark i{{display:grid;width:43px;height:43px;place-items:center;border:2px solid currentColor;border-radius:50%;font-style:normal;font-weight:700;letter-spacing:2px}}
.postmark span{{text-align:left;font:7px/1.5 Arial,sans-serif;letter-spacing:1px}}.actions{{display:grid;grid-template-columns:1fr 1fr;gap:9px}}
.actions button,.actions a{{display:grid;min-height:48px;margin:0;padding:10px;place-items:center;border:1px solid #163a34;border-radius:2px;font:700 13px "Microsoft YaHei",sans-serif;letter-spacing:1px;text-decoration:none;cursor:pointer}}
.actions button{{border-color:#b64932;background:#b64932;color:#fff}}.actions a{{background:transparent;color:#163a34}}
.postcard>p{{margin:12px 0 0;color:#7c786d;text-align:center;font-size:10px}}footer{{text-align:center}}
@media(max-width:390px){{.postcard-signature{{min-height:82px}}.brand-lockup>img{{width:38px;height:38px}}.brand-lockup b{{font-size:14px}}.postmark span{{display:none}}.actions{{grid-template-columns:1fr}}}}
</style></head><body><main><header><h1>焕新造像</h1>
<p>一张旅拍，两种珍藏方式</p></header><section>{cards}</section>
<footer>作品将在 {expiry} 后失效，请及时保存</footer></main>
<script>
const loadImage = (src) => new Promise((resolve, reject) => {{
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = reject;
  image.src = src;
}});
document.querySelectorAll("[data-postcard]").forEach((button) => {{
  button.addEventListener("click", async () => {{
    const index = button.dataset.postcard;
    button.disabled = true;
    button.textContent = "正在生成明信片";
    try {{
      const [photo, logo] = await Promise.all([
        loadImage("/api/shares/{html.escape(share.id)}/images/" + index),
        loadImage("/api/shares/assets/pixel-leap-logo.webp")
      ]);
      const width = photo.naturalWidth;
      const padding = Math.max(28, Math.round(width * .035));
      const footerHeight = Math.max(170, Math.round(width * .2));
      const canvas = document.createElement("canvas");
      canvas.width = width + padding * 2;
      canvas.height = photo.naturalHeight + padding * 2 + footerHeight;
      const context = canvas.getContext("2d");
      context.fillStyle = "#f4eddd";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#fff";
      context.fillRect(padding - 6, padding - 6, width + 12, photo.naturalHeight + 12);
      context.drawImage(photo, padding, padding, width, photo.naturalHeight);
      const logoSize = Math.round(footerHeight * .38);
      const logoY = photo.naturalHeight + padding * 2 + (footerHeight - logoSize) / 2;
      context.drawImage(logo, padding, logoY, logoSize, logoSize);
      context.fillStyle = "#163a34";
      context.font = "bold " + Math.round(footerHeight * .15) + "px serif";
      context.fillText("像素跃迁", padding + logoSize + Math.round(padding * .55), logoY + logoSize * .48);
      context.fillStyle = "#6d796e";
      context.font = Math.round(footerHeight * .065) + "px Arial";
      context.fillText("PIXEL LEAP · RENEWAL PORTRAIT", padding + logoSize + Math.round(padding * .55), logoY + logoSize * .75);
      context.strokeStyle = "#b64932";
      context.lineWidth = Math.max(2, width * .002);
      context.beginPath();
      context.arc(canvas.width - padding - footerHeight * .2, photo.naturalHeight + padding * 2 + footerHeight * .5, footerHeight * .19, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = "#b64932";
      context.textAlign = "center";
      context.font = "bold " + Math.round(footerHeight * .11) + "px serif";
      context.fillText("焕 新", canvas.width - padding - footerHeight * .2, photo.naturalHeight + padding * 2 + footerHeight * .54);
      canvas.toBlob((blob) => {{
        if (!blob) throw new Error("render");
        const anchor = document.createElement("a");
        anchor.href = URL.createObjectURL(blob);
        anchor.download = "pixel-leap-postcard-" + index + ".jpg";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
      }}, "image/jpeg", .96);
    }} catch {{
      window.alert("明信片生成失败，请下载无损原图");
    }} finally {{
      button.disabled = false;
      button.textContent = "保存品牌明信片";
    }}
  }});
}});
</script></body></html>"""


def create_share_router(
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
    asset_store: AssetStore,
) -> APIRouter:
    router = APIRouter()
    db = create_db_dependency(session_factory)
    service = ShareService(settings)

    @router.post("/api/shares", status_code=201)
    async def create_share(
        payload: CreateShareRequest,
        entitlement_token: str | None = Header(
            default=None,
            alias="X-Entitlement-Token",
        ),
        session: AsyncSession = Depends(db),
    ) -> dict[str, str]:
        principal = await require_entitlement(session, entitlement_token)
        if principal.entitlement.session_id != payload.sessionId:
            raise ApiError("UNAUTHORIZED", "体验权益令牌与会话不匹配", 403)

        await session.rollback()
        async with session.begin():
            share = await service.create(
                session,
                session_id=payload.sessionId,
                asset_ids=[item.assetId for item in payload.assets],
            )
        return {
            "url": f"{settings.public_base_url.rstrip('/')}/api/shares/{share.id}",
            "expiresAt": _iso(share.expires_at),
        }

    @router.get("/api/shares/{share_id}", response_class=HTMLResponse)
    async def share_page(
        share_id: str,
        session: AsyncSession = Depends(db),
    ) -> HTMLResponse:
        if not SHARE_ID_PATTERN.fullmatch(share_id):
            return HTMLResponse(_expired_page(), status_code=404)
        share = await service.repository.get(session, share_id)
        if share is None or share.expires_at <= utc_now():
            return HTMLResponse(_expired_page(), status_code=404)
        return HTMLResponse(
            _share_page(settings, share),
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/api/shares/assets/pixel-leap-logo.webp")
    async def share_logo() -> Response:
        logo = (Path(settings.public_directory) / "pixel-leap-logo.webp").resolve()
        public_root = Path(settings.public_directory).resolve()
        if public_root not in logo.parents or not logo.is_file():
            return _not_found()
        return FileResponse(
            logo,
            media_type="image/webp",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    async def find_shared_asset(
        share_id: str,
        index: int,
        session: AsyncSession,
    ) -> tuple[Share, Asset] | None:
        return await service.find_asset(
            session,
            share_id=share_id,
            index=index,
        )

    @router.get("/api/shares/{share_id}/images/{index}")
    async def share_image(
        share_id: str,
        index: int,
        session: AsyncSession = Depends(db),
    ) -> Response:
        found = await find_shared_asset(share_id, index, session)
        if found is None:
            return _not_found()
        _share, asset = found
        try:
            stored = asset_store.read(asset.file_path, category="output")
        except (FileNotFoundError, ValueError):
            return _not_found()
        return Response(
            content=stored.data,
            media_type=stored.mime_type,
            headers={"Cache-Control": "private, max-age=3600"},
        )

    @router.get("/api/shares/{share_id}/download/{index}")
    async def download_share_image(
        share_id: str,
        index: int,
        session: AsyncSession = Depends(db),
    ) -> Response:
        found = await find_shared_asset(share_id, index, session)
        if found is None:
            return _not_found()
        _share, asset = found
        try:
            stored = asset_store.read(asset.file_path, category="output")
        except (FileNotFoundError, ValueError):
            return _not_found()
        extension = stored.mime_type.rsplit("/", 1)[-1].replace("jpeg", "jpg")
        return Response(
            content=stored.data,
            media_type=stored.mime_type,
            headers={
                "Cache-Control": "private, max-age=3600",
                "Content-Disposition": f'attachment; filename="shan-jing-ai-{index}.{extension}"',
            },
        )

    return router
