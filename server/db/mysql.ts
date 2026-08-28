import mysql, { type Pool } from 'mysql2/promise'
import type { ServerConfig } from '../config'

export type Database = {
  pool: Pool
  close(): Promise<void>
  migrate(): Promise<void>
  query<T = unknown>(sql: string, values?: unknown[]): Promise<T>
}

const schema = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS admin_users (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, username VARCHAR(80) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, role ENUM('owner','operator','technical') NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1, failed_attempts INT NOT NULL DEFAULT 0, locked_until DATETIME NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (id CHAR(64) PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, csrf_token CHAR(64) NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL, last_seen_at DATETIME NOT NULL, ip_hash CHAR(64) NULL, user_agent VARCHAR(255) NULL, INDEX idx_admin_sessions_expiry (expires_at), CONSTRAINT fk_admin_sessions_user FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS orders (id VARCHAR(80) PRIMARY KEY, session_id VARCHAR(100) NOT NULL, amount_fen INT NOT NULL, status ENUM('pending','paid','expired','refunded') NOT NULL, created_at DATETIME NOT NULL, expires_at DATETIME NOT NULL, paid_at DATETIME NULL, transaction_id VARCHAR(128) NULL, access_token_hash CHAR(64) NULL, access_expires_at DATETIME NULL, INDEX idx_orders_created (created_at), INDEX idx_orders_status (status))`,
  `CREATE TABLE IF NOT EXISTS generation_jobs (id CHAR(36) PRIMARY KEY, order_id VARCHAR(80) NOT NULL, scene_id VARCHAR(80) NOT NULL, status ENUM('queued','processing','succeeded','failed','uncertain','cancelled') NOT NULL, request_hash CHAR(64) NOT NULL, source_path VARCHAR(500) NULL, source_expires_at DATETIME NULL, attempts INT NOT NULL DEFAULT 0, error_code VARCHAR(80) NULL, started_at DATETIME NULL, completed_at DATETIME NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, INDEX idx_generation_status (status), CONSTRAINT fk_generation_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT)`,
  `CREATE TABLE IF NOT EXISTS generation_styles (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, generation_id CHAR(36) NOT NULL, style_id VARCHAR(80) NOT NULL, style_version INT NOT NULL DEFAULT 1, status ENUM('queued','processing','succeeded','failed','uncertain') NOT NULL, output_path VARCHAR(500) NULL, output_expires_at DATETIME NULL, attempts INT NOT NULL DEFAULT 0, error_code VARCHAR(80) NULL, started_at DATETIME NULL, completed_at DATETIME NULL, UNIQUE KEY uq_generation_style (generation_id, style_id), CONSTRAINT fk_generation_styles_job FOREIGN KEY (generation_id) REFERENCES generation_jobs(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS style_versions (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, style_id VARCHAR(80) NOT NULL, version INT NOT NULL, name VARCHAR(120) NOT NULL, subtitle VARCHAR(255) NOT NULL, description TEXT NOT NULL, prompt TEXT NOT NULL, cover_path VARCHAR(500) NULL, mode ENUM('realistic','artistic') NOT NULL, enabled TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, status ENUM('draft','published','archived') NOT NULL, created_by BIGINT UNSIGNED NULL, created_at DATETIME NOT NULL, published_at DATETIME NULL, UNIQUE KEY uq_style_version (style_id, version))`,
  `CREATE TABLE IF NOT EXISTS pricing_versions (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, amount_fen INT NOT NULL, description VARCHAR(255) NOT NULL, status ENUM('draft','published','archived') NOT NULL, created_by BIGINT UNSIGNED NULL, created_at DATETIME NOT NULL, published_at DATETIME NULL)`,
  `CREATE TABLE IF NOT EXISTS assets (id CHAR(36) PRIMARY KEY, generation_id CHAR(36) NOT NULL, style_id VARCHAR(80) NOT NULL, file_path VARCHAR(500) NOT NULL, mime_type VARCHAR(80) NOT NULL, byte_size BIGINT UNSIGNED NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL, INDEX idx_assets_expiry (expires_at), CONSTRAINT fk_assets_job FOREIGN KEY (generation_id) REFERENCES generation_jobs(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS shares (id VARCHAR(40) PRIMARY KEY, expires_at DATETIME NOT NULL, images_json JSON NOT NULL, created_at DATETIME NOT NULL, INDEX idx_shares_expiry (expires_at))`,
  `CREATE TABLE IF NOT EXISTS refund_requests (id CHAR(36) PRIMARY KEY, order_id VARCHAR(80) NOT NULL, requested_by BIGINT UNSIGNED NOT NULL, approved_by BIGINT UNSIGNED NULL, amount_fen INT NOT NULL, reason VARCHAR(500) NOT NULL, status ENUM('requested','approved','rejected','processing','succeeded','failed') NOT NULL, wechat_refund_id VARCHAR(128) NULL, error_code VARCHAR(80) NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, CONSTRAINT fk_refund_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT)`,
  `CREATE TABLE IF NOT EXISTS approval_requests (id CHAR(36) PRIMARY KEY, type ENUM('refund','style_publish','price_publish') NOT NULL, target_id VARCHAR(80) NOT NULL, requested_by BIGINT UNSIGNED NOT NULL, decided_by BIGINT UNSIGNED NULL, reason VARCHAR(500) NOT NULL, status ENUM('pending','approved','rejected') NOT NULL, created_at DATETIME NOT NULL, decided_at DATETIME NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, actor_user_id BIGINT UNSIGNED NULL, action VARCHAR(100) NOT NULL, target_type VARCHAR(80) NOT NULL, target_id VARCHAR(120) NULL, reason VARCHAR(500) NULL, metadata_json JSON NULL, created_at DATETIME NOT NULL, INDEX idx_audit_created (created_at), INDEX idx_audit_action (action))`,
]

export function createDatabase(config: ServerConfig): Database | null {
  if (!config.database.enabled) return null
  const pool = mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name,
    connectionLimit: config.database.connectionLimit,
    waitForConnections: true,
    timezone: 'Z',
  })
  return {
    pool,
    query: async <T>(sql: string, values?: unknown[]) => { const [rows] = await pool.query(sql, values); return rows as T },
    async migrate() {
      for (const statement of schema) await pool.query(statement)
      await pool.query('INSERT IGNORE INTO schema_migrations(version) VALUES (?)', ['v1-admin-platform'])
    },
    close: () => pool.end(),
  }
}
