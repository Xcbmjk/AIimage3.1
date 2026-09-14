import type { Entitlement, KioskSession, KioskStage } from '../../types'

export const SESSION_STORAGE_KEY = 'kiosk_session'

// 生图尚未开始的阶段。权益（entitlement）在生成请求发出后即被消耗，快照只有
// 取自这些阶段才值得恢复；从生成开始之后的快照恢复到拍照页，只会让下一位
// 游客走完整个流程后在最后一步生成失败。
const PRE_GENERATION_STAGES = new Set<KioskStage>([
  'camera',
  'review',
  'mode',
  'styles',
  'backgrounds',
])

export interface PersistedSession {
  id: string
  entitlement: Entitlement
  entitlementToken: string
}

export function loadPersistedSession(storage: Storage): PersistedSession | null {
  try {
    const stored = storage.getItem(SESSION_STORAGE_KEY)
    if (!stored) return null
    const parsed = JSON.parse(stored) as Partial<KioskSession> & { stage?: unknown }
    if (
      parsed.entitlement &&
      parsed.entitlementToken &&
      parsed.id &&
      typeof parsed.stage === 'string' &&
      PRE_GENERATION_STAGES.has(parsed.stage as KioskStage)
    ) {
      return {
        id: parsed.id,
        entitlement: parsed.entitlement,
        entitlementToken: parsed.entitlementToken,
      }
    }
    // 旧版本写入的快照没有 stage 字段（无法判断生图是否已消耗权益），一律丢弃。
    return null
  } catch {
    return null
  }
}

export function syncPersistedSession(storage: Storage, session: KioskSession): void {
  try {
    const restorable = Boolean(
      session.entitlement &&
        session.entitlementToken &&
        PRE_GENERATION_STAGES.has(session.stage),
    )
    if (restorable) {
      storage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          id: session.id,
          entitlement: session.entitlement,
          entitlementToken: session.entitlementToken,
          stage: session.stage,
        }),
      )
    } else {
      // 生成已开始/结束，或已回到欢迎页：权益无法再服务下一位游客，
      // 必须清掉快照，保证重启后回到首页而不是拍照页。
      storage.removeItem(SESSION_STORAGE_KEY)
    }
  } catch {
    // 存储不可用时静默：会话恢复是体验增强，不能阻断主流程。
  }
}
