import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { execResult, queryRows } from "../../../lib/mysql";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

const signToken = (id: string, tokenVersion: number) => {
  // keep both keys for backwards compatibility
  return jwt.sign({ id, sellerId: id, role: "seller", tokenVersion }, JWT_SECRET, { expiresIn: "30d" });
};

const newId24 = () => crypto.randomBytes(12).toString("hex");

/**
 * Admin creates seller (DB persist)
 * Protected by x-admin-key
 */
const createSeller = async (req: Request, res: Response) => {
  try {
    const { name, firstName, lastName, phone, joiningDate, imageDataUrl, email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "email/password required" });
    }

    const normEmail = String(email).toLowerCase().trim();
    const existing = await queryRows<any[]>("SELECT id FROM sellers WHERE email=? LIMIT 1", [normEmail]);
    if (existing.length) return res.status(409).json({ message: "Seller already exists" });

    const passwordHash = await bcrypt.hash(String(password), 10);

    const fullName = String(
      (name && String(name).trim()) || `${String(firstName || "").trim()} ${String(lastName || "").trim()}`
    ).trim();

    const id = newId24();
    await execResult(
      `INSERT INTO sellers
        (id,name,first_name,last_name,phone,joining_date,image_data_url,email,password_hash,is_active)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
      [
        id,
        fullName,
        String(firstName || ""),
        String(lastName || ""),
        String(phone || ""),
        String(joiningDate || ""),
        String(imageDataUrl || ""),
        normEmail,
        passwordHash,
      ]
    );

    const created = await queryRows<any[]>(
      "SELECT id,name,email,is_active,created_at FROM sellers WHERE id=? LIMIT 1",
      [id]
    );
    const seller = created[0];

    return res.json({
      id: String(seller.id),
      name: seller.name,
      email: seller.email,
      isActive: Boolean(seller.is_active),
      createdAt: seller.created_at,
    });
  } catch (e) {
    console.error("createSeller error:", e);
    return res.status(500).json({ message: "Failed to create seller" });
  }
};

/**
 * Admin list sellers (DB persist)
 * Protected by x-admin-key
 */
const listSellers = async (_req: Request, res: Response) => {
  try {
    const sellers = await queryRows<any[]>(
      "SELECT id,name,email,is_active,created_at FROM sellers WHERE is_active=1 ORDER BY created_at DESC LIMIT 500"
    );

    return res.json(
      sellers.map((s: any) => ({
        id: String(s.id),
        name: s.name,
        email: s.email,
        isActive: Boolean(s.is_active),
        createdAt: s.created_at,
      }))
    );
  } catch (e) {
    console.error("listSellers error:", e);
    return res.status(500).json({ message: "Failed to load sellers" });
  }
};

/**
 * Seller login -> JWT token
 */
const loginSeller = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: "email/password required" });

    const normEmail = String(email).toLowerCase().trim();
    const rows = await queryRows<any[]>(
      "SELECT id,name,email,password_hash,is_active,token_version FROM sellers WHERE email=? LIMIT 1",
      [normEmail]
    );
    const seller = rows[0];
    if (!seller || !seller.is_active) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(String(password), seller.password_hash);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = signToken(String(seller.id), Number(seller.token_version || 1));

    return res.json({
      token,
      seller: { id: String(seller.id), name: seller.name, email: seller.email },
    });
  } catch (e) {
    console.error("loginSeller error:", e);
    return res.status(500).json({ message: "Login failed" });
  }
};

/**
 * Admin deletes/deactivates a seller
 * Protected by x-admin-key
 */
const deleteSeller = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    if (!id) return res.status(400).json({ message: "Seller id required" });

    const srows = await queryRows<any[]>("SELECT id FROM sellers WHERE id=? LIMIT 1", [id]);
    if (!srows.length) return res.status(404).json({ message: "Seller not found" });

    // ✅ Soft-delete (deactivate) so we can immediately revoke existing sessions.
    // UI already filters by is_active=1, so seller will disappear from list.
    await execResult("UPDATE conversation_locks SET seller_id=NULL, assigned_at=NULL WHERE seller_id=?", [id]);
    await execResult(
      "UPDATE sellers SET is_active=0, token_version=token_version+1, updated_at=NOW() WHERE id=?",
      [id]
    );

    return res.json({ ok: true, deleted: true, deactivated: true });
  } catch (e) {
    console.error("deleteSeller error:", e);
    return res.status(500).json({ message: "Failed to delete seller" });
  }
};

export const SellerController = {
  createSeller,
  listSellers,
  loginSeller,
  deleteSeller,
};
