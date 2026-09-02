import express from 'express'
import { agentGenerationEnabled, type ServerConfig } from '../config'
import type { Database } from '../db/mysql'
import { getPublishedBackgrounds, getPublishedPricing, getPublishedStyles } from '../catalog/catalog'
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
  router.get('/catalog/background-assets/:id', async (request, response) => {
    try {
      const assetId = String(request.params.id)
      if (database) {
        const rows = await database.query<Array<{ id: number }>>('SELECT id FROM background_versions WHERE image_path IN (?, ?, ?) AND status = \'published\' AND enabled = 1 AND analysis_status = \'ready\' LIMIT 1', [`background/${assetId}.jpg`, `background/${assetId}.png`, `background/${assetId}.webp`])
        if (!rows[0]) { response.status(404).json({ code: 'NOT_FOUND', message: '背景图片不存在' }); return }
      } else { response.status(404).json({ code: 'NOT_FOUND', message: '背景图片不存在' }); return }
      const asset = assetStore.readById(assetId, 'background')
      response.type(asset.mimeType).setHeader('Cache-Control', 'public, max-age=300').send(asset.buffer)
    } catch {
      response.status(404).json({ code: 'NOT_FOUND', message: '背景图片不存在' })
    }
  })
  router.get('/catalog', async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
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
        backgrounds: await getPublishedBackgrounds(database),
        runtime: { generationMode: config.provider === 'mock' ? 'mock' : 'api', paymentMode: config.payment.mode, agentEnabled: agentGenerationEnabled(config) },
      })
    } catch {
      response.status(503).json({ code: 'CATALOG_UNAVAILABLE', message: '当前配置暂时不可用' })
    }
  })
  return router
}
