import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { Database } from '../db/mysql'
import { MySqlPaymentOrderRepository } from './mysqlOrderRepository'

describe('MySqlPaymentOrderRepository notification idempotency', () => {
  it('returns duplicate without updating the order twice', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('payment_notifications') && sql.startsWith('SELECT')) return [[{ id: 'EV-1' }], []]
      throw new Error(`unexpected query: ${sql}`)
    })
    const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query } as unknown as PoolConnection
    const database = { pool: { getConnection: vi.fn(async () => connection) } } as unknown as Database
    const repository = new MySqlPaymentOrderRepository(database, crypto.randomBytes(32).toString('hex'))

    const result = await repository.processPaymentNotification({ notificationId: 'EV-1', eventType: 'TRANSACTION.SUCCESS', orderId: 'ORDER-1', transactionId: 'WX-1' })

    expect(result).toBe('duplicate')
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('updates payment and records the notification in one transaction', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('payment_notifications') && sql.startsWith('SELECT')) return [[], []]
      if (sql.startsWith('SELECT * FROM orders')) return [[{ id: 'ORDER-1', session_id: 'SESSION-1', status: 'pending', transaction_id: null, access_expires_at: null }], []]
      if (sql.startsWith('UPDATE orders') || sql.startsWith('INSERT INTO payment_notifications')) return [{ affectedRows: 1 }, []]
      throw new Error(`unexpected query: ${sql}`)
    })
    const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query } as unknown as PoolConnection
    const database = { pool: { getConnection: vi.fn(async () => connection) } } as unknown as Database
    const repository = new MySqlPaymentOrderRepository(database, crypto.randomBytes(32).toString('hex'))

    const result = await repository.processPaymentNotification({ notificationId: 'EV-2', eventType: 'TRANSACTION.SUCCESS', orderId: 'ORDER-1', transactionId: 'WX-2' })

    expect(result).toBe('processed')
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE orders'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO payment_notifications'))).toBe(true)
  })
})
