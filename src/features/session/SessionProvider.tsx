import { createContext, type Dispatch, type PropsWithChildren, useContext, useEffect, useMemo, useReducer } from 'react'
import type { KioskSession } from '../../types'
import { createInitialSession, sessionReducer, type SessionAction } from './sessionReducer'
import { loadPersistedSession, syncPersistedSession } from './sessionPersistence'

const SessionContext = createContext<{ state: KioskSession; dispatch: Dispatch<SessionAction> } | null>(null)

export function SessionProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(sessionReducer, undefined, () => {
    const initial = createInitialSession()
    const persisted = loadPersistedSession(window.localStorage)
    if (persisted) {
      // 仅恢复「生图尚未开始」的会话，让意外中断（WebView 崩溃/刷新）的游客继续；
      // 生成已开始或结束的快照不会被恢复，启动后落在首页。
      return { ...initial, ...persisted, stage: 'camera' as const }
    }
    return initial
  })

  // 会话快照只在「兑换后、生图前」保持；生成一旦开始权益即被消耗，
  // 快照随之清除，保证下一位游客重启后看到的是首页而不是拍照页。
  useEffect(() => {
    syncPersistedSession(window.localStorage, state)
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
