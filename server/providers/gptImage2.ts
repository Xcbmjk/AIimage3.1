import type { GeneratedAsset, StylePreset } from '../../src/types'
import { ProviderError, mapProviderError } from '../lib/errors'
import { fetchImageAsDataUrl, normalizeImage } from '../lib/images'
import { endpointUrl } from '../lib/urls'
import type { ServerConfig } from '../config'
import type { ImageProvider } from './types'

export function createGptImageProvider(config: ServerConfig): ImageProvider {
  return {
    name: 'gpt-image-2',
    async generate(photo, mimeType, style: StylePreset): Promise<GeneratedAsset> {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const form = new FormData()
          form.append('model', config.gpt.model)
          form.append('prompt', style.prompt)
          form.append('image', new Blob([new Uint8Array(photo)], { type: mimeType }), 'source.' + mimeType.split('/')[1])
          form.append('size', config.gpt.size)
          form.append('quality', 'low')
          form.append('response_format', config.gpt.responseFormat)
          const response = await fetch(endpointUrl(config.gpt.baseUrl, config.gpt.endpoint), {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.gpt.apiKey}` },
            body: form,
            signal: AbortSignal.timeout(config.timeoutMs),
          })
          if (!response.ok) throw mapProviderError(response.status, 'gpt-image-2', await response.text())
          const payload = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> }
          const first = payload.data?.[0]
          if (!first) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'GPT Image 2 没有返回图片')
          const imageUrl = first.b64_json ? normalizeImage(first.b64_json) : first.url ? await fetchImageAsDataUrl(first.url, config.timeoutMs) : null
          if (!imageUrl) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'GPT Image 2 返回格式不支持')
          return { id: `gpt-${style.id}-${Date.now()}`, styleId: style.id, imageUrl }
        } catch (error) {
          const retryable = error instanceof TypeError
            || error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
            || error instanceof ProviderError && error.retryable
          if (!retryable || attempt === 2) throw error
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
      }
      throw new ProviderError('GENERATION_FAILED', 'GPT Image 2 生图失败', true)
    },
  }
}
