import express, { type Request } from 'express'
import crypto from 'node:crypto'
import { loadConfig } from '../config'
import { decodeDataUrl } from '../lib/images'
import { safeError } from '../lib/errors'
import type { Logger } from '../lib/logger'
import { createGptImageProvider } from '../providers/gptImage2'
import { createMockProvider } from '../providers/mock'
import { createSeedreamProvider } from '../providers/seedream'
import { createJimengI2iProvider } from '../providers/jimengI2i'
import { stylePresets } from '../../src/mocks/fixtures/styles'
import type { GeneratedAsset } from '../../src/types'
import { PaymentOrderStore } from '../payment/orderStore'

const clientEvents = new Set([
  'session.stage_changed',
  'camera.started',
  'camera.fallback',
  'photo.captured',
  'photo.uploaded',
  'styles.updated',
  'generation.started',
  'generation.client_failed',
  'generation.client_succeeded',
  'share.started',
  'share.completed',
  'session.reset',
])

const eventString = (value: unknown, maxLength: number) => typeof value === 'string' && value.length <= maxLength ? value : undefined

function requestId(request: Request) {
  const value = request.header('X-Request-ID')
  return value && /^[a-zA-Z0-9._:-]{1,100}$/.test(value) ? value : crypto.randomUUID()
}

export function createGenerationRouter(logger: Logger, paymentStore: PaymentOrderStore) {
  const config = loadConfig()
  const model = config.provider === 'gpt-image-2' ? config.gpt.model : config.provider === 'seedream' ? config.seedream.model : config.provider === 'jimeng-i2i' ? config.jimeng.reqKey : 'mock'
  const router = express.Router()
  const providers = {
    mock: createMockProvider(),
    'gpt-image-2': createGptImageProvider(config),
    seedream: createSeedreamProvider(config),
    'jimeng-i2i': createJimengI2iProvider(config),
  }

  router.post('/events', (request, response) => {
    const id = requestId(request)
    response.setHeader('X-Request-ID', id)
    const body = request.body as { event?: unknown; sessionId?: unknown; data?: unknown }
    const event = eventString(body.event, 80)
    const sessionId = eventString(body.sessionId, 100)
    if (!event || !clientEvents.has(event) || !sessionId || body.data === undefined || typeof body.data !== 'object' || body.data === null) {
      logger.warn('client_event.rejected', { requestId: id, reason: 'invalid_payload' })
      response.status(400).json({ code: 'INVALID_INPUT', message: '无效的操作日志', retryable: false })
      return
    }
    const data = body.data as Record<string, unknown>
    const safeData: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(data).slice(0, 12)) {
      if (/photo|image|url|token|key|secret|authorization|prompt|payload|body/i.test(key)) continue
      if (typeof value === 'string' && value.length <= 120) safeData[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') safeData[key] = value
    }
    logger.info(event, { requestId: id, sessionId, source: 'browser', data: safeData })
    response.status(204).end()
  })

  router.post('/generation', async (request, response) => {
    const id = requestId(request)
    response.setHeader('X-Request-ID', id)
    const startedAt = Date.now()
    let sessionId: string | undefined
    try {
      const { photo, styles, sessionId: incomingSessionId } = request.body as { photo?: string; styles?: Array<{ id?: string }>; sessionId?: string }
      sessionId = incomingSessionId
      logger.info('generation.request_received', {
        requestId: id,
        sessionId,
        provider: config.provider,
        model,
        styleCount: Array.isArray(styles) ? styles.length : 0,
        styleIds: Array.isArray(styles) ? styles.map((style) => style.id).filter((value): value is string => typeof value === 'string').slice(0, 4) : [],
        photoBytes: typeof photo === 'string' ? Buffer.byteLength(photo, 'utf8') : 0,
      })
      if (!sessionId || !photo || !Array.isArray(styles) || styles.length < 1 || styles.length > 4) {
        logger.warn('generation.validation_failed', { requestId: id, sessionId, reason: 'missing_or_invalid_input', code: 'INVALID_INPUT' })
        response.status(400).json({ code: 'INVALID_INPUT', message: '请提供照片并选择 1–4 种风格', retryable: false })
        return
      }
      const paymentToken = request.header('X-Payment-Token') ?? ''
      if (!paymentStore.authorize(sessionId, paymentToken)) {
        logger.warn('generation.payment_required', { requestId: id, sessionId })
        response.status(402).json({ code: 'PAYMENT_REQUIRED', message: '请先完成微信支付后再使用图片生成', retryable: false })
        return
      }
      const decoded = decodeDataUrl(photo, config.maxInputBytes)
      const selected = styles.map((style) => stylePresets.find((preset) => preset.id === style.id)).filter(Boolean)
      if (selected.length !== styles.length) {
        logger.warn('generation.validation_failed', { requestId: id, sessionId, reason: 'style_not_allowlisted', code: 'INVALID_INPUT' })
        response.status(400).json({ code: 'INVALID_INPUT', message: '包含不可用的创作风格', retryable: false })
        return
      }
      const provider = providers[config.provider]
      const maxConcurrency = 2
      const assets: GeneratedAsset[] = []
      for (let i = 0; i < selected.length; i += maxConcurrency) {
        const batch = selected.slice(i, i + maxConcurrency)
        const batchAssets = await Promise.all(batch.map(async (style) => {
          const styleStartedAt = Date.now()
          logger.info('generation.style_started', { requestId: id, sessionId, provider: config.provider, model, styleId: style!.id, styleName: style!.name })
          try {
            const asset = await provider.generate(decoded.buffer, decoded.mimeType, style!)
            logger.info('generation.style_succeeded', {
              requestId: id,
              sessionId,
              provider: config.provider,
              model,
              styleId: style!.id,
              styleName: style!.name,
              assetId: asset.id,
              outputType: asset.imageUrl.startsWith('data:') ? 'data_url' : 'url',
              outputBytes: Buffer.byteLength(asset.imageUrl, 'utf8'),
              durationMs: Date.now() - styleStartedAt,
            })
            return asset
          } catch (error) {
            const mapped = safeError(error)
            logger.error('generation.style_failed', { requestId: id, sessionId, provider: config.provider, model, styleId: style!.id, styleName: style!.name, durationMs: Date.now() - styleStartedAt, code: mapped.code, retryable: mapped.retryable, ...mapped.details })
            throw error
          }
        }))
        assets.push(...batchAssets)
      }
      logger.info('generation.succeeded', { requestId: id, sessionId, provider: config.provider, model, styleIds: selected.map((style) => style!.id), styleNames: selected.map((style) => style!.name), assetCount: assets.length, durationMs: Date.now() - startedAt })
      response.json({ provider: config.provider, assets })
    } catch (error) {
      const mapped = safeError(error)
      logger.error('generation.failed', { requestId: id, sessionId, provider: config.provider, model, durationMs: Date.now() - startedAt, code: mapped.code, retryable: mapped.retryable, ...mapped.details })
      response.status(mapped.code === 'INVALID_INPUT' ? 400 : 502).json({ code: mapped.code, message: mapped.message, retryable: mapped.retryable })
    }
  })

  return router
}
