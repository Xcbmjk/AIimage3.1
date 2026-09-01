import { stylePresets } from '../mocks/fixtures/styles'
import type { StyleService } from './contracts'

export const httpStyleService: StyleService = {
  async list() {
    try {
      const response = await fetch('/api/catalog')
      if (!response.ok) throw new Error('catalog unavailable')
      const body = await response.json() as { styles?: unknown }
      if (!Array.isArray(body.styles)) throw new Error('catalog invalid')
      return body.styles as Awaited<ReturnType<StyleService['list']>>
    } catch {
      return stylePresets
    }
  },
}
