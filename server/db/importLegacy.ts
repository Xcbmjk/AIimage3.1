import dotenv from 'dotenv'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { loadConfig } from '../config'
import { createDatabase } from './mysql'
import type { PaymentOrder } from '../payment/orderStore'
import type { ShareRecord } from '../share/shareStore'
import path from 'node:path'

dotenv.config({ path: '.env.local' })
dotenv.config()
const config = loadConfig()
const run = async () => {
 const database = createDatabase(config)
 if (!database) throw new Error('MYSQL_ENABLED=true is required')
 await database.migrate()
 const sourcePath = config.payment.orderFile
 const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as { orders?: PaymentOrder[] }
 const orders = Array.isArray(parsed.orders) ? parsed.orders : []
 let imported = 0; let skipped = 0; let failed = 0
 for (const order of orders) {
  try {
    const existing = await database.query<Array<{ id: string }>>('SELECT id FROM orders WHERE id = ?', [order.id])
    if (existing.length) { skipped++; continue }
    await database.pool.query('START TRANSACTION')
    await database.pool.query(
      `INSERT INTO orders (id, session_id, amount_fen, status, created_at, expires_at, paid_at, transaction_id, access_token_hash, access_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [order.id, order.sessionId, order.amountFen, order.status, order.createdAt.slice(0, 19).replace('T', ' '), order.expiresAt.slice(0, 19).replace('T', ' '), order.paidAt?.slice(0, 19).replace('T', ' '), order.transactionId ?? null, order.accessToken ? crypto.createHash('sha256').update(order.accessToken).digest('hex') : null, order.accessExpiresAt?.slice(0, 19).replace('T', ' ') ?? null],
    )
    if (order.generation) {
      await database.pool.query(
        `INSERT INTO generation_jobs (id, order_id, scene_id, status, request_hash, attempts, error_code, started_at, completed_at, created_at, updated_at)
         VALUES (?, ?, 'legacy', ?, ?, 1, ?, ?, ?, ?, ?)`,
        [order.generation.id, order.id, order.generation.status === 'processing' ? 'processing' : order.generation.status, order.generation.requestHash, order.generation.errorCode ?? null, order.generation.startedAt.slice(0, 19).replace('T', ' '), order.generation.completedAt?.slice(0, 19).replace('T', ' ') ?? null, order.createdAt.slice(0, 19).replace('T', ' '), order.generation.completedAt?.slice(0, 19).replace('T', ' ') ?? order.createdAt.slice(0, 19).replace('T', ' ')],
      )
    }
    await database.pool.query('COMMIT')
    imported++
  } catch (error) {
    failed++
    await database.pool.query('ROLLBACK').catch(() => undefined)
    console.error(`failed ${order.id}: ${error instanceof Error ? error.message : String(error)}`)
  }
 }
 const sharesDirectory = path.resolve(process.cwd(), config.shareDirectory)
 let shareImported = 0; let shareSkipped = 0; let shareFailed = 0
 if (fs.existsSync(sharesDirectory)) {
  for (const entry of fs.readdirSync(sharesDirectory, { withFileTypes: true })) {
   if (!entry.isDirectory()) continue
   const sharePath = path.join(sharesDirectory, entry.name, 'share.json')
   try {
    const share = JSON.parse(fs.readFileSync(sharePath, 'utf8')) as ShareRecord
    const existing = await database.query<Array<{ id: string }>>('SELECT id FROM shares WHERE id = ?', [share.id])
    if (existing.length) { shareSkipped++; continue }
    await database.pool.query('INSERT INTO shares (id, expires_at, images_json, created_at) VALUES (?, ?, ?, ?)', [share.id, share.expiresAt.slice(0, 19).replace('T', ' '), JSON.stringify(share.images), new Date().toISOString().slice(0, 19).replace('T', ' ')])
    shareImported++
   } catch (error) { shareFailed++; console.error(`failed share ${entry.name}: ${error instanceof Error ? error.message : String(error)}`) }
  }
 }
 await database.close()
 console.log(JSON.stringify({ sourcePath, total: orders.length, imported, skipped, failed, shares: { imported: shareImported, skipped: shareSkipped, failed: shareFailed } }))
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
