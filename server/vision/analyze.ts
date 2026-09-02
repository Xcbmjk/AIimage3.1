import type { ServerConfig } from '../config'
import { ProviderError, mapProviderError } from '../lib/errors'
import { endpointUrl } from '../lib/urls'

type VisionChatResponse = {
  choices?: Array<{ message?: { content?: unknown } }>
  error?: { type?: string; code?: string }
}

export type VisionInput = {
  backgroundBuffer: Buffer
  backgroundMime: string
  photoBuffer: Buffer
  photoMime: string
  backgroundName: string
  poseHint: string
}

const MAX_PROMPT_CHARS = 1400
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp']

const visionInstruction = (backgroundName: string, poseHint: string) => [
  '你是 AI 旅拍的视觉分析助手。你将看到两张图：第一张是目标背景（含预设人物动作），第二张是刚刚拍摄的游客照片。',
  `本次背景主题：${backgroundName}。参考动作提示：${poseHint}。`,
  '请只输出一段可直接用于图像编辑模型的中文融合指令，描述如何把游客照片中的人物自然地放入背景中并复刻背景里人物的动作。',
  '指令需覆盖：人物的肢体动作与朝向、在画面中的落位、与背景一致的透视/机位、光源方向与色温、接触阴影与景深融合。',
  '不要输出身份保持、质量约束、水印说明等固定套话（由系统另行拼接）；不要使用 JSON、Markdown、列表符号或引号包裹。',
  '严格控制在 220 个汉字以内，只输出指令正文。',
].join('\n')

const backgroundInstruction = (backgroundName: string, poseHint: string) => [
  '你是 AI 旅拍的背景视觉理解助手。你将看到一张由管理员上传的旅拍背景参考图。',
  `本次背景主题：${backgroundName}。管理员补充动作提示：${poseHint}。`,
  '请只输出一段可直接用于图像编辑模型的中文融合指令，描述如何把游客照片中的人物放入这张背景，并替换背景中原有的人物。',
  '指令需覆盖：背景中人物的肢体动作与朝向、人物在画面中的落位、透视/机位、光源方向与色温、接触阴影与景深融合。',
  '不要输出 JSON、Markdown、列表符号或引号包裹，严格控制在 220 个汉字以内，只输出指令正文。',
].join('\n')

function safeContent(response: VisionChatResponse): string {
  const content = response.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') return (part as { text: string }).text
        return ''
      })
      .join('')
  }
  return ''
}

function sanitizeDynamicPrompt(raw: string): string {
  const cleaned = raw
    .replace(/```/g, ' ')
    .replace(/[#*_>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 380)
}

export function composeFallbackPrompt(backgroundName: string, poseHint: string): string {
  return `复刻背景「${backgroundName}」中人物的动作与机位：${poseHint}将照片中的人物自然置于该背景里，匹配背景的透视、机位、光源方向、色温、接触阴影与景深。`
}

export function finalizeAgentPrompt(dynamic: string): string {
  const identity = '以人物照片为唯一身份来源，严格保留五官、脸型、肤色、年龄感与发型；画面中只保留一位主要人物，不得出现第二主角。'
  const action = dynamic.trim() || '参照背景预设动作自然复刻人物的姿态与朝向。'
  const fusion = '以背景图为唯一场景来源，保留背景的建筑、地形、构图与机位；把人物真实地合成进背景，统一透视、焦距、景深、光源方向、色温、接触阴影与空气透视，彻底清除背景中原本的人物，禁止贴纸感、白边和悬浮感。'
  const quality = '高质量完整画面，脸部清晰，双手与肢体结构正确，无重复人物、无多余肢体、无文字、无标志、无水印。'
  return [identity, action, fusion, quality].join('\n').slice(0, MAX_PROMPT_CHARS)
}

export function isVisionConfigured(config: ServerConfig): boolean {
  return Boolean(config.vision.apiKey && config.vision.baseUrl && config.vision.model)
}

async function readVisionText(response: Response): Promise<string> {
  if (!response.body) return ''
  const chunks: Buffer[] = []
  let total = 0
  const maxBytes = 512 * 1024
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > maxBytes) throw new ProviderError('UPSTREAM_BAD_RESPONSE', '视觉模型返回内容过大', false, { provider: 'vision' })
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function analyzeAgentPrompt(config: ServerConfig, input: VisionInput): Promise<string> {
  if (!ALLOWED_IMAGE_MIME.includes(input.backgroundMime) || !ALLOWED_IMAGE_MIME.includes(input.photoMime)) {
    throw new ProviderError('INVALID_INPUT', 'Agent 分析仅支持 JPEG、PNG 或 WebP 图片', false)
  }
  let payload: VisionChatResponse
  try {
    const response = await fetch(endpointUrl(config.vision.baseUrl, config.vision.endpoint), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.vision.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.vision.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: visionInstruction(input.backgroundName, input.poseHint) },
            { type: 'image_url', image_url: { url: `data:${input.backgroundMime};base64,${input.backgroundBuffer.toString('base64')}` } },
            { type: 'image_url', image_url: { url: `data:${input.photoMime};base64,${input.photoBuffer.toString('base64')}` } },
          ],
        }],
        modalities: ['text'],
        stream: false,
      }),
      signal: AbortSignal.timeout(config.vision.timeoutMs),
    })
    const raw = await readVisionText(response)
    try { payload = JSON.parse(raw) as VisionChatResponse }
    catch {
      if (!response.ok) throw mapProviderError(response.status, 'vision')
      throw new ProviderError('UPSTREAM_BAD_RESPONSE', '视觉模型返回了无效响应', false, { provider: 'vision', upstreamStatus: response.status })
    }
    if (!response.ok) {
      const reason = [payload.error?.type, payload.error?.code].filter(Boolean).join(':') || undefined
      throw mapProviderError(response.status, 'vision', reason)
    }
  } catch (error) {
    const retryable = error instanceof TypeError
      || error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
      || error instanceof ProviderError && error.retryable
    throw error instanceof ProviderError && !retryable ? error : new ProviderError('GENERATION_FAILED', '视觉分析失败，请重试或改用经典风格', true, error instanceof ProviderError ? error.details : { provider: 'vision' })
  }

  const dynamic = sanitizeDynamicPrompt(safeContent(payload))
  if (!dynamic) throw new ProviderError('UPSTREAM_BAD_RESPONSE', '视觉模型没有返回可用的分析结果', false, { provider: 'vision' })
  return dynamic
}

export async function analyzeBackgroundPrompt(config: ServerConfig, input: Omit<VisionInput, 'photoBuffer' | 'photoMime'>): Promise<string> {
  if (!ALLOWED_IMAGE_MIME.includes(input.backgroundMime)) throw new ProviderError('INVALID_INPUT', '背景分析仅支持 JPEG、PNG 或 WebP 图片', false)
  try {
    const response = await fetch(endpointUrl(config.vision.baseUrl, config.vision.endpoint), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.vision.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.vision.model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: backgroundInstruction(input.backgroundName, input.poseHint) },
          { type: 'image_url', image_url: { url: `data:${input.backgroundMime};base64,${input.backgroundBuffer.toString('base64')}` } },
        ] }],
        modalities: ['text'],
        stream: false,
      }),
      signal: AbortSignal.timeout(config.vision.timeoutMs),
    })
    const raw = await readVisionText(response)
    let payload: VisionChatResponse
    try { payload = JSON.parse(raw) as VisionChatResponse }
    catch { throw mapProviderError(response.status, 'vision') }
    if (!response.ok) throw mapProviderError(response.status, 'vision')
    const dynamic = sanitizeDynamicPrompt(safeContent(payload))
    if (!dynamic) throw new ProviderError('UPSTREAM_BAD_RESPONSE', '视觉模型没有返回可用的背景分析结果', false, { provider: 'vision' })
    return dynamic
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError('GENERATION_FAILED', '背景视觉理解失败，请重试', true, { provider: 'vision' })
  }
}
