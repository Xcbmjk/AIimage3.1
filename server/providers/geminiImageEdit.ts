import crypto from 'node:crypto'
import type { GeneratedAsset, StylePreset } from '../../src/types'
import type { ServerConfig } from '../config'
import { ProviderError, mapProviderError } from '../lib/errors'
import { validateImageBuffer } from '../lib/images'
import { endpointUrl } from '../lib/urls'
import type { AgentComposeInput, ImageProvider } from './types'

type GeminiChatResponse = {
  model?: string
  choices?: Array<{
    message?: { content?: string }
    finish_reason?: string
  }>
  error?: { type?: string; code?: string }
}

const OUTPUT_DATA_URL = /data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)/
const MAX_OUTPUT_BYTES = 15 * 1024 * 1024
const MAX_RESPONSE_BYTES = Math.ceil(MAX_OUTPUT_BYTES * 4 / 3) + 1024 * 1024

export function extractGeminiEditedImage(content: unknown): { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; buffer: Buffer } {
  if (typeof content !== 'string') throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'Gemini Edit 没有返回图片', false)
  const match = OUTPUT_DATA_URL.exec(content)
  if (!match) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'Gemini Edit 返回格式不支持', false)
  if (match[2].length > Math.ceil(MAX_OUTPUT_BYTES * 4 / 3) + 4) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'Gemini Edit 返回图片过大', false)
  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1] as 'image/jpeg' | 'image/png' | 'image/webp'
  const buffer = Buffer.from(match[2], 'base64')
  validateImageBuffer(buffer, mimeType, MAX_OUTPUT_BYTES)
  return { mimeType, buffer }
}

async function readResponseText(response: Response) {
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_RESPONSE_BYTES) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'Gemini Edit 返回内容过大', false, { provider: 'gemini-3.1-flash-image', upstreamStatus: response.status })
  if (!response.body) return ''
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > MAX_RESPONSE_BYTES) throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'Gemini Edit 返回内容过大', false, { provider: 'gemini-3.1-flash-image', upstreamStatus: response.status })
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function editPrompt(style: StylePreset) {
  return [
    '编辑这张上传的原图。这是图片编辑，不是重新设计构图。',
    '保留同一个人物及其身份特征、面部表情、姿势、身体比例、原始裁剪、镜头角度、服装、背景和物体位置。',
    '不要新增、删除或移动物体，不要发明、替换或改写图片中的文字。只改变视觉渲染方式。',
    style.prompt,
    '只返回编辑后的图片。',
  ].join('\n')
}

function safeUpstreamReason(payload: GeminiChatResponse) {
  const type = payload.error?.type?.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80)
  const code = payload.error?.code?.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80)
  return [type, code].filter(Boolean).join(':') || undefined
}

async function runChatEdit(config: ServerConfig, content: Array<{ type: string; text?: string; image_url?: { url: string } }>): Promise<{ mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; buffer: Buffer }> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(endpointUrl(config.gemini.baseUrl, config.gemini.endpoint), {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.gemini.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.gemini.model,
          messages: [{ role: 'user', content }],
          modalities: ['text', 'image'],
          stream: false,
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      })

      const rawBody = await readResponseText(response)
      let payload: GeminiChatResponse
      try { payload = JSON.parse(rawBody) as GeminiChatResponse }
      catch {
        if (!response.ok) throw mapProviderError(response.status, 'gemini-3.1-flash-image')
        throw new ProviderError('UPSTREAM_BAD_RESPONSE', 'Gemini Edit 返回了无效响应', false, { provider: 'gemini-3.1-flash-image', upstreamStatus: response.status })
      }
      if (!response.ok) throw mapProviderError(response.status, 'gemini-3.1-flash-image', safeUpstreamReason(payload))

      return extractGeminiEditedImage(payload.choices?.[0]?.message?.content)
    } catch (error) {
      const retryable = error instanceof TypeError
        || error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        || error instanceof ProviderError && error.retryable
      if (!retryable || attempt === 2) throw error
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new ProviderError('GENERATION_FAILED', 'Gemini Edit 修图失败', true)
}

function composeInstruction(prompt: string) {
  return [
    '你将看到两张图：第一张是目标背景（含预设人物动作），第二张是游客照片。',
    '把游客照片中的人物合成进第一张背景，替换背景里原本的人物，并复刻其动作、机位与构图。',
    '以背景为唯一场景，保持背景的建筑、地形与光影；只从游客照片取人物身份与外形。',
    prompt,
    '只返回合成后的图片。',
  ].join('\n')
}

export function createGeminiImageEditProvider(config: ServerConfig): ImageProvider {
  return {
    name: 'gemini-3.1-flash-image',
    async generate(photo, mimeType, style): Promise<GeneratedAsset> {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new ProviderError('INVALID_INPUT', 'Gemini Edit 仅支持 JPEG、PNG 或 WebP 照片', false)
      const output = await runChatEdit(config, [
        { type: 'text', text: editPrompt(style) },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${photo.toString('base64')}` } },
      ])
      return { id: `gemini-edit-${style.id}-${crypto.randomUUID()}`, styleId: style.id, imageUrl: `data:${output.mimeType};base64,${output.buffer.toString('base64')}` }
    },
    async compose(input: AgentComposeInput): Promise<GeneratedAsset> {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(input.backgroundMime) || !['image/jpeg', 'image/png', 'image/webp'].includes(input.photoMime)) {
        throw new ProviderError('INVALID_INPUT', 'Agent 合成仅支持 JPEG、PNG 或 WebP 图片', false)
      }
      const output = await runChatEdit(config, [
        { type: 'text', text: composeInstruction(input.prompt) },
        { type: 'image_url', image_url: { url: `data:${input.backgroundMime};base64,${input.background.toString('base64')}` } },
        { type: 'image_url', image_url: { url: `data:${input.photoMime};base64,${input.photo.toString('base64')}` } },
      ])
      return { id: `gemini-agent-${input.backgroundId}-${crypto.randomUUID()}`, styleId: input.backgroundId, imageUrl: `data:${output.mimeType};base64,${output.buffer.toString('base64')}` }
    },
  }
}
