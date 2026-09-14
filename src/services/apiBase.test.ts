import { describe, expect, it } from 'vitest'
import { apiUrl, normalizeApiBase } from './apiBase'

describe('normalizeApiBase', () => {
  it('adds HTTP and the default API port to a bare host', () => {
    expect(normalizeApiBase('111.229.11.229')).toBe('http://111.229.11.229:8787')
  })

  it('preserves an explicit protocol, port, and path', () => {
    expect(normalizeApiBase('http://api.example.test:9000/base/')).toBe('http://api.example.test:9000/base')
  })

  it('returns an empty base for unset configuration', () => {
    expect(normalizeApiBase('')).toBe('')
  })

  it('keeps browser requests same-origin even when an APK base is configured', () => {
    expect(apiUrl('/api/catalog', false)).toBe('/api/catalog')
  })

  it('uses the configured base only for native Android requests', () => {
    // 基址来自 .env.local 的 VITE_API_BASE_URL,服务器会迁移,断言只验证
    // 「原生请求拼接配置基址」这一行为,不绑定具体 IP。
    const configured = import.meta.env.VITE_API_BASE_URL as string | undefined
    expect(apiUrl('/api/catalog', true)).toBe(
      configured ? `${configured.replace(/\/$/, '')}/api/catalog` : '/api/catalog',
    )
  })
})
