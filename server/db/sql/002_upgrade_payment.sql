-- Idempotent payment reliability upgrade for an existing MySQL 5.7 database.

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

SET @schema_name = DATABASE();

-- Existing installations may have the older enum without the refunded state.
ALTER TABLE `orders`
  MODIFY COLUMN `status` ENUM('pending','paid','expired','refunded') NOT NULL;

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = @schema_name AND table_name = 'orders' AND column_name = 'payment_mode'),
  'SELECT 1',
  'ALTER TABLE `orders` ADD COLUMN `payment_mode` ENUM(''mock'',''wechat-native'') NOT NULL DEFAULT ''mock'' AFTER `status`'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

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

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = @schema_name AND table_name = 'orders' AND column_name = 'provider_trade_state'),
  'SELECT 1',
  'ALTER TABLE `orders` ADD COLUMN `provider_trade_state` VARCHAR(32) NULL AFTER `payment_mode`'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = @schema_name AND table_name = 'orders' AND column_name = 'payment_error_code'),
  'SELECT 1',
  'ALTER TABLE `orders` ADD COLUMN `payment_error_code` VARCHAR(80) NULL AFTER `provider_trade_state`'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = @schema_name AND table_name = 'orders' AND column_name = 'query_attempts'),
  'SELECT 1',
  'ALTER TABLE `orders` ADD COLUMN `query_attempts` INT NOT NULL DEFAULT 0 AFTER `payment_error_code`'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = @schema_name AND table_name = 'orders' AND column_name = 'last_query_at'),
  'SELECT 1',
  'ALTER TABLE `orders` ADD COLUMN `last_query_at` DATETIME NULL AFTER `query_attempts`'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = @schema_name AND table_name = 'orders' AND column_name = 'closed_at'),
  'SELECT 1',
  'ALTER TABLE `orders` ADD COLUMN `closed_at` DATETIME NULL AFTER `last_query_at`'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema = @schema_name AND table_name = 'orders' AND index_name = 'uq_orders_transaction'),
  'SELECT 1',
  'ALTER TABLE `orders` ADD UNIQUE KEY `uq_orders_transaction` (`transaction_id`)'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema = @schema_name AND table_name = 'orders' AND index_name = 'idx_orders_reconcile'),
  'SELECT 1',
  'ALTER TABLE `orders` ADD KEY `idx_orders_reconcile` (`status`, `last_query_at`, `expires_at`)'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema = @schema_name AND table_name = 'generation_jobs' AND index_name = 'uq_generation_order'),
  'SELECT 1',
  'ALTER TABLE `generation_jobs` ADD UNIQUE KEY `uq_generation_order` (`order_id`)'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

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

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = @schema_name AND table_name = 'style_versions' AND column_name = 'preview_data'),
  'SELECT 1',
  'ALTER TABLE `style_versions` ADD COLUMN `preview_data` MEDIUMTEXT NULL AFTER `cover_path`'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = @schema_name AND table_name = 'style_versions' AND column_name = 'palette_json'),
  'SELECT 1',
  'ALTER TABLE `style_versions` ADD COLUMN `palette_json` VARCHAR(255) NULL AFTER `preview_data`'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = @schema_name AND table_name = 'style_versions' AND column_name = 'motif'),
  'SELECT 1',
  'ALTER TABLE `style_versions` ADD COLUMN `motif` VARCHAR(40) NULL AFTER `palette_json`'
);
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

INSERT IGNORE INTO `schema_migrations` (`version`)
VALUES ('002_upgrade_payment_sql');
