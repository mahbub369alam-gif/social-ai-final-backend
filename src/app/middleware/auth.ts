import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { queryRows } from "../../lib/mysql";

// NOTE: historically seller token payload used `{ id, role: 'seller' }`.
// Some older code expected `{ sellerId }`. We support both for compatibility.
type JwtPayload = {
  id: string;
  role: "seller" | "admin";
  sellerId?: string;
  adminType?: "super" | "sub";
  email?: string;
  tokenVersion?: number;
};

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

const tryParseBearer = (req: Request): JwtPayload | null => {
  try {
    const h = String(req.headers.authorization || "");
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
};

const validateAdminSession = async (decoded: JwtPayload): Promise<JwtPayload | null> => {
  try {
    if (decoded.role !== "admin") return decoded;

    const adminId = String((decoded as any).id || "");
    const tokenVersion = Number((decoded as any).tokenVersion || 0);

    // Legacy/simplified super-admin tokens used id="admin".
    // We allow them for backwards compatibility.
    if (!adminId || adminId === "admin") return decoded;

    // Fail closed if DB is down.
    const rows = await queryRows<any[]>("SELECT is_active, token_version FROM sub_admins WHERE id=? LIMIT 1", [adminId]);
    if (!rows?.length) return null;
    const r = rows[0];
    if (!r.is_active) return null;
    const currentVersion = Number(r.token_version || 0);
    if (currentVersion !== tokenVersion) return null;
    return decoded;
  } catch {
    return null;
  }
};

const validateSellerSession = async (decoded: JwtPayload): Promise<JwtPayload | null> => {
  try {
    if (decoded.role !== "seller") return decoded;

    const sellerId = String((decoded as any)?.sellerId || (decoded as any)?.id || "");
    const tokenVersion = Number((decoded as any)?.tokenVersion || 0);
    if (!sellerId) return null;

    // Fail closed if DB is down.
    const rows = await queryRows<any[]>("SELECT is_active, token_version FROM sellers WHERE id=? LIMIT 1", [sellerId]);
    if (!rows?.length) return null;
    const r = rows[0];
    if (!r.is_active) return null;
    const currentVersion = Number(r.token_version || 0);
    // If tokenVersion missing (old tokens), treat as invalid for safety.
    if (!tokenVersion || currentVersion !== tokenVersion) return null;

    return { id: sellerId, role: "seller", tokenVersion };
  } catch {
    return null;
  }
};

export const authOptional = (req: Request, _res: Response, next: NextFunction) => {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return next();

    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = decoded;
    return next();
  } catch {
    // invalid token -> treat as unauth
    return next();
  }
};

export const requireSellerAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const h = String(req.headers.authorization || "");
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ message: "Unauthorized (no token)" });

    const decoded0 = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const decoded = await validateSellerSession(decoded0);
    if (!decoded) return res.status(401).json({ message: "Unauthorized (token invalid/expired)" });

    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ message: "Unauthorized (token invalid/expired)" });
  }
};

export const requireAdminOrSeller = async (req: Request, res: Response, next: NextFunction) => {
  const key = String(req.headers["x-admin-key"] || "");
  const expected = String(process.env.ADMIN_API_KEY || "");

  // ✅ Admin (by key)
  if (expected && key && key === expected) {
    req.user = { id: "admin", role: "admin", adminType: "super" };
    return next();
  }

  // ✅ Admin (by JWT)
  const decoded0 = tryParseBearer(req);
  if (decoded0 && decoded0.role === "admin") {
    const decoded = await validateAdminSession(decoded0);
    if (!decoded) return res.status(401).json({ message: "Unauthorized (token invalid/expired)" });
    req.user = {
      id: String((decoded as any).id || "admin"),
      role: "admin",
      adminType: (decoded as any).adminType || "super",
      email: (decoded as any).email,
      tokenVersion: (decoded as any).tokenVersion,
    };
    return next();
  }

  // ✅ Otherwise must be seller token (validated against DB)
  return requireSellerAuth(req, res, next);
};

export const requireAdminKey = async (req: Request, res: Response, next: NextFunction) => {
  // Allow admin JWT as well (for UI login)
  const decoded0 = tryParseBearer(req);
  if (decoded0 && decoded0.role === "admin") {
    const decoded = await validateAdminSession(decoded0);
    if (!decoded) return res.status(401).json({ message: "Unauthorized (token invalid/expired)" });
    req.user = {
      id: String((decoded as any).id || "admin"),
      role: "admin",
      adminType: (decoded as any).adminType || "super",
      email: (decoded as any).email,
      tokenVersion: (decoded as any).tokenVersion,
    };
    return next();
  }

  const key = String(req.headers["x-admin-key"] || "");
  const expected = String(process.env.ADMIN_API_KEY || "");
  if (!expected) return res.status(500).json({ message: "ADMIN_API_KEY missing in .env" });
  if (key !== expected) return res.status(401).json({ message: "Unauthorized" });
  return next();
};


export const requireSuperAdmin = async (req: Request, res: Response, next: NextFunction) => {
  // ✅ Super admin via x-admin-key (legacy master key)
  const key = String(req.headers["x-admin-key"] || "");
  const expected = String(process.env.ADMIN_API_KEY || "");
  if (expected && key && key === expected) {
    req.user = { id: "admin", role: "admin", adminType: "super" };
    return next();
  }

  // ✅ Super admin via JWT (adminType=super)
  const decoded0 = tryParseBearer(req);
  if (decoded0 && decoded0.role === "admin" && (decoded0 as any).adminType === "super") {
    const decoded = await validateAdminSession(decoded0);
    if (!decoded) return res.status(401).json({ message: "Unauthorized (token invalid/expired)" });
    req.user = { id: String((decoded as any).id || "admin"), role: "admin", adminType: "super", email: (decoded as any).email };
    return next();
  }

  return res.status(403).json({ message: "Forbidden (super admin only)" });
};
