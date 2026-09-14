import { Capacitor } from '@capacitor/core'

const configuredBaseUrl = normalizeApiBase((import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim())

export function normalizeApiBase(value: string | undefined, defaultPort = '8787'): string {
  if (!value) return ''
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`
  const url = new URL(candidate)
  if (!url.port) url.port = defaultPort
  return url.toString().replace(/\/$/, '')
}

export function apiUrl(path: string, nativeApp = Capacitor.isNativePlatform()): string {
  // Browser builds are same-origin: Vite proxies locally and Node serves /api in production.
  // Only the embedded Android WebView needs an explicit public API origin.
  if (!configuredBaseUrl || !nativeApp) return path
  return `${configuredBaseUrl}${path.startsWith('/') ? path : `/${path}`}`
}
