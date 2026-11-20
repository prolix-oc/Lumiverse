import type { Database } from "bun:sqlite";
import type { GlobalAddon, CreateGlobalAddonInput, UpdateGlobalAddonInput } from "../types/persona";
export type GlobalAddonEvent = { type: "addon-changed" | "addon-deleted" | "persona-changed"; id: string; addon?: GlobalAddon | null };
export function rowToGlobalAddon(row: any): GlobalAddon {
  return {
    ...row,
    metadata: JSON.parse(row.metadata),
  };
}

function getGlobalAddon(db: Database, userId: string, id: string): GlobalAddon | null {
  const row = db.query("SELECT * FROM global_addons WHERE id = ? AND user_id = ?").get(id, userId) as any;
  if (!row) return null;
  return rowToGlobalAddon(row);
}

function createGlobalAddon(db: Database, events: GlobalAddonEvent[], userId: string, input: CreateGlobalAddonInput): GlobalAddon {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db
    .query(
      `INSERT INTO global_addons (id, user_id, label, content, sort_order, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, userId, input.label, input.content || "",
      input.sort_order ?? 0, JSON.stringify(input.metadata || {}),
      now, now
    );

  const addon = getGlobalAddon(db, userId, id)!;
  events.push({ type: "addon-changed", id, addon });
  return addon;
}

function updateGlobalAddon(db: Database, events: GlobalAddonEvent[], userId: string, id: string, input: UpdateGlobalAddonInput): GlobalAddon | null {
  const existing = getGlobalAddon(db, userId, id);
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

  db.query(`UPDATE global_addons SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const updated = getGlobalAddon(db, userId, id)!;
  events.push({ type: "addon-changed", id, addon: updated });
  return updated;
}

function deleteGlobalAddon(db: Database, events: GlobalAddonEvent[], userId: string, id: string): boolean {
  const result = db.query("DELETE FROM global_addons WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    // Scrub from all personas' attached_global_addons
    scrubGlobalAddonFromPersonas(db, events, userId, id);
    events.push({ type: "addon-deleted", id });
  }
  return result.changes > 0;
}

function duplicateGlobalAddon(db: Database, events: GlobalAddonEvent[], userId: string, id: string): GlobalAddon | null {
  const existing = getGlobalAddon(db, userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db
    .query(
      `INSERT INTO global_addons (id, user_id, label, content, sort_order, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId, userId, `${existing.label} (Copy)`, existing.content,
      existing.sort_order, JSON.stringify(existing.metadata),
      now, now
    );

  const addon = getGlobalAddon(db, userId, newId)!;
  events.push({ type: "addon-changed", id: newId, addon });
  return addon;
}

function reorderGlobalAddons(db: Database, events: GlobalAddonEvent[], userId: string, ids: string[]): void {
  const stmt = db.query("UPDATE global_addons SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?");
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < ids.length; i++) {
    stmt.run(i, now, ids[i], userId);
  }
}

function scrubGlobalAddonFromPersonas(db: Database, events: GlobalAddonEvent[], userId: string, addonId: string): void {
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
    events.push({ type: "persona-changed", id: row.id });
  }
}
const mutations = { createGlobalAddon, updateGlobalAddon, deleteGlobalAddon, duplicateGlobalAddon, reorderGlobalAddons };
type MutationArguments<F> = F extends (db: Database, events: GlobalAddonEvent[], ...args: infer A) => unknown ? A : never;
export type GlobalAddonMutation = { [K in keyof typeof mutations]: { action: K; args: MutationArguments<(typeof mutations)[K]> } }[keyof typeof mutations];
export function mutateGlobalAddonWithDb(db: Database, mutation: GlobalAddonMutation): { value: unknown; events: GlobalAddonEvent[] } {
  return db.transaction(() => {
    const events: GlobalAddonEvent[] = [];
    let value: unknown;
    switch (mutation.action) {
      case "createGlobalAddon": value = createGlobalAddon(db, events, ...mutation.args); break;
      case "updateGlobalAddon": value = updateGlobalAddon(db, events, ...mutation.args); break;
      case "deleteGlobalAddon": value = deleteGlobalAddon(db, events, ...mutation.args); break;
      case "duplicateGlobalAddon": value = duplicateGlobalAddon(db, events, ...mutation.args); break;
      case "reorderGlobalAddons": value = reorderGlobalAddons(db, events, ...mutation.args); break;
    }
    return { value, events };
  }).immediate();
}
