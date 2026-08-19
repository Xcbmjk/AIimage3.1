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
})
