import { Request, Response } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { execResult, queryRows } from "../../../lib/mysql";

type SavedTemplateRow = RowDataPacket & {
  id: number;
  scope: "global" | "seller";
  seller_id: string | null;
  title: string;
  type: "text" | "media";
  text: string | null;
  media_urls_json: string | null;
  created_at: any;
  updated_at: any;
};

const safe = (v: any) => String(v ?? "").trim();

const parseMediaUrls = (s: any): string[] => {
  const raw = safe(s);
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.map((x) => safe(x)).filter(Boolean) : [];
  } catch {
    // fallback: newline separated
    return raw
      .split("\n")
      .map((x) => safe(x))
      .filter(Boolean);
  }
};

const stringifyMediaUrls = (arr: any): string => {
  const urls = (Array.isArray(arr) ? arr : [])
    .map((x) => safe(x))
    .filter(Boolean);
  return JSON.stringify(urls);
};

const getAccessWhere = (req: Request) => {
  const role = String((req.user as any)?.role || "");
  const id = String((req.user as any)?.id || "");

  // Admin can see/manage all templates.
  if (role === "admin") {
    return { sql: "1=1", params: [] as any[] };
  }

  // Seller: global + own seller-scoped templates
  return {
    sql: "(scope='global' OR (scope='seller' AND seller_id=?))",
    params: [id],
  };
};

const list = async (req: Request, res: Response) => {
  try {
    const type = safe((req.query as any)?.type);
    const q = safe((req.query as any)?.q);
    const { sql, params } = getAccessWhere(req);

    const where: string[] = [sql];
    const p: any[] = [...params];

    if (type === "text" || type === "media") {
      where.push("type=?");
      p.push(type);
    }
    if (q) {
      where.push("(title LIKE ? OR text LIKE ?)");
      p.push(`%${q}%`, `%${q}%`);
    }

    const rows = await queryRows<SavedTemplateRow[]>(
      `SELECT id,scope,seller_id,title,type,text,media_urls_json,created_at,updated_at
       FROM saved_templates
       WHERE ${where.join(" AND ")}
       ORDER BY updated_at DESC, id DESC
       LIMIT 500`,
      p
    );

    return res.json(
      rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        sellerId: r.seller_id,
        title: r.title || "",
        type: r.type,
        text: r.text || "",
        mediaUrls: parseMediaUrls(r.media_urls_json),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    );
  } catch (e) {
    console.error("savedTemplate.list error:", e);
    return res.status(500).json({ message: "Failed to list templates" });
  }
};

const createText = async (req: Request, res: Response) => {
  try {
    const role = String((req.user as any)?.role || "");
    const actorId = String((req.user as any)?.id || "");

    const title = safe((req.body as any)?.title);
    const text = safe((req.body as any)?.text);
    let scope = safe((req.body as any)?.scope) as any;

    if (!title) return res.status(400).json({ message: "title required" });
    if (!text) return res.status(400).json({ message: "text required" });

    // default scope
    if (role === "admin") scope = scope === "seller" ? "seller" : "global";
    else scope = "seller";

    const sellerId = role === "seller" ? actorId : scope === "seller" ? safe((req.body as any)?.sellerId) : null;

    // sellers cannot create global
    if (role !== "admin") {
      scope = "seller";
    }

    await execResult(
      "INSERT INTO saved_templates (scope,seller_id,title,type,text,media_urls_json) VALUES (?,?,?,?,?,?)",
      [scope, sellerId || null, title, "text", text, null]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("savedTemplate.createText error:", e);
    return res.status(500).json({ message: "Failed to create template" });
  }
};

const createMedia = async (req: Request, res: Response) => {
  try {
    const role = String((req.user as any)?.role || "");
    const actorId = String((req.user as any)?.id || "");

    const title = safe((req.body as any)?.title);
    let scope = safe((req.body as any)?.scope) as any;
    if (!title) return res.status(400).json({ message: "title required" });

    // default scope
    if (role === "admin") scope = scope === "seller" ? "seller" : "global";
    else scope = "seller";

    // sellers cannot create global
    if (role !== "admin") scope = "seller";

    const sellerId = role === "seller" ? actorId : scope === "seller" ? safe((req.body as any)?.sellerId) : null;

    const filesField = (req as any).files as Record<string, Express.Multer.File[]> | undefined;
    const allFiles: Express.Multer.File[] = [];
    if (filesField?.files?.length) allFiles.push(...filesField.files);
    if (filesField?.file?.length) allFiles.push(...filesField.file);

    if (!allFiles.length) return res.status(400).json({ message: "No files uploaded" });

    const urls = allFiles
      .map((f) => safe((f as any)?.filename))
      .filter(Boolean)
      .map((name) => `/uploads/${encodeURIComponent(name)}`);

    await execResult(
      "INSERT INTO saved_templates (scope,seller_id,title,type,text,media_urls_json) VALUES (?,?,?,?,?,?)",
      [scope, sellerId || null, title, "media", null, stringifyMediaUrls(urls)]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("savedTemplate.createMedia error:", e);
    return res.status(500).json({ message: "Failed to create media template" });
  }
};

const update = async (req: Request, res: Response) => {
  try {
    const id = Number((req.params as any)?.id);
    if (!id) return res.status(400).json({ message: "id required" });

    // load + enforce access
    const { sql, params } = getAccessWhere(req);
    const rows = await queryRows<SavedTemplateRow[]>(
      `SELECT id,scope,seller_id,title,type,text,media_urls_json FROM saved_templates WHERE id=? AND ${sql} LIMIT 1`,
      [id, ...params]
    );
    const cur = rows[0];
    if (!cur) return res.status(404).json({ message: "Not found" });

    const role = String((req.user as any)?.role || "");
    const actorId = String((req.user as any)?.id || "");

    let title = safe((req.body as any)?.title);
    let text = safe((req.body as any)?.text);
    let scope = safe((req.body as any)?.scope) as any;

    // If multipart update, parse files
    const filesField = (req as any).files as Record<string, Express.Multer.File[]> | undefined;
    const allFiles: Express.Multer.File[] = [];
    if (filesField?.files?.length) allFiles.push(...filesField.files);
    if (filesField?.file?.length) allFiles.push(...filesField.file);

    // keep defaults
    if (!title) title = cur.title || "";

    // scope rules
    if (role !== "admin") {
      scope = "seller";
    } else {
      if (scope !== "seller" && scope !== "global") scope = cur.scope;
    }

    const sellerId = role === "seller" ? actorId : scope === "seller" ? safe((req.body as any)?.sellerId) || cur.seller_id : null;

    if (cur.type === "text") {
      if (!text) text = cur.text || "";
      await execResult(
        "UPDATE saved_templates SET title=?, scope=?, seller_id=?, text=? WHERE id=?",
        [title, scope, sellerId || null, text, id]
      );
      return res.json({ ok: true });
    }

    // media template
    let mediaUrls = parseMediaUrls(cur.media_urls_json);
    const incomingUrls = (req.body as any)?.mediaUrls;
    if (Array.isArray(incomingUrls)) {
      mediaUrls = incomingUrls.map((x: any) => safe(x)).filter(Boolean);
    }

    if (allFiles.length) {
      const newUrls = allFiles
        .map((f) => safe((f as any)?.filename))
        .filter(Boolean)
        .map((name) => `/uploads/${encodeURIComponent(name)}`);
      mediaUrls = newUrls;
    }

    await execResult(
      "UPDATE saved_templates SET title=?, scope=?, seller_id=?, media_urls_json=? WHERE id=?",
      [title, scope, sellerId || null, stringifyMediaUrls(mediaUrls), id]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("savedTemplate.update error:", e);
    return res.status(500).json({ message: "Failed to update template" });
  }
};

const remove = async (req: Request, res: Response) => {
  try {
    const id = Number((req.params as any)?.id);
    if (!id) return res.status(400).json({ message: "id required" });

    const { sql, params } = getAccessWhere(req);
    const r = await execResult(
      `DELETE FROM saved_templates WHERE id=? AND ${sql}`,
      [id, ...params]
    );

    if (!r.affectedRows) return res.status(404).json({ message: "Not found" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("savedTemplate.remove error:", e);
    return res.status(500).json({ message: "Failed to delete template" });
  }
};

export const SavedTemplateController = {
  list,
  createText,
  createMedia,
  update,
  remove,
};
