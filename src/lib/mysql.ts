import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";

/**
 * MySQL connection (mysql2/promise)
 *
 * Env vars (recommended):
 * - MYSQL_HOST
 * - MYSQL_PORT
 * - MYSQL_USER
 * - MYSQL_PASSWORD
 * - MYSQL_DATABASE
 */

let _pool: Pool | null = null;

export function getMySqlPool(): Pool {
  if (_pool) return _pool;

  const host = String(process.env.MYSQL_HOST || "127.0.0.1");
  const port = Number(process.env.MYSQL_PORT || 3306);
  const user = String(process.env.MYSQL_USER || "root");
  const password = String(process.env.MYSQL_PASSWORD || "");
  const database = String(process.env.MYSQL_DATABASE || "social_ai");

  _pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 10),
    charset: "utf8mb4",
    waitForConnections: true,
    multipleStatements: true,
  });

  return _pool;
}

export async function withConnection<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const pool = getMySqlPool();
  const conn = await pool.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function queryRows<T extends RowDataPacket[] = RowDataPacket[]>(
  sql: string,
  params: any[] = []
): Promise<T> {
  const pool = getMySqlPool();
  const [rows] = await pool.query(sql, params);
  return rows as T;
}

export async function execResult(
  sql: string,
  params: any[] = []
): Promise<ResultSetHeader> {
  const pool = getMySqlPool();
  const [r] = await pool.execute(sql, params);
  return r as ResultSetHeader;
}

/**
 * Optional auto-migration: creates tables if they don't exist.
 * Enable by setting MYSQL_AUTO_MIGRATE=true
 */
export async function ensureMySqlSchema(): Promise<void> {
  // Backwards-compatible safety: older deployments may not have this table yet.
  // We always ensure `saved_templates` exists so the UI feature works without
  // requiring operators to enable full auto-migration.
  try {
    await queryRows("SELECT 1 FROM saved_templates LIMIT 1");
  } catch {
    const createSavedTemplates = `

CREATE TABLE IF NOT EXISTS sub_admins (
  id                VARCHAR(24) PRIMARY KEY,
  email             VARCHAR(255) NOT NULL UNIQUE,
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
`;
    await queryRows(createSavedTemplates);
  }

  // Backwards-compatible safety: older deployments may not have api_integrations yet.
  // Admin UI + OAuth onboarding rely on this table.
  try {
    await queryRows("SELECT 1 FROM api_integrations LIMIT 1");
  } catch {
    const createApiIntegrations = `
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
`;
    await queryRows(createApiIntegrations);
  }

  // Ensure page_name column exists (older schema may not have it).
  try {
    await queryRows("SELECT page_name FROM api_integrations LIMIT 1");
  } catch {
    try {
      await queryRows("ALTER TABLE api_integrations ADD COLUMN page_name VARCHAR(255) NOT NULL DEFAULT ''");
    } catch {
      // ignore
    }
  }

  
  // Ensure reply thread support column exists (backward compatible).
  try {
    await queryRows("SELECT reply_to_message_id FROM social_chat_messages LIMIT 1");
  } catch {
    try {
      await queryRows("ALTER TABLE social_chat_messages ADD COLUMN reply_to_message_id VARCHAR(36) NULL");
    } catch {
      // ignore (table may not exist yet in fresh install; auto-migrate will create it)
    }
  }

  // ✅ Ensure seller session invalidation support exists.
  // Older deployments may not have token_version on sellers.
  try {
    await queryRows("SELECT token_version FROM sellers LIMIT 1");
  } catch {
    try {
      await queryRows("ALTER TABLE sellers ADD COLUMN token_version INT NOT NULL DEFAULT 1");
    } catch {
      // ignore
    }
  }

  // ✅ Ensure read/unread tracking exists.
  // Store last-read timestamps per role on conversation_locks.
  try {
    await queryRows("SELECT seller_last_read_at, admin_last_read_at FROM conversation_locks LIMIT 1");
  } catch {
    try {
      await queryRows("ALTER TABLE conversation_locks ADD COLUMN seller_last_read_at DATETIME NULL");
    } catch {
      // ignore
    }
    try {
      await queryRows("ALTER TABLE conversation_locks ADD COLUMN admin_last_read_at DATETIME NULL");
    } catch {
      // ignore
    }
  }

const auto = String(process.env.MYSQL_AUTO_MIGRATE || "").toLowerCase();
  if (!(auto === "1" || auto === "true" || auto === "yes")) return;


  const schemaSql = `
CREATE TABLE IF NOT EXISTS sellers (
  id            VARCHAR(24) PRIMARY KEY,
  name          VARCHAR(255) DEFAULT '',
  first_name    VARCHAR(255) DEFAULT '',
  last_name     VARCHAR(255) DEFAULT '',
  phone         VARCHAR(64)  DEFAULT '',
  joining_date  VARCHAR(64)  DEFAULT '',
  image_data_url MEDIUMTEXT,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  token_version INT NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conversation_locks (
  conversation_id VARCHAR(128) PRIMARY KEY,
  seller_id       VARCHAR(24) NULL,
  locked_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seller_last_read_at DATETIME NULL,
  admin_last_read_at  DATETIME NULL,
  delivery_status ENUM('confirmed','hold','cancel','delivered') NOT NULL DEFAULT 'confirmed',
  assigned_by     VARCHAR(24) NULL,
  assigned_at     DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_seller_id (seller_id),
  KEY idx_delivery_status (delivery_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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

-- ✅ API Integrations (FB/IG/WhatsApp)
-- Store tokens in DB so UI can manage without editing .env manually.
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

-- ✅ Saved templates / quick replies (text + media)
-- - Admin creates GLOBAL templates
-- - Seller creates SELLER scoped templates
-- Media URLs are stored as JSON string of relative /uploads/... paths.

CREATE TABLE IF NOT EXISTS sub_admins (
  id                VARCHAR(24) PRIMARY KEY,
  email             VARCHAR(255) NOT NULL UNIQUE,
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
`;

  await queryRows(schemaSql);
}
