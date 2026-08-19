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
  'share.started',
  'share.completed',
  'session.reset',
])

export function trackClientEvent(event: string, sessionId: string, data: ClientEventData = {}) {
  if (!eventNames.has(event)) return
  const requestId = crypto.randomUUID()
  void fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
    body: JSON.stringify({ event, sessionId, data }),
    keepalive: true,
  }).catch(() => undefined)
}
