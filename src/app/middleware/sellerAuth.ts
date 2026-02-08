import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export type SellerJwtPayload = {
  sellerId: string;
  email: string;
  role: "seller";
};

declare global {
  namespace Express {
    interface Request {
      seller?: SellerJwtPayload;
    }
  }
}

export const requireSellerAuth = (req: Request, res: Response, next: NextFunction) => {
  try {
    const token =
      (req as any).cookies?.seller_token ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice("Bearer ".length)
        : "");

    if (!token) return res.status(401).json({ message: "Unauthorized (seller token missing)" });

    const secret = process.env.JWT_SECRET as string;
    if (!secret) return res.status(500).json({ message: "JWT_SECRET missing in .env" });

    const decoded = jwt.verify(token, secret) as SellerJwtPayload;

    if (!decoded?.sellerId || decoded?.role !== "seller") {
      return res.status(401).json({ message: "Unauthorized (invalid seller token)" });
    }

    req.seller = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ message: "Unauthorized (token invalid/expired)" });
  }
};
