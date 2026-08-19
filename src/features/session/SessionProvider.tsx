import { createContext, type Dispatch, type PropsWithChildren, useContext, useMemo, useReducer } from 'react'
import type { KioskSession } from '../../types'
import { createInitialSession, sessionReducer, type SessionAction } from './sessionReducer'

const SessionContext = createContext<{ state: KioskSession; dispatch: Dispatch<SessionAction> } | null>(null)

export function SessionProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(sessionReducer, undefined, createInitialSession)
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
