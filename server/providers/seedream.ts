import type { GeneratedAsset, StylePreset } from '../../src/types'
import { ProviderError, mapProviderError } from '../lib/errors'
import { fetchImageAsDataUrl, normalizeImage } from '../lib/images'
import { endpointUrl } from '../lib/urls'
import type { ServerConfig } from '../config'
import type { ImageProvider } from './types'

export function createSeedreamProvider(config: ServerConfig): ImageProvider {
  return {
    name: 'seedream',
    async generate(photo, _mimeType, style: StylePreset): Promise<GeneratedAsset> {
      const body = {
        model: config.seedream.model,
        prompt: style.prompt,
        image: `data:image/jpeg;base64,${photo.toString('base64')}`,
        size: config.seedream.size,
        response_format: config.seedream.responseFormat,
        watermark: config.seedream.watermark,
      }
      const response = await fetch(endpointUrl(config.seedream.baseUrl, config.seedream.endpoint), {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.seedream.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
      if (!response.ok) throw mapProviderError(response.status, 'seedream', await response.text())
      const payload = await response.json() as { data?: Array<{ b64_json?: string; url?: string }>; images?: Array<{ b64_json?: string; url?: string }> }
      const first = payload.data?.[0] ?? payload.images?.[0]
      if (!first) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'Seedream 没有返回图片')
      const imageUrl = first.b64_json ? normalizeImage(first.b64_json) : first.url ? await fetchImageAsDataUrl(first.url, config.timeoutMs) : null
      if (!imageUrl) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'Seedream 返回格式不支持')
      return { id: `seedream-${style.id}-${Date.now()}`, styleId: style.id, imageUrl }
    },
  }
}
