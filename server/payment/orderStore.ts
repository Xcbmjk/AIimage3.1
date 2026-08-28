import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type PaymentGeneration = {
  id: string
  requestHash: string
  status: 'processing' | 'succeeded' | 'failed' | 'uncertain'
  startedAt: string
  completedAt?: string
  errorCode?: string
  retryable?: boolean
}

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
  accessExpiresAt?: string
  generation?: PaymentGeneration
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

  list() {
    for (const order of this.data.orders) {
      if (order.status === 'pending' && new Date(order.expiresAt).getTime() < Date.now()) order.status = 'expired'
    }
    return [...this.data.orders].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }

  markPaid(id: string, transactionId: string) {
    const order = this.data.orders.find((item) => item.id === id)
    if (!order) return undefined
    if (order.status !== 'paid') {
      order.status = 'paid'
      order.paidAt = new Date().toISOString()
      order.transactionId = transactionId
      order.accessToken = crypto.randomBytes(32).toString('base64url')
      order.accessExpiresAt = new Date(Date.now() + 24 * 3600_000).toISOString()
      this.save()
    }
    return order
  }

  authorize(sessionId: string, accessToken: string) {
    const order = this.findAuthorizedOrder(sessionId, accessToken)
    return Boolean(order)
  }

  reserveGeneration(sessionId: string, accessToken: string, generationId: string, requestHash: string) {
    const order = this.findAuthorizedOrder(sessionId, accessToken)
    if (!order) return { status: 'unauthorized' as const }
    const generation = order.generation
    if (!generation) {
      order.generation = { id: generationId, requestHash, status: 'processing', startedAt: new Date().toISOString() }
      this.save()
      return { status: 'reserved' as const, order }
    }
    if (generation.id !== generationId) return { status: 'already_consumed' as const, generationId: generation.id }
    if (generation.requestHash !== requestHash) return { status: 'request_mismatch' as const }
    if (generation.status === 'succeeded') return { status: 'succeeded' as const }
    if (generation.status === 'failed' && generation.retryable) {
      generation.status = 'processing'
      generation.startedAt = new Date().toISOString()
      delete generation.completedAt
      delete generation.errorCode
      delete generation.retryable
      this.save()
      return { status: 'reserved' as const, order }
    }
    return { status: generation.status as 'processing' | 'failed' | 'uncertain' }
  }

  completeGeneration(generationId: string) {
    const order = this.data.orders.find((item) => item.generation?.id === generationId)
    if (!order?.generation) return false
    order.generation.status = 'succeeded'
    order.generation.completedAt = new Date().toISOString()
    delete order.generation.errorCode
    delete order.generation.retryable
    this.save()
    return true
  }

  failGeneration(generationId: string, errorCode: string, retryable: boolean) {
    const order = this.data.orders.find((item) => item.generation?.id === generationId)
    if (!order?.generation) return false
    order.generation.status = retryable ? 'failed' : 'uncertain'
    order.generation.errorCode = errorCode
    order.generation.retryable = retryable
    order.generation.completedAt = new Date().toISOString()
    this.save()
    return true
  }

  private findAuthorizedOrder(sessionId: string, accessToken: string) {
    const order = this.data.orders.find((item) => item.sessionId === sessionId && item.status === 'paid' && item.accessToken)
    if (!order?.accessToken) return false
    const expiresAt = order.accessExpiresAt ?? (order.paidAt ? new Date(new Date(order.paidAt).getTime() + 24 * 3600_000).toISOString() : undefined)
    if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) return false
    const actual = Buffer.from(order.accessToken)
    const supplied = Buffer.from(accessToken)
    return actual.length === supplied.length && crypto.timingSafeEqual(actual, supplied) ? order : undefined
  }
}
