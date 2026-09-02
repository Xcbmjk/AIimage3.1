import type express from 'express'

type Bucket = { count: number; resetAt: number }

export function createRateLimiter(options: { windowMs: number; max: number; key?: (request: express.Request) => string }) : express.RequestHandler {
  const buckets = new Map<string, Bucket>()
  const keyOf = options.key ?? ((request) => request.ip || request.socket.remoteAddress || 'unknown')
  return (request, response, next) => {
    const now = Date.now()
    const key = keyOf(request)
    const current = buckets.get(key)
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + options.windowMs } : current
    bucket.count += 1
    buckets.set(key, bucket)
    if (buckets.size > 10_000) {
      for (const [bucketKey, value] of buckets) if (value.resetAt <= now) buckets.delete(bucketKey)
    }
    response.setHeader('X-RateLimit-Limit', options.max)
    response.setHeader('X-RateLimit-Remaining', Math.max(0, options.max - bucket.count))
    if (bucket.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      response.setHeader('Retry-After', retryAfter)
      response.status(429).json({ code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试', retryable: true })
      return
    }
    next()
  }
}

export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('INVALID_SEMAPHORE_CAPACITY')
  }
  async run<T>(work: () => Promise<T>) {
    await this.acquire()
    try { return await work() } finally { this.release() }
  }
  private acquire() {
    if (this.active < this.capacity) { this.active += 1; return Promise.resolve() }
    return new Promise<void>((resolve) => this.waiters.push(() => { this.active += 1; resolve() }))
  }
  private release() {
    const next = this.waiters.shift()
    if (next) next()
    else this.active -= 1
  }
}
