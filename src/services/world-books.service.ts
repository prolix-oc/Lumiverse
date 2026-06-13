import { getDb } from "../db/connection";
import type {
  WorldBook, WorldBookEntry,
  CreateWorldBookInput, UpdateWorldBookInput,
  CreateWorldBookEntryInput, UpdateWorldBookEntryInput,
  WorldBookVectorIndexStatus, WorldBookVectorSummary,
  DuplicateWorldBookEntryInput,
  WorldBookEntryBulkActionInput,
  WorldBookEntryBulkActionResult,
} from "../types/world-book";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import * as embeddingsSvc from "./embeddings.service";
import * as vectorizationQueue from "./vectorization-queue.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

function emitWorldBookChanged(userId: string, id: string): void {
  const worldBook = getWorldBook(userId, id);
  if (!worldBook) return;
  eventBus.emit(EventType.WORLD_BOOK_CHANGED, { id, worldBook }, userId);
}

function emitWorldBookEntryChanged(userId: string, id: string): void {
  const entry = getEntry(userId, id);
  if (!entry) return;
  eventBus.emit(EventType.WORLD_BOOK_ENTRY_CHANGED, { id, worldBookId: entry.world_book_id, entry }, userId);
}

const ENTRY_OUTLET_NAME_KEYS = ["outlet_name", "outletName"] as const;

function normalizeEntryOutletName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneUnknownRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value));
}

function splitManagedEntryExtensions(raw: unknown): {
  extensions: Record<string, any>;
  outletName: string | null;
} {
  const extensions = typeof raw === "string"
    ? JSON.parse(raw)
    : cloneUnknownRecord(raw);
  const next = cloneUnknownRecord(extensions);
  const outletName = normalizeEntryOutletName(next.outlet_name ?? next.outletName);
  for (const key of ENTRY_OUTLET_NAME_KEYS) delete next[key];
  return { extensions: next, outletName };
}

function buildStoredEntryExtensions(raw: unknown, outletValue: unknown): string {
  const { extensions, outletName: embeddedOutletName } = splitManagedEntryExtensions(raw);
  const outletName = outletValue !== undefined
    ? normalizeEntryOutletName(outletValue)
    : embeddedOutletName;
  if (outletName) {
    extensions.outlet_name = outletName;
  }
  return JSON.stringify(extensions);
}

function rowToBook(row: any): WorldBook {
  // Explicit field mapping rather than `...row` so internal columns (user_id)
  // aren't shipped to the client.
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    folder: row.folder ?? "",
    metadata: JSON.parse(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeVectorIndexStatus(row: any): WorldBookVectorIndexStatus {
  if (
    row.vector_index_status === "not_enabled" ||
    row.vector_index_status === "pending" ||
    row.vector_index_status === "indexed" ||
    row.vector_index_status === "error"
  ) {
    return row.vector_index_status;
  }
  return row.vectorized ? "pending" : "not_enabled";
}

function rowToEntry(row: any): WorldBookEntry {
  const vectorIndexStatus = normalizeVectorIndexStatus(row);
  const { extensions, outletName } = splitManagedEntryExtensions(row.extensions);
  return {
    ...row,
    outlet_name: outletName,
    key: JSON.parse(row.key),
    keysecondary: JSON.parse(row.keysecondary),
    role: row.role || null,
    selective: !!row.selective,
    constant: !!row.constant,
    disabled: !!row.disabled,
    group_override: !!row.group_override,
    case_sensitive: !!row.case_sensitive,
    match_whole_words: !!row.match_whole_words,
    use_regex: !!row.use_regex,
    prevent_recursion: !!row.prevent_recursion,
    exclude_recursion: !!row.exclude_recursion,
    delay_until_recursion: !!row.delay_until_recursion,
    use_probability: !!row.use_probability,
    vectorized: !!row.vectorized,
    vector_index_status: vectorIndexStatus,
    vector_indexed_at: row.vector_indexed_at ?? null,
    vector_index_error: row.vector_index_error || null,
    scan_depth: row.scan_depth ?? null,
    automation_id: row.automation_id || null,
    extensions,
  };
}

function getPendingVectorIndexState(vectorized: boolean): {
  vector_index_status: WorldBookVectorIndexStatus;
  vector_indexed_at: null;
  vector_index_error: null;
} {
  return {
    vector_index_status: vectorized ? "pending" : "not_enabled",
    vector_indexed_at: null,
    vector_index_error: null,
  };
}

function shouldResetVectorIndex(input: UpdateWorldBookEntryInput): boolean {
  return (
    input.vectorized !== undefined ||
    input.content !== undefined ||
    input.comment !== undefined ||
    input.key !== undefined ||
    input.keysecondary !== undefined ||
    input.disabled !== undefined
  );
}

function touchWorldBook(worldBookId: string, timestamp: number = Math.floor(Date.now() / 1000)): void {
  getDb().query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(timestamp, worldBookId);
}

function cloneEntryExtensions(extensions: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(extensions || {}));
}

function normalizeKeywordList(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizeImportedEntries(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return Object.values(raw as Record<string, any>);
  return [];
}

export function countImportedWorldBookEntries(raw: unknown): number {
  return normalizeImportedEntries(raw).length;
}

function normalizeImportedPosition(position: unknown): number {
  if (typeof position === "number" && Number.isFinite(position)) {
    return position;
  }

  if (typeof position === "string") {
    const trimmed = position.trim().toLowerCase();
    if (!trimmed) return 0;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;

    switch (trimmed) {
      case "before":
      case "before_char":
      case "before_character":
        return 0;
      case "after":
      case "after_char":
      case "after_character":
        return 1;
      case "before_an":
      case "before_authors_note":
      case "before_author_note":
        return 2;
      case "after_an":
      case "after_authors_note":
      case "after_author_note":
        return 3;
      case "at_depth":
      case "depth":
        return 4;
      case "before_em":
      case "before_example":
      case "before_examples":
      case "before_example_messages":
        return 5;
      case "after_em":
      case "after_example":
      case "after_examples":
      case "after_example_messages":
        return 6;
    }
  }

  return 0;
}

export function normalizeImportedEntryInput(raw: any, index: number): CreateWorldBookEntryInput {
  const keys: string[] = Array.isArray(raw.keys) ? raw.keys
    : Array.isArray(raw.key) ? raw.key
    : typeof raw.key === "string" ? raw.key.split(",").map((k: string) => k.trim()).filter(Boolean)
    : typeof raw.keys === "string" ? raw.keys.split(",").map((k: string) => k.trim()).filter(Boolean)
    : [];
  const secondaryKeys: string[] = Array.isArray(raw.secondary_keys) ? raw.secondary_keys
    : Array.isArray(raw.keysecondary) ? raw.keysecondary
    : typeof raw.secondary_keys === "string" ? raw.secondary_keys.split(",").map((k: string) => k.trim()).filter(Boolean)
    : [];

  const comment = raw.comment || raw.name || "";
  const enabled = raw.enabled !== undefined ? raw.enabled
    : raw.disabled !== undefined ? !raw.disabled
    : raw.disable !== undefined ? !raw.disable
    : true;

  const knownFields = new Set([
    "keys", "key", "secondary_keys", "keysecondary", "content", "comment", "name",
    "enabled", "disabled", "disable",
    "insertion_order", "order_value", "order", "displayIndex", "position", "depth", "role", "selective",
    "constant", "case_sensitive", "caseSensitive", "match_whole_words", "matchWholeWords",
    "group", "group_name", "group_override", "groupOverride",
    "group_weight", "groupWeight", "probability", "scan_depth", "scanDepth",
    "automation_id", "automationId", "selectiveLogic", "selective_logic",
    "useProbability", "use_probability", "use_regex", "useRegex",
    "prevent_recursion", "preventRecursion", "exclude_recursion", "excludeRecursion",
    "delay_until_recursion", "delayUntilRecursion",
    "priority", "sticky", "cooldown", "delay",
    "id", "entry", "uid", "vectorized", "extensions", "outlet_name", "outletName",
  ]);
  const extras: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!knownFields.has(k)) extras[k] = v;
  }

  return {
    outlet_name: raw.outlet_name ?? raw.outletName,
    key: keys,
    keysecondary: secondaryKeys,
    content: raw.content || "",
    comment,
    disabled: !enabled,
    order_value: resolveImportOrder(raw, index),
    position: normalizeImportedPosition(raw.position),
    depth: raw.depth ?? 4,
    role: normalizeImportRole(raw.role) || undefined,
    selective: raw.selective ?? false,
    constant: raw.constant ?? false,
    case_sensitive: raw.case_sensitive ?? raw.caseSensitive ?? false,
    match_whole_words: raw.match_whole_words ?? raw.matchWholeWords ?? false,
    group_name: raw.group || raw.group_name || "",
    group_override: raw.group_override ?? raw.groupOverride ?? false,
    group_weight: raw.group_weight ?? raw.groupWeight ?? 100,
    probability: raw.probability ?? 100,
    scan_depth: raw.scan_depth ?? raw.scanDepth ?? undefined,
    automation_id: raw.automation_id || raw.automationId || undefined,
    selective_logic: raw.selectiveLogic ?? raw.selective_logic ?? 0,
    use_probability: raw.useProbability !== undefined ? raw.useProbability : (raw.use_probability !== undefined ? raw.use_probability : true),
    use_regex: raw.use_regex ?? raw.useRegex ?? false,
    prevent_recursion: raw.prevent_recursion ?? raw.preventRecursion ?? false,
    exclude_recursion: raw.exclude_recursion ?? raw.excludeRecursion ?? false,
    delay_until_recursion: raw.delay_until_recursion ?? raw.delayUntilRecursion ?? false,
    priority: raw.priority ?? 10,
    sticky: raw.sticky ?? 0,
    cooldown: raw.cooldown ?? 0,
    delay: raw.delay ?? 0,
    vectorized: raw.vectorized ?? false,
    extensions: { ...raw.extensions, ...extras },
  };
}

export function materializeCharacterBookEntriesForRuntime(
  worldBookId: string,
  characterBook: any,
): WorldBookEntry[] {
  const rawEntries = normalizeImportedEntries(characterBook?.entries);
  return rawEntries.map((raw, index) => {
    const input = normalizeImportedEntryInput(raw, index);
    const outletName = normalizeEntryOutletName(input.outlet_name);
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
      world_book_id: worldBookId,
      uid: typeof raw.uid === "string" && raw.uid ? raw.uid : crypto.randomUUID(),
      outlet_name: outletName,
      key: input.key ?? [],
      keysecondary: input.keysecondary ?? [],
      content: input.content ?? "",
      comment: input.comment ?? "",
      position: input.position ?? 0,
      depth: input.depth ?? 4,
      role: input.role ?? null,
      order_value: input.order_value ?? 100,
      selective: !!input.selective,
      constant: !!input.constant,
      disabled: !!input.disabled,
      group_name: input.group_name ?? "",
      group_override: !!input.group_override,
      group_weight: input.group_weight ?? 100,
      probability: input.probability ?? 100,
      scan_depth: input.scan_depth ?? null,
      case_sensitive: !!input.case_sensitive,
      match_whole_words: !!input.match_whole_words,
      automation_id: input.automation_id ?? null,
      use_regex: !!input.use_regex,
      prevent_recursion: !!input.prevent_recursion,
      exclude_recursion: !!input.exclude_recursion,
      delay_until_recursion: !!input.delay_until_recursion,
      priority: input.priority ?? 10,
      sticky: input.sticky ?? 0,
      cooldown: input.cooldown ?? 0,
      delay: input.delay ?? 0,
      selective_logic: input.selective_logic ?? 0,
      use_probability: input.use_probability !== false,
      vectorized: false,
      vector_index_status: "not_enabled",
      vector_indexed_at: null,
      vector_index_error: null,
      extensions: cloneEntryExtensions(input.extensions || {}),
      created_at: 0,
      updated_at: 0,
    };
  });
}

function getEntriesForBook(userId: string, worldBookId: string, entryIds: string[]): WorldBookEntry[] {
  if (entryIds.length === 0) return [];
  const uniqueIds = [...new Set(entryIds)];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = getDb().query(
    `SELECT e.*
     FROM world_book_entries e
     JOIN world_books w ON e.world_book_id = w.id
     WHERE w.user_id = ? AND e.world_book_id = ? AND e.id IN (${placeholders})`
  ).all(userId, worldBookId, ...uniqueIds) as any[];
  return rows.map(rowToEntry);
}

function setEntriesPendingReindex(entryIds: string[]): void {
  if (entryIds.length === 0) return;
  const placeholders = entryIds.map(() => "?").join(", ");
  getDb().query(
    `UPDATE world_book_entries
     SET vector_index_status = 'pending', vector_indexed_at = NULL, vector_index_error = NULL
     WHERE id IN (${placeholders})`
  ).run(...entryIds);
}

function queueReindexForEntries(userId: string, entries: WorldBookEntry[]): void {
  for (const entry of entries) {
    if (!entry.vectorized) {
      void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, entry.id).catch((err: unknown) => {
        console.warn("[embeddings] Failed to remove world book entry vectors:", err);
      });
      continue;
    }
    void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, entry.id).catch((err: unknown) => {
      console.warn("[embeddings] Failed to remove world book entry vectors:", err);
    });
    vectorizationQueue.queueWorldBookEntryVectorization(userId, entry.id);
  }
}

function queueWorldBookEntriesForIndexing(userId: string, worldBookId: string): void {
  const rows = getDb().query(
    `SELECT id
     FROM world_book_entries
     WHERE world_book_id = ?
       AND vectorized = 1
       AND disabled = 0
       AND length(trim(content)) > 0
       AND vector_index_status IN ('pending', 'error', 'not_enabled')`
  ).all(worldBookId) as Array<{ id: string }>;

  for (const row of rows) {
    vectorizationQueue.queueWorldBookEntryVectorization(userId, row.id);
  }
}

// --- World Book CRUD ---

/** Lightweight listing of all world books for manifest building. */
export function listWorldBooksForManifest(userId: string): Array<{ name: string; metadata: Record<string, any>; created_at: number }> {
  const rows = getDb().query("SELECT name, metadata, created_at FROM world_books WHERE user_id = ?").all(userId) as any[];
  return rows.map((row) => ({
    name: row.name,
    metadata: JSON.parse(row.metadata),
    created_at: row.created_at,
  }));
}

export function listWorldBooks(userId: string, pagination: PaginationParams): PaginatedResult<WorldBook> {
  return paginatedQuery(
    "SELECT * FROM world_books WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM world_books WHERE user_id = ?",
    [userId],
    pagination,
    rowToBook
  );
}

export function getWorldBook(userId: string, id: string): WorldBook | null {
  const row = getDb().query("SELECT * FROM world_books WHERE id = ? AND user_id = ?").get(id, userId) as any;
  return row ? rowToBook(row) : null;
}

/**
 * Cheap signature of a user's world-book list for ETag generation: count +
 * max(updated_at). Creating/deleting a book changes the count; editing a book
 * OR any of its entries bumps updated_at (entry mutations call touchWorldBook),
 * so this uniquely identifies the list without serializing it.
 */
export function getWorldBookListSignature(userId: string): { count: number; maxUpdatedAt: number } {
  const row = getDb()
    .query("SELECT COUNT(*) as count, COALESCE(MAX(updated_at), 0) as maxUpdatedAt FROM world_books WHERE user_id = ?")
    .get(userId) as { count: number; maxUpdatedAt: number };
  return { count: row.count, maxUpdatedAt: row.maxUpdatedAt };
}

/**
 * Cheap signature of a book's entries for ETag generation: count +
 * max(updated_at) over world_book_entries (index-backed by world_book_id).
 * Caller must have already verified ownership of the book. Combined with the
 * book's own updated_at this covers entry CRUD, content edits, and reorders.
 */
export function getWorldBookEntriesSignature(worldBookId: string): { count: number; maxUpdatedAt: number } {
  const row = getDb()
    .query("SELECT COUNT(*) as count, COALESCE(MAX(updated_at), 0) as maxUpdatedAt FROM world_book_entries WHERE world_book_id = ?")
    .get(worldBookId) as { count: number; maxUpdatedAt: number };
  return { count: row.count, maxUpdatedAt: row.maxUpdatedAt };
}

export function createWorldBook(userId: string, input: CreateWorldBookInput): WorldBook {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query("INSERT INTO world_books (id, user_id, name, description, folder, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.name, input.description || "", input.folder || "", JSON.stringify(input.metadata || {}), now, now);
  emitWorldBookChanged(userId, id);
  return getWorldBook(userId, id)!;
}

export function updateWorldBook(userId: string, id: string, input: UpdateWorldBookInput): WorldBook | null {
  const existing = getWorldBook(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.description !== undefined) { fields.push("description = ?"); values.push(input.description); }
  if (input.folder !== undefined) { fields.push("folder = ?"); values.push(input.folder); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE world_books SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  emitWorldBookChanged(userId, id);
  return getWorldBook(userId, id)!;
}

export function deleteWorldBook(userId: string, id: string): boolean {
  const deleted = getDb().query("DELETE FROM world_books WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  if (deleted) eventBus.emit(EventType.WORLD_BOOK_DELETED, { id }, userId);
  return deleted;
}

export function deleteAutoManagedCharacterWorldBooks(userId: string, characterId: string): number {
  const rows = getDb().query(
    `SELECT id
       FROM world_books
      WHERE user_id = ?
        AND json_extract(metadata, '$.auto_managed_by_character') = 1
        AND json_extract(metadata, '$.source_character_id') = ?`
  ).all(userId, characterId) as Array<{ id: string }>;

  let deleted = 0;
  for (const row of rows) {
    if (deleteWorldBook(userId, row.id)) deleted += 1;
  }

  return deleted;
}

export function getWorldBookVectorSummary(userId: string, worldBookId: string): WorldBookVectorSummary | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;

  const entries = listEntries(userId, worldBookId);
  const summary: WorldBookVectorSummary = {
    total: entries.length,
    enabled: 0,
    non_empty: 0,
    enabled_non_empty: 0,
    not_enabled: 0,
    pending: 0,
    indexed: 0,
    error: 0,
  };

  for (const entry of entries) {
    const hasContent = (entry.content || "").trim().length > 0;
    if (entry.vectorized) summary.enabled += 1;
    if (hasContent) summary.non_empty += 1;
    if (hasContent && entry.vectorized) summary.enabled_non_empty += 1;
    summary[entry.vector_index_status] += 1;
  }

  return summary;
}

export function setWorldBookSemanticActivation(
  userId: string,
  worldBookId: string,
  enabled: boolean,
): { summary: WorldBookVectorSummary; updated_entries: number } | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let updatedEntries = 0;

  if (enabled) {
    updatedEntries = db.query(
      `UPDATE world_book_entries
       SET vectorized = 1,
           vector_index_status = 'pending',
           vector_indexed_at = NULL,
           vector_index_error = NULL,
           updated_at = ?
       WHERE world_book_id = ?
         AND length(trim(content)) > 0`
    ).run(now, worldBookId).changes;
  } else {
    updatedEntries = db.query(
      `UPDATE world_book_entries
       SET vectorized = 0,
           vector_index_status = 'not_enabled',
           vector_indexed_at = NULL,
           vector_index_error = NULL,
           updated_at = ?
       WHERE world_book_id = ?`
    ).run(now, worldBookId).changes;
  }

  if (updatedEntries > 0) {
    db.query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(now, worldBookId);
    emitWorldBookChanged(userId, worldBookId);
  }

  if (!enabled) {
    for (const entry of listEntries(userId, worldBookId)) {
      void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, entry.id).catch((err: unknown) => {
        console.warn("[embeddings] Failed to remove world book entry vectors:", err);
      });
    }
  } else if (updatedEntries > 0) {
    queueWorldBookEntriesForIndexing(userId, worldBookId);
  }

  return {
    summary: getWorldBookVectorSummary(userId, worldBookId)!,
    updated_entries: updatedEntries,
  };
}

export function getConvertToVectorizedPreview(
  userId: string,
  worldBookId: string,
): { total: number; eligible: number; keys_to_clear: number; constant_skipped: number; already_vectorized: number; empty_skipped: number; disabled_skipped: number } | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;
  const entries = listEntries(userId, worldBookId);

  let eligible = 0;
  let keysToClear = 0;
  let constantSkipped = 0;
  let alreadyVectorized = 0;
  let emptySkipped = 0;
  let disabledSkipped = 0;

  for (const entry of entries) {
    const hasContent = (entry.content || "").trim().length > 0;
    if (entry.constant) { constantSkipped++; continue; }
    if (!hasContent) { emptySkipped++; continue; }
    if (entry.disabled) { disabledSkipped++; continue; }
    const hasKeys = (entry.key?.length ?? 0) > 0 || (entry.keysecondary?.length ?? 0) > 0;
    if (entry.vectorized && !hasKeys) { alreadyVectorized++; continue; }
    eligible++;
    if (hasKeys) {
      keysToClear++;
    }
  }

  return { total: entries.length, eligible, keys_to_clear: keysToClear, constant_skipped: constantSkipped, already_vectorized: alreadyVectorized, empty_skipped: emptySkipped, disabled_skipped: disabledSkipped };
}

export function convertToVectorized(
  userId: string,
  worldBookId: string,
): { summary: WorldBookVectorSummary; converted: number } | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const converted = db.query(
    `UPDATE world_book_entries
      SET vectorized = 1,
          key = '[]',
          keysecondary = '[]',
          vector_index_status = 'pending',
          vector_indexed_at = NULL,
          vector_index_error = NULL,
          updated_at = ?
      WHERE world_book_id = ?
        AND constant = 0
        AND disabled = 0
        AND length(trim(content)) > 0
        AND (vectorized = 0 OR key != '[]' OR keysecondary != '[]')`
  ).run(now, worldBookId).changes;

  if (converted > 0) {
    db.query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(now, worldBookId);
    queueWorldBookEntriesForIndexing(userId, worldBookId);
  }

  return {
    summary: getWorldBookVectorSummary(userId, worldBookId)!,
    converted,
  };
}

// --- World Book Entry CRUD ---

const ENTRY_SORT_COLUMNS = {
  order: "order_value",
  priority: "priority",
  created: "created_at",
  updated: "updated_at",
  name: "comment",
} as const;

export type EntrySortKey = keyof typeof ENTRY_SORT_COLUMNS;

/**
 * Build an FTS5 MATCH query for the trigram tokenizer. Embedded double quotes
 * are escaped by doubling per FTS5 syntax. Returns "" when the trimmed input is
 * shorter than the trigram minimum (3 chars) — callers fall back to LIKE.
 */
function sanitizeEntryFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 3) return "";
  return trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

/** Escape SQL LIKE metacharacters so a raw user query is matched literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

export function listEntriesPaginated(
  userId: string,
  worldBookId: string,
  pagination: PaginationParams,
  options?: { sortBy?: EntrySortKey; sortDir?: "asc" | "desc"; search?: string }
): PaginatedResult<WorldBookEntry> {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return { data: [], total: 0, limit: pagination.limit, offset: pagination.offset };

  const sortKey: EntrySortKey = options?.sortBy && options.sortBy in ENTRY_SORT_COLUMNS
    ? options.sortBy
    : "order";
  const column = ENTRY_SORT_COLUMNS[sortKey];
  const direction = options?.sortDir === "desc" ? "DESC" : "ASC";
  const collate = sortKey === "name" ? " COLLATE NOCASE" : "";

  const rawSearch = options?.search?.trim() ?? "";
  if (!rawSearch) {
    // Fast path: no search — use cached paginated query
    return paginatedQuery(
      `SELECT * FROM world_book_entries WHERE world_book_id = ? ORDER BY ${column}${collate} ${direction}, id ASC`,
      "SELECT COUNT(*) as count FROM world_book_entries WHERE world_book_id = ?",
      [worldBookId],
      pagination,
      rowToEntry
    );
  }

  const ftsQuery = sanitizeEntryFtsQuery(rawSearch);
  const db = getDb();

  let fromClause: string;
  let whereStr: string;
  let params: any[];

  if (ftsQuery) {
    // FTS path (trigram): JOIN world_book_entries_fts, scoped by world_book_id.
    fromClause = "world_book_entries e JOIN world_book_entries_fts fts ON fts.rowid = e.rowid";
    whereStr = "e.world_book_id = ? AND world_book_entries_fts MATCH ?";
    params = [worldBookId, ftsQuery];
  } else {
    // LIKE fallback — trigram can't match 1–2 char queries (e.g. 2-char CJK).
    const like = `%${escapeLike(rawSearch)}%`;
    fromClause = "world_book_entries e";
    whereStr =
      "e.world_book_id = ? AND (e.comment LIKE ? ESCAPE '\\' OR e.content LIKE ? ESCAPE '\\' OR e.key LIKE ? ESCAPE '\\' OR e.keysecondary LIKE ? ESCAPE '\\')";
    params = [worldBookId, like, like, like, like];
  }

  const countRow = db
    .query(`SELECT COUNT(*) as count FROM ${fromClause} WHERE ${whereStr}`)
    .get(...params) as { count: number } | null;
  const total = countRow?.count ?? 0;

  const rows = db
    .query(
      `SELECT e.* FROM ${fromClause} WHERE ${whereStr} ORDER BY e.${column}${collate} ${direction}, e.id ASC LIMIT ? OFFSET ?`
    )
    .all(...params, pagination.limit, pagination.offset) as any[];

  return {
    data: rows.map(rowToEntry),
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

export function listEntries(userId: string, worldBookId: string): WorldBookEntry[] {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return [];

  return (getDb().query("SELECT * FROM world_book_entries WHERE world_book_id = ? ORDER BY order_value ASC").all(worldBookId) as any[]).map(rowToEntry);
}

/**
 * Batch-load entries for multiple world books in 2 queries (ownership + entries).
 * Returns a Map from bookId → entries[], preserving per-book grouping.
 */
export function listEntriesForBooks(userId: string, bookIds: string[]): Map<string, WorldBookEntry[]> {
  if (bookIds.length === 0) return new Map();
  const ph = bookIds.map(() => "?").join(", ");
  const owned = getDb()
    .query(`SELECT id FROM world_books WHERE id IN (${ph}) AND user_id = ?`)
    .all(...bookIds, userId) as { id: string }[];
  const ownedSet = new Set(owned.map(b => b.id));
  const validIds = bookIds.filter(id => ownedSet.has(id));
  if (validIds.length === 0) return new Map();
  const eph = validIds.map(() => "?").join(", ");
  const rows = getDb()
    .query(`SELECT * FROM world_book_entries WHERE world_book_id IN (${eph}) ORDER BY world_book_id, order_value ASC`)
    .all(...validIds) as any[];
  const result = new Map<string, WorldBookEntry[]>();
  for (const id of validIds) result.set(id, []);
  for (const row of rows) {
    result.get(row.world_book_id)?.push(rowToEntry(row));
  }
  return result;
}

export function getEntry(userId: string, id: string): WorldBookEntry | null {
  const row = getDb().query(
    "SELECT e.* FROM world_book_entries e JOIN world_books w ON e.world_book_id = w.id WHERE e.id = ? AND w.user_id = ?"
  ).get(id, userId) as any;
  return row ? rowToEntry(row) : null;
}

export function createEntry(
  userId: string,
  worldBookId: string,
  input: CreateWorldBookEntryInput,
  opts?: { emitEvent?: boolean },
): WorldBookEntry | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;

  const id = crypto.randomUUID();
  const uid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const vectorized = !!input.vectorized;
  const vectorIndexState = getPendingVectorIndexState(vectorized);
  const storedExtensions = buildStoredEntryExtensions(input.extensions, input.outlet_name);

  getDb()
    .query(
      `INSERT INTO world_book_entries (
        id, world_book_id, uid, key, keysecondary, content, comment,
        position, depth, role, order_value, selective, constant, disabled,
        group_name, group_override, group_weight, probability, scan_depth,
        case_sensitive, match_whole_words, automation_id,
        use_regex, prevent_recursion, exclude_recursion, delay_until_recursion,
        priority, sticky, cooldown, delay, selective_logic, use_probability,
        vectorized, vector_index_status, vector_indexed_at, vector_index_error,
        extensions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, worldBookId, uid,
      JSON.stringify(input.key || []),
      JSON.stringify(input.keysecondary || []),
      input.content || "",
      input.comment || "",
      input.position ?? 0,
      input.depth ?? 4,
      input.role || null,
      input.order_value ?? 100,
      input.selective ? 1 : 0,
      input.constant ? 1 : 0,
      input.disabled ? 1 : 0,
      input.group_name || "",
      input.group_override ? 1 : 0,
      input.group_weight ?? 100,
      input.probability ?? 100,
      input.scan_depth ?? null,
      input.case_sensitive ? 1 : 0,
      input.match_whole_words ? 1 : 0,
      input.automation_id || null,
      input.use_regex ? 1 : 0,
      input.prevent_recursion ? 1 : 0,
      input.exclude_recursion ? 1 : 0,
      input.delay_until_recursion ? 1 : 0,
      input.priority ?? 10,
      input.sticky ?? 0,
      input.cooldown ?? 0,
      input.delay ?? 0,
      input.selective_logic ?? 0,
      input.use_probability !== false ? 1 : 0,
      vectorized ? 1 : 0,
      vectorIndexState.vector_index_status,
      vectorIndexState.vector_indexed_at,
      vectorIndexState.vector_index_error,
      storedExtensions,
      now, now
    );

  touchWorldBook(worldBookId, now);
  const created = getEntry(userId, id)!;
  if (created.vectorized) {
    vectorizationQueue.queueWorldBookEntryVectorization(userId, created.id);
  }
  if (opts?.emitEvent !== false) emitWorldBookEntryChanged(userId, id);
  return created;
}

export function updateEntry(userId: string, id: string, input: UpdateWorldBookEntryInput): WorldBookEntry | null {
  const existing = getEntry(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  const jsonArrayFields = ["key", "keysecondary"] as const;
  for (const f of jsonArrayFields) {
    if (input[f] !== undefined) { fields.push(`${f} = ?`); values.push(JSON.stringify(input[f])); }
  }

  const stringFields = ["content", "comment", "role", "group_name", "automation_id"] as const;
  for (const f of stringFields) {
    if (input[f] !== undefined) { fields.push(`${f} = ?`); values.push(input[f]); }
  }

  const intFields = ["position", "depth", "order_value", "group_weight", "probability", "scan_depth", "priority", "sticky", "cooldown", "delay", "selective_logic"] as const;
  for (const f of intFields) {
    if (input[f] !== undefined) { fields.push(`${f} = ?`); values.push(input[f]); }
  }

  const boolFields = ["selective", "constant", "disabled", "group_override", "case_sensitive", "match_whole_words", "use_regex", "prevent_recursion", "exclude_recursion", "delay_until_recursion", "use_probability", "vectorized"] as const;
  for (const f of boolFields) {
    if (input[f] !== undefined) { fields.push(`${f} = ?`); values.push(input[f] ? 1 : 0); }
  }

  if (input.extensions !== undefined || input.outlet_name !== undefined) {
    fields.push("extensions = ?");
    values.push(buildStoredEntryExtensions(
      input.extensions ?? existing.extensions,
      input.outlet_name !== undefined ? input.outlet_name : existing.outlet_name,
    ));
  }

  if (shouldResetVectorIndex(input)) {
    const nextVectorized = input.vectorized ?? existing.vectorized;
    const vectorIndexState = getPendingVectorIndexState(nextVectorized);
    fields.push("vector_index_status = ?");
    values.push(vectorIndexState.vector_index_status);
    fields.push("vector_indexed_at = ?");
    values.push(vectorIndexState.vector_indexed_at);
    fields.push("vector_index_error = ?");
    values.push(vectorIndexState.vector_index_error);
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  getDb().query(`UPDATE world_book_entries SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  touchWorldBook(existing.world_book_id, values[values.length - 2]);
  const updated = getEntry(userId, id)!;
  if (updated.vectorized) {
    if (shouldResetVectorIndex(input) || updated.vector_index_status !== "indexed") {
      vectorizationQueue.queueWorldBookEntryVectorization(userId, updated.id);
    }
  } else {
    void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, updated.id).catch((err: unknown) => {
      console.warn("[embeddings] Failed to remove world book entry vectors:", err);
    });
  }
  emitWorldBookEntryChanged(userId, id);
  return updated;
}

export function deleteEntry(userId: string, id: string): boolean {
  // Verify the entry belongs to a world book owned by this user
  const entry = getEntry(userId, id);
  if (!entry) return false;

  const deleted = getDb().query("DELETE FROM world_book_entries WHERE id = ?").run(id).changes > 0;
  if (deleted) {
    touchWorldBook(entry.world_book_id);
    void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, id).catch((err: unknown) => {
      console.warn("[embeddings] Failed to remove world book entry vectors:", err);
    });
    eventBus.emit(EventType.WORLD_BOOK_ENTRY_DELETED, { id, worldBookId: entry.world_book_id }, userId);
  }
  return deleted;
}

export function duplicateEntry(userId: string, entryId: string, input?: DuplicateWorldBookEntryInput): WorldBookEntry | null {
  const existing = getEntry(userId, entryId);
  if (!existing) return null;

  const targetBookId = input?.target_book_id || existing.world_book_id;
  const targetBook = getWorldBook(userId, targetBookId);
  if (!targetBook) return null;

  const duplicatedComment = existing.comment
    ? `${existing.comment} (Copy)`
    : "Copy";

  return createEntry(userId, targetBook.id, {
    outlet_name: existing.outlet_name,
    key: [...existing.key],
    keysecondary: [...existing.keysecondary],
    content: existing.content,
    comment: duplicatedComment,
    position: existing.position,
    depth: existing.depth,
    role: existing.role || undefined,
    order_value: existing.order_value,
    selective: existing.selective,
    constant: existing.constant,
    disabled: existing.disabled,
    group_name: existing.group_name,
    group_override: existing.group_override,
    group_weight: existing.group_weight,
    probability: existing.probability,
    scan_depth: existing.scan_depth ?? undefined,
    case_sensitive: existing.case_sensitive,
    match_whole_words: existing.match_whole_words,
    automation_id: existing.automation_id || undefined,
    use_regex: existing.use_regex,
    prevent_recursion: existing.prevent_recursion,
    exclude_recursion: existing.exclude_recursion,
    delay_until_recursion: existing.delay_until_recursion,
    priority: existing.priority,
    sticky: existing.sticky,
    cooldown: existing.cooldown,
    delay: existing.delay,
    selective_logic: existing.selective_logic,
    use_probability: existing.use_probability,
    vectorized: existing.vectorized,
    extensions: cloneEntryExtensions(existing.extensions),
  });
}

export function reorderEntries(userId: string, worldBookId: string, orderedIds: string[]): boolean {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return false;
  const uniqueIds = [...new Set(orderedIds)];
  if (uniqueIds.length === 0) return false;

  const entries = listEntries(userId, worldBookId);
  if (uniqueIds.length !== entries.length) return false;
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  if (uniqueIds.some((id) => !entryMap.has(id))) return false;

  const currentValues = entries.map((entry) => entry.order_value).sort((a, b) => a - b);
  const strictlyIncreasing = currentValues.every((value, index) => index === 0 || value > currentValues[index - 1]);
  const normalizedValues = strictlyIncreasing
    ? currentValues
    : entries.map((_, index) => index);
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();

  db.transaction(() => {
    const stmt = db.query("UPDATE world_book_entries SET order_value = ?, updated_at = ? WHERE id = ? AND world_book_id = ?");
    uniqueIds.forEach((entryId, index) => {
      stmt.run(normalizedValues[index], now, entryId, worldBookId);
    });
    touchWorldBook(worldBookId, now);
  })();

  emitWorldBookChanged(userId, worldBookId);
  return true;
}

export function bulkOperateEntries(
  userId: string,
  worldBookId: string,
  input: WorldBookEntryBulkActionInput,
): WorldBookEntryBulkActionResult | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;

  const uniqueIds = [...new Set(input.entry_ids || [])];
  if (uniqueIds.length === 0) {
    throw new Error("entry_ids is required");
  }

  const entries = getEntriesForBook(userId, worldBookId, uniqueIds);
  if (entries.length !== uniqueIds.length) {
    throw new Error("One or more entries were not found in this world book");
  }

  const orderedEntries = uniqueIds.map((id) => entries.find((entry) => entry.id === id)!);
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();

  if (input.action === "delete") {
    db.transaction(() => {
      const stmt = db.query("DELETE FROM world_book_entries WHERE id = ? AND world_book_id = ?");
      uniqueIds.forEach((entryId) => stmt.run(entryId, worldBookId));
      touchWorldBook(worldBookId, now);
    })();
    for (const entry of orderedEntries) {
      void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, entry.id).catch((err: unknown) => {
        console.warn("[embeddings] Failed to remove world book entry vectors:", err);
      });
    }
    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  if (input.action === "move") {
    const targetBook = getWorldBook(userId, input.target_book_id);
    if (!targetBook) {
      throw new Error("Target world book not found");
    }

    db.transaction(() => {
      const stmt = db.query(
        `UPDATE world_book_entries
         SET world_book_id = ?, updated_at = ?, vector_index_status = ?, vector_indexed_at = NULL, vector_index_error = NULL
         WHERE id = ? AND world_book_id = ?`
      );
      orderedEntries.forEach((entry) => {
        stmt.run(
          targetBook.id,
          now,
          entry.vectorized ? "pending" : "not_enabled",
          entry.id,
          worldBookId,
        );
      });
      touchWorldBook(worldBookId, now);
      touchWorldBook(targetBook.id, now);
    })();

    queueReindexForEntries(userId, orderedEntries);
    emitWorldBookChanged(userId, worldBookId);
    emitWorldBookChanged(userId, targetBook.id);
    return { action: input.action, affected: uniqueIds.length, target_book_id: targetBook.id };
  }

  if (input.action === "renumber") {
    const step = Number.isFinite(input.step) && input.step && input.step > 0 ? Math.trunc(input.step) : 1;
    const direction = input.direction === "desc" ? "desc" : "asc";
    const start = input.start != null ? Math.trunc(input.start) : orderedEntries[0]?.order_value ?? 0;
    db.transaction(() => {
      const stmt = db.query("UPDATE world_book_entries SET order_value = ?, updated_at = ? WHERE id = ? AND world_book_id = ?");
      orderedEntries.forEach((entry, index) => {
        const delta = step * index;
        const nextValue = direction === "desc" ? start - delta : start + delta;
        stmt.run(nextValue, now, entry.id, worldBookId);
      });
      touchWorldBook(worldBookId, now);
    })();
    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  if (input.action === "add_keyword") {
    const keyword = input.keyword.trim();
    if (!keyword) {
      throw new Error("keyword is required");
    }
    const target = input.target === "secondary" ? "secondary" : "primary";
    db.transaction(() => {
      const stmt = db.query(
        `UPDATE world_book_entries
         SET key = ?, keysecondary = ?, updated_at = ?
         WHERE id = ? AND world_book_id = ?`
      );
      orderedEntries.forEach((entry) => {
        const nextPrimary = target === "primary"
          ? normalizeKeywordList([...entry.key, keyword])
          : normalizeKeywordList(entry.key);
        const nextSecondary = target === "secondary"
          ? normalizeKeywordList([...entry.keysecondary, keyword])
          : normalizeKeywordList(entry.keysecondary);
        stmt.run(JSON.stringify(nextPrimary), JSON.stringify(nextSecondary), now, entry.id, worldBookId);
      });
      touchWorldBook(worldBookId, now);
    })();

    const affectedVectorized = orderedEntries.filter((entry) => entry.vectorized);
    setEntriesPendingReindex(affectedVectorized.map((entry) => entry.id));
    for (const entry of affectedVectorized) {
      vectorizationQueue.queueWorldBookEntryVectorization(userId, entry.id);
    }
    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  if (input.action === "set_position") {
    const position = Number.isFinite(input.position) ? Math.trunc(input.position) : 0;
    if (position < 0 || position > 7) {
      throw new Error("position must be between 0 and 7");
    }
    const depth = position === 4 && Number.isFinite(input.depth) ? Math.trunc(input.depth!) : 4;
    db.transaction(() => {
      const stmt = db.query(
        "UPDATE world_book_entries SET position = ?, depth = ?, updated_at = ? WHERE id = ? AND world_book_id = ?",
      );
      uniqueIds.forEach((entryId) => {
        stmt.run(position, position === 4 ? depth : orderedEntries.find((e) => e.id === entryId)!.depth, now, entryId, worldBookId);
      });
      touchWorldBook(worldBookId, now);
    })();
    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  throw new Error("Unsupported bulk action");
}

// --- Import helpers ---

/**
 * Convert SillyTavern numeric role (0=system, 1=user, 2=assistant) or string
 * role to the string format Lumiverse expects. Returns null for unknown/unset.
 */
function normalizeImportRole(role: any): string | null {
  if (role === 0 || role === "system") return "system";
  if (role === 1 || role === "user") return "user";
  if (role === 2 || role === "assistant") return "assistant";
  if (typeof role === "string" && role) return role;
  return null;
}

/**
 * Resolve order_value for an imported entry. Prefers displayIndex (ST's visual
 * ordering set by drag-and-drop), then explicit ordering fields, then the
 * iteration index so entries retain their original source ordering.
 */
function resolveImportOrder(raw: any, index: number): number {
  // displayIndex — SillyTavern's visual ordering (most reliable for user intent)
  if (raw.displayIndex !== undefined && raw.displayIndex !== null) return raw.displayIndex;
  // insertion_order / order_value / order — explicit prompt-injection ordering
  const explicit = raw.insertion_order ?? raw.order_value ?? raw.order;
  if (explicit !== undefined && explicit !== null) return explicit;
  // Last resort: preserve source iteration order
  return index;
}

// --- World Book Import (shared helpers) ---

const IMPORT_DEFAULT_CHUNK_SIZE = 500;

export interface ImportWorldBookOptions {
  signal?: AbortSignal;
}

export interface ImportResult {
  worldBook: WorldBook;
  entryCount: number;
  aborted?: boolean;
}

interface BulkInsertEntriesResult {
  insertedIds: string[];
  vectorizedIds: string[];
  aborted: boolean;
}

interface BulkInsertEntriesOptions {
  forceVectorizedOff?: boolean;
  signal?: AbortSignal;
  chunkSize?: number;
}

// Inserts pre-normalized entries in chunked transactions with a reused
// prepared statement. A 1k-entry import becomes ~2 fsyncs instead of ~1k.
// Between chunks we check the optional AbortSignal so a client disconnect
// stops further work. world_books.updated_at is touched once at the end.
// Vectorization is NOT queued here — the caller enqueues from the returned IDs.
function bulkInsertEntries(
  worldBookId: string,
  inputs: CreateWorldBookEntryInput[],
  options: BulkInsertEntriesOptions = {},
): BulkInsertEntriesResult {
  const chunkSize = Math.max(1, options.chunkSize ?? IMPORT_DEFAULT_CHUNK_SIZE);
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const insertedIds: string[] = [];
  const vectorizedIds: string[] = [];

  if (inputs.length === 0) {
    return { insertedIds, vectorizedIds, aborted: false };
  }

  const insert = db.query(
    `INSERT INTO world_book_entries (
      id, world_book_id, uid, key, keysecondary, content, comment,
      position, depth, role, order_value, selective, constant, disabled,
      group_name, group_override, group_weight, probability, scan_depth,
      case_sensitive, match_whole_words, automation_id,
      use_regex, prevent_recursion, exclude_recursion, delay_until_recursion,
      priority, sticky, cooldown, delay, selective_logic, use_probability,
      vectorized, vector_index_status, vector_indexed_at, vector_index_error,
      extensions, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let aborted = false;

  for (let start = 0; start < inputs.length; start += chunkSize) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    const end = Math.min(start + chunkSize, inputs.length);

    const tx = db.transaction(() => {
      for (let i = start; i < end; i++) {
        const input = inputs[i];
        const id = crypto.randomUUID();
        const uid = crypto.randomUUID();
        const vectorized = options.forceVectorizedOff ? false : !!input.vectorized;
        const vectorIndexState = getPendingVectorIndexState(vectorized);
        const extensionsJson = buildStoredEntryExtensions(input.extensions, input.outlet_name);

        insert.run(
          id, worldBookId, uid,
          JSON.stringify(input.key || []),
          JSON.stringify(input.keysecondary || []),
          input.content || "",
          input.comment || "",
          input.position ?? 0,
          input.depth ?? 4,
          input.role || null,
          input.order_value ?? 100,
          input.selective ? 1 : 0,
          input.constant ? 1 : 0,
          input.disabled ? 1 : 0,
          input.group_name || "",
          input.group_override ? 1 : 0,
          input.group_weight ?? 100,
          input.probability ?? 100,
          input.scan_depth ?? null,
          input.case_sensitive ? 1 : 0,
          input.match_whole_words ? 1 : 0,
          input.automation_id || null,
          input.use_regex ? 1 : 0,
          input.prevent_recursion ? 1 : 0,
          input.exclude_recursion ? 1 : 0,
          input.delay_until_recursion ? 1 : 0,
          input.priority ?? 10,
          input.sticky ?? 0,
          input.cooldown ?? 0,
          input.delay ?? 0,
          input.selective_logic ?? 0,
          input.use_probability !== false ? 1 : 0,
          vectorized ? 1 : 0,
          vectorIndexState.vector_index_status,
          vectorIndexState.vector_indexed_at,
          vectorIndexState.vector_index_error,
          extensionsJson,
          now, now,
        );

        insertedIds.push(id);
        if (vectorized) vectorizedIds.push(id);
      }
    });
    tx();
  }

  if (insertedIds.length > 0) {
    db.query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(now, worldBookId);
  }

  return { insertedIds, vectorizedIds, aborted };
}

function queueVectorizationsBatch(userId: string, ids: string[]): void {
  for (const id of ids) {
    vectorizationQueue.queueWorldBookEntryVectorization(userId, id);
  }
}

// --- World Book Import (standalone JSON) ---

export function importWorldBook(
  userId: string,
  payload: any,
  options: ImportWorldBookOptions = {},
): ImportResult {
  // Accept imported lorebook format or a plain {entries} object.
  // Imported lorebooks may wrap entries in an object keyed by numeric index,
  // or provide them as an array.
  const bookName = payload.name || payload.originalName || "Imported World Book";
  const description = payload.description || "";

  const worldBook = createWorldBook(userId, {
    name: bookName,
    description,
    metadata: { source: "import" },
  });

  const rawEntries = normalizeImportedEntries(payload.entries);
  const inputs = rawEntries.map((raw, i) => normalizeImportedEntryInput(raw, i));

  const result = bulkInsertEntries(worldBook.id, inputs, { signal: options.signal });
  queueVectorizationsBatch(userId, result.vectorizedIds);

  emitWorldBookChanged(userId, worldBook.id);
  return {
    worldBook,
    entryCount: result.insertedIds.length,
    aborted: result.aborted || undefined,
  };
}

// Bulk import variant that forces vectorization off for every entry. Used by
// migration endpoints — users opt in to embeddings per-book afterwards.
export function importWorldBookBulk(
  userId: string,
  payload: any,
  options: ImportWorldBookOptions = {},
): ImportResult {
  const bookName = payload.name || payload.originalName || "Imported World Book";
  const description = payload.description || "";

  const worldBook = createWorldBook(userId, {
    name: bookName,
    description,
    metadata: { source: "import" },
  });

  const rawEntries = normalizeImportedEntries(payload.entries);
  const inputs = rawEntries.map((raw, i) => normalizeImportedEntryInput(raw, i));

  const result = bulkInsertEntries(worldBook.id, inputs, {
    forceVectorizedOff: true,
    signal: options.signal,
  });

  emitWorldBookChanged(userId, worldBook.id);
  return {
    worldBook,
    entryCount: result.insertedIds.length,
    aborted: result.aborted || undefined,
  };
}

// --- Character Book Import / Export ---

export function importCharacterBook(
  userId: string,
  characterId: string,
  characterName: string,
  characterBook: any,
  options: { autoManagedByCharacter?: boolean; signal?: AbortSignal } = {},
): ImportResult {
  const bookName = characterBook.name || `${characterName}'s Lorebook`;
  const importedAt = new Date().toLocaleString();
  const description = characterBook.description || `Imported from ${characterName} at ${importedAt}`;
  const worldBook = createWorldBook(userId, {
    name: bookName,
    description,
    metadata: {
      source: "character",
      source_character_id: characterId,
      auto_managed_by_character: options.autoManagedByCharacter === true,
    },
  });

  const rawEntries = normalizeImportedEntries(characterBook?.entries);
  const inputs = rawEntries.map((raw, i) => normalizeImportedEntryInput(raw, i));

  const result = bulkInsertEntries(worldBook.id, inputs, { signal: options.signal });
  queueVectorizationsBatch(userId, result.vectorizedIds);

  emitWorldBookChanged(userId, worldBook.id);
  return {
    worldBook,
    entryCount: result.insertedIds.length,
    aborted: result.aborted || undefined,
  };
}

// Import a world book from the Lumiverse export format (used in lumiverse_modules.json).
// Entries already use the internal schema, so normalizeImportedEntryInput is a no-op for
// the canonical fields and only kicks in for the legacy aliases it tolerates.
export function importLumiverseWorldBook(
  userId: string,
  characterId: string,
  data: Record<string, any>,
  options: ImportWorldBookOptions = {},
): ImportResult {
  const bookName = data.name || "Imported Lorebook";
  const description = data.description || `Imported from CharX at ${new Date().toLocaleString()}`;
  const worldBook = createWorldBook(userId, {
    name: bookName,
    description,
    metadata: { ...(data.metadata || {}), source: "charx_import", source_character_id: characterId },
  });

  const rawEntries = normalizeImportedEntries(data.entries);
  const inputs = rawEntries.map((raw, i) => normalizeImportedEntryInput(raw, i));

  const result = bulkInsertEntries(worldBook.id, inputs, { signal: options.signal });
  queueVectorizationsBatch(userId, result.vectorizedIds);

  emitWorldBookChanged(userId, worldBook.id);
  return {
    worldBook,
    entryCount: result.insertedIds.length,
    aborted: result.aborted || undefined,
  };
}

// --- World Book Export ---

export type WorldBookExportFormat = "lumiverse" | "character_book" | "sillytavern";

export function exportWorldBook(
  userId: string,
  worldBookId: string,
  format: WorldBookExportFormat = "lumiverse"
): Record<string, any> | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;
  const entries = listEntries(userId, worldBookId);

  switch (format) {
    case "lumiverse":
      return exportLumiverse(book, entries);
    case "character_book":
      return exportCharacterBookFormat(book, entries);
    case "sillytavern":
      return exportSillyTavern(book, entries);
  }
}

function exportLumiverse(book: WorldBook, entries: WorldBookEntry[]): Record<string, any> {
  return {
    version: 1,
    type: "lumiverse_world_book",
    name: book.name,
    description: book.description,
    metadata: book.metadata,
    entries: entries.map((entry) => {
      const { id, world_book_id, vector_index_status, vector_indexed_at, vector_index_error, created_at, updated_at, ...rest } = entry;
      return rest;
    }),
    exported_at: Math.floor(Date.now() / 1000),
  };
}

function entryToCharacterBookSpec(entry: WorldBookEntry, index: number): Record<string, any> {
  const extensions: Record<string, any> = {
    ...entry.extensions,
    priority: entry.priority,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    selective_logic: entry.selective_logic,
    use_probability: entry.use_probability,
    use_regex: entry.use_regex,
    prevent_recursion: entry.prevent_recursion,
    exclude_recursion: entry.exclude_recursion,
    delay_until_recursion: entry.delay_until_recursion,
    group_override: entry.group_override,
    group_weight: entry.group_weight,
    probability: entry.probability,
    scan_depth: entry.scan_depth,
    automation_id: entry.automation_id,
    vectorized: entry.vectorized,
    uid: entry.uid,
  };
  if (entry.outlet_name) extensions.outlet_name = entry.outlet_name;

  return {
    id: index,
    keys: entry.key,
    secondary_keys: entry.keysecondary,
    content: entry.content,
    comment: entry.comment,
    enabled: !entry.disabled,
    insertion_order: entry.order_value,
    position: entry.position,
    depth: entry.depth,
    selective: entry.selective,
    constant: entry.constant,
    case_sensitive: entry.case_sensitive,
    match_whole_words: entry.match_whole_words,
    ...(entry.role ? { role: entry.role } : {}),
    ...(entry.group_name ? { group: entry.group_name } : {}),
    extensions,
  };
}

function exportCharacterBookFormat(book: WorldBook, entries: WorldBookEntry[]): Record<string, any> {
  return {
    name: book.name,
    description: book.description,
    entries: entries.map((entry, i) => entryToCharacterBookSpec(entry, i)),
  };
}

function exportSillyTavern(book: WorldBook, entries: WorldBookEntry[]): Record<string, any> {
  return {
    name: book.name,
    description: book.description,
    entries: Object.fromEntries(
      entries.map((entry, i) => [
        String(i),
        {
          uid: entry.uid,
          keys: entry.key,
          secondary_keys: entry.keysecondary,
          content: entry.content,
          comment: entry.comment,
          enabled: !entry.disabled,
          insertion_order: entry.order_value,
          position: entry.position,
          depth: entry.depth,
          selective: entry.selective,
          constant: entry.constant,
          case_sensitive: entry.case_sensitive,
          match_whole_words: entry.match_whole_words,
          role: entry.role,
          group: entry.group_name,
          group_override: entry.group_override,
          group_weight: entry.group_weight,
          probability: entry.probability,
          scan_depth: entry.scan_depth,
          automation_id: entry.automation_id,
          selectiveLogic: entry.selective_logic,
          useProbability: entry.use_probability,
          use_regex: entry.use_regex,
          prevent_recursion: entry.prevent_recursion,
          exclude_recursion: entry.exclude_recursion,
          delay_until_recursion: entry.delay_until_recursion,
          priority: entry.priority,
          sticky: entry.sticky,
          cooldown: entry.cooldown,
          delay: entry.delay,
          vectorized: entry.vectorized,
          ...(entry.outlet_name ? { outlet_name: entry.outlet_name } : {}),
          ...entry.extensions,
        },
      ])
    ),
  };
}
