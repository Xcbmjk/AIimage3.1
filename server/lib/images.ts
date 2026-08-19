import { ProviderError } from './errors'

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/

export function decodeDataUrl(value: unknown, maxBytes: number) {
  if (typeof value !== 'string') throw new ProviderError('INVALID_INPUT', '照片格式无效', false)
  const match = DATA_URL.exec(value)
  if (!match) throw new ProviderError('INVALID_INPUT', '只支持 JPEG、PNG 或 WebP 图片', false)
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.byteLength > maxBytes) throw new ProviderError('INVALID_INPUT', '照片尺寸过大，请重新拍摄', false)
  return { buffer, mimeType: match[1] }
}

export function normalizeImage(value: unknown, mimeType = 'image/png') {
  if (typeof value !== 'string' || value.length === 0) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务没有返回图片', false)
  return value.startsWith('data:') ? value : `data:${mimeType};base64,${value}`
}

export async function fetchImageAsDataUrl(url: string, timeoutMs: number) {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务返回了无效图片地址', false) }
  if (parsed.protocol !== 'https:') throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务图片地址不安全', false)
  const response = await fetch(parsed, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务图片下载失败', false)
  const type = response.headers.get('content-type')?.split(';')[0] ?? 'image/png'
  if (!type.startsWith('image/')) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务返回的不是图片', false)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > 15 * 1024 * 1024) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务返回图片过大', false)
  return `data:${type};base64,${buffer.toString('base64')}`
}
