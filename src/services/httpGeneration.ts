import type { CapturedPhoto, GeneratedAsset, GenerationJob, StylePreset } from '../types'
import type { GenerationService } from './contracts'
import { trackClientEvent } from './clientLogger'

type ApiError = { code?: string; message?: string; retryable?: boolean }

export const httpGenerationService: GenerationService = {
  async generate(sessionId: string, paymentToken: string, photo: CapturedPhoto, styles: StylePreset[], onProgress: (jobs: GenerationJob[]) => void) {
    const controller = new AbortController()
    const startedAt = performance.now()
    trackClientEvent('generation.started', sessionId, { styleCount: styles.length, styleIds: styles.map((style) => style.id).join(','), photoSource: photo.source })
    const timeout = window.setTimeout(() => controller.abort(), 300_000)
    const jobs: GenerationJob[] = styles.map((style, index) => ({ id: `api-job-${index}`, styleId: style.id, status: 'queued', progress: 0 }))
    onProgress(jobs)
    const ticker = window.setInterval(() => {
      const elapsedSeconds = (performance.now() - startedAt) / 1000
      const progress = elapsedSeconds <= 30
        ? Math.round(elapsedSeconds * 2.5)
        : elapsedSeconds <= 50
          ? Math.round(75 + (elapsedSeconds - 30) * 0.75)
          : Math.min(95, Math.round(90 + (elapsedSeconds - 50) * 0.125))
      onProgress(jobs.map((job) => ({ ...job, status: 'working', progress })))
    }, 1000)

    try {
      const response = await fetch('/api/generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Payment-Token': paymentToken },
        body: JSON.stringify({ sessionId, photo: photo.url, styles: styles.map((style) => ({ id: style.id })) }),
        signal: controller.signal,
      })
      const payload = (await response.json()) as ApiError & { assets?: GeneratedAsset[] }
      if (!response.ok || !payload.assets) throw new Error(payload.message ?? 'AI 生图服务暂时不可用，请稍后重试')
      onProgress(jobs.map((job) => ({ ...job, status: 'complete', progress: 100 })))
      trackClientEvent('generation.client_succeeded', sessionId, { styleCount: styles.length, durationMs: Math.round(performance.now() - startedAt) })
      return payload.assets
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError' ? '生图等待超时，请检查服务配置后重试' : error instanceof Error ? error.message : '生图失败'
      trackClientEvent('generation.client_failed', sessionId, { errorName: error instanceof Error ? error.name : 'unknown', durationMs: Math.round(performance.now() - startedAt) })
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error(message, { cause: error })
      throw error
    } finally {
      window.clearTimeout(timeout)
      window.clearInterval(ticker)
    }
  },
}
