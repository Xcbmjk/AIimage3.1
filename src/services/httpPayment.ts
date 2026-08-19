import type { PaymentService } from './contracts'

async function payload(response: Response) {
  const body = await response.json() as { message?: string }
  if (!response.ok) throw new Error(body.message ?? '支付服务暂时不可用')
  return body
}

export const httpPaymentService: PaymentService = {
  async create(sessionId) {
    const response = await fetch('/api/payments/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    return await payload(response) as Awaited<ReturnType<PaymentService['create']>>
  },
  async status(orderId, sessionId) {
    const response = await fetch(`/api/payments/orders/${encodeURIComponent(orderId)}?sessionId=${encodeURIComponent(sessionId)}`)
    return await payload(response) as Awaited<ReturnType<PaymentService['status']>>
  },
}
