import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { execResult, queryRows } from "../../../lib/mysql";
import { sendInviteEmail } from "../../../lib/mailer";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

/**
 * BOOTSTRAP SUPER ADMIN
 * ---------------------
 * We keep ADMIN_USERNAME / ADMIN_PASSWORD only as a *one-time bootstrap*.
 * After the first run, Super Admin lives in DB like any other admin.
 */
const getBootstrapSuperCreds = () => {
  const username = String(process.env.ADMIN_USERNAME || "admin").trim();
  const password = String(process.env.ADMIN_PASSWORD || "").trim();
  return { username, password };
};

type AdminType = "super" | "sub";

const signAdminToken = (payload: { id: string; email?: string; adminType: AdminType }) => {
  return jwt.sign(
    {
      id: payload.id,
      role: "admin",
      adminType: payload.adminType,
      email: payload.email || "",
      tokenVersion: (payload as any).tokenVersion || 0,
    },
    JWT_SECRET,
    {
      // Admin UI relies on this token for loading integrations (connected pages, etc.).
      // A short expiry makes connected pages appear to "disappear" after a while.
      // Keep this reasonably long for dashboard usage.
      expiresIn: "30d",
    }
  );
};

const newId24 = () => crypto.randomBytes(12).toString("hex");


const ensureAdminSecurityTables = async () => {
  // Create / evolve tables if migrations weren't run.
  await queryRows(`
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
  `);

  await queryRows(`
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
  `);

  await queryRows(`
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
  `);

  // Best-effort schema hardening for older deployments.
  const safeAlter = async (sql: string) => {
    try {
      await execResult(sql);
    } catch {
      // ignore
    }
  };

  await safeAlter("ALTER TABLE sub_admins ADD COLUMN token_version INT NOT NULL DEFAULT 1");
  await safeAlter("ALTER TABLE sub_admins ADD COLUMN must_set_password TINYINT(1) NOT NULL DEFAULT 0");
  await safeAlter("ALTER TABLE sub_admins ADD COLUMN admin_type VARCHAR(16) NOT NULL DEFAULT 'sub'");
  await safeAlter("ALTER TABLE sub_admins MODIFY COLUMN password_hash VARCHAR(255) NULL");

  // ✅ Seed a DB-based super admin once (if none exists).
  const existingSuper = await queryRows<any[]>(
    "SELECT id FROM sub_admins WHERE admin_type='super' LIMIT 1"
  );
  if (!existingSuper?.length) {
    const boot = getBootstrapSuperCreds();
    // Don't auto-create if password isn't provided.
    if (boot.password) {
      const email = String(process.env.ADMIN_EMAIL || boot.username || "admin").trim().toLowerCase();
      const hash = await bcrypt.hash(boot.password, 10);
      try {
        await execResult(
          "INSERT INTO sub_admins (id, email, admin_type, password_hash, must_set_password, is_active, token_version) VALUES (?,?, 'super', ?, 0, 1, 1)",
          [newId24(), email, hash]
        );
      } catch {
        // ignore duplicate insert in race conditions
      }
    }
  }
};

const sha256Hex = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

const getIp = (req: Request) => {
  const xf = String(req.headers["x-forwarded-for"] || "");
  const ip = xf.split(",")[0]?.trim();
  return ip || (req as any).ip || "unknown";
};

const logAudit = async (
  req: Request,
  args: {
    action: string;
    targetId?: string;
    targetEmail?: string;
    meta?: any;
  }
) => {
  try {
    const actorId = String((req as any)?.user?.id || "admin");
    const actorEmail = String((req as any)?.user?.email || "");
    const actorType = String((req as any)?.user?.adminType || "super");
    await execResult(
      "INSERT INTO admin_audit_logs (id, actor_id, actor_email, actor_type, action, target_id, target_email, ip, user_agent, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        newId24(),
        actorId,
        actorEmail || null,
        actorType,
        args.action,
        args.targetId || null,
        args.targetEmail || null,
        getIp(req),
        String(req.headers["user-agent"] || "") || null,
        args.meta ? JSON.stringify(args.meta) : null,
      ]
    );
  } catch {
    // audit logs must never break prod requests
  }
};

const isStrongPassword = (p: string) => {
  // 10+ chars, upper, lower, number, symbol
  if (!p || p.length < 10) return false;
  if (!/[a-z]/.test(p)) return false;
  if (!/[A-Z]/.test(p)) return false;
  if (!/[0-9]/.test(p)) return false;
  if (!/[^A-Za-z0-9]/.test(p)) return false;
  return true;
};

/**
 * POST /api/admin/login
 * - Super admin: username/password (from env)
 * - Sub admin:   email/password (stored in DB)
 * Returns admin JWT with { role:'admin', adminType:'super'|'sub' }
 */
const login = async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body || {};
    const inputU = String(username || "").trim();
    const inputP = String(password || "").trim();

    // ✅ Ensure tables + DB-based super admin (seed once)
    await ensureAdminSecurityTables();

    // ✅ 1) Try DB-based admin (super or sub)
    const rows = await queryRows<any[]>(
      "SELECT id, email, admin_type, password_hash, must_set_password, is_active, token_version FROM sub_admins WHERE email=? LIMIT 1",
      [String(inputU).trim().toLowerCase()]
    );

    if (!rows?.length) return res.status(401).json({ message: "Invalid credentials" });

    const sub = rows[0];
    if (!sub.is_active) return res.status(403).json({ message: "Account is disabled" });
    if (sub.must_set_password) return res.status(403).json({ message: "Please set your password using the invite link" });

    const ok = await bcrypt.compare(inputP, String(sub.password_hash || ""));
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const adminType: AdminType = (String(sub.admin_type || "sub") === "super" ? "super" : "sub") as AdminType;
    const token = signAdminToken({
      id: String(sub.id),
      adminType,
      email: String(sub.email),
      tokenVersion: Number(sub.token_version || 0),
    } as any);
    return res.json({ token, admin: { email: String(sub.email), adminType } });
  } catch (e) {
    console.error("admin login error:", e);
    return res.status(500).json({ message: "Login failed" });
  }
};

/**
 * SUPER ADMIN ONLY
 * GET /api/admin/sub-admins
 */
const listSubAdmins = async (_req: Request, res: Response) => {
  try {
    await ensureAdminSecurityTables();
    const rows = await queryRows<any[]>(
      "SELECT id, email, must_set_password, is_active, token_version, created_at, updated_at FROM sub_admins WHERE admin_type='sub' ORDER BY created_at DESC"
    );
    return res.json({ items: rows || [] });
  } catch (e) {
    console.error("listSubAdmins error:", e);
    return res.status(500).json({ message: "Failed to load sub admins" });
  }
};

/**
 * SUPER ADMIN ONLY
 * POST /api/admin/sub-admins
 * body: { email, password }
 */
const createSubAdmin = async (req: Request, res: Response) => {
  try {
    await ensureAdminSecurityTables();
    const { email, password } = req.body || {};
    const e = String(email || "").trim().toLowerCase();
    const p = String(password || "").trim();

    if (!e || !p) return res.status(400).json({ message: "Email and password are required" });
    if (!isStrongPassword(p)) return res.status(400).json({ message: "Password must be 10+ chars with upper, lower, number, symbol" });

    const existing = await queryRows<any[]>("SELECT id FROM sub_admins WHERE email=? LIMIT 1", [e]);
    if (existing?.length) return res.status(409).json({ message: "Email already exists" });

    const id = newId24();
    const hash = await bcrypt.hash(p, 10);

    await execResult(
      "INSERT INTO sub_admins (id, email, admin_type, password_hash, must_set_password, is_active, token_version) VALUES (?,?, 'sub', ?,0,1,1)",
      [id, e, hash]
    );
    await logAudit(req, { action: "SUB_ADMIN_CREATED", targetId: id, targetEmail: e });
    return res.status(201).json({ id, email: e });
  } catch (e) {
    console.error("createSubAdmin error:", e);
    return res.status(500).json({ message: "Failed to create sub admin" });
  }
};

/**
 * SUPER ADMIN ONLY
 * PATCH /api/admin/sub-admins/:id
 * body: { is_active?, password? }
 */
const updateSubAdmin = async (req: Request, res: Response) => {
  try {
    await ensureAdminSecurityTables();
    const id = String(req.params.id || "").trim();
    const { is_active, password } = req.body || {};

    if (!id) return res.status(400).json({ message: "Missing id" });

    const updates: string[] = [];
    const params: any[] = [];

    let shouldRevoke = false;
    if (typeof is_active !== "undefined") {
      updates.push("is_active=?");
      params.push(is_active ? 1 : 0);
      // disabling should revoke sessions
      if (!is_active) shouldRevoke = true;
    }

    if (typeof password !== "undefined") {
      const p = String(password || "").trim();
      if (!isStrongPassword(p)) return res.status(400).json({ message: "Password must be 10+ chars with upper, lower, number, symbol" });
      const hash = await bcrypt.hash(p, 10);
      updates.push("password_hash=?");
      params.push(hash);
      updates.push("must_set_password=0");
      shouldRevoke = true;
    }

    if (shouldRevoke) {
      updates.push("token_version = token_version + 1");
    }

    if (!updates.length) return res.status(400).json({ message: "Nothing to update" });

    params.push(id);
    await execResult(`UPDATE sub_admins SET ${updates.join(", ")} WHERE id=?`, params);

    await logAudit(req, {
      action: "SUB_ADMIN_UPDATED",
      targetId: id,
      meta: { is_active: typeof is_active !== "undefined" ? !!is_active : undefined, passwordChanged: typeof password !== "undefined" },
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("updateSubAdmin error:", e);
    return res.status(500).json({ message: "Failed to update sub admin" });
  }
};

/**
 * SUPER ADMIN ONLY
 * DELETE /api/admin/sub-admins/:id
 */
const deleteSubAdmin = async (req: Request, res: Response) => {
  try {
    await ensureAdminSecurityTables();
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ message: "Missing id" });

    const rows = await queryRows<any[]>("SELECT email FROM sub_admins WHERE id=? LIMIT 1", [id]);
    await execResult("DELETE FROM sub_admins WHERE id=?", [id]);
    await logAudit(req, { action: "SUB_ADMIN_DELETED", targetId: id, targetEmail: rows?.[0]?.email });
    return res.json({ ok: true });
  } catch (e) {
    console.error("deleteSubAdmin error:", e);
    return res.status(500).json({ message: "Failed to delete sub admin" });
  }
};

/**
 * SUPER ADMIN ONLY
 * POST /api/admin/sub-admins/invite
 * body: { email }
 * Returns: { subAdminId, email, inviteLink }
 */
const inviteSubAdmin = async (req: Request, res: Response) => {
  try {
    await ensureAdminSecurityTables();
    const { email } = req.body || {};
    const e = String(email || "").trim().toLowerCase();
    if (!e) return res.status(400).json({ message: "Email is required" });

    // Create (or reuse) sub admin row in 'must_set_password' state
    const existing = await queryRows<any[]>("SELECT id, is_active FROM sub_admins WHERE email=? LIMIT 1", [e]);
    let subId = existing?.[0]?.id as string | undefined;
    if (existing?.length) {
      if (!existing[0].is_active) return res.status(403).json({ message: "This account is disabled" });
      // Keep existing id
      await execResult("UPDATE sub_admins SET must_set_password=1 WHERE id=?", [subId]);
    } else {
      subId = newId24();
      await execResult(
        "INSERT INTO sub_admins (id, email, admin_type, password_hash, must_set_password, is_active, token_version) VALUES (?,?, 'sub', NULL,1,1,1)",
        [subId, e]
      );
    }

    // Create invite token (store hash)
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256Hex(rawToken);
    const inviteId = newId24();
    await execResult(
      "INSERT INTO sub_admin_invites (id, sub_admin_id, token_hash, expires_at, used_at) VALUES (?,?,?,?,NULL)",
      [inviteId, subId, tokenHash, new Date(Date.now() + 30 * 60 * 1000)]
    );

    // Revoke any existing sessions (so disable/reset is immediate)
    await execResult("UPDATE sub_admins SET token_version = token_version + 1 WHERE id=?", [subId]);

    const uiBase = String(process.env.PUBLIC_UI_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
    const inviteLink = `${uiBase}/admin/accept-invite?token=${rawToken}`;

    await logAudit(req, { action: "SUB_ADMIN_INVITED", targetId: subId, targetEmail: e });

let emailed = false;
try {
  await sendInviteEmail(e, inviteLink);
  emailed = true;
  await logAudit(req, { action: "SUB_ADMIN_INVITE_EMAIL_SENT", targetId: subId, targetEmail: e });
} catch (mailErr) {
  console.warn("Invite email failed (will still return link):", mailErr);
  await logAudit(req, {
    action: "SUB_ADMIN_INVITE_EMAIL_FAILED",
    targetId: subId,
    targetEmail: e,
    meta: { error: String((mailErr as any)?.message || mailErr) },
  });
}

return res.status(201).json({ subAdminId: subId, email: e, inviteLink, emailed });

  } catch (e) {
    console.error("inviteSubAdmin error:", e);
    return res.status(500).json({ message: "Failed to create invite" });
  }
};

/**
 * POST /api/admin/accept-invite
 * body: { token, password }
 */
const acceptInvite = async (req: Request, res: Response) => {
  try {
    await ensureAdminSecurityTables();
    const { token, password } = req.body || {};
    const raw = String(token || "").trim();
    const p = String(password || "").trim();
    if (!raw || !p) return res.status(400).json({ message: "Token and password are required" });
    if (!isStrongPassword(p)) return res.status(400).json({ message: "Password must be 10+ chars with upper, lower, number, symbol" });

    const tokenHash = sha256Hex(raw);
    const rows = await queryRows<any[]>(
      "SELECT id, sub_admin_id, expires_at, used_at FROM sub_admin_invites WHERE token_hash=? ORDER BY created_at DESC LIMIT 1",
      [tokenHash]
    );
    if (!rows?.length) return res.status(400).json({ message: "Invalid invite token" });
    const inv = rows[0];
    if (inv.used_at) return res.status(400).json({ message: "Invite token already used" });
    const exp = new Date(inv.expires_at);
    if (exp.getTime() < Date.now()) return res.status(400).json({ message: "Invite token expired" });

    const subId = String(inv.sub_admin_id);
    const subRows = await queryRows<any[]>("SELECT email, is_active FROM sub_admins WHERE id=? LIMIT 1", [subId]);
    if (!subRows?.length) return res.status(400).json({ message: "Account not found" });
    if (!subRows[0].is_active) return res.status(403).json({ message: "Account is disabled" });

    const hash = await bcrypt.hash(p, 10);
    await execResult(
      "UPDATE sub_admins SET password_hash=?, must_set_password=0, token_version = token_version + 1 WHERE id=?",
      [hash, subId]
    );
    await execResult("UPDATE sub_admin_invites SET used_at=NOW() WHERE id=?", [String(inv.id)]);

    // Best-effort audit (no actor here)
    await execResult(
      "INSERT INTO admin_audit_logs (id, actor_id, actor_email, actor_type, action, target_id, target_email, ip, user_agent, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        newId24(),
        subId,
        String(subRows[0].email || ""),
        "sub",
        "SUB_ADMIN_ACCEPT_INVITE",
        subId,
        String(subRows[0].email || ""),
        getIp(req),
        String(req.headers["user-agent"] || "") || null,
        null,
      ]
    );

    return res.json({ ok: true, email: String(subRows[0].email || "") });
  } catch (e) {
    console.error("acceptInvite error:", e);
    return res.status(500).json({ message: "Failed to set password" });
  }
};

/**
 * SUPER ADMIN ONLY
 * GET /api/admin/audit-logs?limit=50
 */
const listAuditLogs = async (req: Request, res: Response) => {
  try {
    await ensureAdminSecurityTables();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await queryRows<any[]>(
      "SELECT id, actor_id, actor_email, actor_type, action, target_id, target_email, ip, created_at, meta_json FROM admin_audit_logs ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    return res.json({ items: rows || [] });
  } catch (e) {
    console.error("listAuditLogs error:", e);
    return res.status(500).json({ message: "Failed to load audit logs" });
  }
};

/**
 * ADMIN (super/sub)
 * GET /api/admin/me
 */
const me = async (req: Request, res: Response) => {
  try {
    const u: any = (req as any).user || null;
    if (!u) return res.status(401).json({ message: "Unauthorized" });
    return res.json({
      id: String(u.id || ""),
      role: "admin",
      adminType: (u.adminType === "super" ? "super" : "sub") as AdminType,
      email: String(u.email || ""),
    });
  } catch {
    return res.status(500).json({ message: "Failed" });
  }
};

/**
 * ADMIN (super/sub)
 * POST /api/admin/change-password
 * body: { oldPassword, newPassword }
 */
const changePassword = async (req: Request, res: Response) => {
  try {
    await ensureAdminSecurityTables();
    const u: any = (req as any).user || null;
    if (!u?.id) return res.status(401).json({ message: "Unauthorized" });

    const { oldPassword, newPassword } = req.body || {};
    const oldP = String(oldPassword || "").trim();
    const newP = String(newPassword || "").trim();
    if (!oldP || !newP) return res.status(400).json({ message: "Old and new password are required" });
    if (!isStrongPassword(newP)) return res.status(400).json({ message: "Password must be 10+ chars with upper, lower, number, symbol" });

    const rows = await queryRows<any[]>(
      "SELECT id, email, password_hash, admin_type, is_active, token_version FROM sub_admins WHERE id=? LIMIT 1",
      [String(u.id)]
    );
    if (!rows?.length) return res.status(404).json({ message: "Account not found" });
    const a = rows[0];
    if (!a.is_active) return res.status(403).json({ message: "Account is disabled" });

    const ok = await bcrypt.compare(oldP, String(a.password_hash || ""));
    if (!ok) return res.status(401).json({ message: "Old password is incorrect" });

    const hash = await bcrypt.hash(newP, 10);
    await execResult(
      "UPDATE sub_admins SET password_hash=?, must_set_password=0, token_version=token_version+1 WHERE id=?",
      [hash, String(u.id)]
    );

    await logAudit(req, {
      action: "ADMIN_PASSWORD_CHANGED",
      targetId: String(u.id),
      targetEmail: String(a.email || ""),
      meta: { adminType: String(a.admin_type || "sub") },
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("changePassword error:", e);
    return res.status(500).json({ message: "Failed to change password" });
  }
};

export const AdminController = {
  login,
  me,
  changePassword,
  listSubAdmins,
  createSubAdmin,
  updateSubAdmin,
  deleteSubAdmin,
  inviteSubAdmin,
  acceptInvite,
  listAuditLogs,
};
