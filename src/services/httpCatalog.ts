import type { BackgroundService, StyleService } from './contracts'
import { apiUrl } from './apiBase'

export const httpStyleService: StyleService = {
  async list() {
    try {
      const response = await fetch(apiUrl('/api/catalog'))
      if (!response.ok) throw new Error('catalog unavailable')
      const body = await response.json() as { styles?: unknown }
      if (!Array.isArray(body.styles)) throw new Error('catalog invalid')
      return body.styles as Awaited<ReturnType<StyleService['list']>>
    } catch {
      return []
    }
  },
}

export const httpBackgroundService: BackgroundService = {
  async list() {
    try {
      const response = await fetch(apiUrl('/api/catalog'))
      if (!response.ok) return []
      const body = await response.json() as { backgrounds?: unknown; runtime?: { agentEnabled?: boolean } }
      if (body.runtime && body.runtime.agentEnabled === false) return []
      if (!Array.isArray(body.backgrounds)) return []
      return body.backgrounds as Awaited<ReturnType<BackgroundService['list']>>
    } catch {
      return []
    }
  },
}
