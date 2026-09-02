import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createGenerationRouter } from './routes/generation'
import { distPath, loadConfig } from './config'
import { createLogger, logLevel } from './lib/logger'
import { PaymentOrderStore } from './payment/orderStore'
import { createPaymentRouter } from './routes/payments'
import { createShareRouter } from './routes/shares'
import { ShareStore } from './share/shareStore'
import { createAdminRouter } from './routes/admin'
import { createDatabase } from './db/mysql'
import { collectHealth } from './lib/health'
import { createCatalogRouter } from './routes/catalog'
import { AssetStore } from './assets/assetStore'
import { createRateLimiter } from './lib/rateLimit'
import { MySqlPaymentOrderRepository } from './payment/mysqlOrderRepository'
import { WechatPayClient } from './payment/wechatPay'
import { startPaymentReconciler } from './payment/reconciliation'

dotenv.config({ path: '.env.local' })
dotenv.config()
const config = loadConfig()
const logger = createLogger({ level: logLevel(config.logLevel), file: config.logFile, retentionDays: config.logRetentionDays })
const app = express()
const shareStore = new ShareStore(config.shareDirectory, config.shareExpiryHours)
const database = createDatabase(config)
const paymentStore = database
  ? new MySqlPaymentOrderRepository(database, config.adminSessionSecret)
  : new PaymentOrderStore(config.payment.orderFile)
const assetStore = new AssetStore()

app.use((request, response, next) => {
  const incoming = request.header('X-Request-ID')
  const id = incoming && /^[a-zA-Z0-9._:-]{1,100}$/.test(incoming) ? incoming : crypto.randomUUID()
  const startedAt = Date.now()
  request.headers['x-request-id'] = id
  response.setHeader('X-Request-ID', id)
  logger.info('http.request_started', { requestId: id, method: request.method, path: request.originalUrl })
  response.on('finish', () => logger.info('http.request_completed', {
    requestId: id,
    method: request.method,
    path: request.originalUrl,
    statusCode: response.statusCode,
    durationMs: Date.now() - startedAt,
  }))
  next()
})
app.use('/api/payments/orders', createRateLimiter({ windowMs: 60_000, max: 10 }))
app.use('/api/generation', createRateLimiter({ windowMs: 60_000, max: 6, key: (request) => request.body?.sessionId || request.ip || 'unknown' }))
app.use('/api/agent/generation', createRateLimiter({ windowMs: 60_000, max: 6, key: (request) => request.body?.sessionId || request.ip || 'unknown' }))
app.use('/api/shares', createRateLimiter({ windowMs: 60_000, max: 10, key: (request) => request.body?.sessionId || request.ip || 'unknown' }))
app.use('/api/admin/auth/login', createRateLimiter({ windowMs: 15 * 60_000, max: 10 }))
app.use('/api', createPaymentRouter(config, paymentStore, logger, database))
app.use('/api', createCatalogRouter(config, database, assetStore))
app.use('/api/shares', express.json({ limit: '64mb' }))
// A browser data URL expands binary image data by roughly 4/3 before JSON overhead.
const generationBodyLimit = Math.ceil(config.maxInputBytes * 4 / 3) + 1024 * 1024
app.use(express.json({ limit: generationBodyLimit }))
app.get('/api/health', async (request, response) => {
  const health = await collectHealth(config, database)
  logger.info('health.checked', { requestId: request.header('X-Request-ID'), provider: config.provider, status: health.status })
  response.status(health.ok ? 200 : 503).json(health)
})
app.use('/', createAdminRouter(config, paymentStore, logger, database, assetStore))
app.use('/api', createGenerationRouter(logger, paymentStore, database, assetStore))
app.use('/api', createShareRouter(shareStore, paymentStore, logger, config.payment.publicBaseUrl, assetStore, database))

app.use('/api', (request, response) => {
  logger.warn('http.route_not_found', { requestId: request.header('X-Request-ID'), method: request.method, path: request.originalUrl })
  response.status(404).json({ code: 'NOT_FOUND', message: '接口不存在', retryable: false })
})

app.use((error: unknown, request: express.Request, response: express.Response, next: express.NextFunction) => {
  if (response.headersSent) return next(error)
  const id = response.getHeader('X-Request-ID')
  const status = error && typeof error === 'object' && 'status' in error ? (error as { status?: number }).status : undefined
  const isJsonSyntaxError = error instanceof SyntaxError && status === 400
  const isPayloadTooLarge = status === 413
  logger.error(isJsonSyntaxError ? 'http.invalid_json' : isPayloadTooLarge ? 'http.payload_too_large' : 'http.unhandled_error', { requestId: id, method: request.method, path: request.originalUrl, reason: error instanceof Error ? error.name : 'unknown' })
  response.status(isJsonSyntaxError ? 400 : isPayloadTooLarge ? 413 : 500).json(isJsonSyntaxError
    ? { code: 'INVALID_INPUT', message: '请求 JSON 格式无效', retryable: false }
    : isPayloadTooLarge
      ? { code: 'INVALID_INPUT', message: '图片大小超过 10 MB，请压缩后重新上传', retryable: false }
      : { code: 'GENERATION_FAILED', message: '服务暂时不可用，请稍后重试', retryable: true })
})

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get(/.*/, (_request, response) => response.sendFile(path.join(distPath, 'index.html')))
}

const start = async () => {
  if (database) {
    try { await database.migrate() }
    catch (error) { logger.error('database.migration_failed', { reason: error instanceof Error ? error.message : 'unknown' }) }
  }
  const wechat = config.payment.mode === 'wechat-native' ? new WechatPayClient(config.payment) : null
  startPaymentReconciler(paymentStore, wechat, logger)
  app.listen(config.port, '0.0.0.0', () => {
    logger.info('server.started', { address: `http://0.0.0.0:${config.port}`, provider: config.provider, database: Boolean(database) })
  })
}
start().catch((error) => {
  logger.error('server.start_failed', { reason: error instanceof Error ? error.message : 'unknown' })
  process.exitCode = 1
})
