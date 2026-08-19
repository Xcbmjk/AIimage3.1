import type { GenerationErrorCode } from '../../src/types'

export type ProviderErrorDetails = {
  provider?: string
  upstreamStatus?: number
  reason?: string
}

export class ProviderError extends Error {
  constructor(
    public code: GenerationErrorCode,
    message: string,
    public retryable = false,
    public details: ProviderErrorDetails = {},
  ) { super(message) }
}

export function mapProviderError(status: number, provider?: string, reason?: string): ProviderError {
  const details = { provider, upstreamStatus: status, reason: reason?.replace(/\s+/g, ' ').slice(0, 500) }
  if (status === 401 || status === 403) return new ProviderError('UPSTREAM_AUTH', 'AI 服务认证失败，请检查服务端密钥配置', false, details)
  if (status === 429) return new ProviderError('UPSTREAM_RATE_LIMIT', 'AI 服务当前繁忙，请稍后重试', true, details)
  if (status >= 500) return new ProviderError('GENERATION_FAILED', 'AI 服务暂时不可用，请稍后重试', true, details)
  return new ProviderError('UPSTREAM_BAD_RESPONSE', 'AI 服务返回了无法识别的结果', false, details)
}

export function safeError(error: unknown) {
  if (error instanceof ProviderError) return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: error.details,
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { code: 'UPSTREAM_TIMEOUT' as const, message: 'AI 生图等待超时，请稍后重试', retryable: true, details: { reason: error.name } }
  }
  if (error instanceof Error) return { code: 'GENERATION_FAILED' as const, message: 'AI 生图失败，请稍后重试', retryable: true, details: { reason: error.name } }
  return { code: 'GENERATION_FAILED' as const, message: 'AI 生图失败，请稍后重试', retryable: true, details: { reason: 'unknown' } }
}
