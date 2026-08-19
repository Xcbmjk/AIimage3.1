import { KioskFlow } from '../features/kiosk/KioskFlow'
import { SessionProvider } from '../features/session/SessionProvider'

export function App() {
  return <SessionProvider><div className="app-shell"><KioskFlow /></div></SessionProvider>
}
