import { NextFunction, Request, Response } from "express";

/**
 * Simple in-memory rate limiter (no extra deps).
 * - Window: 10 minutes
 * - Max attempts per key: 5
 *
 * Key strategy: `${ip}|${username}` to slow both IP-based and account-guessing attacks.
 *
 * NOTE: In multi-instance production, use Redis.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const getIp = (req: Request) => {
  const xf = String(req.headers["x-forwarded-for"] || "");
  const ip = xf.split(",")[0]?.trim();
  return ip || req.ip || "unknown";
};

export const rateLimitAdminLogin = (req: Request, res: Response, next: NextFunction) => {
  try {
    const ip = getIp(req);
    const u = String((req.body || {}).username || "").trim().toLowerCase();
    const key = `${ip}|${u || "_"}`;

    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return next();
    }

    existing.count += 1;
    buckets.set(key, existing);

    if (existing.count > MAX_ATTEMPTS) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ message: `Too many login attempts. Try again in ${retryAfterSec}s.` });
    }

    return next();
  } catch {
    // fail open (rate limit should not block logins on unexpected errors)
    return next();
  }
};
