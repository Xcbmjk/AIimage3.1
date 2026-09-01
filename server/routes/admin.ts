import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ServerConfig } from '../config'
import type { Logger } from '../lib/logger'
import type { PaymentOrder, PaymentOrderRepository } from '../payment/orderStore'
import type { Database } from '../db/mysql'
import { collectHealth } from '../lib/health'
import { stylePresets } from '../../src/mocks/fixtures/styles'
import { AssetStore } from '../assets/assetStore'

type Role = 'owner' | 'operator' | 'technical'
type Session = { username: string; role: Role; csrf: string; expiresAt: number }
type StyleInput = { styleId: string; name: string; subtitle: string; description: string; prompt: string; mode: 'realistic' | 'artistic'; palette: [string, string, string]; motif: string; previewData?: string; coverPath?: string; sortOrder: number; enabled: boolean }
const sessions = new Map<string, Session>()
const audit: Array<Record<string, unknown>> = []
const rolePermissions: Record<Role, string[]> = {
  owner: ['read', 'retry', 'style:write', 'price:write', 'refund:write', 'user:write'],
  operator: ['read', 'retry', 'style:draft', 'refund:request'],
  technical: ['read', 'retry', 'health:read'],
}

const sanitize = (order: PaymentOrder) => ({
  id: order.id, sessionId: order.sessionId, amountFen: order.amountFen, status: order.status,
  createdAt: order.createdAt, expiresAt: order.expiresAt, paidAt: order.paidAt,
  transactionId: order.transactionId ? `${order.transactionId.slice(0, 6)}...` : undefined,
  generation: order.generation && {
    id: order.generation.id, status: order.generation.status, startedAt: order.generation.startedAt,
    completedAt: order.generation.completedAt, errorCode: order.generation.errorCode,
  },
})
const now = () => new Date().toISOString()

export function createAdminRouter(config: ServerConfig, store: PaymentOrderRepository, logger: Logger, database?: Database | null, assetStore = new AssetStore()) {
  const router = express.Router()
  const getSession = (request: express.Request) => {
    const id = request.headers.cookie?.match(/(?:^|; )admin_session=([^;]+)/)?.[1]
    if (!id) return undefined
    const session = sessions.get(id)
    if (!session || session.expiresAt < Date.now()) { if (session) sessions.delete(id); return undefined }
    return { id, ...session }
  }
  const guard: express.RequestHandler = (request, response, next) => {
    const session = getSession(request)
    const tokenValid = Boolean(config.adminToken && request.header('X-Admin-Token') === config.adminToken)
    if (!session && !tokenValid) { response.status(401).json({ code: 'ADMIN_UNAUTHORIZED', message: '后台登录已失效' }); return }
    ;(request as express.Request & { admin?: { username: string; role: Role; sessionId?: string } }).admin = session
      ? { username: session.username, role: session.role, sessionId: session.id }
      : { username: 'bootstrap', role: 'owner' }
    next()
  }
  const requirePermission = (permission: string): express.RequestHandler => (request, response, next) => {
    const admin = (request as express.Request & { admin?: { role: Role } }).admin
    if (!admin || !rolePermissions[admin.role].includes(permission)) { response.status(403).json({ code: 'ADMIN_FORBIDDEN', message: '当前账号无权执行此操作' }); return }
    next()
  }
  const requireAnyPermission = (...permissions: string[]): express.RequestHandler => (request, response, next) => {
    const admin = (request as express.Request & { admin?: { role: Role } }).admin
    if (!admin || !permissions.some((permission) => rolePermissions[admin.role].includes(permission))) { response.status(403).json({ code: 'ADMIN_FORBIDDEN', message: '当前账号无权执行此操作' }); return }
    next()
  }
  const record = (request: express.Request, action: string, targetType: string, targetId?: string, reason?: string) => {
    const admin = (request as express.Request & { admin?: { username: string } }).admin
    const event = { actor: admin?.username ?? 'unknown', action, targetType, targetId, reason, createdAt: now() }
    audit.unshift(event)
    logger.info('admin.audit', event)
    if (database) void database.query('INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, reason, created_at) SELECT id, ?, ?, ?, ?, UTC_TIMESTAMP() FROM admin_users WHERE username = ? LIMIT 1', [action, targetType, targetId ?? null, reason ?? null, admin?.username ?? ''])
    return event
  }

  router.post('/api/admin/auth/login', express.json({ limit: '16kb' }), async (request, response) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : ''
    const password = typeof request.body?.password === 'string' ? request.body.password : ''
    if (!username || !password) { response.status(400).json({ code: 'INVALID_INPUT', message: '请输入账号和密码' }); return }
    let role: Role | undefined
    if (config.adminToken && password === config.adminToken && (username === 'owner' || username === 'admin')) role = 'owner'
    if (database) {
      const rows = await database.query<Array<{ id: number; username: string; password_hash: string; role: Role; active: number }>>('SELECT id, username, password_hash, role, active FROM admin_users WHERE username = ? LIMIT 1', [username])
      const account = rows[0]
      if (account?.active && verifyPassword(password, account.password_hash)) role = account.role
    }
    if (!role) { response.status(401).json({ code: 'ADMIN_UNAUTHORIZED', message: '账号或密码错误' }); return }
    const id = crypto.randomBytes(32).toString('hex'); const csrf = crypto.randomBytes(32).toString('hex')
    sessions.set(id, { username, role, csrf, expiresAt: Date.now() + 8 * 3600_000 })
    response.setHeader('Set-Cookie', [`admin_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`, `admin_csrf=${csrf}; SameSite=Strict; Path=/; Max-Age=28800`])
    response.json({ user: { username, role }, csrf })
  })
  router.post('/api/admin/auth/logout', guard, (request, response) => {
    const session = getSession(request); if (session) sessions.delete(session.id)
    response.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); response.status(204).end()
  })
  router.get('/api/admin/auth/me', guard, (request, response) => {
    const admin = (request as express.Request & { admin?: { username: string; role: Role } }).admin!
    response.json({ user: admin, permissions: rolePermissions[admin.role] })
  })

  router.get('/api/admin/summary', guard, async (_request, response) => {
    const orders = await store.list(); const paid = orders.filter((order) => order.status === 'paid'); const generations = paid.map((order) => order.generation).filter(Boolean)
    response.json({ provider: config.provider, paymentMode: config.payment.mode, totals: {
      orders: orders.length, paid: paid.length, pending: orders.filter((o) => o.status === 'pending').length,
      expired: orders.filter((o) => o.status === 'expired').length,
      generationSucceeded: generations.filter((g) => g?.status === 'succeeded').length,
      generationFailed: generations.filter((g) => g?.status === 'failed' || g?.status === 'uncertain').length,
    }, recentOrders: orders.slice(0, 10).map(sanitize) })
  })
  router.get('/api/admin/dashboard', guard, async (_request, response) => {
    const orders = await store.list(); const day = Date.now() - 24 * 3600_000
    response.json({ orders24h: orders.filter((o) => new Date(o.createdAt).getTime() >= day).length, provider: config.provider, database: database ? 'mysql' : 'json-fallback', auditEvents: audit.length })
  })
  router.get('/api/admin/orders', guard, async (request, response) => {
    const status = typeof request.query.status === 'string' ? request.query.status : undefined; const search = typeof request.query.search === 'string' ? request.query.search.toLowerCase() : ''
    const page = Math.max(1, Number(request.query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)))
    const filtered = (await store.list()).filter((order) => (!status || order.status === status) && (!search || `${order.id} ${order.sessionId}`.toLowerCase().includes(search)))
    response.json({ orders: filtered.slice((page - 1) * pageSize, page * pageSize).map(sanitize), total: filtered.length, page, pageSize })
  })
  router.get('/api/admin/orders/:id', guard, async (request, response) => {
    const order = await store.find(String(request.params.id)); if (!order) { response.status(404).json({ code: 'NOT_FOUND', message: '订单不存在' }); return }
    response.json({ order: sanitize(order), audit: audit.filter((event) => event.targetId === order.id) })
  })
  router.get('/api/admin/generations', guard, async (_request, response) => response.json({ generations: (await store.list()).filter((order) => order.generation).map((order) => ({ orderId: order.id, ...order.generation })) }))
  router.post('/api/admin/generations/:id/retry', guard, requirePermission('retry'), express.json({ limit: '16kb' }), async (request, response) => {
    const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : ''
    if (!reason) { response.status(400).json({ code: 'INVALID_INPUT', message: '请填写重试原因' }); return }
    const generationId = String(request.params.id); const order = (await store.list()).find((item) => item.generation?.id === generationId)
    if (!order?.generation || !['failed', 'uncertain'].includes(order.generation.status)) { response.status(409).json({ code: 'GENERATION_NOT_RETRYABLE', message: '仅失败或待核查任务可重试' }); return }
    const attempts = Number((order.generation as PaymentOrder['generation'] & { attempts?: number }).attempts ?? 0)
    if (attempts >= 2) { response.status(409).json({ code: 'RETRY_LIMIT_REACHED', message: '已达到最多 2 次重试' }); return }
    ;(order.generation as PaymentOrder['generation'] & { attempts?: number }).attempts = attempts + 1
    record(request, 'generation.retry_requested', 'generation', generationId, reason); response.status(202).json({ accepted: true, generationId, attempts: attempts + 1 })
  })
  router.get('/api/admin/styles', guard, async (_request, response) => {
    if (!database) { response.json({ styles: stylePresets.map((style) => ({ ...style, version: 1, status: 'published' })) }); return }
    const styles = await database.query<Array<Record<string, unknown>>>(`SELECT id, style_id AS styleId, version, name, subtitle, description, prompt, mode, enabled, sort_order AS sortOrder, status, cover_path AS coverPath, preview_data AS previewPath, palette_json AS paletteJson, motif, created_at AS createdAt, published_at AS publishedAt FROM style_versions ORDER BY sort_order, style_id, version DESC`)
    response.json({ styles: styles.map((style) => ({ ...style, previewUrl: typeof style.previewPath === 'string' && style.previewPath.startsWith('style/') ? `/api/catalog/style-assets/${style.previewPath.split('/').pop()!.split('.')[0]}` : style.previewPath })) })
  })
  const parseStyleInput = (body: Record<string, unknown>, styleIdOverride?: string): StyleInput | undefined => {
    const styleId = styleIdOverride ?? (typeof body.styleId === 'string' ? body.styleId.trim() : '')
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const subtitle = typeof body.subtitle === 'string' ? body.subtitle.trim() : ''
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const mode = body.mode === 'realistic' || body.mode === 'artistic' ? body.mode : undefined
    const palette = Array.isArray(body.palette) && body.palette.length === 3 && body.palette.every((value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) ? body.palette as [string, string, string] : undefined
    const motif = typeof body.motif === 'string' ? body.motif.trim() : ''
    const previewData = typeof body.previewPath === 'string' ? body.previewPath : typeof body.previewData === 'string' && body.previewData.startsWith('data:') ? body.previewData : ''
    const coverPath = typeof body.coverPath === 'string' ? body.coverPath.trim() : ''
    const sortOrder = body.sortOrder === undefined ? 0 : Number(body.sortOrder)
    const enabled = body.enabled === undefined ? true : body.enabled === true
    if (!/^[a-z0-9-]{1,80}$/.test(styleId) || !name || name.length > 120 || subtitle.length > 255 || description.length > 2000 || !prompt || prompt.length > 12000 || !mode || !palette || motif.length > 40 || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000 || previewData.length > 5 * 1024 * 1024 || coverPath.length > 500) return undefined
    return { styleId, name, subtitle, description, prompt, mode, palette, motif, previewData: previewData || undefined, coverPath: coverPath || undefined, sortOrder, enabled }
  }
  router.post('/api/admin/style-assets', guard, requireAnyPermission('style:draft', 'style:write'), express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), (request, response) => {
    if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) { response.status(400).json({ code: 'INVALID_INPUT', message: '请上传 JPG、PNG 或 WebP 图片' }); return }
    const mimeType = request.header('Content-Type') ?? ''
    const bytes = request.body as Buffer
    const validHeader = (mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) || (mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) || (mimeType === 'image/webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
    if (!validHeader) { response.status(400).json({ code: 'INVALID_INPUT', message: '图片内容与文件类型不匹配' }); return }
    try { const saved = assetStore.save(bytes, mimeType, 'style', 3650); record(request, 'style.image_uploaded', 'style-asset', saved.id); response.status(201).json({ assetId: saved.id, path: saved.relativePath, url: `/api/catalog/style-assets/${saved.id}` }) } catch { response.status(400).json({ code: 'INVALID_INPUT', message: '图片格式不受支持' }) }
  })
  const createStyleDraft = async (request: express.Request, response: express.Response) => {
    if (!database) { response.status(503).json({ code: 'DATABASE_REQUIRED', message: '风格配置需要启用 MySQL' }); return }
    const input = parseStyleInput(request.body ?? {})
    if (!input) { response.status(400).json({ code: 'INVALID_INPUT', message: '风格字段不完整或格式无效' }); return }
    const [latestRows] = await database.pool.query('SELECT COALESCE(MAX(version), 0) AS version FROM style_versions WHERE style_id = ?', [input.styleId])
    const version = Number((latestRows as Array<{ version: number }>)[0]?.version ?? 0) + 1
    const nowValue = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await database.pool.query(`INSERT INTO style_versions (style_id, version, name, subtitle, description, prompt, cover_path, preview_data, palette_json, motif, mode, enabled, sort_order, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`, [input.styleId, version, input.name, input.subtitle, input.description, input.prompt, input.coverPath ?? null, input.previewData ?? null, JSON.stringify(input.palette), input.motif, input.mode, input.enabled ? 1 : 0, input.sortOrder, nowValue])
    record(request, 'style.draft_created', 'style', `${input.styleId}@${version}`)
    response.status(201).json({ styleId: input.styleId, version, status: 'draft' })
  }
  router.post('/api/admin/styles', guard, requireAnyPermission('style:draft', 'style:write'), express.json({ limit: '6mb' }), createStyleDraft)
  router.post('/api/admin/styles/drafts', guard, requireAnyPermission('style:draft', 'style:write'), express.json({ limit: '6mb' }), createStyleDraft)
  router.put('/api/admin/styles/:styleId', guard, requireAnyPermission('style:draft', 'style:write'), express.json({ limit: '6mb' }), async (request, response) => {
    if (!database) { response.status(503).json({ code: 'DATABASE_REQUIRED', message: '风格配置需要启用 MySQL' }); return }
    const styleId = String(request.params.styleId); const version = Number(request.body?.version)
    if (!Number.isInteger(version) || version < 1) { response.status(400).json({ code: 'INVALID_INPUT', message: '请提供有效版本号' }); return }
    const input = parseStyleInput({ ...(request.body ?? {}), styleId }, styleId)
    if (!input) { response.status(400).json({ code: 'INVALID_INPUT', message: '风格字段不完整或格式无效' }); return }
    const [rows] = await database.pool.query('SELECT status FROM style_versions WHERE style_id = ? AND version = ? LIMIT 1', [styleId, version]); const target = (rows as Array<Record<string, unknown>>)[0]
    if (!target) { response.status(404).json({ code: 'NOT_FOUND', message: '风格版本不存在' }); return }
    if (target.status !== 'draft') { response.status(409).json({ code: 'STYLE_VERSION_LOCKED', message: '已发布版本不可直接修改，请新建草稿版本' }); return }
    await database.pool.query(`UPDATE style_versions SET name = ?, subtitle = ?, description = ?, prompt = ?, cover_path = ?, preview_data = ?, palette_json = ?, motif = ?, mode = ?, enabled = ?, sort_order = ? WHERE style_id = ? AND version = ?`, [input.name, input.subtitle, input.description, input.prompt, input.coverPath ?? null, input.previewData ?? null, JSON.stringify(input.palette), input.motif, input.mode, input.enabled ? 1 : 0, input.sortOrder, styleId, version])
    record(request, 'style.draft_updated', 'style', `${styleId}@${version}`); response.json({ styleId, version, status: 'draft' })
  })
  router.delete('/api/admin/styles/:styleId', guard, requirePermission('style:write'), async (request, response) => {
    if (!database) { response.status(503).json({ code: 'DATABASE_REQUIRED', message: '风格配置需要启用 MySQL' }); return }
    const styleId = String(request.params.styleId); const [rows] = await database.pool.query('SELECT style_id FROM style_versions WHERE style_id = ? LIMIT 1', [styleId])
    if (!(rows as Array<Record<string, unknown>>)[0]) { response.status(404).json({ code: 'NOT_FOUND', message: '风格不存在' }); return }
    await database.pool.query(`UPDATE style_versions SET enabled = 0, status = 'archived' WHERE style_id = ?`, [styleId])
    record(request, 'style.archived', 'style', styleId, typeof request.body?.reason === 'string' ? request.body.reason.trim() : undefined)
    response.json({ styleId, status: 'archived' })
  })
  router.post('/api/admin/styles/:styleId/publish', guard, requirePermission('style:write'), express.json({ limit: '8kb' }), async (request, response) => {
    if (!database) { response.status(503).json({ code: 'DATABASE_REQUIRED', message: '风格配置需要启用 MySQL' }); return }
    const styleId = String(request.params.styleId); const requestedVersion = Number(request.body?.version)
    const [targetRows] = await database.pool.query('SELECT id, version, status FROM style_versions WHERE style_id = ? AND (? IS NULL OR version = ?) ORDER BY version DESC LIMIT 1', [styleId, Number.isInteger(requestedVersion) ? requestedVersion : null, Number.isInteger(requestedVersion) ? requestedVersion : null])
    const target = (targetRows as Array<Record<string, unknown>>)[0]
    if (!target) { response.status(404).json({ code: 'NOT_FOUND', message: '风格版本不存在' }); return }
    const connection = await database.pool.getConnection()
    try { await connection.beginTransaction(); await connection.query(`UPDATE style_versions SET status = 'archived' WHERE style_id = ? AND status = 'published'`, [styleId]); await connection.query(`UPDATE style_versions SET status = 'published', published_at = UTC_TIMESTAMP() WHERE id = ?`, [target.id]); await connection.commit() } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
    const targetVersion = Number(target.version)
    record(request, 'style.published', 'style', `${styleId}@${targetVersion}`)
    response.json({ styleId, version: targetVersion, status: 'published' })
  })
  router.post('/api/admin/styles/:styleId/rollback', guard, requirePermission('style:write'), express.json({ limit: '8kb' }), async (request, response) => {
    if (!database) { response.status(503).json({ code: 'DATABASE_REQUIRED', message: '风格配置需要启用 MySQL' }); return }
    const styleId = String(request.params.styleId); const version = Number(request.body?.version)
    if (!Number.isInteger(version) || version < 1) { response.status(400).json({ code: 'INVALID_INPUT', message: '请提供有效版本号' }); return }
    const [targetRows] = await database.pool.query('SELECT id FROM style_versions WHERE style_id = ? AND version = ? LIMIT 1', [styleId, version])
    const target = (targetRows as Array<Record<string, unknown>>)[0]
    if (!target) { response.status(404).json({ code: 'NOT_FOUND', message: '风格版本不存在' }); return }
    await database.pool.query(`UPDATE style_versions SET status = CASE WHEN id = ? THEN 'published' ELSE 'archived' END, published_at = CASE WHEN id = ? THEN UTC_TIMESTAMP() ELSE published_at END WHERE style_id = ?`, [target.id, target.id, styleId])
    record(request, 'style.rolled_back', 'style', `${styleId}@${version}`)
    response.json({ styleId, version, status: 'published' })
  })
  router.get('/api/admin/pricing', guard, async (_request, response) => {
    if (!database) { response.json({ versions: [{ id: 0, amountFen: config.payment.amountFen, description: config.payment.description, status: 'published' }] }); return }
    const versions = await database.query<Array<Record<string, unknown>>>(`SELECT id, amount_fen AS amountFen, description, status, created_at AS createdAt, published_at AS publishedAt FROM pricing_versions ORDER BY id DESC`)
    response.json({ versions })
  })
  router.post('/api/admin/pricing/drafts', guard, requirePermission('price:write'), express.json({ limit: '8kb' }), async (request, response) => {
    if (!database) { response.status(503).json({ code: 'DATABASE_REQUIRED', message: '价格配置需要启用 MySQL' }); return }
    const amountFen = Number(request.body?.amountFen); const description = typeof request.body?.description === 'string' ? request.body.description.trim() : ''
    if (!Number.isInteger(amountFen) || amountFen < 1 || amountFen > 1_000_000 || !description) { response.status(400).json({ code: 'INVALID_INPUT', message: '价格必须为有效正整数，且需要填写说明' }); return }
    const nowValue = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const [result] = await database.pool.query('INSERT INTO pricing_versions (amount_fen, description, status, created_at) VALUES (?, ?, \'draft\', ?)', [amountFen, description, nowValue])
    const id = Number((result as { insertId: number }).insertId)
    record(request, 'pricing.draft_created', 'pricing', String(id)); response.status(201).json({ id, amountFen, description, status: 'draft' })
  })
  router.post('/api/admin/pricing/:id/publish', guard, requirePermission('price:write'), async (request, response) => {
    if (!database) { response.status(503).json({ code: 'DATABASE_REQUIRED', message: '价格配置需要启用 MySQL' }); return }
    const id = Number(request.params.id); if (!Number.isInteger(id)) { response.status(400).json({ code: 'INVALID_INPUT', message: '价格版本无效' }); return }
    const [targetRows] = await database.pool.query('SELECT id FROM pricing_versions WHERE id = ? LIMIT 1', [id]); if (!(targetRows as Array<Record<string, unknown>>)[0]) { response.status(404).json({ code: 'NOT_FOUND', message: '价格版本不存在' }); return }
    const connection = await database.pool.getConnection(); try { await connection.beginTransaction(); await connection.query(`UPDATE pricing_versions SET status = 'archived' WHERE status = 'published'`); await connection.query(`UPDATE pricing_versions SET status = 'published', published_at = UTC_TIMESTAMP() WHERE id = ?`, [id]); await connection.commit() } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
    record(request, 'pricing.published', 'pricing', String(id)); response.json({ id, status: 'published' })
  })
  router.post('/api/admin/refunds', guard, requireAnyPermission('refund:request', 'refund:write'), express.json({ limit: '16kb' }), async (request, response) => {
    const order = await store.find(String(request.body?.orderId ?? '')); const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : ''
    if (!order || order.status !== 'paid' || !reason) { response.status(400).json({ code: 'INVALID_INPUT', message: '仅已支付订单可申请退款，且必须填写原因' }); return }
    const event = record(request, 'refund.requested', 'order', order.id, reason); response.status(202).json({ requestId: crypto.randomUUID(), status: 'requested', orderId: order.id, audit: event })
  })
  router.get('/api/admin/audit-logs', guard, (_request, response) => response.json({ logs: audit.slice(0, 200) }))
  router.get('/api/admin/health', guard, async (_request, response) => {
    const health = await collectHealth(config, database ?? null)
    response.status(health.ok ? 200 : 503).json(health)
  })
  router.get('/admin', (_request, response) => {
    const adminIndex = path.resolve(process.cwd(), 'dist/admin/index.html')
    if (fs.existsSync(adminIndex)) { response.sendFile(adminIndex); return }
    response.type('html').send('<!doctype html><meta charset="utf-8"><title>山境造像后台</title><p>请运行 Vite 开发服务器或先执行 npm run build。</p>')
  })
  logger.info('admin.router_ready', { enabled: Boolean(config.adminToken || database), database: Boolean(database) }); return router
}

function verifyPassword(password: string, encoded: string) {
  const [salt, digest] = encoded.split(':'); if (!salt || !digest) return false
  const actual = crypto.scryptSync(password, salt, 32).toString('hex'); return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(digest))
}
export function hashAdminPassword(password: string) { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}` }
