import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { GlobalAddon, CreateGlobalAddonInput, UpdateGlobalAddonInput } from "../types/persona";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";

function rowToGlobalAddon(row: any): GlobalAddon {
  return {
    ...row,
    metadata: JSON.parse(row.metadata),
  };
}

export function listGlobalAddons(userId: string, pagination: PaginationParams): PaginatedResult<GlobalAddon> {
  return paginatedQuery(
    "SELECT * FROM global_addons WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC",
    "SELECT COUNT(*) as count FROM global_addons WHERE user_id = ?",
    [userId],
    pagination,
    rowToGlobalAddon
  );
}

export function getGlobalAddon(userId: string, id: string): GlobalAddon | null {
  const row = getDb().query("SELECT * FROM global_addons WHERE id = ? AND user_id = ?").get(id, userId) as any;
  if (!row) return null;
  return rowToGlobalAddon(row);
}

export function getGlobalAddonsByIds(userId: string, ids: string[]): GlobalAddon[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .query(`SELECT * FROM global_addons WHERE id IN (${placeholders}) AND user_id = ? ORDER BY sort_order ASC`)
    .all(...ids, userId) as any[];
  return rows.map(rowToGlobalAddon);
}

export function createGlobalAddon(userId: string, input: CreateGlobalAddonInput): GlobalAddon {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO global_addons (id, user_id, label, content, sort_order, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, userId, input.label, input.content || "",
      input.sort_order ?? 0, JSON.stringify(input.metadata || {}),
      now, now
    );

  const addon = getGlobalAddon(userId, id)!;
  eventBus.emit(EventType.GLOBAL_ADDON_CHANGED, { id, addon }, userId);
  return addon;
}

export function updateGlobalAddon(userId: string, id: string, input: UpdateGlobalAddonInput): GlobalAddon | null {
  const existing = getGlobalAddon(userId, id);
  if (!existing) return null;

  const now = Math.floor(Date.now() / 1000);
  const fields: string[] = [];
  const values: any[] = [];

  if (input.label !== undefined) { fields.push("label = ?"); values.push(input.label); }
  if (input.content !== undefined) { fields.push("content = ?"); values.push(input.content); }
  if (input.sort_order !== undefined) { fields.push("sort_order = ?"); values.push(input.sort_order); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE global_addons SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const updated = getGlobalAddon(userId, id)!;
  eventBus.emit(EventType.GLOBAL_ADDON_CHANGED, { id, addon: updated }, userId);
  return updated;
}

export function deleteGlobalAddon(userId: string, id: string): boolean {
  const result = getDb().query("DELETE FROM global_addons WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    // Scrub from all personas' attached_global_addons
    scrubGlobalAddonFromPersonas(userId, id);
    eventBus.emit(EventType.GLOBAL_ADDON_DELETED, { id }, userId);
  }
  return result.changes > 0;
}

export function duplicateGlobalAddon(userId: string, id: string): GlobalAddon | null {
  const existing = getGlobalAddon(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO global_addons (id, user_id, label, content, sort_order, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId, userId, `${existing.label} (Copy)`, existing.content,
      existing.sort_order, JSON.stringify(existing.metadata),
      now, now
    );

  const addon = getGlobalAddon(userId, newId)!;
  eventBus.emit(EventType.GLOBAL_ADDON_CHANGED, { id: newId, addon }, userId);
  return addon;
}

export function reorderGlobalAddons(userId: string, ids: string[]): void {
  const db = getDb();
  const stmt = db.query("UPDATE global_addons SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?");
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < ids.length; i++) {
    stmt.run(i, now, ids[i], userId);
  }
}

function scrubGlobalAddonFromPersonas(userId: string, addonId: string): void {
  const db = getDb();
  const rows = db
    .query("SELECT id, metadata FROM personas WHERE user_id = ?")
    .all(userId) as any[];

  const now = Math.floor(Date.now() / 1000);
  const updateStmt = db.query("UPDATE personas SET metadata = ?, updated_at = ? WHERE id = ? AND user_id = ?");

  for (const row of rows) {
    const meta = JSON.parse(row.metadata);
    const attached = meta?.attached_global_addons;
    if (!Array.isArray(attached)) continue;
    const filtered = attached.filter((a: any) => a.id !== addonId);
    if (filtered.length === attached.length) continue;
    meta.attached_global_addons = filtered;
    updateStmt.run(JSON.stringify(meta), now, row.id, userId);
    eventBus.emit(EventType.PERSONA_CHANGED, { id: row.id }, userId);
  }
}
