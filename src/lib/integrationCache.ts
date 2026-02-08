import { queryRows } from "./mysql";
import type { RowDataPacket } from "mysql2/promise";

type IntegrationRow = RowDataPacket & {
  platform: "facebook" | "instagram" | "whatsapp";
  page_id: string;
  page_token: string;
  is_active: number;
};

// Simple in-memory cache so hot paths (webhook handling) can synchronously read tokens.
// Refreshed at boot and whenever an integration is saved.
let _tokenByPageId: Record<string, string> = {};
let _loadedAt = 0;

export async function refreshIntegrationCache(): Promise<void> {
  try {
    const rows = await queryRows<IntegrationRow[]>(
      "SELECT platform,page_id,page_token,is_active FROM api_integrations WHERE is_active=1"
    );
    const next: Record<string, string> = {};
    for (const r of rows) {
      const pid = String(r.page_id || "").trim();
      const tok = String(r.page_token || "").trim();
      if (pid && tok) next[pid] = tok;
    }
    _tokenByPageId = next;
    _loadedAt = Date.now();
  } catch {
    // Ignore: DB may be offline at boot; callers will fall back to env.
  }
}

export function getCachedPageToken(pageId: string): string {
  const pid = String(pageId || "").trim();
  if (!pid) return "";
  return String(_tokenByPageId[pid] || "").trim();
}

export function getIntegrationCacheMeta() {
  return { loadedAt: _loadedAt, count: Object.keys(_tokenByPageId).length };
}
