import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config'
import { ProviderError } from '../lib/errors'
import { analyzeAgentPrompt, composeFallbackPrompt, finalizeAgentPrompt, isVisionConfigured } from './analyze'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const baseInput = {
  backgroundBuffer: Buffer.from(png, 'base64'),
  backgroundMime: 'image/png',
  photoBuffer: Buffer.from(png, 'base64'),
  photoMime: 'image/png',
  backgroundName: '门前石阶',
  poseHint: '端坐姿态，身体正面朝向镜头。',
}

const visionConfig = loadConfig({ VISION_BASE_URL: 'https://vision.example/v1', VISION_API_KEY: 'vision-key', VISION_MODEL: 'vision-model' })

afterEach(() => vi.restoreAllMocks())

describe('vision agent prompt analyzer', () => {
  it('detects whether a real vision model is configured', () => {
    expect(isVisionConfigured(loadConfig({ AI_PROVIDER: 'mock' }))).toBe(false)
    expect(isVisionConfigured(visionConfig)).toBe(true)
  })

  it('builds a deterministic fallback prompt from the background pose hint', () => {
    const prompt = composeFallbackPrompt(baseInput.backgroundName, baseInput.poseHint)
    expect(prompt).toContain('门前石阶')
    expect(prompt).toContain('端坐姿态')
  })

  it('wraps the dynamic action with server-controlled identity, fusion and quality guardrails', () => {
    const prompt = finalizeAgentPrompt('复刻端坐动作，人物落位于台阶中央。')
    expect(prompt).toContain('以人物照片为唯一身份来源')
    expect(prompt).toContain('以背景图为唯一场景来源')
    expect(prompt).toContain('复刻端坐动作')
    expect(prompt).toContain('无重复人物')
  })

  it('sends background and portrait as two image parts and returns a sanitized prompt', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '```\n# 让 人物\n坐 姿 ，\n光 线 从 右 上 到 来\n```' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const dynamic = await analyzeAgentPrompt(visionConfig, baseInput)

    expect(dynamic).not.toContain('`')
    expect(dynamic).not.toContain('#')
    expect(dynamic.length).toBeGreaterThan(0)
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toMatchObject({ model: 'vision-model', modalities: ['text'], stream: false })
    const content = body.messages[0].content
    expect(content).toHaveLength(3)
    expect(content[1].image_url.url).toBe(`data:image/png;base64,${png}`)
    expect(content[2].image_url.url).toBe(`data:image/png;base64,${png}`)
    expect(content[0].text).toContain('视觉分析助手')
  })

  it('rejects unsupported image types before calling the vision model', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(analyzeAgentPrompt(visionConfig, { ...baseInput, photoMime: 'image/gif' })).rejects.toBeInstanceOf(ProviderError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails when the vision model returns no usable text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }))
    await expect(analyzeAgentPrompt(visionConfig, baseInput)).rejects.toMatchObject({ code: 'UPSTREAM_BAD_RESPONSE' })
  })

  it('classifies an upstream authentication failure without leaking the body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('secret upstream body', { status: 403 }))
    await expect(analyzeAgentPrompt(visionConfig, baseInput)).rejects.toMatchObject({ code: 'UPSTREAM_AUTH' })
  })
})
