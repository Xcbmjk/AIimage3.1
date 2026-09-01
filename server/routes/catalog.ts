import express from 'express'
import type { ServerConfig } from '../config'
import type { Database } from '../db/mysql'
import { getPublishedPricing, getPublishedStyles } from '../catalog/catalog'
import { AssetStore } from '../assets/assetStore'

export function createCatalogRouter(config: ServerConfig, database?: Database | null, assetStore = new AssetStore()) {
  const router = express.Router()
  router.get('/catalog/style-assets/:id', (request, response) => {
    try {
      const asset = assetStore.readById(String(request.params.id), 'style')
      response.type(asset.mimeType).setHeader('Cache-Control', 'public, max-age=300').send(asset.buffer)
    } catch {
      response.status(404).json({ code: 'NOT_FOUND', message: '风格图片不存在' })
    }
  })
  router.get('/catalog', async (_request, response) => {
    try {
      const [styles, pricing] = await Promise.all([getPublishedStyles(database), getPublishedPricing(config, database)])
      response.json({
        styles: styles.map((style) => {
          const { prompt, ...publicStyle } = style
          void prompt
          return publicStyle
        }),
        pricing,
        product: { maxStyles: config.maxStyles, shareExpiryHours: config.shareExpiryHours },
        runtime: { generationMode: config.provider === 'mock' ? 'mock' : 'api', paymentMode: config.payment.mode },
      })
    } catch {
      response.status(503).json({ code: 'CATALOG_UNAVAILABLE', message: '当前配置暂时不可用' })
    }
  })
  return router
}
