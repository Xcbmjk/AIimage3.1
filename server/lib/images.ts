import { ProviderError } from './errors'
import dns from 'node:dns/promises'
import net from 'node:net'

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/

export function decodeDataUrl(value: unknown, maxBytes: number) {
  if (typeof value !== 'string') throw new ProviderError('INVALID_INPUT', '照片格式无效', false)
  const match = DATA_URL.exec(value)
  if (!match) throw new ProviderError('INVALID_INPUT', '只支持 JPEG、PNG 或 WebP 图片', false)
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.byteLength > maxBytes) throw new ProviderError('INVALID_INPUT', '照片尺寸过大，请重新拍摄', false)
  validateImageBuffer(buffer, match[1], maxBytes)
  return { buffer, mimeType: match[1] }
}

export function validateImageBuffer(buffer: Buffer, mimeType: string, maxBytes = 15 * 1024 * 1024) {
  if (!buffer.length || buffer.length > maxBytes) throw new ProviderError('INVALID_INPUT', '图片大小不符合要求', false)
  let width = 0
  let height = 0
  if (mimeType === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20)
  } else if (mimeType === 'image/webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    if (buffer.toString('ascii', 12, 16) === 'VP8X' && buffer.length >= 30) {
      width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16)
      height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16)
    }
  } else if (mimeType === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8) {
    for (let offset = 2; offset + 9 < buffer.length;) {
      if (buffer[offset] !== 0xff) { offset += 1; continue }
      const marker = buffer[offset + 1]
      if (marker === 0xd9 || marker === 0xda) break
      const segmentLength = buffer.readUInt16BE(offset + 2)
      if (segmentLength < 2 || offset + segmentLength + 2 > buffer.length) break
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        height = buffer.readUInt16BE(offset + 5); width = buffer.readUInt16BE(offset + 7); break
      }
      offset += segmentLength + 2
    }
  }
  if (!width || !height || width > 12000 || height > 12000 || width * height > 40_000_000) throw new ProviderError('INVALID_INPUT', '图片格式或尺寸无效', false)
}

export function normalizeImage(value: unknown, mimeType = 'image/png') {
  if (typeof value !== 'string' || value.length === 0) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务没有返回图片', false)
  return value.startsWith('data:') ? value : `data:${mimeType};base64,${value}`
}

export async function fetchImageAsDataUrl(url: string, timeoutMs: number) {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务返回了无效图片地址', false) }
  if (parsed.protocol !== 'https:') throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务图片地址不安全', false)
  if (isPrivateHostname(parsed.hostname)) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务图片地址不安全', false)
  const addresses = await dns.lookup(parsed.hostname, { all: true }).catch(() => [])
  if (!addresses.length || addresses.some((address) => isPrivateAddress(address.address))) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务图片地址不安全', false)
  const response = await fetch(parsed, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务图片重定向被拒绝', false)
  if (!response.ok) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务图片下载失败', false)
  const type = response.headers.get('content-type')?.split(';')[0] ?? 'image/png'
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务返回的不是受支持的图片', false)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > 15 * 1024 * 1024) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务返回图片过大', false)
  if (!response.body) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务没有返回图片内容', false)
  const chunks: Buffer[] = []; let total = 0
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > 15 * 1024 * 1024) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务返回图片过大', false)
    chunks.push(Buffer.from(chunk))
  }
  const buffer = Buffer.concat(chunks)
  validateImageBuffer(buffer, type)
  return `data:${type};base64,${buffer.toString('base64')}`
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized === 'metadata.google.internal'
}

function isPrivateAddress(address: string) {
  const family = net.isIP(address)
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 0
  }
  if (family === 6) return address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb')
  return true
}
