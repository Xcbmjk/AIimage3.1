import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ServerConfig } from '../config'
import type { Logger } from '../lib/logger'
import { PaymentOrderStore, type PaymentOrder } from '../payment/orderStore'
import type { Database } from '../db/mysql'
import { collectHealth } from '../lib/health'

type Role = 'owner' | 'operator' | 'technical'
type Session = { username: string; role: Role; csrf: string; expiresAt: number }
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

export function createAdminRouter(config: ServerConfig, store: PaymentOrderStore, logger: Logger, database?: Database | null) {
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
  const record = (request: express.Request, action: string, targetType: string, targetId?: string, reason?: string) => {
    const admin = (request as express.Request & { admin?: { username: string } }).admin
    const event = { actor: admin?.username ?? 'unknown', action, targetType, targetId, reason, createdAt: now() }
    audit.unshift(event); logger.info('admin.audit', event); return event
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

  router.get('/api/admin/summary', guard, (_request, response) => {
    const orders = store.list(); const paid = orders.filter((order) => order.status === 'paid'); const generations = paid.map((order) => order.generation).filter(Boolean)
    response.json({ provider: config.provider, paymentMode: config.payment.mode, totals: {
      orders: orders.length, paid: paid.length, pending: orders.filter((o) => o.status === 'pending').length,
      expired: orders.filter((o) => o.status === 'expired').length,
      generationSucceeded: generations.filter((g) => g?.status === 'succeeded').length,
      generationFailed: generations.filter((g) => g?.status === 'failed' || g?.status === 'uncertain').length,
    }, recentOrders: orders.slice(0, 10).map(sanitize) })
  })
  router.get('/api/admin/dashboard', guard, (_request, response) => {
    const orders = store.list(); const day = Date.now() - 24 * 3600_000
    response.json({ orders24h: orders.filter((o) => new Date(o.createdAt).getTime() >= day).length, provider: config.provider, database: database ? 'mysql' : 'json-fallback', auditEvents: audit.length })
  })
  router.get('/api/admin/orders', guard, (request, response) => {
    const status = typeof request.query.status === 'string' ? request.query.status : undefined; const search = typeof request.query.search === 'string' ? request.query.search.toLowerCase() : ''
    const page = Math.max(1, Number(request.query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)))
    const filtered = store.list().filter((order) => (!status || order.status === status) && (!search || `${order.id} ${order.sessionId}`.toLowerCase().includes(search)))
    response.json({ orders: filtered.slice((page - 1) * pageSize, page * pageSize).map(sanitize), total: filtered.length, page, pageSize })
  })
  router.get('/api/admin/orders/:id', guard, (request, response) => {
    const order = store.find(String(request.params.id)); if (!order) { response.status(404).json({ code: 'NOT_FOUND', message: '订单不存在' }); return }
    response.json({ order: sanitize(order), audit: audit.filter((event) => event.targetId === order.id) })
  })
  router.get('/api/admin/generations', guard, (_request, response) => response.json({ generations: store.list().filter((order) => order.generation).map((order) => ({ orderId: order.id, ...order.generation })) }))
  router.post('/api/admin/generations/:id/retry', guard, requirePermission('retry'), express.json({ limit: '16kb' }), (request, response) => {
    const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : ''
    if (!reason) { response.status(400).json({ code: 'INVALID_INPUT', message: '请填写重试原因' }); return }
    const generationId = String(request.params.id); const order = store.list().find((item) => item.generation?.id === generationId)
    if (!order?.generation || !['failed', 'uncertain'].includes(order.generation.status)) { response.status(409).json({ code: 'GENERATION_NOT_RETRYABLE', message: '仅失败或待核查任务可重试' }); return }
    const attempts = Number((order.generation as PaymentOrder['generation'] & { attempts?: number }).attempts ?? 0)
    if (attempts >= 2) { response.status(409).json({ code: 'RETRY_LIMIT_REACHED', message: '已达到最多 2 次重试' }); return }
    ;(order.generation as PaymentOrder['generation'] & { attempts?: number }).attempts = attempts + 1
    record(request, 'generation.retry_requested', 'generation', generationId, reason); response.status(202).json({ accepted: true, generationId, attempts: attempts + 1 })
  })
  router.get('/api/admin/styles', guard, (_request, response) => response.json({ styles: [], message: '风格版本将在启用 MySQL 后从已发布配置读取' }))
  router.get('/api/admin/pricing', guard, (_request, response) => response.json({ versions: [{ amountFen: config.payment.amountFen, description: config.payment.description, status: 'published' }] }))
  router.post('/api/admin/refunds', guard, requirePermission('refund:request'), express.json({ limit: '16kb' }), (request, response) => {
    const order = store.find(String(request.body?.orderId ?? '')); const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : ''
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
