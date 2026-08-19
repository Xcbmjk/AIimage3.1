import type { GeneratedAsset, ShareLink } from '../types'
import type { ShareService } from './contracts'
import { trackClientEvent } from './clientLogger'

export const httpShareService: ShareService = {
  async create(sessionId: string, paymentToken: string, assets: GeneratedAsset[]): Promise<ShareLink> {
    trackClientEvent('share.started', sessionId, { assetCount: assets.length })
    const response = await fetch('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Payment-Token': paymentToken },
      body: JSON.stringify({ sessionId, assets: assets.map(({ imageUrl }) => ({ imageUrl })) }),
    })
    const payload = await response.json() as Partial<ShareLink> & { message?: string }
    if (!response.ok || !payload.url || !payload.expiresAt) throw new Error(payload.message ?? '作品分享创建失败，请稍后重试')
    trackClientEvent('share.completed', sessionId, { assetCount: assets.length })
    return { url: payload.url, expiresAt: payload.expiresAt }
  },
}
