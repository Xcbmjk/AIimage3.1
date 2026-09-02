import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config'
import { ProviderError } from '../lib/errors'
import { createGeminiImageEditProvider, extractGeminiEditedImage } from './geminiImageEdit'
import type { StylePreset } from '../../src/types'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const style: StylePreset = {
  id: 'ink',
  name: '水墨',
  subtitle: '',
  description: '',
  prompt: '转换成水墨画风。',
  palette: ['#000000', '#777777', '#ffffff'],
  motif: '',
  resultImage: '',
  mode: 'artistic',
}

afterEach(() => vi.restoreAllMocks())

describe('Gemini image edit provider', () => {
  it('extracts and validates a Markdown image data URI', () => {
    const result = extractGeminiEditedImage(`![image](data:image/png;base64,${png})`)
    expect(result.mimeType).toBe('image/png')
    expect(result.buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  })

  it('rejects responses without a supported image', () => {
    expect(() => extractGeminiEditedImage('生成完成')).toThrowError(ProviderError)
  })

  it('sends the source image through the edit chat protocol', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      model: 'gemini-3.1-flash-image',
      choices: [{ message: { content: `![image](data:image/png;base64,${png})` }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const config = loadConfig({ AI_PROVIDER: 'gemini-3.1-flash-image', GEMINI_IMAGE_API_KEY: 'test-key', AI_REQUEST_TIMEOUT_MS: '1000' })
    const provider = createGeminiImageEditProvider(config)

    const asset = await provider.generate(Buffer.from(png, 'base64'), 'image/png', style)

    expect(asset.styleId).toBe('ink')
    expect(asset.imageUrl).toBe(`data:image/png;base64,${png}`)
    const request = fetchMock.mock.calls[0][1]
    const body = JSON.parse(String(request?.body))
    expect(body).toMatchObject({ model: 'gemini-3.1-flash-image', modalities: ['text', 'image'], stream: false })
    expect(body.messages[0].content[0].text).toContain('这是图片编辑，不是重新设计构图')
    expect(body.messages[0].content[1].image_url.url).toBe(`data:image/png;base64,${png}`)
  })

  it('classifies a non-JSON authentication response without exposing its body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('secret upstream response', { status: 401 }))
    const config = loadConfig({ AI_PROVIDER: 'gemini-3.1-flash-image', GEMINI_IMAGE_API_KEY: 'test-key', AI_REQUEST_TIMEOUT_MS: '1000' })
    const provider = createGeminiImageEditProvider(config)

    await expect(provider.generate(Buffer.from(png, 'base64'), 'image/png', style)).rejects.toMatchObject({
      code: 'UPSTREAM_AUTH',
      details: { provider: 'gemini-3.1-flash-image', upstreamStatus: 401, reason: undefined },
    })
  })

  it('composes background and portrait into one edit request keyed to the background', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      model: 'gemini-3.1-flash-image',
      choices: [{ message: { content: `![image](data:image/png;base64,${png})` }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const config = loadConfig({ AI_PROVIDER: 'gemini-3.1-flash-image', GEMINI_IMAGE_API_KEY: 'test-key', AI_REQUEST_TIMEOUT_MS: '1000' })
    const provider = createGeminiImageEditProvider(config)

    const asset = await provider.compose!({
      background: Buffer.from(png, 'base64'),
      backgroundMime: 'image/png',
      photo: Buffer.from(png, 'base64'),
      photoMime: 'image/png',
      prompt: '将人物合成进背景并复刻动作。',
      backgroundId: 'gate-steps',
    })

    expect(asset.styleId).toBe('gate-steps')
    expect(asset.imageUrl).toBe(`data:image/png;base64,${png}`)
    const content = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[0].content
    expect(content).toHaveLength(3)
    expect(content[1].image_url.url).toBe(`data:image/png;base64,${png}`)
    expect(content[2].image_url.url).toBe(`data:image/png;base64,${png}`)
    expect(content[0].text).toContain('第一张是目标背景')
  })

  it('rejects unsupported background mime types before composing', async () => {
    const config = loadConfig({ AI_PROVIDER: 'gemini-3.1-flash-image', GEMINI_IMAGE_API_KEY: 'test-key', AI_REQUEST_TIMEOUT_MS: '1000' })
    const provider = createGeminiImageEditProvider(config)
    await expect(provider.compose!({
      background: Buffer.from(png, 'base64'),
      backgroundMime: 'image/gif',
      photo: Buffer.from(png, 'base64'),
      photoMime: 'image/png',
      prompt: 'x',
      backgroundId: 'gate-steps',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
