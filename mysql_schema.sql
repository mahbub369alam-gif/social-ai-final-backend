-- Social AI Backend (MySQL)
-- Create database manually if you want:
--   CREATE DATABASE social_ai CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--   USE social_ai;

CREATE TABLE IF NOT EXISTS sellers (
  id             VARCHAR(24) PRIMARY KEY,
  name           VARCHAR(255) DEFAULT '',
  first_name     VARCHAR(255) DEFAULT '',
  last_name      VARCHAR(255) DEFAULT '',
  phone          VARCHAR(64)  DEFAULT '',
  joining_date   VARCHAR(64)  DEFAULT '',
  image_data_url MEDIUMTEXT,
  email          VARCHAR(255) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  token_version  INT NOT NULL DEFAULT 1,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conversation_locks (
  conversation_id VARCHAR(128) PRIMARY KEY,
  seller_id       VARCHAR(24) NULL,
  locked_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seller_last_read_at DATETIME NULL,
  admin_last_read_at  DATETIME NULL,
  -- Customer receipts (platform-provided). Used for ✓✓ in UI.
  customer_last_delivered_at DATETIME NULL,
  customer_last_read_at      DATETIME NULL,
  delivery_status ENUM('confirmed','hold','cancel','delivered') NOT NULL DEFAULT 'confirmed',
  assigned_by     VARCHAR(24) NULL,
  assigned_at     DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_seller_id (seller_id),
  KEY idx_delivery_status (delivery_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Migration (for existing databases)
-- If your conversation_locks table already exists, you may need to add these
-- columns manually (older installs won't have them).
-- ---------------------------------------------------------------------------
-- ALTER TABLE conversation_locks
--   ADD COLUMN customer_last_delivered_at DATETIME NULL AFTER admin_last_read_at,
--   ADD COLUMN customer_last_read_at      DATETIME NULL AFTER customer_last_delivered_at;

CREATE TABLE IF NOT EXISTS social_chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(128) NOT NULL,
  customer_name VARCHAR(255) DEFAULT '',
  customer_profile_pic MEDIUMTEXT,
  sender ENUM('customer','bot') NOT NULL,
  sender_role ENUM('customer','admin','seller','ai') DEFAULT 'customer',
  sender_name VARCHAR(255) DEFAULT '',
  message MEDIUMTEXT NOT NULL,
    reply_to_message_id VARCHAR(36) NULL,
platform ENUM('facebook','instagram') NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  timestamp DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_conv_time (conversation_id, timestamp),
  KEY idx_time (timestamp),
  KEY idx_reply (reply_to_message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ✅ API Integrations
CREATE TABLE IF NOT EXISTS api_integrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  platform ENUM('facebook','instagram','whatsapp') NOT NULL,
  page_id VARCHAR(128) NOT NULL DEFAULT '',
  page_name VARCHAR(255) NOT NULL DEFAULT '',
  page_token MEDIUMTEXT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_platform_page (platform, page_id),
  KEY idx_platform_active (platform, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sub_admins (
  id                VARCHAR(24) PRIMARY KEY,
  email             VARCHAR(255) NOT NULL UNIQUE,
  admin_type        VARCHAR(16) NOT NULL DEFAULT 'sub',
  password_hash     VARCHAR(255) NULL,
  must_set_password TINYINT(1) NOT NULL DEFAULT 0,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  token_version     INT NOT NULL DEFAULT 1,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sub_admin_invites (
  id             VARCHAR(24) PRIMARY KEY,
  sub_admin_id   VARCHAR(24) NOT NULL,
  token_hash     CHAR(64) NOT NULL,
  expires_at     DATETIME NOT NULL,
  used_at        DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sub_admin (sub_admin_id),
  KEY idx_token_hash (token_hash),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id           VARCHAR(24) PRIMARY KEY,
  actor_id     VARCHAR(64) NOT NULL,
  actor_email  VARCHAR(255) NULL,
  actor_type   VARCHAR(32) NOT NULL,
  action       VARCHAR(64) NOT NULL,
  target_id    VARCHAR(64) NULL,
  target_email VARCHAR(255) NULL,
  ip           VARCHAR(64) NULL,
  user_agent   VARCHAR(255) NULL,
  meta_json    JSON NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_action (action),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- ✅ Saved templates / quick replies (text + media)
-- - Admin creates GLOBAL templates
-- - Seller creates SELLER scoped templates
-- Media URLs are stored as JSON string of relative /uploads/... paths.
CREATE TABLE IF NOT EXISTS saved_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  scope ENUM('global','seller') NOT NULL DEFAULT 'seller',
  seller_id VARCHAR(24) NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  type ENUM('text','media') NOT NULL,
  text MEDIUMTEXT NULL,
  media_urls_json MEDIUMTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_scope (scope),
  KEY idx_seller (seller_id),
  KEY idx_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
