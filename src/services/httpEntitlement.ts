import type { EntitlementRedemption } from '../types'
import type { EntitlementService } from './contracts'
import { apiUrl } from './apiBase'

type ApiError = { message?: string }

export const httpEntitlementService: EntitlementService = {
  async validate(code) {
    throw new Error(`兑换码校验需要提交兑换，请使用兑换入口（${code.trim()}）`)
  },
  async consume(code, sessionId): Promise<EntitlementRedemption> {
    const response = await fetch(apiUrl('/api/entitlements/redeem'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), sessionId }),
    })
    const payload = await response.json() as ApiError & Partial<EntitlementRedemption>
    if (!response.ok || !payload.entitlement || !payload.accessToken) {
      throw new Error(payload.message ?? '兑换码暂时无法使用，请稍后重试')
    }
    return { entitlement: payload.entitlement, accessToken: payload.accessToken }
  },
  async restore() {
    // Entitlements are consumed server-side and cannot be rolled back by the kiosk.
  },
}
