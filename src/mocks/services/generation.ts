import { productConfig } from '../../config/product'
import type { AgentGenerationService, BackgroundService, GenerationService, ShareService, StyleService } from '../../services/contracts'
import type { GeneratedAsset, GenerationJob } from '../../types'
import { stylePresets } from '../fixtures/styles'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const mockGenerationService: GenerationService = {
  async generate(_sessionId, _entitlementToken, _generationId, _photo, styles, onProgress) {
    if (!styles.length || styles.length > productConfig.maxStylesDefault) {
      throw new Error(`单次最多生成 ${productConfig.maxStylesDefault} 种风格`)
    }
    let jobs: GenerationJob[] = styles.map((style, index) => ({
      id: `job-${Date.now()}-${index}`,
      styleId: style.id,
      status: 'queued',
      progress: 0,
    }))
    onProgress(jobs)

    for (let step = 1; step <= 10; step += 1) {
      await wait(productConfig.generationTickMs)
      jobs = jobs.map((job, index) => {
        const progress = Math.min(100, Math.max(0, step * 12 - index * 10))
        return { ...job, progress, status: progress >= 100 ? 'complete' : progress > 0 ? 'working' : 'queued' }
      })
      onProgress(jobs)
    }

    return styles.map<GeneratedAsset>((style, index) => ({
      id: `asset-${Date.now()}-${index}`,
      styleId: style.id,
      imageUrl: style.resultImage,
    }))
  },
}

const mockAgentPrompt = (backgroundName: string, poseHint: string) => [
  '【模拟视觉分析】保留输入照片人物的五官、脸型与肤色身份特征。',
  `依据所选背景「${backgroundName}」复刻其人物动作：${poseHint}`,
  '将人物自然合成进背景，统一透视、光源方向、色温与接触阴影，消除贴纸感与白边。',
  '高质量完整画面，肢体结构正确，无重复人物、无文字、无水印。',
].join('\n')

export const mockAgentGenerationService: AgentGenerationService = {
  async generate(_sessionId, _entitlementToken, _generationId, _photo, background, onProgress) {
    let jobs: GenerationJob[] = [{ id: `agent-mock-${Date.now()}`, styleId: background.id, status: 'queued', progress: 0 }]
    onProgress(jobs)
    for (let step = 1; step <= 8; step += 1) {
      await wait(productConfig.generationTickMs)
      jobs = jobs.map((job) => {
        const progress = Math.min(100, step * 14)
        return { ...job, progress, status: progress >= 100 ? 'complete' : 'working' }
      })
      onProgress(jobs)
    }
    const prompt = mockAgentPrompt(background.name, background.poseHint)
    const assets: GeneratedAsset[] = [{ id: `agent-asset-${Date.now()}`, styleId: background.id, imageUrl: background.previewImage }]
    return { assets, prompt }
  },
}

export const mockBackgroundService: BackgroundService = {
  async list() {
    return []
  },
}

export const mockShareService: ShareService = {
  async create(_sessionId, _entitlementToken, assets) {
    await wait(300)
    const id = assets.map((asset) => asset.styleId).join('-') || 'result'
    return {
      url: `https://demo.shanjing.example/share/${id}`,
      expiresAt: new Date(Date.now() + productConfig.shareExpiryHours * 3600_000).toISOString(),
    }
  },
}

export const mockStyleService: StyleService = {
  async list() {
    return stylePresets
  },
}
