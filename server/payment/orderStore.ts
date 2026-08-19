import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type PaymentOrder = {
  id: string
  sessionId: string
  amountFen: number
  status: 'pending' | 'paid' | 'expired'
  createdAt: string
  expiresAt: string
  paidAt?: string
  transactionId?: string
  accessToken?: string
}

type OrderData = { orders: PaymentOrder[] }

export class PaymentOrderStore {
  private readonly filePath: string
  private data: OrderData

  constructor(filePath: string) {
    this.filePath = path.resolve(process.cwd(), filePath)
    this.data = this.read()
  }

  private read(): OrderData {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as OrderData
      return Array.isArray(parsed.orders) ? parsed : { orders: [] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { orders: [] }
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.filePath)
  }

  create(sessionId: string, amountFen: number) {
    const now = Date.now()
    const order: PaymentOrder = {
      id: `SJ${new Date(now).toISOString().replace(/\D/g, '').slice(0, 14)}${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      sessionId,
      amountFen,
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
    }
    this.data.orders.push(order)
    this.data.orders = this.data.orders.filter((item) => Date.now() - new Date(item.createdAt).getTime() < 7 * 24 * 3600_000)
    this.save()
    return order
  }

  find(id: string) {
    const order = this.data.orders.find((item) => item.id === id)
    if (order?.status === 'pending' && new Date(order.expiresAt).getTime() < Date.now()) {
      order.status = 'expired'
      this.save()
    }
    return order
  }

  markPaid(id: string, transactionId: string) {
    const order = this.data.orders.find((item) => item.id === id)
    if (!order) return undefined
    if (order.status !== 'paid') {
      order.status = 'paid'
      order.paidAt = new Date().toISOString()
      order.transactionId = transactionId
      order.accessToken = crypto.randomBytes(32).toString('base64url')
      this.save()
    }
    return order
  }

  authorize(sessionId: string, accessToken: string) {
    const order = this.data.orders.find((item) => item.sessionId === sessionId && item.status === 'paid' && item.accessToken)
    if (!order?.accessToken) return false
    const actual = Buffer.from(order.accessToken)
    const supplied = Buffer.from(accessToken)
    return actual.length === supplied.length && crypto.timingSafeEqual(actual, supplied)
  }
}
