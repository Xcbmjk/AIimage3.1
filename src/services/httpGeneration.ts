import type { CapturedPhoto, GeneratedAsset, GenerationFailure, GenerationJob, StylePreset } from '../types'
import type { GenerationService } from './contracts'
import { trackClientEvent } from './clientLogger'
import { apiUrl } from './apiBase'
import { photoToFile } from './photoFile'

type ApiError = { code?: string; message?: string; retryable?: boolean; assets?: GeneratedAsset[]; failures?: GenerationFailure[] }

export const httpGenerationService: GenerationService = {
  async generate(sessionId: string, entitlementToken: string, generationId: string, photo: CapturedPhoto, styles: StylePreset[], onProgress: (jobs: GenerationJob[]) => void) {
    const controller = new AbortController()
    const startedAt = performance.now()
    trackClientEvent('generation.started', sessionId, { styleCount: styles.length, styleIds: styles.map((style) => style.id).join(','), photoSource: photo.source })
    const timeout = window.setTimeout(() => controller.abort(), 660_000)
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
      const form = new FormData()
      form.set('sessionId', sessionId)
      form.set('generationId', generationId)
      form.set('styles', JSON.stringify(styles.map((style) => ({ id: style.id }))))
      form.set('photo', await photoToFile(photo))
      const response = await fetch(apiUrl('/api/generation'), {
        method: 'POST',
        headers: { 'X-Entitlement-Token': entitlementToken },
        body: form,
        signal: controller.signal,
      })
      const body = await response.text()
      let payload: ApiError = {}
      try { payload = JSON.parse(body) as ApiError } catch { /* handled below */ }
      if (!payload.message && !response.ok) payload.message = `生图服务返回 HTTP ${response.status}`
      const failures = Array.isArray(payload.failures) ? payload.failures : []
      const assets = Array.isArray(payload.assets) ? payload.assets : []
      // Partial success still delivers something: only fail when no image at all came back.
      if (!response.ok || !assets.length) {
        throw new Error(failures[0]?.message ?? payload.message ?? 'AI 生图服务暂时不可用，请稍后重试')
      }
      const failedIds = new Set(failures.map((failure) => failure.styleId))
      onProgress(jobs.map((job) => failedIds.has(job.styleId)
        ? { ...job, status: 'failed', progress: 100 }
        : { ...job, status: 'complete', progress: 100 }))
      const durationMs = Math.round(performance.now() - startedAt)
      if (failures.length) {
        trackClientEvent('generation.client_partial', sessionId, { styleCount: styles.length, failedCount: failures.length, durationMs })
      } else {
        trackClientEvent('generation.client_succeeded', sessionId, { styleCount: styles.length, durationMs })
      }
      return assets
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
