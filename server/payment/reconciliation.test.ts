import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../lib/logger'
import type { PaymentOrder, PaymentOrderRepository } from './orderStore'
import { reconcileWechatOrder, type WechatOrderGateway } from './reconciliation'

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
const order = (overrides: Partial<PaymentOrder> = {}): PaymentOrder => ({
  id: 'SJ20260831120000ABCDEF12', sessionId: '16de9a80-f226-45be-8c2d-f9f632aa0140', amountFen: 990,
  status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides,
})

function repository(current: PaymentOrder) {
  const store: PaymentOrderRepository = {
    create: vi.fn(), find: vi.fn(async () => current), list: vi.fn(async () => [current]),
    markPaid: vi.fn(async (_id, transactionId): Promise<PaymentOrder> => ({ ...current, status: 'paid', transactionId })),
    authorize: vi.fn(async () => false), reserveGeneration: vi.fn(), completeGeneration: vi.fn(), failGeneration: vi.fn(),
    recordProviderState: vi.fn(async () => undefined), markExpired: vi.fn(async () => true), markRefunded: vi.fn(async () => true),
  }
  return store
}

describe('payment reconciliation', () => {
  it('marks an order paid when provider query returns SUCCESS', async () => {
    const current = order(); const store = repository(current)
    const wechat: WechatOrderGateway = { merchantId: 'mch', queryOrder: vi.fn(async () => ({ appid: 'app', mchid: 'mch', out_trade_no: current.id, transaction_id: 'wx-1', trade_state: 'SUCCESS' as const, amount: { total: 990, currency: 'CNY' } })), closeOrder: vi.fn() }
    await reconcileWechatOrder(current, store, wechat, logger)
    expect(store.markPaid).toHaveBeenCalledWith(current.id, 'wx-1', undefined)
    expect(wechat.closeOrder).not.toHaveBeenCalled()
  })

  it('closes an expired NOTPAY order before marking it expired', async () => {
    const current = order({ expiresAt: new Date(Date.now() - 1_000).toISOString() }); const store = repository(current)
    const wechat: WechatOrderGateway = { merchantId: 'mch', queryOrder: vi.fn(async () => ({ appid: 'app', mchid: 'mch', out_trade_no: current.id, trade_state: 'NOTPAY' as const, amount: { total: 990, currency: 'CNY' } })), closeOrder: vi.fn(async () => undefined) }
    await reconcileWechatOrder(current, store, wechat, logger)
    expect(wechat.closeOrder).toHaveBeenCalledWith(current.id)
    expect(store.markExpired).toHaveBeenCalledWith(current.id, true)
  })

  it('does not grant payment when the queried amount differs', async () => {
    const current = order(); const store = repository(current)
    const wechat: WechatOrderGateway = { merchantId: 'mch', queryOrder: vi.fn(async () => ({ appid: 'app', mchid: 'mch', out_trade_no: current.id, transaction_id: 'wx-1', trade_state: 'SUCCESS' as const, amount: { total: 1, currency: 'CNY' } })), closeOrder: vi.fn() }
    await reconcileWechatOrder(current, store, wechat, logger)
    expect(store.markPaid).not.toHaveBeenCalled()
    expect(store.recordProviderState).toHaveBeenCalledWith(current.id, 'SUCCESS', 'ORDER_MISMATCH')
  })
})
