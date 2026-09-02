import type { GeneratedAsset, GenerationJob } from '../types'
import type { AgentGenerationService } from './contracts'
import { trackClientEvent } from './clientLogger'

type ApiError = { code?: string; message?: string; retryable?: boolean }

export const httpAgentGenerationService: AgentGenerationService = {
  async generate(sessionId, paymentToken, generationId, photo, background, onProgress) {
    const controller = new AbortController()
    const startedAt = performance.now()
    trackClientEvent('agent.started', sessionId, { backgroundId: background.id, photoSource: photo.source })
    const timeout = window.setTimeout(() => controller.abort(), 300_000)
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
      const response = await fetch('/api/agent/generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Payment-Token': paymentToken },
        body: JSON.stringify({ sessionId, generationId, photo: photo.url, backgroundId: background.id }),
        signal: controller.signal,
      })
      const payload = (await response.json()) as ApiError & { assets?: GeneratedAsset[]; prompt?: string }
      if (!response.ok || !payload.assets) throw new Error(payload.message ?? 'Agent 生图服务暂时不可用，请稍后重试')
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
      onProgress(jobs.map((job) => ({ ...job, status: 'complete', progress: 100 })))
      trackClientEvent('agent.succeeded', sessionId, { backgroundId: background.id, durationMs: Math.round(performance.now() - startedAt) })
      return { assets: payload.assets, prompt }
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
