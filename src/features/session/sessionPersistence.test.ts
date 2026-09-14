import { describe, expect, it } from 'vitest'
import type { Entitlement, KioskSession, KioskStage } from '../../types'
import { createInitialSession } from './sessionReducer'
import {
  SESSION_STORAGE_KEY,
  loadPersistedSession,
  syncPersistedSession,
} from './sessionPersistence'

const entitlement: Entitlement = {
  code: 'HX-001',
  status: 'used',
  maxStyles: 4,
  expiresAt: '2026-09-15T00:00:00.000Z',
}

function sessionAt(stage: KioskStage): KioskSession {
  return {
    ...createInitialSession(),
    entitlement,
    entitlementToken: 'token-1',
    stage,
  }
}

describe('sessionPersistence', () => {
  it('keeps the snapshot only while generation has not started', () => {
    for (const stage of ['camera', 'review', 'mode', 'styles', 'backgrounds'] as const) {
      syncPersistedSession(window.localStorage, sessionAt(stage))
      expect(window.localStorage.getItem(SESSION_STORAGE_KEY), stage).not.toBeNull()
    }
  })

  it('drops the snapshot once generation starts or the session resets', () => {
    for (const stage of ['generating', 'results', 'download', 'welcome', 'redeem'] as const) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, '"stale"')
      syncPersistedSession(window.localStorage, sessionAt(stage))
      expect(window.localStorage.getItem(SESSION_STORAGE_KEY), stage).toBeNull()
    }
  })

  it('restores a pre-generation snapshot', () => {
    const session = sessionAt('review')
    syncPersistedSession(window.localStorage, session)
    expect(loadPersistedSession(window.localStorage)).toEqual({
      id: session.id,
      entitlement,
      entitlementToken: 'token-1',
    })
  })

  it('ignores legacy snapshots written without a stage field', () => {
    // 旧版本 APK 只写 entitlement/token,无法判断权益是否已被生成消耗,
    // 恢复它会让设备永远跳过首页落回拍照页 —— 必须当作不可信丢弃。
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ id: 'legacy-id', entitlement, entitlementToken: 'legacy-token' }),
    )
    expect(loadPersistedSession(window.localStorage)).toBeNull()
  })

  it('ignores snapshots whose stage is a generation-or-later stage', () => {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        id: 'x',
        entitlement,
        entitlementToken: 't',
        stage: 'download',
      }),
    )
    expect(loadPersistedSession(window.localStorage)).toBeNull()
  })
})
