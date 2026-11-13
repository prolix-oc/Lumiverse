import type { Database } from "bun:sqlite";
import type { CharacterLibraryScope, UpdateCharacterInput } from "../types/character";

export class InvalidCharacterLibraryScopeError extends Error {
  readonly code = "INVALID_CHARACTER_LIBRARY_SCOPE" as const;
  constructor(readonly value: unknown) { super('Character library scope must be exactly "mine" or "shared"'); this.name = "InvalidCharacterLibraryScopeError"; }
}

export function normalizeCharacterLibraryScope(scope: unknown): CharacterLibraryScope {
  if (scope === undefined) return "mine";
  if (scope === "mine" || scope === "shared") return scope;
  throw new InvalidCharacterLibraryScopeError(scope);
}

export function explicitCharacterInputScope(input: { library_scope?: unknown; extensions?: Record<string, any> }): CharacterLibraryScope | undefined {
  const direct = input.library_scope === undefined ? undefined : normalizeCharacterLibraryScope(input.library_scope);
  const mirrorValue = input.extensions && Object.prototype.hasOwnProperty.call(input.extensions, "_lumiverse_library_scope") ? input.extensions._lumiverse_library_scope : undefined;
  const mirror = mirrorValue === undefined ? undefined : normalizeCharacterLibraryScope(mirrorValue);
  if (direct !== undefined && mirror !== undefined && direct !== mirror) throw new InvalidCharacterLibraryScopeError({ library_scope: direct, _lumiverse_library_scope: mirror });
  return direct ?? mirror;
}

export function canonicalCharacterExtensions(extensions: Record<string, any> | undefined, scope: CharacterLibraryScope): Record<string, any> {
  return { ...(extensions || {}), _lumiverse_library_scope: scope };
}

export type CharacterTagBulkOperation = "add" | "remove" | "replace";

export interface CharacterTagBulkInput {
  ids: string[];
  operation: CharacterTagBulkOperation;
  tags: string[];
}

export interface CharacterTagBulkResult {
  updated: number;
  unchanged: number;
}

function applyTagOperation(current: string[], operation: CharacterTagBulkOperation, tags: string[]): string[] {
  if (operation === "add") {
    const merged = [...current];
    for (const t of tags) if (!merged.includes(t)) merged.push(t);
    return merged;
  }
  if (operation === "remove") {
    const remove = new Set(tags);
    return current.filter((t) => !remove.has(t));
  }
  return [...tags]; // replace
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Apply a tag operation to many characters in a single transaction.
 * Mirrors the transactional pattern in tag-library-import.service.ts.
 * Emits no per-character events; callers refresh the browser afterwards.
 */
export function updateCharacterTagsWithDb(db: Database, userId: string, input: CharacterTagBulkInput): CharacterTagBulkResult {
  const ids = Array.from(new Set(input.ids.filter((id) => typeof id === "string" && id.length > 0)));
  if (ids.length === 0) throw new Error("At least one character id is required");
  const operation = input.operation;
  if (operation !== "add" && operation !== "remove" && operation !== "replace") {
    throw new Error("Invalid tag operation");
  }
  const tags = Array.from(new Set(input.tags.map((t) => (typeof t === "string" ? t.trim() : "")).filter((t) => t.length > 0)));
  if (tags.length === 0) throw new Error("At least one tag is required");

  return db.transaction(() => {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .query(`SELECT id, tags FROM characters WHERE id IN (${placeholders}) AND user_id = ?`)
      .all(...ids, userId) as Array<{ id: string; tags: string | null }>;

    const now = Math.floor(Date.now() / 1000);
    const updateStmt = db.query("UPDATE characters SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?");
    let updated = 0;
    let unchanged = 0;
    for (const row of rows) {
      let current: string[] = [];
      try {
        const parsed = JSON.parse(row.tags || "[]");
        if (Array.isArray(parsed)) current = parsed.filter((t) => typeof t === "string");
      } catch {}
      const next = applyTagOperation(current, operation, tags);
      if (stringArraysEqual(current, next)) {
        unchanged++;
        continue;
      }
      updateStmt.run(JSON.stringify(next), now, row.id, userId);
      updated++;
    }
    return { updated, unchanged };
  }).immediate();
}

export function updateCharacterRowWithDb(
  db: Database, userId: string, id: string, input: UpdateCharacterInput,
  options: { preserveUpdatedAt?: boolean } = {},
): { before: any; after: any; changed: boolean } | null {
  return db.transaction(() => {
    const row = db.query("SELECT * FROM characters WHERE id = ? AND user_id = ?").get(id, userId) as any;
    if (!row) return null;
    const existing = { library_scope: row.library_scope, extensions: JSON.parse(row.extensions || "{}") };
    const now = Math.floor(Date.now() / 1000);
    const fields: string[] = [];
    const values: any[] = [];

    const stringFields = [
      "name", "description", "personality", "scenario", "first_mes",
      "mes_example", "creator", "creator_notes", "system_prompt", "post_history_instructions",
    ] as const;

    for (const field of stringFields) {
      if (input[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(input[field]);
      }
    }

    if (input.folder !== undefined) {
      fields.push("folder = ?");
      values.push(input.folder.trim());
    }

    const explicitScope = explicitCharacterInputScope(input);
    if (explicitScope !== undefined) { fields.push("library_scope = ?"); values.push(explicitScope); }
    const jsonFields = ["tags", "alternate_greetings"] as const;
    for (const field of jsonFields) {
      if (input[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(JSON.stringify(input[field]));
      }
    }
    if (input.extensions !== undefined || explicitScope !== undefined) {
      const scope = explicitScope ?? existing.library_scope ?? "mine";
      fields.push("extensions = ?"); values.push(JSON.stringify(canonicalCharacterExtensions(input.extensions ?? existing.extensions, scope)));
    }

    if (fields.length === 0) return { before: row, after: row, changed: false };

    if (!options.preserveUpdatedAt) {
      fields.push("updated_at = ?");
      values.push(now);
    }
    values.push(id);
    values.push(userId);

    db.query(`UPDATE characters SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
    const after = db.query("SELECT * FROM characters WHERE id = ? AND user_id = ?").get(id, userId);
    return { before: row, after, changed: true };
  }).immediate();
}
