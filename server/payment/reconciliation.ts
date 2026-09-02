import type { Logger } from '../lib/logger'
import type { PaymentOrder, PaymentOrderRepository } from './orderStore'
import type { WechatPayClient } from './wechatPay'

export type WechatOrderGateway = Pick<WechatPayClient, 'merchantId' | 'queryOrder' | 'closeOrder'>

export async function reconcileWechatOrder(order: PaymentOrder, store: PaymentOrderRepository, wechat: WechatOrderGateway, logger: Logger) {
  try {
    const transaction = await wechat.queryOrder(order.id)
    if (transaction.out_trade_no !== order.id || transaction.mchid !== wechat.merchantId || transaction.amount?.total !== undefined && transaction.amount.total !== order.amountFen || transaction.amount?.currency && transaction.amount.currency !== 'CNY') {
      await store.recordProviderState?.(order.id, transaction.trade_state, 'ORDER_MISMATCH')
      logger.warn('payment.query_rejected', { orderId: order.id, reason: 'order_or_amount_mismatch' })
      return await store.find(order.id)
    }
    await store.recordProviderState?.(order.id, transaction.trade_state)
    if (transaction.trade_state === 'SUCCESS' && transaction.transaction_id) {
      return await store.markPaid(order.id, transaction.transaction_id, transaction.success_time)
    }
    if (transaction.trade_state === 'REFUND') {
      await store.markRefunded?.(order.id)
      return await store.find(order.id)
    }
    if (transaction.trade_state === 'CLOSED') {
      await store.markExpired?.(order.id, true)
      return await store.find(order.id)
    }
    if (transaction.trade_state === 'NOTPAY' && new Date(order.expiresAt).getTime() <= Date.now()) {
      await wechat.closeOrder(order.id)
      await store.markExpired?.(order.id, true)
      logger.info('payment.order_closed', { orderId: order.id, reason: 'expired' })
      return await store.find(order.id)
    }
    return await store.find(order.id)
  } catch (error) {
    try { await store.recordProviderState?.(order.id, 'QUERY_FAILED', error instanceof Error ? error.name : 'unknown') } catch { /* Preserve the original reconciliation failure. */ }
    logger.warn('payment.query_failed', { orderId: order.id, reason: error instanceof Error ? error.name : 'unknown' })
    return await store.find(order.id)
  }
}

export function startPaymentReconciler(store: PaymentOrderRepository, wechat: WechatOrderGateway | null, logger: Logger, intervalMs = 30_000) {
  if (!wechat || !store.pendingForReconciliation) return () => undefined
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const orders = await store.pendingForReconciliation!(50)
      for (const order of orders) await reconcileWechatOrder(order, store, wechat, logger)
    } catch (error) {
      logger.error('payment.reconciler_failed', { reason: error instanceof Error ? error.name : 'unknown' })
    } finally { running = false }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
