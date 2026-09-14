import type { GeneratedAsset, GenerationFailure, GenerationJob } from '../types'
import type { AgentGenerationService } from './contracts'
import { trackClientEvent } from './clientLogger'
import { apiUrl } from './apiBase'
import { photoToFile } from './photoFile'

type ApiError = { code?: string; message?: string; retryable?: boolean; assets?: GeneratedAsset[]; prompt?: string; failures?: GenerationFailure[] }

export const httpAgentGenerationService: AgentGenerationService = {
  async generate(sessionId, entitlementToken, generationId, photo, background, onProgress) {
    const controller = new AbortController()
    const startedAt = performance.now()
    trackClientEvent('agent.started', sessionId, { backgroundId: background.id, photoSource: photo.source })
    const timeout = window.setTimeout(() => controller.abort(), 660_000)
    const jobs: GenerationJob[] = [{ id: `agent-job-${generationId}`, styleId: background.id, status: 'queued', progress: 0 }]
    onProgress(jobs)
    const ticker = window.setInterval(() => {
      const elapsedSeconds = (performance.now() - startedAt) / 1000
      const progress = elapsedSeconds <= 30
        ? Math.round(elapsedSeconds * 2.2)
        : elapsedSeconds <= 55
          ? Math.round(66 + (elapsedSeconds - 30) * 0.6)
          : Math.min(95, Math.round(81 + (elapsedSeconds - 55) * 0.12))
      onProgress(jobs.map((job) => ({ ...job, status: 'working', progress })))
    }, 1000)

    try {
      const form = new FormData()
      form.set('sessionId', sessionId)
      form.set('generationId', generationId)
      form.set('backgroundId', background.id)
      form.set('photo', await photoToFile(photo))
      const response = await fetch(apiUrl('/api/agent/generation'), {
        method: 'POST',
        headers: { 'X-Entitlement-Token': entitlementToken },
        body: form,
        signal: controller.signal,
      })
      const body = await response.text()
      let payload: ApiError = {}
      try { payload = JSON.parse(body) as ApiError } catch { /* handled below */ }
      if (!payload.message && !response.ok) payload.message = `Agent 生图服务返回 HTTP ${response.status}`
      const assets = Array.isArray(payload.assets) ? payload.assets : []
      // Agent composes a single image, so there is no partial-success case:
      // no image means the request failed.
      if (!response.ok || !assets.length) throw new Error(payload.message ?? 'Agent 生图服务暂时不可用，请稍后重试')
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
      onProgress(jobs.map((job) => ({ ...job, status: 'complete', progress: 100 })))
      trackClientEvent('agent.succeeded', sessionId, { backgroundId: background.id, durationMs: Math.round(performance.now() - startedAt) })
      return { assets, prompt }
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError' ? 'Agent 生图等待超时，请检查服务配置后重试' : error instanceof Error ? error.message : 'Agent 生图失败'
      trackClientEvent('agent.failed', sessionId, { backgroundId: background.id, errorName: error instanceof Error ? error.name : 'unknown', durationMs: Math.round(performance.now() - startedAt) })
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error(message, { cause: error })
      throw error
    } finally {
      window.clearTimeout(timeout)
      window.clearInterval(ticker)
    }
  },
}
