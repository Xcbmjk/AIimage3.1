import fs from 'node:fs/promises'
import path from 'node:path'
import { agentGenerationEnabled, type ServerConfig } from '../config'
import type { Database } from '../db/mysql'

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'disabled'
export type HealthCheck = { status: HealthStatus; latencyMs?: number; message?: string; details?: Record<string, unknown> }

const timeout = async <T>(promise: Promise<T>, milliseconds: number) => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('HEALTH_CHECK_TIMEOUT')), milliseconds) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const timed = async (work: () => Promise<HealthCheck>): Promise<HealthCheck> => {
  const startedAt = Date.now()
  try { return { ...(await work()), latencyMs: Date.now() - startedAt } }
  catch (error) { return { status: 'down', latencyMs: Date.now() - startedAt, message: error instanceof Error ? error.message : '检查失败' } }
}

async function checkDirectory(directory: string): Promise<HealthCheck> {
  await fs.mkdir(directory, { recursive: true })
  await fs.access(directory, fs.constants.W_OK)
  return { status: 'ok', details: { path: path.relative(process.cwd(), directory) || '.' } }
}

function collectAgentVisionCheck(config: ServerConfig): HealthCheck {
  const setCount = [config.vision.baseUrl, config.vision.apiKey, config.vision.model].filter(Boolean).length
  if (agentGenerationEnabled(config)) {
    return { status: 'ok', message: 'Agent 智能生图已启用', details: { provider: config.provider } }
  }
  if (setCount > 0) {
    return { status: 'degraded', message: 'VISION_* 配置不完整（需要 VISION_BASE_URL、VISION_API_KEY、VISION_MODEL），Agent 模式已禁用', details: { provider: config.provider, configured: setCount } }
  }
  if (config.provider === 'mock') {
    return { status: 'disabled', message: 'Agent 模式使用 mock 回退提示词', details: { provider: config.provider } }
  }
  return { status: 'disabled', message: '未配置 VISION_*，Agent 模式已禁用', details: { provider: config.provider } }
}

export async function collectHealth(config: ServerConfig, database: Database | null): Promise<{ ok: boolean; status: HealthStatus; checks: Record<string, HealthCheck>; timestamp: string }> {
  const mysql = !config.database.enabled
    ? { status: 'disabled' as const, message: 'MYSQL_ENABLED=false' }
    : await timed(async () => {
      if (!database) return { status: 'down' as const, message: '数据库连接池未初始化' }
      await timeout(database.pool.query('SELECT 1 AS ok'), 1500)
      return { status: 'ok' as const, message: '连接正常', details: { database: config.database.name } }
    })
  if (mysql.status === 'down') {
    mysql.message = '数据库连接失败'
    mysql.details = { ...(mysql.details ?? {}), code: 'MYSQL_UNAVAILABLE' }
  }
  const storage = await timed(async () => {
    const [asset, share, data] = await Promise.all([
      checkDirectory(path.resolve(process.cwd(), 'data/assets')),
      checkDirectory(path.resolve(process.cwd(), config.shareDirectory)),
      checkDirectory(path.resolve(process.cwd(), 'data')),
    ])
    const statuses = [asset.status, share.status, data.status]
    return { status: statuses.every((value) => value === 'ok') ? 'ok' as const : 'degraded' as const, details: { assets: asset.status, shares: share.status, data: data.status } }
  })
  const checks: Record<string, HealthCheck> = {
    api: { status: 'ok', message: 'HTTP 服务正常' },
    mysql,
    storage,
    aiProvider: { status: 'ok', message: '供应商配置已加载', details: { provider: config.provider, mode: 'configured' } },
    agentVision: collectAgentVisionCheck(config),
    payment: { status: 'ok', message: '支付配置已加载', details: { mode: config.payment.mode } },
    queue: { status: database && mysql.status === 'ok' ? 'ok' : 'degraded', message: database && mysql.status === 'ok' ? '持久化队列已连接' : database ? '数据库不可用，队列暂停' : '使用 JSON 回退存储' },
  }
  const blocking = Object.values(checks).some((check) => check.status === 'down')
  const degraded = Object.values(checks).some((check) => check.status === 'degraded')
  return { ok: !blocking, status: blocking ? 'down' : degraded ? 'degraded' : 'ok', checks, timestamp: new Date().toISOString() }
}
