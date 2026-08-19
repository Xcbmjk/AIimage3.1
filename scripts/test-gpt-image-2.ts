import dotenv from 'dotenv'
import fs from 'node:fs/promises'
import path from 'node:path'
import { endpointUrl } from '../server/lib/urls'

dotenv.config({ path: path.resolve('.env.local') })
dotenv.config()

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const DEFAULT_PROMPT = '在保留人物身份特征、脸部结构、发型和姿态的前提下，把背景改成具有电影感的山间日落场景，保持竖幅构图和自然光影。'

type CliOptions = {
  input?: string
  output?: string
  prompt?: string
}

type ImageResult = {
  b64_json?: string
  url?: string
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--input') options.input = argv[++index]
    else if (argument === '--output') options.output = argv[++index]
    else if (argument === '--prompt') options.prompt = argv[++index]
    else if (argument === '--help' || argument === '-h') {
      console.log(`用法：npm run test:gpt-image-2 -- [选项]\n\n选项：\n  --input <路径>   输入图片；默认自动查找 test/ 或 src/test/ 下的第一张图片\n  --output <路径>  输出图片；默认写入 test/output/gpt-image-2-edited-<时间戳>.png\n  --prompt <文本>  修改指令；也可以使用 GPT_IMAGE_PROMPT 环境变量\n`)
      process.exit(0)
    }
  }
  return options
}

async function findInputImage(): Promise<string> {
  const roots = [path.resolve('test'), path.resolve('src/test')]
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      const image = entries
        .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .sort((left, right) => left.name.localeCompare(right.name))[0]
      if (image) return path.join(root, image.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error('没有找到测试图片，请通过 --input <图片路径> 指定图片')
}

function mimeTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return 'image/png'
}

function endpointUrl(baseUrl: string, endpoint: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(endpoint.replace(/^\/+/, ''), base).toString()
}

function decodeImage(value: string, fallbackMimeType = 'image/png'): { bytes: Buffer; mimeType: string } {
  if (value.startsWith('data:')) {
    const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(value)
    if (!match) throw new Error('上游返回了无法解析的 data URL')
    return { bytes: Buffer.from(match[2], 'base64'), mimeType: match[1] }
  }
  return { bytes: Buffer.from(value, 'base64'), mimeType: fallbackMimeType }
}

async function saveResult(result: ImageResult, outputPath: string, timeoutMs: number): Promise<void> {
  if (result.b64_json) {
    const image = decodeImage(result.b64_json)
    await fs.writeFile(outputPath, image.bytes)
    return
  }
  if (!result.url) throw new Error('上游响应中没有 data[0].b64_json 或 data[0].url')

  const response = await fetch(result.url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`下载上游图片失败：HTTP ${response.status}`)
  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const inputPath = path.resolve(options.input ?? process.env.GPT_IMAGE_INPUT ?? await findInputImage())
  const outputPath = path.resolve(options.output ?? process.env.GPT_IMAGE_OUTPUT ?? path.join('test', 'output', `gpt-image-2-edited-${Date.now()}.png`))
  const prompt = options.prompt ?? process.env.GPT_IMAGE_PROMPT ?? DEFAULT_PROMPT
  const baseUrl = process.env.GPT_IMAGE_BASE_URL
  const apiKey = process.env.GPT_IMAGE_API_KEY
  const model = process.env.GPT_IMAGE_MODEL ?? 'gpt-image-2'
  const endpoint = process.env.GPT_IMAGE_ENDPOINT ?? '/images/edits'
  const size = process.env.GPT_IMAGE_SIZE ?? '1024x1536'
  const responseFormat = process.env.GPT_IMAGE_RESPONSE_FORMAT ?? 'b64_json'
  const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 120_000)

  if (!baseUrl) throw new Error('缺少 GPT_IMAGE_BASE_URL，请先在 .env.local 中配置')
  if (!apiKey) throw new Error('缺少 GPT_IMAGE_API_KEY，请先在 .env.local 中配置')

  const inputBytes = await fs.readFile(inputPath)
  const mimeType = mimeTypeFor(inputPath)
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  form.append('image', new Blob([inputBytes], { type: mimeType }), path.basename(inputPath))
  form.append('size', size)
  if (responseFormat) form.append('response_format', responseFormat)

  console.log(`输入：${inputPath}`)
  console.log(`模型：${model}`)
  console.log(`请求：${endpointUrl(baseUrl, endpoint)}`)
  console.log(`指令：${prompt}`)

  const startedAt = performance.now()
  const response = await fetch(endpointUrl(baseUrl, endpoint), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`GPT Image 2 请求失败：HTTP ${response.status}\n${responseText}`)
  }

  let payload: { data?: ImageResult[] }
  try {
    payload = JSON.parse(responseText) as { data?: ImageResult[] }
  } catch {
    throw new Error(`上游返回不是合法 JSON：${responseText.slice(0, 500)}`)
  }

  const result = payload.data?.[0]
  if (!result) throw new Error('上游响应中没有 data[0]')
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await saveResult(result, outputPath, timeoutMs)
  const elapsedSeconds = (performance.now() - startedAt) / 1000
  console.log(`输出：${outputPath}`)
  console.log(`总耗时：${elapsedSeconds.toFixed(2)} 秒`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
