import path from 'node:path'

export type ServerConfig = {
  provider: 'mock' | 'gpt-image-2' | 'seedream' | 'jimeng-i2i'
  port: number
  timeoutMs: number
  maxInputBytes: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logFile: string
  logRetentionDays: number
  shareDirectory: string
  shareExpiryHours: number
  gpt: { baseUrl: string; apiKey: string; model: string; endpoint: string; size: string; responseFormat: string }
  seedream: { baseUrl: string; apiKey: string; model: string; endpoint: string; size: string; responseFormat: string; watermark: boolean }
  jimeng: { baseUrl: string; accessKeyId: string; secretAccessKey: string; reqKey: string; scale: number; width: number; height: number; pollIntervalMs: number; pollTimeoutMs: number }
  payment: {
    mode: 'mock' | 'wechat-native'
    amountFen: number
    description: string
    orderFile: string
    publicBaseUrl: string
    appId: string
    mchId: string
    certificateSerial: string
    privateKeyPath: string
    apiV3Key: string
    wechatPayPublicKeyId: string
    wechatPayPublicKeyPath: string
  }
}

const required = (value: string | undefined, name: string) => {
  if (!value) throw new Error(`${name} is required when the selected AI_PROVIDER is active`)
  return value
}

const bool = (value: string | undefined, fallback: boolean) => value === undefined ? fallback : value.toLowerCase() === 'true'

export function loadConfig(env = process.env): ServerConfig {
  const provider = (env.AI_PROVIDER ?? 'mock') as ServerConfig['provider']
  if (!['mock', 'gpt-image-2', 'seedream', 'jimeng-i2i'].includes(provider)) throw new Error('AI_PROVIDER must be mock, gpt-image-2, seedream, or jimeng-i2i')
  const paymentMode = (env.PAYMENT_MODE ?? 'mock') as ServerConfig['payment']['mode']
  if (!['mock', 'wechat-native'].includes(paymentMode)) throw new Error('PAYMENT_MODE must be mock or wechat-native')
  const amountFen = Number(env.PAYMENT_AMOUNT_FEN ?? 990)
  if (!Number.isInteger(amountFen) || amountFen < 1) throw new Error('PAYMENT_AMOUNT_FEN must be a positive integer')
  const config: ServerConfig = {
    provider,
    port: Number(env.API_PORT ?? 8787),
    timeoutMs: Number(env.AI_REQUEST_TIMEOUT_MS ?? 120_000),
    maxInputBytes: Number(env.AI_MAX_INPUT_BYTES ?? 10 * 1024 * 1024),
    logLevel: (env.LOG_LEVEL ?? 'info') as ServerConfig['logLevel'],
    logFile: env.LOG_FILE ?? 'logs/generation.log',
    logRetentionDays: Number(env.LOG_RETENTION_DAYS ?? 14),
    shareDirectory: env.SHARE_DIRECTORY ?? 'data/shares',
    shareExpiryHours: Number(env.SHARE_EXPIRY_HOURS ?? 24),
    gpt: {
      baseUrl: env.GPT_IMAGE_BASE_URL ?? '',
      apiKey: env.GPT_IMAGE_API_KEY ?? '',
      model: env.GPT_IMAGE_MODEL ?? 'gpt-image-2',
      endpoint: env.GPT_IMAGE_ENDPOINT ?? '/images/edits',
      size: env.GPT_IMAGE_SIZE ?? '1024x1536',
      responseFormat: env.GPT_IMAGE_RESPONSE_FORMAT ?? 'b64_json',
    },
    seedream: {
      baseUrl: env.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: env.ARK_API_KEY ?? '',
      model: env.ARK_SEEDREAM_MODEL ?? '',
      endpoint: env.ARK_IMAGE_ENDPOINT ?? '/images/generations',
      size: env.ARK_IMAGE_SIZE ?? '1024x1536',
      responseFormat: env.ARK_RESPONSE_FORMAT ?? 'b64_json',
      watermark: bool(env.ARK_WATERMARK, false),
    },
    jimeng: {
      baseUrl: env.JIMENG_BASE_URL ?? 'https://visual.volcengineapi.com',
      accessKeyId: env.VOLC_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.VOLC_SECRET_ACCESS_KEY ?? '',
      reqKey: env.JIMENG_REQ_KEY ?? 'jimeng_i2i_v30',
      scale: Number(env.JIMENG_SCALE ?? 0.5),
      width: Number(env.JIMENG_WIDTH ?? 1024),
      height: Number(env.JIMENG_HEIGHT ?? 1536),
      pollIntervalMs: Number(env.JIMENG_POLL_INTERVAL_MS ?? 2000),
      pollTimeoutMs: Number(env.JIMENG_POLL_TIMEOUT_MS ?? 300000),
    },
    payment: {
      mode: paymentMode,
      amountFen,
      description: env.PAYMENT_DESCRIPTION ?? '山境造像 AI 旅拍体验',
      orderFile: env.PAYMENT_ORDER_FILE ?? 'data/payment-orders.json',
      publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${env.API_PORT ?? 8787}`).replace(/\/$/, ''),
      appId: env.WECHAT_PAY_APP_ID ?? '',
      mchId: env.WECHAT_PAY_MCH_ID ?? '',
      certificateSerial: env.WECHAT_PAY_CERT_SERIAL ?? '',
      privateKeyPath: env.WECHAT_PAY_PRIVATE_KEY_PATH ?? '',
      apiV3Key: env.WECHAT_PAY_API_V3_KEY ?? '',
      wechatPayPublicKeyId: env.WECHAT_PAY_PUBLIC_KEY_ID ?? '',
      wechatPayPublicKeyPath: env.WECHAT_PAY_PUBLIC_KEY_PATH ?? '',
    },
  }
  if (provider === 'gpt-image-2') {
    required(config.gpt.baseUrl, 'GPT_IMAGE_BASE_URL')
    required(config.gpt.apiKey, 'GPT_IMAGE_API_KEY')
  }
  if (provider === 'seedream') {
    required(config.seedream.apiKey, 'ARK_API_KEY')
    required(config.seedream.model, 'ARK_SEEDREAM_MODEL')
  }
  if (provider === 'jimeng-i2i') {
    required(config.jimeng.accessKeyId, 'VOLC_ACCESS_KEY_ID')
    required(config.jimeng.secretAccessKey, 'VOLC_SECRET_ACCESS_KEY')
    if (config.jimeng.scale < 0 || config.jimeng.scale > 1) throw new Error('JIMENG_SCALE must be between 0 and 1')
  }
  if (paymentMode === 'wechat-native') {
    required(config.payment.publicBaseUrl, 'PUBLIC_BASE_URL')
    required(config.payment.appId, 'WECHAT_PAY_APP_ID')
    required(config.payment.mchId, 'WECHAT_PAY_MCH_ID')
    required(config.payment.certificateSerial, 'WECHAT_PAY_CERT_SERIAL')
    required(config.payment.privateKeyPath, 'WECHAT_PAY_PRIVATE_KEY_PATH')
    required(config.payment.apiV3Key, 'WECHAT_PAY_API_V3_KEY')
    required(config.payment.wechatPayPublicKeyId, 'WECHAT_PAY_PUBLIC_KEY_ID')
    required(config.payment.wechatPayPublicKeyPath, 'WECHAT_PAY_PUBLIC_KEY_PATH')
    if (Buffer.byteLength(config.payment.apiV3Key, 'utf8') !== 32) throw new Error('WECHAT_PAY_API_V3_KEY must be exactly 32 bytes')
    if (!config.payment.publicBaseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must use HTTPS for wechat-native payment')
  }
  return config
}

export const distPath = path.resolve(process.cwd(), 'dist')
