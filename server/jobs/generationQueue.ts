import type { Database } from '../db/mysql'

export type QueueJob = { id: string; orderId: string; sceneId: string; status: string; attempts: number; errorCode?: string }

export class GenerationQueue {
  constructor(private readonly database: Database) {}
  async enqueue(job: { id: string; orderId: string; sceneId: string; requestHash: string; sourcePath?: string; sourceExpiresAt?: string }) {
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await this.database.pool.query(`INSERT INTO generation_jobs (id, order_id, scene_id, status, request_hash, source_path, source_expires_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`, [job.id, job.orderId, job.sceneId, job.requestHash, job.sourcePath ?? null, job.sourceExpiresAt?.slice(0, 19).replace('T', ' ') ?? null, timestamp, timestamp])
  }
  async claim(limit = 1): Promise<QueueJob[]> {
    const connection = await this.database.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.query(`SELECT id, order_id AS orderId, scene_id AS sceneId, status, attempts, error_code AS errorCode FROM generation_jobs WHERE status = 'queued' ORDER BY created_at LIMIT ? FOR UPDATE`, [limit])
      const jobs = rows as QueueJob[]
      for (const job of jobs) await connection.query(`UPDATE generation_jobs SET status = 'processing', attempts = attempts + 1, started_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'queued'`, [job.id])
      await connection.commit(); return jobs
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }
  async complete(id: string) { await this.database.pool.query(`UPDATE generation_jobs SET status = 'succeeded', completed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP(), error_code = NULL WHERE id = ?`, [id]) }
  async fail(id: string, errorCode: string, uncertain = false) { await this.database.pool.query(`UPDATE generation_jobs SET status = ?, error_code = ?, completed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?`, [uncertain ? 'uncertain' : 'failed', errorCode, id]) }
  async recover(staleMinutes = 15) { const [result] = await this.database.pool.query(`UPDATE generation_jobs SET status = 'queued', updated_at = UTC_TIMESTAMP() WHERE status = 'processing' AND started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)`, [staleMinutes]); return (result as { affectedRows: number }).affectedRows }
}

