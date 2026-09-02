import express, { type Request } from 'express'
import crypto from 'node:crypto'
import { agentGenerationEnabled, loadConfig } from '../config'
import { decodeDataUrl } from '../lib/images'
import { safeError } from '../lib/errors'
import type { Logger } from '../lib/logger'
import { createGptImageProvider } from '../providers/gptImage2'
import { createMockProvider } from '../providers/mock'
import { createSeedreamProvider } from '../providers/seedream'
import { createJimengI2iProvider } from '../providers/jimengI2i'
import { createGeminiImageEditProvider } from '../providers/geminiImageEdit'
import { stylePresets } from '../../src/mocks/fixtures/styles'
import { scenePresets } from '../../src/mocks/fixtures/scenes'
import type { BackgroundPreset, GeneratedAsset } from '../../src/types'
import type { PaymentOrderRepository } from '../payment/orderStore'
import { withPortraitPrompt } from '../lib/portraitPrompt'
import { composeFallbackPrompt, finalizeAgentPrompt, isVisionConfigured } from '../vision/analyze'
import type { Database } from '../db/mysql'
import { getPublishedStyles } from '../catalog/catalog'
import { Semaphore } from '../lib/rateLimit'
import { AssetStore } from '../assets/assetStore'

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
  'agent.started',
  'agent.succeeded',
  'agent.failed',
  'share.started',
  'share.completed',
  'session.reset',
])

const eventString = (value: unknown, maxLength: number) => typeof value === 'string' && value.length <= maxLength ? value : undefined

function requestId(request: Request) {
  const value = request.header('X-Request-ID')
  return value && /^[a-zA-Z0-9._:-]{1,100}$/.test(value) ? value : crypto.randomUUID()
}

export function createGenerationRouter(logger: Logger, paymentStore: PaymentOrderRepository, database?: Database | null, assetStore = new AssetStore()) {
  const config = loadConfig()
  const model = config.provider === 'gpt-image-2' ? config.gpt.model : config.provider === 'seedream' ? config.seedream.model : config.provider === 'jimeng-i2i' ? config.jimeng.reqKey : config.provider === 'gemini-3.1-flash-image' ? config.gemini.model : 'mock'
  const router = express.Router()
  const runningGenerations = new Map<string, Promise<GeneratedAsset[]>>()
  const runningAgentGenerations = new Map<string, Promise<{ asset: GeneratedAsset; prompt: string }>>()
  const completedGenerations = new Map<string, { assets: GeneratedAsset[]; prompt?: string; expiresAt: number }>()
  const providerSemaphore = new Semaphore(1)
  const providers = {
    mock: createMockProvider(),
    'gpt-image-2': createGptImageProvider(config),
    seedream: createSeedreamProvider(config),
    'jimeng-i2i': createJimengI2iProvider(config),
    'gemini-3.1-flash-image': createGeminiImageEditProvider(config),
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
    let activeGenerationId: string | undefined
    try {
      const { photo, sceneId, styles, sessionId: incomingSessionId, generationId } = request.body as { photo?: string; sceneId?: string; styles?: Array<{ id?: string }>; sessionId?: string; generationId?: string }
      sessionId = incomingSessionId
      logger.info('generation.request_received', {
        requestId: id,
        sessionId,
        provider: config.provider,
        model,
        styleCount: Array.isArray(styles) ? styles.length : 0,
        styleIds: Array.isArray(styles) ? styles.map((style) => style.id).filter((value): value is string => typeof value === 'string').slice(0, 4) : [],
        sceneId,
        photoBytes: typeof photo === 'string' ? Buffer.byteLength(photo, 'utf8') : 0,
      })
      if (!sessionId || !generationId || !/^[a-f0-9-]{36}$/i.test(generationId) || !photo || !sceneId || !Array.isArray(styles) || styles.length < 1 || styles.length > config.maxStyles) {
        logger.warn('generation.validation_failed', { requestId: id, sessionId, reason: 'missing_or_invalid_input', code: 'INVALID_INPUT' })
        response.status(400).json({ code: 'INVALID_INPUT', message: '请提供照片并选择 1–4 种风格', retryable: false })
        return
      }
      const decoded = decodeDataUrl(photo, config.maxInputBytes)
      const scene = scenePresets.find((preset) => preset.id === sceneId)
      if (!scene) {
        logger.warn('generation.validation_failed', { requestId: id, sessionId, reason: 'scene_not_allowlisted', code: 'INVALID_INPUT' })
        response.status(400).json({ code: 'INVALID_INPUT', message: '包含不可用的目的地场景', retryable: false })
        return
      }
      const publishedStyles = await getPublishedStyles(database)
      const selected = styles.map((style) => publishedStyles.find((preset) => preset.id === style.id)).filter(Boolean)
      if (selected.length !== styles.length) {
        logger.warn('generation.validation_failed', { requestId: id, sessionId, reason: 'style_not_allowlisted', code: 'INVALID_INPUT' })
        response.status(400).json({ code: 'INVALID_INPUT', message: '包含不可用的创作风格', retryable: false })
        return
      }
      const requestHash = crypto.createHash('sha256')
        .update(sessionId)
        .update('\0')
        .update(decoded.buffer)
        .update('\0')
        .update(scene.id)
        .update('\0')
        .update(selected.map((style) => style!.id).sort().join(','))
        .digest('hex')
      const paymentToken = request.header('X-Payment-Token') ?? ''
      const reservation = await paymentStore.reserveGeneration(sessionId, paymentToken, generationId, requestHash, scene.id)
      if (reservation.status === 'unauthorized') {
        logger.warn('generation.payment_required', { requestId: id, sessionId })
        response.status(402).json({ code: 'PAYMENT_REQUIRED', message: '请先完成微信支付后再使用图片生成', retryable: false })
        return
      }
      if (reservation.status === 'already_consumed') {
        logger.warn('generation.already_consumed', { requestId: id, sessionId, generationId, existingGenerationId: reservation.generationId })
        response.status(409).json({ code: 'GENERATION_ALREADY_CONSUMED', message: '本次支付权益已经用于其他生图任务', retryable: false, generationId: reservation.generationId })
        return
      }
      if (reservation.status === 'request_mismatch') {
        logger.warn('generation.request_mismatch', { requestId: id, sessionId, generationId })
        response.status(409).json({ code: 'GENERATION_REQUEST_MISMATCH', message: '该生图任务的照片或风格与首次请求不一致', retryable: false })
        return
      }
      if (reservation.status === 'succeeded') {
        const completed = completedGenerations.get(generationId)
        if (!completed || completed.expiresAt <= Date.now()) {
          completedGenerations.delete(generationId)
          response.status(409).json({ code: 'GENERATION_ALREADY_CONSUMED', message: '本次支付权益已经完成生图，结果恢复功能暂不可用，请联系工作人员处理', retryable: false })
          return
        }
        logger.info('generation.replayed', { requestId: id, sessionId, generationId, assetCount: completed.assets.length })
        response.json({ provider: config.provider, assets: completed.assets })
        return
      }
      if (reservation.status === 'failed' || reservation.status === 'uncertain') {
        response.status(409).json({ code: 'GENERATION_ALREADY_CONSUMED', message: '本次生图任务状态无法自动重试，请联系工作人员处理', retryable: false })
        return
      }
      const provider = providers[config.provider]
      const generationSessionId = sessionId
      let generation = runningGenerations.get(generationId)
      if (reservation.status === 'processing' && !generation) {
        response.status(409).json({ code: 'GENERATION_IN_PROGRESS', message: '生图任务正在处理，请稍后查询结果', retryable: true })
        return
      }
      if (!generation && reservation.status === 'reserved') {
        generation = providerSemaphore.run(() => generateAssets(provider, selected.map((style) => withPortraitPrompt(scene, style!)), decoded, logger, { requestId: id, sessionId: generationSessionId!, provider: config.provider, model, sceneId: scene.id }))
        runningGenerations.set(generationId, generation)
      }
      if (!generation) throw new Error('GENERATION_STATE_INVALID')
      activeGenerationId = generationId
      const assets = await generation
      const persistedAssets = await Promise.all(assets.map(async (asset) => {
        try {
          const decodedAsset = decodeDataUrl(asset.imageUrl, 15 * 1024 * 1024)
          const saved = assetStore.save(decodedAsset.buffer, decodedAsset.mimeType, 'output', 30)
          if (database) {
            try { await database.pool.query('INSERT IGNORE INTO assets (id, generation_id, style_id, file_path, mime_type, byte_size, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())', [saved.id, generationId, asset.styleId, saved.relativePath, saved.mimeType, saved.byteSize, saved.expiresAt.slice(0, 19).replace('T', ' ')]) }
            catch (error) { logger.warn('generation.asset_persist_failed', { requestId: id, generationId, styleId: asset.styleId, reason: error instanceof Error ? error.name : 'unknown' }); return asset }
          }
          return { ...asset, assetId: saved.id }
        } catch {
          return asset
        }
      }))
      await paymentStore.completeGeneration(generationId)
      completedGenerations.set(generationId, { assets: persistedAssets, expiresAt: Date.now() + 10 * 60_000 })
      logger.info('generation.succeeded', { requestId: id, sessionId, provider: config.provider, model, sceneId: scene.id, styleIds: selected.map((style) => style!.id), styleNames: selected.map((style) => style!.name), assetCount: assets.length, durationMs: Date.now() - startedAt })
      response.json({ provider: config.provider, assets: persistedAssets })
    } catch (error) {
      const mapped = safeError(error)
      if (activeGenerationId) await paymentStore.failGeneration(activeGenerationId, mapped.code, mapped.code === 'UPSTREAM_RATE_LIMIT')
      logger.error('generation.failed', { requestId: id, sessionId, provider: config.provider, model, durationMs: Date.now() - startedAt, code: mapped.code, retryable: mapped.retryable, ...mapped.details })
      response.status(mapped.code === 'INVALID_INPUT' ? 400 : 502).json({ code: mapped.code, message: mapped.message, retryable: mapped.retryable })
    } finally {
      if (activeGenerationId) runningGenerations.delete(activeGenerationId)
    }
  })

  router.post('/agent/generation', async (request, response) => {
    const id = requestId(request)
    response.setHeader('X-Request-ID', id)
    const startedAt = Date.now()
    let sessionId: string | undefined
    let activeGenerationId: string | undefined
    try {
      const { photo, backgroundId, sessionId: incomingSessionId, generationId } = request.body as { photo?: string; backgroundId?: string; sessionId?: string; generationId?: string }
      sessionId = incomingSessionId
      logger.info('agent.request_received', {
        requestId: id,
        sessionId,
        provider: config.provider,
        visionConfigured: isVisionConfigured(config),
        backgroundId,
        photoBytes: typeof photo === 'string' ? Buffer.byteLength(photo, 'utf8') : 0,
      })
      if (!agentGenerationEnabled(config)) {
        logger.warn('agent.disabled', { requestId: id, sessionId, provider: config.provider })
        response.status(503).json({ code: 'CONFIG_ERROR', message: '当前配置未启用 Agent 智能生图', retryable: false })
        return
      }
      if (!sessionId || !generationId || !/^[a-f0-9-]{36}$/i.test(generationId) || !photo || !backgroundId) {
        logger.warn('agent.validation_failed', { requestId: id, sessionId, reason: 'missing_or_invalid_input', code: 'INVALID_INPUT' })
        response.status(400).json({ code: 'INVALID_INPUT', message: '请提供照片并选择一张背景', retryable: false })
        return
      }
      let background: BackgroundPreset | undefined
      let backgroundAsset: { buffer: Buffer; mimeType: string } | undefined
      if (database) {
        const rows = await database.query<Array<{ backgroundId: string; name: string; subtitle: string; description: string; poseHint: string; analysisPrompt: string | null; imagePath: string; imageMime: string }>>(`SELECT background_id AS backgroundId, name, subtitle, description, pose_hint AS poseHint, analysis_prompt AS analysisPrompt, image_path AS imagePath, image_mime AS imageMime FROM background_versions WHERE background_id = ? AND status = 'published' AND enabled = 1 AND analysis_status = 'ready' ORDER BY version DESC LIMIT 1`, [backgroundId])
        const row = rows[0]
        if (row) {
          background = { id: row.backgroundId, name: row.name, subtitle: row.subtitle, description: row.description, poseHint: row.poseHint, previewImage: `/api/catalog/background-assets/${row.imagePath.split('/').pop()!.split('.')[0]}`, analysisPrompt: row.analysisPrompt ?? undefined, imageMime: row.imageMime }
          backgroundAsset = assetStore.readById(row.imagePath.split('/').pop()!.split('.')[0], 'background')
        }
      }
      if (!background) {
        logger.warn('agent.validation_failed', { requestId: id, sessionId, reason: 'background_not_allowlisted', code: 'INVALID_INPUT' })
        response.status(400).json({ code: 'INVALID_INPUT', message: '包含不可用的背景素材', retryable: false })
        return
      }
      const decodedPhoto = decodeDataUrl(photo, config.maxInputBytes)
      const decodedBackground = backgroundAsset ?? readBackgroundReference(background.previewImage)
      const provider = providers[config.provider]
      if (!provider.compose) {
        logger.warn('agent.provider_unsupported', { requestId: id, sessionId, provider: config.provider })
        response.status(503).json({ code: 'CONFIG_ERROR', message: '当前图像模型不支持 Agent 合成', retryable: false })
        return
      }
      const requestHash = crypto.createHash('sha256')
        .update(sessionId)
        .update('\0')
        .update(decodedPhoto.buffer)
        .update('\0')
        .update('agent')
        .update('\0')
        .update(background.id)
        .digest('hex')
      const paymentToken = request.header('X-Payment-Token') ?? ''
      const reservation = await paymentStore.reserveGeneration(sessionId, paymentToken, generationId, requestHash, `agent:${background.id}`)
      if (reservation.status === 'unauthorized') {
        logger.warn('agent.payment_required', { requestId: id, sessionId })
        response.status(402).json({ code: 'PAYMENT_REQUIRED', message: '请先完成微信支付后再使用图片生成', retryable: false })
        return
      }
      if (reservation.status === 'already_consumed') {
        logger.warn('agent.already_consumed', { requestId: id, sessionId, generationId, existingGenerationId: reservation.generationId })
        response.status(409).json({ code: 'GENERATION_ALREADY_CONSUMED', message: '本次支付权益已经用于其他生图任务', retryable: false, generationId: reservation.generationId })
        return
      }
      if (reservation.status === 'request_mismatch') {
        logger.warn('agent.request_mismatch', { requestId: id, sessionId, generationId })
        response.status(409).json({ code: 'GENERATION_REQUEST_MISMATCH', message: '该生图任务的照片或背景与首次请求不一致', retryable: false })
        return
      }
      if (reservation.status === 'succeeded') {
        const completed = completedGenerations.get(generationId)
        if (!completed || completed.expiresAt <= Date.now()) {
          completedGenerations.delete(generationId)
          response.status(409).json({ code: 'GENERATION_ALREADY_CONSUMED', message: '本次支付权益已经完成生图，结果恢复功能暂不可用，请联系工作人员处理', retryable: false })
          return
        }
        logger.info('agent.replayed', { requestId: id, sessionId, generationId, assetCount: completed.assets.length })
        response.json({ provider: config.provider, prompt: completed.prompt ?? '', assets: completed.assets })
        return
      }
      if (reservation.status === 'failed' || reservation.status === 'uncertain') {
        response.status(409).json({ code: 'GENERATION_ALREADY_CONSUMED', message: '本次生图任务状态无法自动重试，请联系工作人员处理', retryable: false })
        return
      }
      const generationSessionId = sessionId
      let pending = runningAgentGenerations.get(generationId)
      if (reservation.status === 'processing' && !pending) {
        response.status(409).json({ code: 'GENERATION_IN_PROGRESS', message: '生图任务正在处理，请稍后查询结果', retryable: true })
        return
      }
      if (!pending && reservation.status === 'reserved') {
        pending = providerSemaphore.run(async () => {
          const analyzeStartedAt = Date.now()
          const dynamic = background.analysisPrompt ?? composeFallbackPrompt(background.name, background.poseHint)
          const prompt = finalizeAgentPrompt(dynamic)
          logger.info('agent.prompt_generated', { requestId: id, sessionId: generationSessionId, backgroundId: background.id, visionMode: background.analysisPrompt ? 'preanalyzed' : 'fallback', promptChars: prompt.length, durationMs: Date.now() - analyzeStartedAt })
          const asset = await provider.compose!({
            background: decodedBackground.buffer,
            backgroundMime: decodedBackground.mimeType,
            photo: decodedPhoto.buffer,
            photoMime: decodedPhoto.mimeType,
            prompt,
            backgroundId: background.id,
          })
          return { asset, prompt }
        })
        runningAgentGenerations.set(generationId, pending)
      }
      if (!pending) throw new Error('GENERATION_STATE_INVALID')
      activeGenerationId = generationId
      const { asset, prompt: generatedPrompt } = await pending
      const persisted = await persistAsset(asset, generationId, database, assetStore, logger, id)
      await paymentStore.completeGeneration(generationId)
      completedGenerations.set(generationId, { assets: [persisted], prompt: generatedPrompt, expiresAt: Date.now() + 10 * 60_000 })
      logger.info('agent.succeeded', { requestId: id, sessionId, provider: config.provider, backgroundId: background.id, assetCount: 1, durationMs: Date.now() - startedAt })
      response.json({ provider: config.provider, prompt: generatedPrompt, assets: [persisted] })
    } catch (error) {
      const mapped = safeError(error)
      if (activeGenerationId) await paymentStore.failGeneration(activeGenerationId, mapped.code, mapped.code === 'UPSTREAM_RATE_LIMIT')
      logger.error('agent.failed', { requestId: id, sessionId, provider: config.provider, durationMs: Date.now() - startedAt, code: mapped.code, retryable: mapped.retryable, ...mapped.details })
      response.status(mapped.code === 'INVALID_INPUT' ? 400 : mapped.code === 'CONFIG_ERROR' ? 503 : 502).json({ code: mapped.code, message: mapped.message, retryable: mapped.retryable })
    } finally {
      if (activeGenerationId) runningAgentGenerations.delete(activeGenerationId)
    }
  })

  return router
}

const SVG_REFERENCE = /^data:image\/svg\+xml(?:;charset=utf-8)?,(.*)$/

function readBackgroundReference(value: string): { buffer: Buffer; mimeType: string } {
  const svg = SVG_REFERENCE.exec(value)
  if (svg) return { buffer: Buffer.from(decodeURIComponent(svg[1]), 'utf8'), mimeType: 'image/svg+xml' }
  return decodeDataUrl(value, 15 * 1024 * 1024)
}

async function persistAsset(
  asset: GeneratedAsset,
  generationId: string,
  database: Database | null | undefined,
  assetStore: AssetStore,
  logger: Logger,
  requestId: string,
): Promise<GeneratedAsset> {
  try {
    const decoded = decodeDataUrl(asset.imageUrl, 15 * 1024 * 1024)
    const saved = assetStore.save(decoded.buffer, decoded.mimeType, 'output', 30)
    if (database) {
      try {
        await database.pool.query('INSERT IGNORE INTO assets (id, generation_id, style_id, file_path, mime_type, byte_size, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())', [saved.id, generationId, asset.styleId, saved.relativePath, saved.mimeType, saved.byteSize, saved.expiresAt.slice(0, 19).replace('T', ' ')])
      } catch (error) {
        logger.warn('agent.asset_persist_failed', { requestId, generationId, styleId: asset.styleId, reason: error instanceof Error ? error.name : 'unknown' })
        return asset
      }
    }
    return { ...asset, assetId: saved.id }
  } catch {
    return asset
  }
}

async function generateAssets(
  provider: ReturnType<typeof createMockProvider>,
  selected: Array<(typeof stylePresets)[number] | undefined>,
  decoded: ReturnType<typeof decodeDataUrl>,
  logger: Logger,
  context: { requestId: string; sessionId: string; provider: string; model: string; sceneId: string },
) {
  const maxConcurrency = 1
  const assets: GeneratedAsset[] = []
  for (let i = 0; i < selected.length; i += maxConcurrency) {
    const batch = selected.slice(i, i + maxConcurrency)
    const batchAssets = await Promise.all(batch.map(async (style) => {
      const styleStartedAt = Date.now()
      logger.info('generation.style_started', { ...context, styleId: style!.id, styleName: style!.name })
      try {
        const asset = await provider.generate(decoded.buffer, decoded.mimeType, style!)
        logger.info('generation.style_succeeded', {
          ...context,
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
        logger.error('generation.style_failed', { ...context, styleId: style!.id, styleName: style!.name, durationMs: Date.now() - styleStartedAt, code: mapped.code, retryable: mapped.retryable, ...mapped.details })
        throw error
      }
    }))
    assets.push(...batchAssets)
  }
  return assets
}
