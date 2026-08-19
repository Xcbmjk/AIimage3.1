import crypto from 'node:crypto'
import type { GeneratedAsset, StylePreset } from '../../src/types'
import type { ServerConfig } from '../config'
import { ProviderError, mapProviderError } from '../lib/errors'
import { fetchImageAsDataUrl, normalizeImage } from '../lib/images'
import type { ImageProvider } from './types'

const REGION = 'cn-north-1'
const SERVICE = 'cv'
const VERSION = '2022-08-31'

type JimengResponse = {
  code?: number
  message?: string
  request_id?: string
  data?: {
    task_id?: string
    status?: 'in_queue' | 'generating' | 'done' | 'not_found' | 'expired'
    image_urls?: string[] | null
    binary_data_base64?: string[] | null
  }
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
const hmac = (key: crypto.BinaryLike | crypto.KeyObject, value: string) => crypto.createHmac('sha256', key).update(value).digest()

function signedHeaders(config: ServerConfig, body: string, action: string) {
  const url = new URL(config.jimeng.baseUrl)
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const shortDate = date.slice(0, 8)
  const payloadHash = sha256(body)
  const query = `Action=${encodeURIComponent(action)}&Version=${encodeURIComponent(VERSION)}`
  const canonicalHeaders = `host:${url.host}\nx-content-sha256:${payloadHash}\nx-date:${date}\n`
  const headerNames = 'host;x-content-sha256;x-date'
  const canonicalRequest = `POST\n${url.pathname || '/'}\n${query}\n${canonicalHeaders}\n${headerNames}\n${payloadHash}`
  const scope = `${shortDate}/${REGION}/${SERVICE}/request`
  const stringToSign = `HMAC-SHA256\n${date}\n${scope}\n${sha256(canonicalRequest)}`
  const dateKey = hmac(config.jimeng.secretAccessKey, shortDate)
  const regionKey = hmac(dateKey, REGION)
  const serviceKey = hmac(regionKey, SERVICE)
  const signingKey = hmac(serviceKey, 'request')
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return {
    Authorization: `HMAC-SHA256 Credential=${config.jimeng.accessKeyId}/${scope}, SignedHeaders=${headerNames}, Signature=${signature}`,
    'Content-Type': 'application/json',
    'X-Content-Sha256': payloadHash,
    'X-Date': date,
  }
}

async function request(config: ServerConfig, action: string, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload)
  const response = await fetch(`${config.jimeng.baseUrl}?Action=${action}&Version=${VERSION}`, {
    method: 'POST',
    headers: signedHeaders(config, body, action),
    body,
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  if (!response.ok) throw mapProviderError(response.status, 'jimeng-i2i', await response.text())
  const result = await response.json() as JimengResponse
  if (result.code !== 10000) {
    const retryable = result.code === 50429 || result.code === 50430 || result.code === 50511 || result.code === 50519
    throw new ProviderError('GENERATION_FAILED', retryable ? '即梦服务繁忙，请稍后重试' : '即梦未能完成图片处理', retryable, {
      provider: 'jimeng-i2i',
      reason: `${result.code ?? 'unknown'}:${result.message ?? 'unknown'}`,
    })
  }
  return result
}

export function createJimengI2iProvider(config: ServerConfig): ImageProvider {
  return {
    name: 'jimeng-i2i',
    async generate(photo, mimeType, style: StylePreset): Promise<GeneratedAsset> {
      if (!['image/jpeg', 'image/png'].includes(mimeType)) throw new ProviderError('INVALID_INPUT', '即梦仅支持 JPEG 或 PNG 照片', false)
      if (photo.byteLength > 4.7 * 1024 * 1024) throw new ProviderError('INVALID_INPUT', '即梦输入照片不能超过 4.7MB', false)

      const submitted = await request(config, 'CVSync2AsyncSubmitTask', {
        req_key: config.jimeng.reqKey,
        binary_data_base64: [photo.toString('base64')],
        prompt: style.prompt,
        seed: -1,
        scale: config.jimeng.scale,
        width: config.jimeng.width,
        height: config.jimeng.height,
      })
      const taskId = submitted.data?.task_id
      if (!taskId) throw new ProviderError('UPSTREAM_BAD_RESPONSE', '即梦没有返回任务 ID', false)

      const deadline = Date.now() + config.jimeng.pollTimeoutMs
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, config.jimeng.pollIntervalMs))
        const result = await request(config, 'CVSync2AsyncGetResult', {
          req_key: config.jimeng.reqKey,
          task_id: taskId,
          req_json: JSON.stringify({ return_url: true, logo_info: { add_logo: false } }),
        })
        const status = result.data?.status
        if (status === 'in_queue' || status === 'generating') continue
        if (status === 'not_found' || status === 'expired') throw new ProviderError('GENERATION_FAILED', '即梦任务不存在或已过期，请重试', true)
        if (status === 'done') {
          const base64 = result.data?.binary_data_base64?.[0]
          const url = result.data?.image_urls?.[0]
          const imageUrl = base64 ? normalizeImage(base64, 'image/jpeg') : url ? await fetchImageAsDataUrl(url, config.timeoutMs) : null
          if (!imageUrl) throw new ProviderError('UPSTREAM_BAD_RESPONSE', '即梦任务完成但没有返回图片', false)
          return { id: `jimeng-${style.id}-${taskId}`, styleId: style.id, imageUrl }
        }
        throw new ProviderError('UPSTREAM_BAD_RESPONSE', '即梦返回了未知任务状态', false)
      }
      throw new ProviderError('UPSTREAM_TIMEOUT', '即梦生图等待超时，请稍后重试', true)
    },
  }
}
