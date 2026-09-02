import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from '../lib/logger'
import { PaymentOrderStore } from '../payment/orderStore'
import { createGenerationRouter } from './generation'

const directories: string[] = []
const servers: Server[] = []
const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))))
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('generation route payment entitlement', () => {
  it('does not consume invalid input and replays only the bound generation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-generation-'))
    directories.push(directory)
    const store = new PaymentOrderStore(path.join(directory, 'orders.json'))
    const sessionId = '16de9a80-f226-45be-8c2d-f9f632aa0140'
    const order = store.create(sessionId, 990)
    const paid = store.markPaid(order.id, 'wx-transaction')!
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api', createGenerationRouter(logger, store))
    const server = app.listen(0)
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE')
    const endpoint = `http://127.0.0.1:${address.port}/api/generation`
    const generationId = '15f78f97-da7a-47f3-be82-30cab8aa80bb'
    const headers = { 'Content-Type': 'application/json', 'X-Payment-Token': paid.accessToken! }
    const request = (id: string, styleId: string, sceneId = 'great-wall') => fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId, generationId: id, photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', sceneId, styles: [{ id: styleId }] }),
    })

    const invalid = await request(generationId, 'not-allowlisted')
    expect(invalid.status).toBe(400)

    const invalidScene = await request(generationId, 'ink', 'not-allowlisted')
    expect(invalidScene.status).toBe(400)

    const first = await request(generationId, 'ink')
    const firstBody = await first.json() as { assets: Array<{ id: string }> }
    expect(first.status).toBe(200)
    expect(firstBody.assets).toHaveLength(1)

    const replay = await request(generationId, 'ink')
    const replayBody = await replay.json() as { assets: Array<{ id: string }> }
    expect(replay.status).toBe(200)
    expect(replayBody.assets).toEqual(firstBody.assets)

    const changedScene = await request(generationId, 'ink', 'west-lake')
    expect(changedScene.status).toBe(409)
    expect(await changedScene.json()).toMatchObject({ code: 'GENERATION_REQUEST_MISMATCH' })

    const secondGeneration = await request('76571f6b-b7c9-49ef-8f0a-9ed51d46df73', 'ink')
    expect(secondGeneration.status).toBe(409)
    expect(await secondGeneration.json()).toMatchObject({ code: 'GENERATION_ALREADY_CONSUMED', generationId })
  })
})

describe('agent generation route', () => {
  it('rejects requests when no administrator-published background exists', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-agent-'))
    directories.push(directory)
    const store = new PaymentOrderStore(path.join(directory, 'orders.json'))
    const sessionId = '16de9a80-f226-45be-8c2d-f9f632aa0141'
    const order = store.create(sessionId, 990)
    const paid = store.markPaid(order.id, 'wx-transaction')!
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api', createGenerationRouter(logger, store))
    const server = app.listen(0)
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE')
    const endpoint = `http://127.0.0.1:${address.port}/api/agent/generation`
    const generationId = '15f78f97-da7a-47f3-be82-30cab8aa80bb'
    const headers = { 'Content-Type': 'application/json', 'X-Payment-Token': paid.accessToken! }
    const request = (id: string, backgroundId: string) => fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId, generationId: id, photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', backgroundId }),
    })

    const response = await request(generationId, 'gate-steps')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' })
  })
})
