import crypto from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { Database } from '../db/mysql'
import type { GenerationReservation, PaymentGeneration, PaymentOrder, PaymentOrderRepository } from './orderStore'

type OrderRow = RowDataPacket & {
  id: string
  session_id: string
  amount_fen: number
  status: PaymentOrder['status']
  created_at: Date | string
  expires_at: Date | string
  paid_at: Date | string | null
  transaction_id: string | null
  access_expires_at: Date | string | null
  payment_mode: PaymentOrder['paymentMode'] | null
  provider_trade_state: string | null
  query_attempts: number
  last_query_at: Date | string | null
  closed_at: Date | string | null
  generation_id: string | null
  request_hash: string | null
  generation_status: PaymentGeneration['status'] | null
  generation_started_at: Date | string | null
  generation_completed_at: Date | string | null
  generation_error_code: string | null
  generation_attempts: number | null
}

const selectOrder = `SELECT o.*,
  g.id AS generation_id, g.request_hash, g.status AS generation_status,
  g.started_at AS generation_started_at, g.completed_at AS generation_completed_at,
  g.error_code AS generation_error_code, g.attempts AS generation_attempts
  FROM orders o LEFT JOIN generation_jobs g ON g.order_id = o.id`

const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : undefined
const sqlDate = (value: string) => new Date(value).toISOString().slice(0, 19).replace('T', ' ')

export class MySqlPaymentOrderRepository implements PaymentOrderRepository {
  constructor(private readonly database: Database, private readonly tokenSecret: string) {}

  async create(sessionId: string, amountFen: number, paymentMode: PaymentOrder['paymentMode'] = 'mock') {
    const now = Date.now()
    const order: PaymentOrder = {
      id: `SJ${new Date(now).toISOString().replace(/\D/g, '').slice(0, 14)}${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      sessionId,
      amountFen,
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
      paymentMode,
      queryAttempts: 0,
    }
    await this.database.pool.query(
      `INSERT INTO orders (id, session_id, amount_fen, status, payment_mode, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [order.id, sessionId, amountFen, paymentMode, sqlDate(order.createdAt), sqlDate(order.expiresAt)],
    )
    return order
  }

  async find(id: string) {
    const rows = await this.database.query<OrderRow[]>(`${selectOrder} WHERE o.id = ? LIMIT 1`, [id])
    return rows[0] ? this.map(rows[0]) : undefined
  }

  async list() {
    const rows = await this.database.query<OrderRow[]>(`${selectOrder} ORDER BY o.created_at DESC`)
    return rows.map((row) => this.map(row))
  }

  async markPaid(id: string, transactionId: string, paidAt = new Date().toISOString()) {
    const connection = await this.database.pool.getConnection()
    try {
      await connection.beginTransaction()
      const order = await this.lockOrder(connection, id)
      if (!order) { await connection.rollback(); return undefined }
      if (order.status !== 'paid') {
        const accessExpiresAt = new Date(new Date(paidAt).getTime() + 24 * 3600_000).toISOString()
        const token = this.issueToken(order.id, order.session_id, accessExpiresAt)
        await connection.query(
          `UPDATE orders SET status = 'paid', paid_at = ?, transaction_id = ?, access_token_hash = ?, access_expires_at = ?, provider_trade_state = 'SUCCESS'
           WHERE id = ?`,
          [sqlDate(paidAt), transactionId, this.hash(token), sqlDate(accessExpiresAt), id],
        )
      } else if (order.transaction_id && order.transaction_id !== transactionId) {
        throw new Error('PAYMENT_TRANSACTION_CONFLICT')
      }
      await connection.commit()
      return await this.find(id)
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      throw error
    } finally { connection.release() }
  }

  async authorize(sessionId: string, accessToken: string) {
    const payload = this.verifyToken(accessToken)
    if (!payload || payload.sessionId !== sessionId || payload.expiresAt <= Date.now()) return false
    const rows = await this.database.query<Array<RowDataPacket & { access_token_hash: string | null }>>(
      `SELECT access_token_hash FROM orders WHERE id = ? AND session_id = ? AND status = 'paid' AND access_expires_at > UTC_TIMESTAMP() LIMIT 1`,
      [payload.orderId, sessionId],
    )
    const expected = rows[0]?.access_token_hash
    if (!expected) return false
    const tokenHash = this.hash(accessToken)
    if (this.safeEqual(expected, tokenHash)) return true
    await this.database.pool.query(`UPDATE orders SET access_token_hash = ? WHERE id = ? AND access_token_hash = ?`, [tokenHash, payload.orderId, expected])
    return true
  }

  async reserveGeneration(sessionId: string, accessToken: string, generationId: string, requestHash: string, sceneId = 'legacy'): Promise<GenerationReservation> {
    const payload = this.verifyToken(accessToken)
    if (!payload || payload.sessionId !== sessionId || payload.expiresAt <= Date.now()) return { status: 'unauthorized' }
    const connection = await this.database.pool.getConnection()
    try {
      await connection.beginTransaction()
      const orderRows = await connection.query<Array<RowDataPacket & { id: string; session_id: string; status: string; access_token_hash: string | null; access_expires_at: Date | string | null }>>(
        `SELECT id, session_id, status, access_token_hash, access_expires_at FROM orders WHERE id = ? FOR UPDATE`, [payload.orderId],
      )
      const order = orderRows[0][0]
      if (!order || order.session_id !== sessionId || order.status !== 'paid' || !order.access_token_hash || !order.access_expires_at || new Date(order.access_expires_at).getTime() <= Date.now()) {
        await connection.rollback(); return { status: 'unauthorized' }
      }
      const tokenHash = this.hash(accessToken)
      if (!this.safeEqual(order.access_token_hash, tokenHash)) await connection.query(`UPDATE orders SET access_token_hash = ? WHERE id = ?`, [tokenHash, order.id])
      const [generationRows] = await connection.query<Array<RowDataPacket & { id: string; request_hash: string; status: PaymentGeneration['status']; error_code: string | null }>>(
        `SELECT id, request_hash, status, error_code FROM generation_jobs WHERE order_id = ? LIMIT 1 FOR UPDATE`, [order.id],
      )
      const generation = generationRows[0]
      if (!generation) {
        const now = new Date().toISOString()
        await connection.query(
          `INSERT INTO generation_jobs (id, order_id, scene_id, status, request_hash, attempts, started_at, created_at, updated_at)
           VALUES (?, ?, ?, 'processing', ?, 1, ?, ?, ?)`,
          [generationId, order.id, sceneId, requestHash, sqlDate(now), sqlDate(now), sqlDate(now)],
        )
        await connection.commit()
        return { status: 'reserved', order: (await this.find(order.id))! }
      }
      if (generation.id !== generationId) { await connection.rollback(); return { status: 'already_consumed', generationId: generation.id } }
      if (generation.request_hash !== requestHash) { await connection.rollback(); return { status: 'request_mismatch' } }
      if (generation.status === 'failed' && generation.error_code === 'UPSTREAM_RATE_LIMIT') {
        await connection.query(`UPDATE generation_jobs SET status = 'processing', attempts = attempts + 1, started_at = UTC_TIMESTAMP(), completed_at = NULL, error_code = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [generationId])
        await connection.commit()
        return { status: 'reserved', order: (await this.find(order.id))! }
      }
      await connection.rollback()
      return { status: generation.status }
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      throw error
    } finally { connection.release() }
  }

  async completeGeneration(generationId: string) {
    const [result] = await this.database.pool.query(`UPDATE generation_jobs SET status = 'succeeded', completed_at = UTC_TIMESTAMP(), error_code = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [generationId])
    return Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0
  }

  async failGeneration(generationId: string, errorCode: string, retryable: boolean) {
    const [result] = await this.database.pool.query(
      `UPDATE generation_jobs SET status = ?, error_code = ?, completed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?`,
      [retryable ? 'failed' : 'uncertain', errorCode, generationId],
    )
    return Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0
  }

  async pendingForReconciliation(limit = 50) {
    const rows = await this.database.query<OrderRow[]>(
      `${selectOrder} WHERE o.status = 'pending' AND o.payment_mode = 'wechat-native' AND (o.last_query_at IS NULL OR o.last_query_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 SECOND)) ORDER BY o.created_at ASC LIMIT ?`,
      [limit],
    )
    return rows.map((row) => this.map(row))
  }

  async recordProviderState(id: string, tradeState: string, errorCode?: string) {
    await this.database.pool.query(
      `UPDATE orders SET provider_trade_state = ?, payment_error_code = ?, query_attempts = query_attempts + 1, last_query_at = UTC_TIMESTAMP() WHERE id = ?`,
      [tradeState, errorCode ?? null, id],
    )
  }

  async markExpired(id: string, closed = false) {
    const [result] = await this.database.pool.query(
      `UPDATE orders SET status = 'expired', provider_trade_state = 'CLOSED', closed_at = IF(?, UTC_TIMESTAMP(), closed_at) WHERE id = ? AND status = 'pending'`,
      [closed ? 1 : 0, id],
    )
    return Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0
  }

  async markRefunded(id: string) {
    const [result] = await this.database.pool.query(
      `UPDATE orders SET status = 'refunded', provider_trade_state = 'REFUND' WHERE id = ? AND status IN ('paid', 'refunded')`, [id],
    )
    return Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0
  }

  async processPaymentNotification(input: { notificationId: string; eventType: string; orderId: string; transactionId: string; paidAt?: string }) {
    const connection = await this.database.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [notificationRows] = await connection.query<Array<RowDataPacket & { id: string }>>(`SELECT id FROM payment_notifications WHERE id = ? LIMIT 1 FOR UPDATE`, [input.notificationId])
      if (notificationRows[0]) { await connection.commit(); return 'duplicate' as const }
      const order = await this.lockOrder(connection, input.orderId)
      if (!order) { await connection.rollback(); return 'not_found' as const }
      if (order.status === 'paid' && order.transaction_id && order.transaction_id !== input.transactionId) { await connection.rollback(); return 'conflict' as const }
      const paidAt = input.paidAt ?? new Date().toISOString()
      const accessExpiresAt = order.access_expires_at ? iso(order.access_expires_at)! : new Date(new Date(paidAt).getTime() + 24 * 3600_000).toISOString()
      const token = this.issueToken(order.id, order.session_id, accessExpiresAt)
      await connection.query(
        `UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), transaction_id = COALESCE(transaction_id, ?), access_token_hash = COALESCE(access_token_hash, ?), access_expires_at = COALESCE(access_expires_at, ?), provider_trade_state = 'SUCCESS' WHERE id = ?`,
        [sqlDate(paidAt), input.transactionId, this.hash(token), sqlDate(accessExpiresAt), order.id],
      )
      await connection.query(
        `INSERT INTO payment_notifications (id, event_type, order_id, transaction_id, processed_at, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [input.notificationId, input.eventType, input.orderId, input.transactionId],
      )
      await connection.commit()
      return 'processed' as const
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      throw error
    } finally { connection.release() }
  }

  private async lockOrder(connection: PoolConnection, id: string) {
    const [rows] = await connection.query<OrderRow[]>(`SELECT * FROM orders WHERE id = ? LIMIT 1 FOR UPDATE`, [id])
    return rows[0]
  }

  private map(row: OrderRow): PaymentOrder {
    const accessExpiresAt = iso(row.access_expires_at)
    return {
      id: row.id,
      sessionId: row.session_id,
      amountFen: Number(row.amount_fen),
      status: row.status,
      createdAt: iso(row.created_at)!,
      expiresAt: iso(row.expires_at)!,
      paidAt: iso(row.paid_at),
      transactionId: row.transaction_id ?? undefined,
      accessToken: row.status === 'paid' && accessExpiresAt ? this.issueToken(row.id, row.session_id, accessExpiresAt) : undefined,
      accessExpiresAt,
      paymentMode: row.payment_mode ?? undefined,
      providerTradeState: row.provider_trade_state ?? undefined,
      queryAttempts: Number(row.query_attempts ?? 0),
      lastQueryAt: iso(row.last_query_at),
      closedAt: iso(row.closed_at),
      generation: row.generation_id && row.request_hash && row.generation_status && row.generation_started_at ? {
        id: row.generation_id,
        requestHash: row.request_hash,
        status: row.generation_status,
        startedAt: iso(row.generation_started_at)!,
        completedAt: iso(row.generation_completed_at),
        errorCode: row.generation_error_code ?? undefined,
        attempts: Number(row.generation_attempts ?? 0),
        retryable: row.generation_status === 'failed' && row.generation_error_code === 'UPSTREAM_RATE_LIMIT',
      } : undefined,
    }
  }

  private issueToken(orderId: string, sessionId: string, expiresAt: string) {
    const encoded = Buffer.from(JSON.stringify({ orderId, sessionId, expiresAt: new Date(expiresAt).getTime() })).toString('base64url')
    const signature = crypto.createHmac('sha256', this.tokenSecret).update(encoded).digest('base64url')
    return `${encoded}.${signature}`
  }

  private verifyToken(token: string): { orderId: string; sessionId: string; expiresAt: number } | undefined {
    const [encoded, suppliedSignature] = token.split('.')
    if (!encoded || !suppliedSignature) return undefined
    const expectedSignature = crypto.createHmac('sha256', this.tokenSecret).update(encoded).digest('base64url')
    if (!this.safeEqual(expectedSignature, suppliedSignature)) return undefined
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>
      if (typeof payload.orderId !== 'string' || typeof payload.sessionId !== 'string' || typeof payload.expiresAt !== 'number') return undefined
      return payload as { orderId: string; sessionId: string; expiresAt: number }
    } catch { return undefined }
  }

  private hash(value: string) { return crypto.createHash('sha256').update(value).digest('hex') }
  private safeEqual(left: string, right: string) {
    const a = Buffer.from(left); const b = Buffer.from(right)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
}
