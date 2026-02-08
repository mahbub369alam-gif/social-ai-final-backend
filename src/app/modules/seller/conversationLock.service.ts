import { execResult, queryRows, withConnection } from "../../../lib/mysql";

/**
 * ✅ Ensure a conversation is locked to the FIRST seller who replies.
 * MySQL strategy (race-safe):
 * - INSERT IGNORE (conversation_id is PRIMARY KEY)
 * - Then SELECT owner
 */
export async function ensureConversationLock(
  conversationId: string,
  sellerId: string
): Promise<{ ownerSellerId: string; created: boolean }> {
  const cid = String(conversationId || "").trim();
  const sid = String(sellerId || "").trim();
  if (!cid) throw new Error("conversationId required");
  if (!sid) throw new Error("sellerId required");

  return withConnection(async (conn) => {
    // INSERT IGNORE => created only when it didn't exist.
    const [r] = await conn.execute(
      `INSERT IGNORE INTO conversation_locks (conversation_id, seller_id, locked_at)
       VALUES (?,?,NOW())`,
      [cid, sid]
    );
    const created = (r as any)?.affectedRows === 1;

    const [rows] = await conn.query(
      "SELECT seller_id FROM conversation_locks WHERE conversation_id=? LIMIT 1",
      [cid]
    );
    const ownerSellerId = String((rows as any)?.[0]?.seller_id || "");
    return { ownerSellerId, created };
  });
}

export async function getConversationLockOwner(conversationId: string): Promise<string> {
  const cid = String(conversationId || "").trim();
  if (!cid) return "";
  const rows = await queryRows<any[]>(
    "SELECT seller_id FROM conversation_locks WHERE conversation_id=? LIMIT 1",
    [cid]
  );
  return String(rows?.[0]?.seller_id || "");
}

export async function getConversationAssignedSellerId(conversationId: string): Promise<string | null> {
  const cid = String(conversationId || "").trim();
  if (!cid) return null;
  const rows = await queryRows<any[]>(
    "SELECT seller_id FROM conversation_locks WHERE conversation_id=? LIMIT 1",
    [cid]
  );
  const v = rows?.[0]?.seller_id;
  if (v === null || v === undefined || String(v) === "") return null;
  return String(v);
}

export async function upsertConversationMeta(params: {
  conversationId: string;
  sellerId?: string | null;
  deliveryStatus?: "confirmed" | "hold" | "cancel" | "delivered";
  assignedBy?: string | null;
}): Promise<{
  conversationId: string;
  assignedSellerId: string | null;
  deliveryStatus: "confirmed" | "hold" | "cancel" | "delivered";
  assignedAt: string | null;
}> {
  const cid = String(params.conversationId || "").trim();
  if (!cid) throw new Error("conversationId required");

  // We want to preserve locked_at on insert, and allow updates.
  // Use ON DUPLICATE KEY UPDATE.
  const sellerId = params.sellerId === undefined ? undefined : params.sellerId;
  const deliveryStatus = params.deliveryStatus;
  const assignedBy = params.assignedBy;

  // Build dynamic SQL to update only provided fields.
  const setParts: string[] = [];
  const setVals: any[] = [];

  if (sellerId !== undefined) {
    setParts.push("seller_id=VALUES(seller_id)");
    // assigned_at should move when assigning, clear when unassigning
    setParts.push("assigned_at=VALUES(assigned_at)");
  }
  if (deliveryStatus) {
    setParts.push("delivery_status=VALUES(delivery_status)");
  }
  if (assignedBy !== undefined) {
    setParts.push("assigned_by=VALUES(assigned_by)");
  }

  const insertSellerId = sellerId === undefined ? null : sellerId;
  const insertAssignedAt =
    sellerId === undefined ? null : sellerId ? new Date() : null;

  const insertDelivery = deliveryStatus || "confirmed";
  const insertAssignedBy = assignedBy === undefined ? null : assignedBy;

  const sql = `
    INSERT INTO conversation_locks
      (conversation_id, seller_id, locked_at, delivery_status, assigned_by, assigned_at)
    VALUES
      (?,?,NOW(),?,?,?)
    ON DUPLICATE KEY UPDATE
      ${setParts.length ? setParts.join(", ") : "conversation_id=conversation_id"}
  `;

  const paramsArr = [cid, insertSellerId, insertDelivery, insertAssignedBy, insertAssignedAt];
  await execResult(sql, paramsArr);

  const rows = await queryRows<any[]>(
    "SELECT conversation_id, seller_id, delivery_status, assigned_at FROM conversation_locks WHERE conversation_id=? LIMIT 1",
    [cid]
  );
  const row = rows[0] || {};
  return {
    conversationId: cid,
    assignedSellerId: row.seller_id ? String(row.seller_id) : null,
    deliveryStatus: (row.delivery_status as any) || "confirmed",
    assignedAt: row.assigned_at ? new Date(row.assigned_at).toISOString() : null,
  };
}
