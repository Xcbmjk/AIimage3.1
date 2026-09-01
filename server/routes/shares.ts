import express from 'express'
import os from 'node:os'
import path from 'node:path'
import type { Logger } from '../lib/logger'
import type { PaymentOrderRepository } from '../payment/orderStore'
import { ShareStore } from '../share/shareStore'
import { AssetStore } from '../assets/assetStore'
import type { Database } from '../db/mysql'

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!)

export function createShareRouter(store: ShareStore, paymentStore: PaymentOrderRepository, logger: Logger, publicBaseUrl: string, assetStore = new AssetStore(), database?: Database | null) {
  const router = express.Router()

  router.post('/shares', async (request, response) => {
    const { sessionId, assets } = request.body as { sessionId?: string; assets?: Array<{ imageUrl?: string; assetId?: string }> }
    const paymentToken = request.header('X-Payment-Token') ?? ''
    if (!sessionId || !await paymentStore.authorize(sessionId, paymentToken)) {
      response.status(402).json({ message: '请先完成支付后再分享作品' })
      return
    }
    if (!Array.isArray(assets) || assets.length < 1 || assets.length > 4 || assets.some((asset) => typeof asset.assetId !== 'string' && typeof asset.imageUrl !== 'string')) {
      response.status(400).json({ message: '没有可分享的作品' })
      return
    }
    try {
      const imageUrls = await Promise.all(assets.map(async (asset) => {
        if (!asset.assetId) {
          if (asset.imageUrl!.startsWith('data:image/svg+xml')) throw new Error('SVG_NOT_ALLOWED')
          return asset.imageUrl!
        }
        if (!/^[a-f0-9-]{36}$/i.test(asset.assetId)) throw new Error('INVALID_ASSET_ID')
        if (database) {
          const rows = await database.query<Array<{ filePath: string }>>('SELECT a.file_path AS filePath FROM assets a JOIN generation_jobs g ON g.id = a.generation_id JOIN orders o ON o.id = g.order_id WHERE a.id = ? AND o.session_id = ? AND a.expires_at > UTC_TIMESTAMP() LIMIT 1', [asset.assetId, sessionId])
          if (!rows[0]) throw new Error('ASSET_NOT_OWNED')
        }
        return assetStore.readById(asset.assetId, 'output')
      }))
      const share = store.create(imageUrls.map((item) => typeof item === 'string' ? item : `data:${item.mimeType};base64,${item.buffer.toString('base64')}`))
      const url = `${shareBaseUrl(request, publicBaseUrl)}/api/shares/${share.id}`
      logger.info('share.created', { sessionId, shareId: share.id, assetCount: share.images.length, expiresAt: share.expiresAt })
      response.status(201).json({ url, expiresAt: share.expiresAt })
    } catch (error) {
      logger.warn('share.rejected', { sessionId, reason: error instanceof Error ? error.message : 'unknown' })
      response.status(400).json({ message: '作品图片格式不支持，请重新生成' })
    }
  })

  router.get('/shares/assets/pixel-leap-logo.webp', (_request, response) => {
    response.setHeader('Cache-Control', 'public, max-age=86400')
    response.sendFile(path.resolve(process.cwd(), 'public/pixel-leap-logo.webp'))
  })

  router.get('/shares/:id', (request, response) => {
    const share = store.find(request.params.id)
    if (!share) {
      response.status(404).type('html').send(renderExpiredPage())
      return
    }
    response.setHeader('Cache-Control', 'no-store')
    response.type('html').send(renderSharePage(share.id, share.images.length, share.expiresAt))
  })

  router.get('/shares/:id/images/:index', (request, response) => {
    const share = store.find(request.params.id)
    const index = Number(request.params.index) - 1
    const imagePath = share && Number.isInteger(index) ? store.imagePath(share, index) : null
    if (!share || !imagePath) {
      response.status(404).end()
      return
    }
    const image = share.images[index]
    response.setHeader('Cache-Control', 'private, max-age=3600')
    if (image.mimeType === 'image/svg+xml') response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
    response.type(image.mimeType).sendFile(imagePath)
  })

  router.get('/shares/:id/download/:index', (request, response) => {
    const share = store.find(request.params.id)
    const index = Number(request.params.index) - 1
    const imagePath = share && Number.isInteger(index) ? store.imagePath(share, index) : null
    if (!share || !imagePath) {
      response.status(404).end()
      return
    }
    response.download(imagePath, `shan-jing-ai-${index + 1}.${share.images[index].fileName.split('.').pop()}`)
  })

  return router
}

function shareBaseUrl(request: express.Request, configuredBaseUrl: string) {
  let baseUrl: URL
  try {
    baseUrl = new URL(configuredBaseUrl)
  } catch {
    baseUrl = new URL(`${request.protocol}://${request.get('host')}`)
  }
  const requestOrigin = request.get('origin')
  if (['127.0.0.1', 'localhost'].includes(baseUrl.hostname) && requestOrigin) {
    try { baseUrl = new URL(requestOrigin) } catch { /* Keep the configured URL. */ }
  }
  if (['127.0.0.1', 'localhost'].includes(baseUrl.hostname)) {
    const address = Object.values(os.networkInterfaces()).flat().find((item) => item?.family === 'IPv4' && !item.internal)?.address
    if (address) baseUrl.hostname = address
  }
  return baseUrl.toString().replace(/\/$/, '')
}

function renderSharePage(id: string, imageCount: number, expiresAt: string) {
  const cards = Array.from({ length: imageCount }, (_, index) => `<article class="postcard"><div class="photo-mat"><img src="/api/shares/${id}/images/${index + 1}" alt="AI 旅拍作品 ${index + 1}"></div><div class="postcard-signature"><div class="brand-lockup"><img src="/api/shares/assets/pixel-leap-logo.webp" alt="像素跃迁 Logo"><span><b>像素跃迁</b><small>PIXEL LEAP</small></span></div><div class="postmark"><i>山境</i><span>MOUNTAIN<br>PORTRAIT</span></div></div><div class="actions"><button type="button" data-postcard="${index + 1}">保存品牌明信片</button><a href="/api/shares/${id}/download/${index + 1}">下载无损原图 ${imageCount > 1 ? index + 1 : ''}</a></div><p>明信片版仅在图片外增加品牌留白，原图内容不做修改</p></article>`).join('')
  const expiry = escapeHtml(new Date(expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>山境造像 · 保存作品</title><style>:root{--ink:#163a34;--paper:#f4eddd;--red:#b64932;--gold:#b69962}*{box-sizing:border-box}body{margin:0;background:#09241f;color:#f8eed7;font-family:"Noto Serif SC","Songti SC","Microsoft YaHei",serif;background-image:radial-gradient(circle at 20% 0,rgba(75,125,108,.36),transparent 36%),linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px);background-size:auto,100% 5px}header{padding:48px 20px 30px;text-align:center}header:before{content:"PIXEL LEAP · AI PORTRAIT";display:block;margin-bottom:16px;color:#d1b679;font:10px Arial,sans-serif;letter-spacing:4px}h1{margin:0 0 12px;font-size:32px;font-weight:500;letter-spacing:8px}header p,.postcard>p{margin:0;color:#c9b994;font-size:12px;letter-spacing:1px}.works{width:min(100%,640px);margin:auto;padding:0 16px 44px}.postcard{position:relative;margin:12px 0 36px;padding:13px 13px 20px;overflow:hidden;border-radius:3px;background:var(--paper);color:var(--ink);box-shadow:0 24px 70px rgba(0,0,0,.35),inset 0 0 70px rgba(106,83,44,.05)}.postcard:after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.2;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.15'/%3E%3C/svg%3E")}.photo-mat{position:relative;z-index:1;padding:6px;background:#fff;box-shadow:0 2px 10px rgba(31,43,35,.12)}.photo-mat>img{display:block;width:100%;height:auto;background:#ddd}.postcard-signature{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;min-height:92px;padding:16px 8px 10px}.brand-lockup{display:flex;align-items:center;gap:10px}.brand-lockup>img{width:46px;height:46px;object-fit:contain}.brand-lockup span{display:flex;flex-direction:column;text-align:left}.brand-lockup b{font-size:17px;letter-spacing:4px}.brand-lockup small{margin-top:3px;color:#6d796e;font:8px Arial,sans-serif;letter-spacing:2px}.postmark{display:flex;align-items:center;gap:8px;color:var(--red)}.postmark i{display:grid;width:43px;height:43px;place-items:center;border:2px solid currentColor;border-radius:50%;font-style:normal;font-weight:700;letter-spacing:2px}.postmark span{text-align:left;font:7px/1.5 Arial,sans-serif;letter-spacing:1px}.actions{position:relative;z-index:2;display:grid;grid-template-columns:1fr 1fr;gap:9px}.actions button,.actions a{display:grid;min-height:48px;margin:0;padding:10px;place-items:center;border:1px solid var(--ink);border-radius:2px;font:700 13px "Microsoft YaHei",sans-serif;letter-spacing:1px;text-decoration:none;cursor:pointer}.actions button{border-color:var(--red);background:var(--red);color:#fff}.actions a{background:transparent;color:var(--ink)}.postcard>p{position:relative;z-index:1;margin-top:12px;color:#7c786d;text-align:center;font-size:10px}footer{padding:0 20px 38px;text-align:center;color:#a99e85;font-size:11px;letter-spacing:1px}@media(max-width:390px){.postcard-signature{min-height:82px}.brand-lockup>img{width:38px;height:38px}.brand-lockup b{font-size:14px}.postmark span{display:none}.actions{grid-template-columns:1fr}}</style></head><body><header><h1>山境造像</h1><p>一张旅拍，两种珍藏方式</p></header><main class="works">${cards}</main><footer>作品将在 ${expiry} 后失效，请及时保存</footer><script>const loadImage=(src)=>new Promise((resolve,reject)=>{const image=new Image;image.onload=()=>resolve(image);image.onerror=reject;image.src=src});document.querySelectorAll('[data-postcard]').forEach(button=>button.addEventListener('click',async()=>{const index=button.dataset.postcard;button.disabled=true;button.textContent='正在生成明信片';try{const [photo,logo]=await Promise.all([loadImage('/api/shares/${id}/images/'+index),loadImage('/api/shares/assets/pixel-leap-logo.webp')]);const width=photo.naturalWidth;const padding=Math.max(28,Math.round(width*.035));const footerHeight=Math.max(170,Math.round(width*.2));const canvas=document.createElement('canvas');canvas.width=width+padding*2;canvas.height=photo.naturalHeight+padding*2+footerHeight;const context=canvas.getContext('2d');context.fillStyle='#f4eddd';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#fff';context.fillRect(padding-6,padding-6,width+12,photo.naturalHeight+12);context.drawImage(photo,padding,padding,width,photo.naturalHeight);const logoSize=Math.round(footerHeight*.38);const logoY=photo.naturalHeight+padding*2+(footerHeight-logoSize)/2;context.drawImage(logo,padding,logoY,logoSize,logoSize);context.fillStyle='#163a34';context.font='bold '+Math.round(footerHeight*.15)+'px serif';context.fillText('像素跃迁',padding+logoSize+Math.round(padding*.55),logoY+logoSize*.48);context.fillStyle='#6d796e';context.font=Math.round(footerHeight*.065)+'px Arial';context.fillText('PIXEL LEAP · MOUNTAIN PORTRAIT',padding+logoSize+Math.round(padding*.55),logoY+logoSize*.75);context.strokeStyle='#b64932';context.lineWidth=Math.max(2,width*.002);context.beginPath();context.arc(canvas.width-padding-footerHeight*.2,photo.naturalHeight+padding*2+footerHeight*.5,footerHeight*.19,0,Math.PI*2);context.stroke();context.fillStyle='#b64932';context.textAlign='center';context.font='bold '+Math.round(footerHeight*.11)+'px serif';context.fillText('山 境',canvas.width-padding-footerHeight*.2,photo.naturalHeight+padding*2+footerHeight*.54);canvas.toBlob(blob=>{if(!blob)throw new Error('render');const anchor=document.createElement('a');anchor.href=URL.createObjectURL(blob);anchor.download='pixel-leap-postcard-'+index+'.jpg';anchor.click();setTimeout(()=>URL.revokeObjectURL(anchor.href),1000)},'image/jpeg',.96)}catch{alert('明信片生成失败，请下载无损原图')}finally{button.disabled=false;button.textContent='保存品牌明信片'}}));</script></body></html>`
}

function renderExpiredPage() {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>作品已失效</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b2823;color:#f8eed7;font-family:sans-serif;text-align:center}p{color:#d7c69d}</style></head><body><main><h1>作品已失效</h1><p>保存期限为 24 小时，请重新体验生成。</p></main></body></html>'
}
