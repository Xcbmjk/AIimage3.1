import { createContext, type Dispatch, type PropsWithChildren, useContext, useEffect, useMemo, useReducer } from 'react'
import type { KioskSession } from '../../types'
import { createInitialSession, sessionReducer, type SessionAction } from './sessionReducer'

const SessionContext = createContext<{ state: KioskSession; dispatch: Dispatch<SessionAction> } | null>(null)

const SESSION_STORAGE_KEY = 'kiosk_session'

function loadPersistedSession(): Partial<KioskSession> | null {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!stored) return null
    const parsed = JSON.parse(stored)
    // 只恢复关键字段：entitlement, entitlementToken, id
    if (parsed.entitlement && parsed.entitlementToken && parsed.id) {
      return {
        id: parsed.id,
        entitlement: parsed.entitlement,
        entitlementToken: parsed.entitlementToken,
      }
    }
    return null
  } catch {
    return null
  }
}

function persistSession(session: KioskSession) {
  try {
    // 只保存关键字段
    const toSave = {
      id: session.id,
      entitlement: session.entitlement,
      entitlementToken: session.entitlementToken,
    }
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(toSave))
  } catch {
    // 忽略存储错误
  }
}

export function SessionProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(sessionReducer, undefined, () => {
    const initial = createInitialSession()
    const persisted = loadPersistedSession()
    if (persisted && persisted.entitlement && persisted.entitlementToken) {
      // 恢复到相机页面
      return { ...initial, ...persisted, stage: 'camera' as const }
    }
    return initial
  })

  // 持久化 entitlement 和 token
  useEffect(() => {
    if (state.entitlement && state.entitlementToken) {
      persistSession(state)
    } else if (state.stage === 'welcome') {
      // 用户重置或回到欢迎页，清除持久化
      localStorage.removeItem(SESSION_STORAGE_KEY)
    }
  }, [state])

  const value = useMemo(() => ({ state, dispatch }), [state])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

// Session state and the provider intentionally share this module.
// eslint-disable-next-line react-refresh/only-export-components
export function useSession() {
  const context = useContext(SessionContext)
  if (!context) throw new Error('useSession must be used within SessionProvider')
  return context
}

