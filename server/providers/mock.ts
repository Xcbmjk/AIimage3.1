import type { GeneratedAsset, StylePreset } from '../../src/types'
import type { ImageProvider } from './types'
import { stylePresets } from '../../src/mocks/fixtures/styles'

export const createMockProvider = (): ImageProvider => ({
  name: 'mock',
  async generate(_photo, _mimeType, style: StylePreset): Promise<GeneratedAsset> {
    const fixture = stylePresets.find((item) => item.id === style.id)
    return { id: `mock-${style.id}-${Date.now()}`, styleId: style.id, imageUrl: fixture?.resultImage ?? style.resultImage }
  },
})
