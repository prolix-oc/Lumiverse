import type { Database } from "bun:sqlite";
import type { DeletionOperation } from "../types/deletion";

export function rowToDeletionOperation(row: any): DeletionOperation {
  return {
    operationId: row.id, entity: row.entity, entityId: row.entity_id,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.error ? { error: JSON.parse(row.error) } : {}),
  };
}

export function startCharacterDeletionWithDb(db: Database, userId: string, id: string, operationId: string):
  { operation: DeletionOperation; newlyMarked: boolean; existingRequest?: boolean } | null {
  return db.transaction(() => {
    const previous = db.query("SELECT * FROM deletion_operations WHERE id = ?").get(operationId) as any;
    if (previous) {
      if (previous.user_id !== userId || previous.entity !== "character" || previous.entity_id !== id) {
        throw Object.assign(new Error("Deletion operation ID is already in use"), { code: "DELETION_ID_CONFLICT" });
      }
      return { operation: rowToDeletionOperation(previous), newlyMarked: false, existingRequest: true };
    }
    const owned = db.query("SELECT id FROM characters WHERE id = ? AND user_id = ?").get(id, userId);
    if (!owned) return null;
    const now = Date.now();
    db.query("INSERT INTO deletion_operations (id, user_id, entity, entity_id, status, created_at, updated_at) VALUES (?, ?, 'character', ?, 'accepted', ?, ?)")
      .run(operationId, userId, id, now, now);
    db.query("UPDATE characters SET deleting = 1 WHERE id = ? AND user_id = ? AND deleting = 0").run(id, userId);
    const changed = (db.query("SELECT changes() AS count").get() as { count: number }).count;
    return { operation: { operationId, entity: "character" as const, entityId: id, status: "accepted" as const, createdAt: now, updatedAt: now }, newlyMarked: changed > 0 };
  }).immediate();
}

/** A lost acknowledgment can be reconciled from the final source-row deletion. */
export function getDeletionOperationWithDb(db: Database, userId: string, operationId: string): DeletionOperation | null {
  return db.transaction(() => {
    const row = db.query("SELECT * FROM deletion_operations WHERE id = ? AND user_id = ?").get(operationId, userId) as any;
    if (!row) return null;
    if (row.status !== "completed" && row.entity === "character" && !db.query("SELECT id FROM characters WHERE id = ? AND user_id = ?").get(row.entity_id, userId)) {
      row.status = "completed";
      row.error = null;
      row.updated_at = Date.now();
      db.query("UPDATE deletion_operations SET status = 'completed', error = NULL, updated_at = ? WHERE id = ? AND user_id = ?").run(row.updated_at, operationId, userId);
    }
    return rowToDeletionOperation(row);
  }).immediate();
}
