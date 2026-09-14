import { createUuid } from '../lib/uuid'
import { apiUrl } from './apiBase'

type ClientEventData = Record<string, string | number | boolean>

const eventNames = new Set([
  'session.stage_changed',
  'camera.started',
  'camera.fallback',
  'photo.captured',
  'photo.uploaded',
  'styles.updated',
  'generation.started',
  'generation.client_failed',
  'generation.client_succeeded',
  'agent.started',
  'agent.succeeded',
  'agent.failed',
  'share.started',
  'share.completed',
  'session.reset',
])

export function trackClientEvent(event: string, sessionId: string, data: ClientEventData = {}) {
  if (!eventNames.has(event)) return
  const requestId = createUuid()
  void fetch(apiUrl('/api/events'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
    body: JSON.stringify({ event, sessionId, data }),
    keepalive: true,
  }).catch(() => undefined)
}
