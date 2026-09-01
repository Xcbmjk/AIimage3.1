import express from 'express'
import { describe, expect, it } from 'vitest'
import { createRateLimiter, Semaphore } from './rateLimit'

describe('rate limiting primitives', () => {
  it('serializes semaphore work', async () => {
    const semaphore = new Semaphore(1)
    let active = 0
    let peak = 0
    await Promise.all(Array.from({ length: 4 }, () => semaphore.run(async () => {
      active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 1)); active -= 1
    })))
    expect(peak).toBe(1)
  })

  it('returns 429 after the configured request count', async () => {
    const app = express()
    app.use(createRateLimiter({ windowMs: 60_000, max: 1 }))
    app.get('/', (_request, response) => response.json({ ok: true }))
    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE')
    const url = `http://127.0.0.1:${address.port}/`
    expect((await fetch(url)).status).toBe(200)
    const limited = await fetch(url)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
})
