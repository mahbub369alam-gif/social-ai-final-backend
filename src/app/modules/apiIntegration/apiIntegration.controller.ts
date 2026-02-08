import { Request, Response } from "express";
import { execResult, queryRows } from "../../../lib/mysql";
import { updateEnvFile } from "../../../lib/envFile";
import { refreshIntegrationCache } from "../../../lib/integrationCache";
import type { RowDataPacket } from "mysql2/promise";

// mysql2 typings: queryRows<T>() expects T extends RowDataPacket[].
// Define the row type as RowDataPacket to satisfy the constraint.
type IntegrationRow = RowDataPacket & {
  id: number;
  platform: "facebook" | "instagram" | "whatsapp";
  page_id: string;
  page_name?: string;
  page_token: string;
  is_active: number;
  created_at: any;
  updated_at: any;
};

const normalize = (s: any) => String(s || "").trim();

const getFacebook = async (_req: Request, res: Response) => {
  try {
    const rows = await queryRows<IntegrationRow[]>(
      "SELECT id,platform,page_id,page_token,is_active,created_at,updated_at FROM api_integrations WHERE platform='facebook' AND is_active=1 ORDER BY updated_at DESC, id DESC LIMIT 1"
    );

    const db = rows[0];

    // Fallback to env if DB empty
    const envPageId = normalize(process.env.FB_PAGE_ID || process.env.PAGE_ID_FB_1 || process.env.PAGE_ID);
    const envTok = normalize(process.env.FB_PAGE_ACCESS_TOKEN || process.env.PAGE_TOKEN_FB_1 || process.env.PAGE_ACCESS_TOKEN);

    return res.json({
      source: db ? "database" : envPageId && envTok ? "env" : "none",
      platform: "facebook",
      pageId: db ? normalize(db.page_id) : envPageId,
      pageTokenMasked: (db ? normalize(db.page_token) : envTok)
        ? maskToken(db ? normalize(db.page_token) : envTok)
        : "",
      updatedAt: db ? db.updated_at : null,
    });
  } catch (e) {
    console.error("getFacebook integration error:", e);
    return res.status(500).json({ message: "Failed to load integration" });
  }
};

const listActive = (platform: "facebook" | "instagram") => async (_req: Request, res: Response) => {
  try {
    const rows = await queryRows<IntegrationRow[]>(
      "SELECT id,platform,page_id,page_name,is_active,updated_at FROM api_integrations WHERE platform=? AND is_active=1 ORDER BY updated_at DESC, id DESC",
      [platform]
    );
    return res.json({ platform, pages: rows.map((r) => ({
      id: r.id,
      pageId: normalize(r.page_id),
      pageName: normalize((r as any).page_name),
      updatedAt: r.updated_at,
    })) });
  } catch (e) {
    console.error("listActive integration error:", e);
    return res.status(500).json({ message: "Failed to load pages" });
  }
};

const listFacebook = async (_req: Request, res: Response) => {
  try {
    const rows = await queryRows<IntegrationRow[]>(
      "SELECT id,platform,page_id,page_name,page_token,is_active,created_at,updated_at FROM api_integrations WHERE platform='facebook' AND is_active=1 ORDER BY updated_at DESC, id DESC"
    );
    return res.json({ pages: rows.map(r => ({
      id: r.id,
      pageId: normalize(r.page_id),
      pageName: normalize((r as any).page_name),
      updatedAt: r.updated_at,
      tokenMasked: maskToken(normalize(r.page_token)),
    }))});
  } catch (e) {
    console.error("listFacebook integration error:", e);
    return res.status(500).json({ message: "Failed to load pages" });
  }
};

const saveFacebook = async (req: Request, res: Response) => {
  try {
    const pageId = normalize(req.body?.pageId);
    const pageToken = normalize(req.body?.pageToken);

    if (!pageId || !pageToken) {
      return res.status(400).json({ message: "pageId/pageToken required" });
    }

    // 1) Persist to DB
    // Allow multiple pages. api_integrations has UNIQUE(platform,page_id)
    // so re-saving the same page should update token instead of throwing.
    await execResult(
      "INSERT INTO api_integrations (platform,page_id,page_name,page_token,is_active) VALUES ('facebook',?,'',?,1) " +
        "ON DUPLICATE KEY UPDATE page_token=VALUES(page_token), is_active=1, updated_at=CURRENT_TIMESTAMP",
      [pageId, pageToken]
    );

    // 2) Persist to .env (so restarts keep it)
    // Use both legacy + new keys because other code already supports these.
    const pairs: Record<string, string> = {
      FB_PAGE_ID: pageId,
      FB_PAGE_ACCESS_TOKEN: pageToken,
      PAGE_ID_FB_1: pageId,
      PAGE_TOKEN_FB_1: pageToken,
    };
    try {
      updateEnvFile(pairs);
    } catch (e) {
      console.error("Failed to update .env:", e);
      // DB already saved; still respond OK with warning
      return res.json({ ok: true, saved: "database", warn: "Saved to DB, but could not write .env" });
    }

    // 3) Update runtime env so it works immediately without restart (legacy fallback)
    for (const [k, v] of Object.entries(pairs)) {
      process.env[k] = v;
    }

    // 4) Refresh token cache used by webhook handlers
    await refreshIntegrationCache();

    return res.json({ ok: true, saved: "database+env" });
  } catch (e) {
    console.error("saveFacebook integration error:", e);
    return res.status(500).json({ message: "Failed to save integration" });
  }
};

function maskToken(token: string) {
  const t = normalize(token);
  if (t.length <= 8) return "********";
  return `${t.slice(0, 4)}********${t.slice(-4)}`;
}

export const ApiIntegrationController = {
  getFacebook,
  saveFacebook,
  listActiveFacebook: listActive("facebook"),
  listActiveInstagram: listActive("instagram"),
};
