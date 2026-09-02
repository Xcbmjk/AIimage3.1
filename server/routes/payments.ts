import express from 'express'
import type { ServerConfig } from '../config'
import type { Logger } from '../lib/logger'
import type { PaymentOrderRepository } from '../payment/orderStore'
import { WechatPayClient } from '../payment/wechatPay'
import type { Database } from '../db/mysql'
import { getPublishedPricing } from '../catalog/catalog'
import { reconcileWechatOrder } from '../payment/reconciliation'

const sessionPattern = /^[a-f0-9-]{36}$/i

export function createPaymentRouter(config: ServerConfig, store: PaymentOrderRepository, logger: Logger, database?: Database | null) {
  const router = express.Router()
  const wechat = config.payment.mode === 'wechat-native' ? new WechatPayClient(config.payment) : null

  router.post('/payments/wechat/notify', express.raw({ type: 'application/json', limit: '256kb' }), async (request, response) => {
    if (!wechat || !Buffer.isBuffer(request.body)) {
      response.status(404).end()
      return
    }
    const rawBody = request.body.toString('utf8')
    try {
      if (!wechat.verifyNotification(request.headers, rawBody)) {
        response.status(401).json({ code: 'FAIL', message: '签名验证失败' })
        return
      }
      const payload = JSON.parse(rawBody) as { id?: string; event_type?: string; resource?: { ciphertext: string; nonce: string; associated_data?: string; algorithm?: string; original_type?: string } }
      if (payload.event_type !== 'TRANSACTION.SUCCESS') {
        response.status(204).end()
        return
      }
      if (!payload.resource || payload.resource.algorithm !== 'AEAD_AES_256_GCM' || payload.resource.original_type !== 'transaction') { response.status(400).json({ code: 'FAIL', message: '通知资源无效' }); return }
      const transaction = wechat.decryptNotification(payload.resource)
      const order = await store.find(transaction.out_trade_no)
      if (!order || transaction.trade_state !== 'SUCCESS' || transaction.appid !== config.payment.appId || transaction.mchid !== config.payment.mchId || transaction.amount.total !== order.amountFen || transaction.amount.currency !== 'CNY') {
        logger.warn('payment.notification_rejected', { orderId: transaction.out_trade_no, reason: 'order_or_amount_mismatch' })
        response.status(400).json({ code: 'FAIL', message: '订单校验失败' })
        return
      }
      if (!payload.id) { response.status(400).json({ code: 'FAIL', message: '通知 ID 缺失' }); return }
      const result = store.processPaymentNotification
        ? await store.processPaymentNotification({ notificationId: payload.id, eventType: payload.event_type!, orderId: order.id, transactionId: transaction.transaction_id, paidAt: transaction.success_time })
        : (await store.markPaid(order.id, transaction.transaction_id, transaction.success_time), 'processed' as const)
      if (result === 'conflict' || result === 'not_found') { response.status(409).json({ code: 'FAIL', message: '订单状态冲突' }); return }
      logger.info('payment.completed', { orderId: order.id, sessionId: order.sessionId, transactionId: transaction.transaction_id })
      response.status(204).end()
    } catch (error) {
      logger.error('payment.notification_failed', { reason: error instanceof Error ? error.name : 'unknown' })
      response.status(400).json({ code: 'FAIL', message: '通知处理失败' })
    }
  })

  router.post('/payments/orders', express.json({ limit: '32kb' }), async (request, response) => {
    const sessionId = typeof request.body?.sessionId === 'string' ? request.body.sessionId : ''
    if (!sessionPattern.test(sessionId)) {
      response.status(400).json({ code: 'INVALID_INPUT', message: '无效的体验会话' })
      return
    }
    const pricing = await getPublishedPricing(config, database)
    const order = await store.create(sessionId, pricing.amountFen, config.payment.mode)
    try {
      const codeUrl = wechat
        ? await wechat.createNativeOrder(order, pricing.description)
        : `${config.payment.publicBaseUrl}/api/payments/mock/${encodeURIComponent(order.id)}`
      logger.info('payment.order_created', { orderId: order.id, sessionId, amountFen: order.amountFen, mode: config.payment.mode })
      response.status(201).json({ orderId: order.id, amountFen: order.amountFen, description: pricing.description, expiresAt: order.expiresAt, codeUrl, mock: !wechat })
    } catch (error) {
      logger.error('payment.order_create_failed', { orderId: order.id, sessionId, reason: error instanceof Error ? error.message : 'unknown' })
      response.status(502).json({ code: 'PAYMENT_FAILED', message: '暂时无法创建微信支付订单，请稍后重试' })
    }
  })

  router.get('/payments/orders/:orderId', async (request, response) => {
    let order = await store.find(request.params.orderId)
    if (!order) {
      response.status(404).json({ code: 'NOT_FOUND', message: '支付订单不存在' })
      return
    }
    const sessionId = request.query.sessionId
    if (sessionId !== order.sessionId) {
      response.status(403).json({ code: 'FORBIDDEN', message: '无权查询该订单' })
      return
    }
    const lastQueryAge = order.lastQueryAt ? Date.now() - new Date(order.lastQueryAt).getTime() : Number.POSITIVE_INFINITY
    if (wechat && order.status === 'pending' && order.paymentMode === 'wechat-native' && lastQueryAge >= 2_000) order = await reconcileWechatOrder(order, store, wechat, logger) ?? order
    else if (!wechat && order.status === 'pending' && new Date(order.expiresAt).getTime() <= Date.now()) {
      await store.markExpired?.(order.id, false)
      order = await store.find(order.id) ?? order
    }
    response.json({ status: order.status, accessToken: order.status === 'paid' ? order.accessToken : undefined })
  })

  router.get('/payments/mock/:orderId', async (request, response) => {
    if (config.payment.mode !== 'mock') {
      response.status(404).end()
      return
    }
    const existing = await store.find(request.params.orderId)
    const order = existing?.status === 'paid' ? existing : await store.markPaid(request.params.orderId, `MOCK-${request.params.orderId}`)
    if (!order) {
      response.status(404).send('订单不存在')
      return
    }
    logger.info('payment.mock_completed', { orderId: order.id, sessionId: order.sessionId })
    response.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>支付成功</title><body style="font-family:sans-serif;text-align:center;padding:72px 20px;background:#112e29;color:#fff"><h1>模拟支付成功</h1><p>请返回体验大屏，系统将自动进入拍照。</p></body>')
  })

  return router
}
