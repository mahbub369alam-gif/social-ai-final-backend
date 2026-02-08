import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export type AuthedRequest = Request & {
  user?: { role: "admin" | "seller"; sellerId: string };
};

export const requireAdminKey = (req: Request, res: Response, next: NextFunction) => {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({ message: "ADMIN_KEY not set in env" });
  }
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ message: "Unauthorized (admin key)" });
  }

  (req as AuthedRequest).user = { role: "admin", sellerId: "admin" };
  next();
};

export const requireSellerAuth = (req: Request, res: Response, next: NextFunction) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) return res.status(401).json({ message: "Unauthorized (no token)" });
  if (!process.env.JWT_SECRET) return res.status(500).json({ message: "JWT_SECRET not set in env" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as any;

    // ✅ seller.controller.ts token payload অনুযায়ী
    const sellerId = decoded?.sellerId;
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized (token invalid/expired)" });
    }

    (req as AuthedRequest).user = { role: "seller", sellerId: String(sellerId) };
    next();
  } catch {
    return res.status(401).json({ message: "Unauthorized (token invalid/expired)" });
  }
};

export const requireAdminOrSeller = (req: Request, res: Response, next: NextFunction) => {
  // ✅ admin key থাকলে admin
  const key = req.headers["x-admin-key"];
  if (process.env.ADMIN_KEY && key && key === process.env.ADMIN_KEY) {
    (req as AuthedRequest).user = { role: "admin", sellerId: "admin" };
    return next();
  }
  // ✅ না হলে seller token
  return requireSellerAuth(req, res, next);
};
