-- Mountain Portrait admin platform schema for MySQL 5.7.
-- Run this file against an empty or partially initialized server.

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS `aiaimage`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `aiaimage`;

CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `version` VARCHAR(64) NOT NULL,
  `applied_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `admin_users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(80) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('owner','operator','technical') NOT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `failed_attempts` INT NOT NULL DEFAULT 0,
  `locked_until` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `admin_sessions` (
  `id` CHAR(64) NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `csrf_token` CHAR(64) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL,
  `last_seen_at` DATETIME NOT NULL,
  `ip_hash` CHAR(64) NULL,
  `user_agent` VARCHAR(255) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_admin_sessions_expiry` (`expires_at`),
  CONSTRAINT `fk_admin_sessions_user`
    FOREIGN KEY (`user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `orders` (
  `id` VARCHAR(80) NOT NULL,
  `session_id` VARCHAR(100) NOT NULL,
  `amount_fen` INT NOT NULL,
  `status` ENUM('pending','paid','expired','refunded') NOT NULL,
  `payment_mode` ENUM('mock','wechat-native','voucher') NOT NULL DEFAULT 'mock',
  `provider_trade_state` VARCHAR(32) NULL,
  `payment_error_code` VARCHAR(80) NULL,
  `query_attempts` INT NOT NULL DEFAULT 0,
  `last_query_at` DATETIME NULL,
  `closed_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `paid_at` DATETIME NULL,
  `transaction_id` VARCHAR(128) NULL,
  `access_token_hash` CHAR(64) NULL,
  `access_expires_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_orders_transaction` (`transaction_id`),
  KEY `idx_orders_created` (`created_at`),
  KEY `idx_orders_status` (`status`),
  KEY `idx_orders_reconcile` (`status`, `last_query_at`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `generation_jobs` (
  `id` CHAR(36) NOT NULL,
  `order_id` VARCHAR(80) NOT NULL,
  `scene_id` VARCHAR(80) NOT NULL,
  `status` ENUM('queued','processing','succeeded','failed','uncertain','cancelled') NOT NULL,
  `request_hash` CHAR(64) NOT NULL,
  `source_path` VARCHAR(500) NULL,
  `source_expires_at` DATETIME NULL,
  `attempts` INT NOT NULL DEFAULT 0,
  `error_code` VARCHAR(80) NULL,
  `started_at` DATETIME NULL,
  `completed_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_generation_order` (`order_id`),
  KEY `idx_generation_status` (`status`),
  CONSTRAINT `fk_generation_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `generation_styles` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `generation_id` CHAR(36) NOT NULL,
  `style_id` VARCHAR(80) NOT NULL,
  `style_version` INT NOT NULL DEFAULT 1,
  `status` ENUM('queued','processing','succeeded','failed','uncertain') NOT NULL,
  `output_path` VARCHAR(500) NULL,
  `output_expires_at` DATETIME NULL,
  `attempts` INT NOT NULL DEFAULT 0,
  `error_code` VARCHAR(80) NULL,
  `started_at` DATETIME NULL,
  `completed_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_generation_style` (`generation_id`, `style_id`),
  CONSTRAINT `fk_generation_styles_job`
    FOREIGN KEY (`generation_id`) REFERENCES `generation_jobs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `style_versions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `style_id` VARCHAR(80) NOT NULL,
  `version` INT NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `subtitle` VARCHAR(255) NOT NULL,
  `description` TEXT NOT NULL,
  `prompt` TEXT NOT NULL,
  `cover_path` VARCHAR(500) NULL,
  `preview_data` MEDIUMTEXT NULL,
  `palette_json` VARCHAR(255) NULL,
  `motif` VARCHAR(40) NULL,
  `mode` ENUM('realistic','artistic') NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `status` ENUM('draft','published','archived') NOT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL,
  `published_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_style_version` (`style_id`, `version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `redeem_codes` (
  `id` CHAR(36) NOT NULL,
  `code_hash` CHAR(64) NOT NULL,
  `code_prefix` VARCHAR(16) NOT NULL,
  `status` ENUM('available','reserved','redeemed','disabled') NOT NULL DEFAULT 'available',
  `session_id` VARCHAR(100) NULL,
  `order_id` VARCHAR(80) NULL,
  `reserved_at` DATETIME NULL,
  `redeemed_at` DATETIME NULL,
  `expires_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_redeem_code_hash` (`code_hash`), KEY `idx_redeem_status` (`status`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `mini_program_tokens` (
  `id` CHAR(36) NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `status` ENUM('active','claimed','disabled') NOT NULL DEFAULT 'active',
  `code_id` CHAR(36) NULL,
  `claimed_at` DATETIME NULL,
  `expires_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_mini_program_token_hash` (`token_hash`), KEY `idx_mini_token_status` (`status`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `background_versions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `background_id` VARCHAR(80) NOT NULL,
  `version` INT NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `subtitle` VARCHAR(255) NOT NULL,
  `description` TEXT NOT NULL,
  `pose_hint` TEXT NOT NULL,
  `analysis_prompt` TEXT NULL,
  `image_path` VARCHAR(500) NOT NULL,
  `image_mime` VARCHAR(80) NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `analysis_status` ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending',
  `status` ENUM('draft','published','archived') NOT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL,
  `analyzed_at` DATETIME NULL,
  `published_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_background_version` (`background_id`, `version`),
  KEY `idx_background_published` (`status`, `enabled`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pricing_versions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `amount_fen` INT NOT NULL,
  `description` VARCHAR(255) NOT NULL,
  `status` ENUM('draft','published','archived') NOT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL,
  `published_at` DATETIME NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `assets` (
  `id` CHAR(36) NOT NULL,
  `generation_id` CHAR(36) NOT NULL,
  `style_id` VARCHAR(80) NOT NULL,
  `file_path` VARCHAR(500) NOT NULL,
  `mime_type` VARCHAR(80) NOT NULL,
  `byte_size` BIGINT UNSIGNED NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_assets_expiry` (`expires_at`),
  CONSTRAINT `fk_assets_job`
    FOREIGN KEY (`generation_id`) REFERENCES `generation_jobs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `shares` (
  `id` VARCHAR(40) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `images_json` JSON NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_shares_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `refund_requests` (
  `id` CHAR(36) NOT NULL,
  `order_id` VARCHAR(80) NOT NULL,
  `requested_by` BIGINT UNSIGNED NOT NULL,
  `approved_by` BIGINT UNSIGNED NULL,
  `amount_fen` INT NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `status` ENUM('requested','approved','rejected','processing','succeeded','failed') NOT NULL,
  `wechat_refund_id` VARCHAR(128) NULL,
  `error_code` VARCHAR(80) NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_refund_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `payment_notifications` (
  `id` VARCHAR(64) NOT NULL,
  `event_type` VARCHAR(64) NOT NULL,
  `order_id` VARCHAR(80) NOT NULL,
  `transaction_id` VARCHAR(128) NOT NULL,
  `processed_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_payment_notification_transaction` (`transaction_id`),
  KEY `idx_payment_notification_order` (`order_id`),
  CONSTRAINT `fk_payment_notification_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `approval_requests` (
  `id` CHAR(36) NOT NULL,
  `type` ENUM('refund','style_publish','price_publish') NOT NULL,
  `target_id` VARCHAR(80) NOT NULL,
  `requested_by` BIGINT UNSIGNED NOT NULL,
  `decided_by` BIGINT UNSIGNED NULL,
  `reason` VARCHAR(500) NOT NULL,
  `status` ENUM('pending','approved','rejected') NOT NULL,
  `created_at` DATETIME NOT NULL,
  `decided_at` DATETIME NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `actor_user_id` BIGINT UNSIGNED NULL,
  `action` VARCHAR(100) NOT NULL,
  `target_type` VARCHAR(80) NOT NULL,
  `target_id` VARCHAR(120) NULL,
  `reason` VARCHAR(500) NULL,
  `metadata_json` JSON NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_audit_created` (`created_at`),
  KEY `idx_audit_action` (`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `schema_migrations` (`version`)
VALUES ('001_schema_sql');
