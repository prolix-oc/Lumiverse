import { getDb } from "../db/connection";
import type {
  WorldBook, WorldBookEntry,
  CreateWorldBookInput, UpdateWorldBookInput,
  CreateWorldBookEntryInput, UpdateWorldBookEntryInput,
  WorldBookVectorIndexStatus, WorldBookVectorSummary,
} from "../types/world-book";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import * as embeddingsSvc from "./embeddings.service";

function rowToBook(row: any): WorldBook {
  return { ...row, metadata: JSON.parse(row.metadata) };
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
  return {
    ...row,
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
    extensions: JSON.parse(row.extensions),
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
  return input.vectorized !== undefined || input.content !== undefined || input.disabled !== undefined;
}

// --- World Book CRUD ---

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

export function createWorldBook(userId: string, input: CreateWorldBookInput): WorldBook {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query("INSERT INTO world_books (id, user_id, name, description, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.name, input.description || "", JSON.stringify(input.metadata || {}), now, now);
  return getWorldBook(userId, id)!;
}

export function updateWorldBook(userId: string, id: string, input: UpdateWorldBookInput): WorldBook | null {
  const existing = getWorldBook(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.description !== undefined) { fields.push("description = ?"); values.push(input.description); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE world_books SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  return getWorldBook(userId, id)!;
}

export function deleteWorldBook(userId: string, id: string): boolean {
  return getDb().query("DELETE FROM world_books WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
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
  }

  if (!enabled) {
    for (const entry of listEntries(userId, worldBookId)) {
      void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, entry.id).catch((err: unknown) => {
        console.warn("[embeddings] Failed to remove world book entry vectors:", err);
      });
    }
  }

  return {
    summary: getWorldBookVectorSummary(userId, worldBookId)!,
    updated_entries: updatedEntries,
  };
}

// --- World Book Entry CRUD ---

export function listEntriesPaginated(userId: string, worldBookId: string, pagination: PaginationParams): PaginatedResult<WorldBookEntry> {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return { data: [], total: 0, limit: pagination.limit, offset: pagination.offset };

  return paginatedQuery(
    "SELECT * FROM world_book_entries WHERE world_book_id = ? ORDER BY order_value ASC",
    "SELECT COUNT(*) as count FROM world_book_entries WHERE world_book_id = ?",
    [worldBookId],
    pagination,
    rowToEntry
  );
}

export function listEntries(userId: string, worldBookId: string): WorldBookEntry[] {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return [];

  return (getDb().query("SELECT * FROM world_book_entries WHERE world_book_id = ? ORDER BY order_value ASC").all(worldBookId) as any[]).map(rowToEntry);
}

export function getEntry(userId: string, id: string): WorldBookEntry | null {
  const row = getDb().query(
    "SELECT e.* FROM world_book_entries e JOIN world_books w ON e.world_book_id = w.id WHERE e.id = ? AND w.user_id = ?"
  ).get(id, userId) as any;
  return row ? rowToEntry(row) : null;
}

export function createEntry(userId: string, worldBookId: string, input: CreateWorldBookEntryInput): WorldBookEntry | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;

  const id = crypto.randomUUID();
  const uid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const vectorized = !!input.vectorized;
  const vectorIndexState = getPendingVectorIndexState(vectorized);

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
      JSON.stringify(input.extensions || {}),
      now, now
    );

  getDb().query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(now, worldBookId);
  const created = getEntry(userId, id)!;
  if (created.vectorized) {
    void embeddingsSvc.syncWorldBookEntryEmbedding(userId, created).catch((err: unknown) => {
      console.warn("[embeddings] Failed to index world book entry:", err);
    });
  }
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

  if (input.extensions !== undefined) { fields.push("extensions = ?"); values.push(JSON.stringify(input.extensions)); }

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
  const updated = getEntry(userId, id)!;
  if (updated.vectorized) {
    void embeddingsSvc.syncWorldBookEntryEmbedding(userId, updated).catch((err: unknown) => {
      console.warn("[embeddings] Failed to index world book entry:", err);
    });
  } else {
    void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, updated.id).catch((err: unknown) => {
      console.warn("[embeddings] Failed to remove world book entry vectors:", err);
    });
  }
  return updated;
}

export function deleteEntry(userId: string, id: string): boolean {
  // Verify the entry belongs to a world book owned by this user
  const entry = getEntry(userId, id);
  if (!entry) return false;

  const deleted = getDb().query("DELETE FROM world_book_entries WHERE id = ?").run(id).changes > 0;
  if (deleted) {
    void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, id).catch((err: unknown) => {
      console.warn("[embeddings] Failed to remove world book entry vectors:", err);
    });
  }
  return deleted;
}

// --- World Book Import (standalone JSON) ---

export function importWorldBook(
  userId: string,
  payload: any
): { worldBook: WorldBook; entryCount: number } {
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

  // Normalize entries: object-keyed to array
  let rawEntries: any[] = [];
  const src = payload.entries;
  if (Array.isArray(src)) {
    rawEntries = src;
  } else if (src && typeof src === "object") {
    rawEntries = Object.values(src);
  }

  let entryCount = 0;
  for (const raw of rawEntries) {
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
    const enabled = raw.enabled !== undefined ? raw.enabled : (raw.disabled !== undefined ? !raw.disabled : true);

    // Collect unknown fields into extensions
    const knownFields = new Set([
      "keys", "key", "secondary_keys", "keysecondary", "content", "comment", "name", "enabled", "disabled",
      "insertion_order", "order_value", "position", "depth", "role", "selective",
      "constant", "case_sensitive", "match_whole_words", "group", "group_name",
      "group_override", "group_weight", "probability", "scan_depth",
      "automation_id", "extensions", "selectiveLogic", "selective_logic",
      "useProbability", "use_probability", "use_regex",
      "prevent_recursion", "exclude_recursion", "delay_until_recursion",
      "priority", "sticky", "cooldown", "delay",
      "id", "entry", "uid", "vectorized",
    ]);
    const extras: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!knownFields.has(k)) extras[k] = v;
    }

    createEntry(userId, worldBook.id, {
      key: keys,
      keysecondary: secondaryKeys,
      content: raw.content || "",
      comment,
      disabled: !enabled,
      order_value: raw.insertion_order ?? raw.order_value ?? 100,
      position: raw.position ?? 0,
      depth: raw.depth ?? 4,
      role: raw.role || undefined,
      selective: raw.selective ?? false,
      constant: raw.constant ?? false,
      case_sensitive: raw.case_sensitive ?? false,
      match_whole_words: raw.match_whole_words ?? false,
      group_name: raw.group || raw.group_name || "",
      group_override: raw.group_override ?? false,
      group_weight: raw.group_weight ?? 100,
      probability: raw.probability ?? 100,
      scan_depth: raw.scan_depth ?? undefined,
      automation_id: raw.automation_id || undefined,
      selective_logic: raw.selectiveLogic ?? raw.selective_logic ?? 0,
      use_probability: raw.useProbability !== undefined ? raw.useProbability : (raw.use_probability !== undefined ? raw.use_probability : true),
      use_regex: raw.use_regex ?? false,
      prevent_recursion: raw.prevent_recursion ?? false,
      exclude_recursion: raw.exclude_recursion ?? false,
      delay_until_recursion: raw.delay_until_recursion ?? false,
      priority: raw.priority ?? 10,
      sticky: raw.sticky ?? 0,
      cooldown: raw.cooldown ?? 0,
      delay: raw.delay ?? 0,
      vectorized: raw.vectorized ?? false,
      extensions: { ...raw.extensions, ...extras },
    });
    entryCount++;
  }

  return { worldBook, entryCount };
}

/**
 * Bulk import variant that skips per-entry embedding indexing and
 * runs all inserts in a single transaction. Used by migration endpoints.
 */
export function importWorldBookBulk(
  userId: string,
  payload: any
): { worldBook: WorldBook; entryCount: number } {
  const bookName = payload.name || payload.originalName || "Imported World Book";
  const description = payload.description || "";

  const worldBook = createWorldBook(userId, {
    name: bookName,
    description,
    metadata: { source: "import" },
  });

  let rawEntries: any[] = [];
  const src = payload.entries;
  if (Array.isArray(src)) {
    rawEntries = src;
  } else if (src && typeof src === "object") {
    rawEntries = Object.values(src);
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

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

  let entryCount = 0;

  const tx = db.transaction(() => {
    for (const raw of rawEntries) {
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
      const enabled = raw.enabled !== undefined ? raw.enabled : (raw.disabled !== undefined ? !raw.disabled : true);

      insert.run(
        crypto.randomUUID(), worldBook.id, crypto.randomUUID(),
        JSON.stringify(keys),
        JSON.stringify(secondaryKeys),
        raw.content || "",
        comment,
        raw.position ?? 0,
        raw.depth ?? 4,
        raw.role || null,
        raw.insertion_order ?? raw.order_value ?? 100,
        raw.selective ? 1 : 0,
        raw.constant ? 1 : 0,
        !enabled ? 1 : 0,
        raw.group || raw.group_name || "",
        raw.group_override ? 1 : 0,
        raw.group_weight ?? 100,
        raw.probability ?? 100,
        raw.scan_depth ?? null,
        raw.case_sensitive ? 1 : 0,
        raw.match_whole_words ? 1 : 0,
        raw.automation_id || null,
        raw.use_regex ? 1 : 0,
        raw.prevent_recursion ? 1 : 0,
        raw.exclude_recursion ? 1 : 0,
        raw.delay_until_recursion ? 1 : 0,
        raw.priority ?? 10,
        raw.sticky ?? 0,
        raw.cooldown ?? 0,
        raw.delay ?? 0,
        raw.selectiveLogic ?? raw.selective_logic ?? 0,
        (raw.useProbability !== undefined ? raw.useProbability : (raw.use_probability !== undefined ? raw.use_probability : true)) ? 1 : 0,
        0, // vectorized is always false for bulk import; user can re-enable it later
        "not_enabled",
        null,
        null,
        JSON.stringify(raw.extensions || {}),
        now, now
      );
      entryCount++;
    }
  });

  tx();

  if (entryCount > 0) {
    db.query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(now, worldBook.id);
  }

  return { worldBook, entryCount };
}

// --- Character Book Import ---

export function importCharacterBook(
  userId: string,
  characterId: string,
  characterName: string,
  characterBook: any
): { worldBook: WorldBook; entryCount: number } {
  const bookName = characterBook.name || `${characterName}'s Lorebook`;
  const importedAt = new Date().toLocaleString();
  const description = characterBook.description || `Imported from ${characterName} at ${importedAt}`;
  const worldBook = createWorldBook(userId, {
    name: bookName,
    description,
    metadata: { source: "character", source_character_id: characterId },
  });

  const entries = characterBook.entries || [];
  let entryCount = 0;

  for (const raw of entries) {
    const keys: string[] = Array.isArray(raw.keys) ? raw.keys : [];
    const secondaryKeys: string[] = Array.isArray(raw.secondary_keys) ? raw.secondary_keys : [];

    // Map known CCV2/V3 field names to our schema
    const comment = raw.comment || raw.name || "";
    const enabled = raw.enabled !== undefined ? raw.enabled : true;

    // Collect unknown fields into extensions
    const knownFields = new Set([
      "keys", "secondary_keys", "content", "comment", "name", "enabled",
      "insertion_order", "position", "depth", "role", "selective",
      "constant", "case_sensitive", "match_whole_words", "group",
      "group_override", "group_weight", "probability", "scan_depth",
      "automation_id", "extensions", "selectiveLogic", "useProbability",
      "use_regex", "prevent_recursion", "exclude_recursion",
      "delay_until_recursion", "priority", "sticky", "cooldown", "delay",
      "id", "entry", "uid",
    ]);
    const extras: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!knownFields.has(k)) extras[k] = v;
    }

    createEntry(userId, worldBook.id, {
      key: keys,
      keysecondary: secondaryKeys,
      content: raw.content || "",
      comment,
      disabled: !enabled,
      order_value: raw.insertion_order ?? 100,
      position: raw.position ?? 0,
      depth: raw.depth ?? 4,
      role: raw.role || undefined,
      selective: raw.selective ?? false,
      constant: raw.constant ?? false,
      case_sensitive: raw.case_sensitive ?? false,
      match_whole_words: raw.match_whole_words ?? false,
      group_name: raw.group || "",
      group_override: raw.group_override ?? false,
      group_weight: raw.group_weight ?? 100,
      probability: raw.probability ?? 100,
      scan_depth: raw.scan_depth ?? undefined,
      automation_id: raw.automation_id || undefined,
      selective_logic: raw.selectiveLogic ?? raw.selective_logic ?? 0,
      use_probability: raw.useProbability !== undefined ? raw.useProbability : (raw.use_probability !== undefined ? raw.use_probability : true),
      use_regex: raw.use_regex ?? false,
      prevent_recursion: raw.prevent_recursion ?? false,
      exclude_recursion: raw.exclude_recursion ?? false,
      delay_until_recursion: raw.delay_until_recursion ?? false,
      priority: raw.priority ?? 10,
      sticky: raw.sticky ?? 0,
      cooldown: raw.cooldown ?? 0,
      delay: raw.delay ?? 0,
      extensions: { ...raw.extensions, ...extras },
    });
    entryCount++;
  }

  return { worldBook, entryCount };
}
