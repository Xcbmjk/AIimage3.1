import { productConfig } from '../../config/product'
import type { Entitlement } from '../../types'
import type { EntitlementService } from '../../services/contracts'

const STORAGE_KEY = 'mountain-portrait:used-codes'
const VALID_CODES = new Set([productConfig.demoCode, 'VIP888', 'SCENIC01'])

const getUsedCodes = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

const makeEntitlement = (code: string, sessionId?: string): Entitlement => ({
  code,
  status: getUsedCodes()[code] ? 'used' : 'available',
  maxStyles: productConfig.maxStylesDefault,
  expiresAt: '2027-12-31T23:59:59.000Z',
  sessionId,
})

export const mockEntitlementService: EntitlementService = {
  async validate(rawCode) {
    const code = rawCode.trim().toUpperCase()
    await new Promise((resolve) => setTimeout(resolve, 450))
    if (!VALID_CODES.has(code)) throw new Error('未找到该体验码，请检查后重试')
    const entitlement = makeEntitlement(code)
    if (entitlement.status === 'used') throw new Error('该体验码已完成体验，不可重复使用')
    return entitlement
  },
  async consume(rawCode, sessionId) {
    const code = rawCode.trim().toUpperCase()
    const entitlement = await this.validate(code)
    const used = getUsedCodes()
    if (used[code]) throw new Error('该体验码已完成体验，不可重复使用')
    used[code] = sessionId
    localStorage.setItem(STORAGE_KEY, JSON.stringify(used))
    return { ...entitlement, status: 'used', sessionId }
  },
  async restore(rawCode, sessionId) {
    const code = rawCode.trim().toUpperCase()
    const used = getUsedCodes()
    if (used[code] === sessionId) {
      delete used[code]
      localStorage.setItem(STORAGE_KEY, JSON.stringify(used))
    }
  },
}
