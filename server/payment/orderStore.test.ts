import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PaymentOrderStore } from './orderStore'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('PaymentOrderStore', () => {
  it('authorizes only the paid session with the issued token', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-payments-'))
    directories.push(directory)
    const store = new PaymentOrderStore(path.join(directory, 'orders.json'))
    const order = store.create('16de9a80-f226-45be-8c2d-f9f632aa0140', 990)

    expect(store.authorize(order.sessionId, 'not-paid')).toBe(false)
    const paid = store.markPaid(order.id, 'wx-transaction')
    expect(store.authorize(order.sessionId, paid!.accessToken!)).toBe(true)
    expect(store.authorize('cc6f7fab-d227-49ff-a9e6-01b60ea0d391', paid!.accessToken!)).toBe(false)
  })

  it('binds one paid order to exactly one generation request', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-payments-'))
    directories.push(directory)
    const file = path.join(directory, 'orders.json')
    const store = new PaymentOrderStore(file)
    const order = store.create('16de9a80-f226-45be-8c2d-f9f632aa0140', 990)
    const paid = store.markPaid(order.id, 'wx-transaction')!

    expect(store.reserveGeneration(order.sessionId, paid.accessToken!, '15f78f97-da7a-47f3-be82-30cab8aa80bb', 'hash-1').status).toBe('reserved')
    expect(store.reserveGeneration(order.sessionId, paid.accessToken!, '76571f6b-b7c9-49ef-8f0a-9ed51d46df73', 'hash-1').status).toBe('already_consumed')
    expect(store.reserveGeneration(order.sessionId, paid.accessToken!, '15f78f97-da7a-47f3-be82-30cab8aa80bb', 'hash-2').status).toBe('request_mismatch')
  })

  it('persists completed generation consumption without storing image payloads', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-payments-'))
    directories.push(directory)
    const file = path.join(directory, 'orders.json')
    const store = new PaymentOrderStore(file)
    const order = store.create('16de9a80-f226-45be-8c2d-f9f632aa0140', 990)
    const paid = store.markPaid(order.id, 'wx-transaction')!
    const generationId = '15f78f97-da7a-47f3-be82-30cab8aa80bb'
    const assets = [{ id: 'asset-1', styleId: 'ink', imageUrl: 'data:image/png;base64,AA==' }]

    store.reserveGeneration(order.sessionId, paid.accessToken!, generationId, 'hash-1')
    expect(store.completeGeneration(generationId)).toBe(true)

    const reloaded = new PaymentOrderStore(file)
    expect(reloaded.reserveGeneration(order.sessionId, paid.accessToken!, generationId, 'hash-1')).toEqual({ status: 'succeeded' })
    expect(fs.readFileSync(file, 'utf8')).not.toContain(assets[0].imageUrl)
  })

  it('does not reset generation consumption on duplicate payment callbacks', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-payments-'))
    directories.push(directory)
    const store = new PaymentOrderStore(path.join(directory, 'orders.json'))
    const order = store.create('16de9a80-f226-45be-8c2d-f9f632aa0140', 990)
    const paid = store.markPaid(order.id, 'wx-transaction')!
    const generationId = '15f78f97-da7a-47f3-be82-30cab8aa80bb'
    store.reserveGeneration(order.sessionId, paid.accessToken!, generationId, 'hash-1')

    const duplicate = store.markPaid(order.id, 'wx-transaction')!

    expect(duplicate.accessToken).toBe(paid.accessToken)
    expect(duplicate.generation?.id).toBe(generationId)
  })
})
