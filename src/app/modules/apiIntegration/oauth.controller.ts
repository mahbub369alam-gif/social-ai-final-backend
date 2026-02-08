import { Request, Response } from "express";
import crypto from "crypto";
import { execResult, queryRows } from "../../../lib/mysql";
import { refreshIntegrationCache } from "../../../lib/integrationCache";
import type { RowDataPacket } from "mysql2/promise";
import {
  MetaPlatform,
  buildOAuthScopes,
  exchangeCodeForUserToken,
  fetchUserPages,
  subscribePageToWebhooks,
} from "./metaOAuth.service";

type Session = {
  platform: MetaPlatform;
  userAccessToken: string;
  createdAt: number;
  expiresInSec: number;
};

// In-memory state → token bridge.
// Good enough for single-instance deployments. If you scale horizontally,
// move this to Redis.
const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 60 min

function now() {
  return Date.now();
}

function cleanExpired() {
  const t = now();
  for (const [k, v] of sessions.entries()) {
    if (t - v.createdAt > SESSION_TTL_MS) sessions.delete(k);
  }
}

function mustEnv(name: string): string {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`${name} missing in .env`);
  return v;
}

function frontendRedirectUrl(platform: MetaPlatform, state: string): string {
  const base = String(process.env.FRONTEND_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  // Reuse existing admin route: /admin/api
  const tab = platform === "instagram" ? "instagram" : "facebook";
  return `${base}/admin/api?tab=${encodeURIComponent(tab)}&state=${encodeURIComponent(state)}`;
}

function backendCallbackUrl(platform: MetaPlatform): string {
  const base = String(process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}`)
    .replace(/\/$/, "");
  return `${base}/api/integrations/${platform}/oauth/callback`;
}

function buildDialogUrl(platform: MetaPlatform, state: string): string {
  const appId = mustEnv("META_APP_ID");
  const redirectUri = backendCallbackUrl(platform);
  const scopes = buildOAuthScopes(platform);
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: scopes,
  });
  return `https://www.facebook.com/dialog/oauth?${params.toString()}`;
}

const oauthStart = (platform: MetaPlatform) => async (_req: Request, res: Response) => {
  try {
    cleanExpired();
    // Generate state
    const state = crypto.randomBytes(18).toString("hex");
    // Create placeholder session (token will be stored at callback)
    sessions.set(state, {
      platform,
      userAccessToken: "",
      createdAt: now(),
      expiresInSec: 0,
    });

    const url = buildDialogUrl(platform, state);
    return res.redirect(url);
  } catch (e: any) {
    console.error("oauthStart error:", e);
    return res.status(500).send(`OAuth start failed: ${e?.message || ""}`);
  }
};

const oauthCallback = (platform: MetaPlatform) => async (req: Request, res: Response) => {
  try {
    cleanExpired();
    const code = String(req.query?.code || "");
    const state = String(req.query?.state || "");
    const err = String(req.query?.error_description || req.query?.error || "");
    if (err) {
      console.error("OAuth callback error:", err);
      return res.redirect(frontendRedirectUrl(platform, `error_${state || ""}`));
    }
    if (!code || !state) return res.status(400).send("Missing code/state");
    const sess = sessions.get(state);
    if (!sess || sess.platform !== platform) return res.status(400).send("Invalid state");

    const appId = mustEnv("META_APP_ID");
    const appSecret = mustEnv("META_APP_SECRET");
    const redirectUri = backendCallbackUrl(platform);

    const tokenRes = await exchangeCodeForUserToken({ code, redirectUri, appId, appSecret });
    sessions.set(state, {
      platform,
      userAccessToken: String(tokenRes.access_token || "").trim(),
      createdAt: now(),
      expiresInSec: Number(tokenRes.expires_in || 0),
    });

    return res.redirect(frontendRedirectUrl(platform, state));
  } catch (e: any) {
    console.error("oauthCallback error:", e?.response?.data || e);
    return res.status(500).send(`OAuth callback failed: ${e?.message || ""}`);
  }
};

const oauthPages = (platform: MetaPlatform) => async (req: Request, res: Response) => {
  try {
    cleanExpired();
    const state = String(req.query?.state || "").trim();
    if (!state) return res.status(400).json({ message: "state required" });
    const sess = sessions.get(state);
    if (!sess || sess.platform !== platform || !sess.userAccessToken) {
      return res.status(400).json({ message: "Invalid/expired state" });
    }

    const pages = await fetchUserPages(sess.userAccessToken);
    return res.json({ pages });
  } catch (e: any) {
    console.error("oauthPages error:", e?.response?.data || e);
    return res.status(500).json({ message: "Failed to fetch pages" });
  }
};

type IntegrationRow = RowDataPacket & {
  id: number;
  platform: "facebook" | "instagram" | "whatsapp";
  page_id: string;
  page_name: string;
  is_active: number;
  updated_at: any;
};

const oauthSelect = (platform: MetaPlatform) => async (req: Request, res: Response) => {
  try {
    cleanExpired();
    const state = String(req.body?.state || "").trim();
    const pageId = String(req.body?.pageId || "").trim();
    if (!state || !pageId) return res.status(400).json({ message: "state/pageId required" });
    const sess = sessions.get(state);
    if (!sess || sess.platform !== platform || !sess.userAccessToken) {
      return res.status(400).json({ message: "Invalid/expired state" });
    }

    const pages = await fetchUserPages(sess.userAccessToken);
    const page = pages.find((p) => p.id === pageId);
    if (!page) return res.status(400).json({ message: "Page not found for this user" });

    // Save integration (multi-page)
    await execResult(
      "INSERT INTO api_integrations (platform,page_id,page_name,page_token,is_active) VALUES (?,?,?,?,1) " +
        "ON DUPLICATE KEY UPDATE page_name=VALUES(page_name), page_token=VALUES(page_token), is_active=1, updated_at=CURRENT_TIMESTAMP",
      [platform, page.id, page.name, page.access_token]
    );

    // Try subscribe (best-effort)
    let warn = "";
    try {
      await subscribePageToWebhooks(page.id, page.access_token);
    } catch (e: any) {
      warn = "Saved, but could not auto-subscribe webhooks (check app permissions/roles).";
      console.warn("subscribePageToWebhooks warn:", e?.response?.data || e);
    }

    await refreshIntegrationCache();

    // Return current connected pages (active)
    const active = await queryRows<IntegrationRow[]>(
      "SELECT id,platform,page_id,page_name,is_active,updated_at FROM api_integrations WHERE platform=? AND is_active=1 ORDER BY updated_at DESC",
      [platform]
    );

    return res.json({ ok: true, page: { id: page.id, name: page.name }, warn, active });
  } catch (e: any) {
    console.error("oauthSelect error:", e?.response?.data || e);
    return res.status(500).json({ message: "Failed to add page" });
  }
};

export const OAuthIntegrationController = {
  facebook: {
    start: oauthStart("facebook"),
    callback: oauthCallback("facebook"),
    pages: oauthPages("facebook"),
    select: oauthSelect("facebook"),
  },
  instagram: {
    start: oauthStart("instagram"),
    callback: oauthCallback("instagram"),
    pages: oauthPages("instagram"),
    select: oauthSelect("instagram"),
  },
};
