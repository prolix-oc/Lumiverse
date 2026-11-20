import type { Database, SQLQueryBindings } from "bun:sqlite";

// Match UUID substrings just as LIKE '%id%' does, including uppercase, embedded
// IDs and UUID versions beyond v5. Do not parse JSON: references can be plain text.
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_ID_RE = new RegExp(`^${UUID_PATTERN}$`, "i");
const UUID_TEXT_RE = new RegExp(UUID_PATTERN, "gi");
export const isIndexableImageId = (id: string): boolean => UUID_ID_RE.test(id);
export function extractImageIds(values: Iterable<unknown>): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length < 36) continue;
    for (const match of value.matchAll(UUID_TEXT_RE)) ids.add(match[0].toLowerCase());
  }
  return ids;
}

const SOURCES = {
  characters: "extensions, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, alternate_greetings",
  personas: "metadata",
  presets: "metadata",
  chats: "metadata",
  messages: "extra, swipes, content",
  settings: "value",
} as const;
type Source = keyof typeof SOURCES;
const SOURCE_FIELDS = Object.fromEntries(Object.entries(SOURCES).map(([source, columns]) => [source, columns.split(", ")])) as Record<Source, string[]>;
interface SourceRow { source_id: string; user_id: string | null; [column: string]: unknown }
interface Cursor { source_type: Source; last_id: string | null; last_user_id: string | null; completed: number }
interface Dirty { source_type: Source; source_id: string; user_id: string }
const schemaCache = new WeakMap<Database, { version: number; available: boolean }>();

/** Missing schema/triggers never turn into a negative reference result. */
export function hasImageReferenceIndex(db: Database): boolean {
  const version = (db.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
  const cached = schemaCache.get(db);
  if (cached?.version === version) return cached.available;
  const names = new Set((db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all() as { name: string }[]).map(row => row.name));
  const required = ["image_references", "image_reference_dirty", "image_reference_index_state", "images", "character_gallery", "theme_assets",
    ...Object.keys(SOURCES).flatMap(source => [source, ...["insert", "update", "delete"].map(action => `image_refs_${source}_${action}`)])];
  const available = required.every(name => names.has(name));
  schemaCache.set(db, { version, available });
  return available;
}

function selectColumns(source: Source): string {
  if (source === "settings") return "json_array(key, user_id) AS source_id, user_id, key, value";
  if (source === "messages") return "m.id AS source_id, c.user_id, m.extra, m.swipes, m.content";
  return `id AS source_id, user_id, ${SOURCES[source]}${source === "characters" ? ", deleting" : ""}`;
}
function fetchSource(db: Database, source: Source, id: string): SourceRow | null {
  if (source === "settings") {
    const [key, userId] = JSON.parse(id) as [string, string | null];
    return db.query(`SELECT ${selectColumns(source)} FROM settings WHERE key = ? AND user_id IS ?`).get(key, userId) as SourceRow | null;
  }
  if (source === "messages") {
    return db.query(`SELECT ${selectColumns(source)} FROM messages m LEFT JOIN chats c ON c.id = m.chat_id WHERE m.id = ?`).get(id) as SourceRow | null;
  }
  return db.query(`SELECT ${selectColumns(source)} FROM ${source} WHERE id = ?`).get(id) as SourceRow | null;
}
function replaceReferences(db: Database, source: Source, id: string, row: SourceRow | null): void {
  db.query("DELETE FROM image_references WHERE source_type = ? AND source_id = ?").run(source, id);
  if (row && row.user_id !== null && !(source === "characters" && row.deleting)) {
    const values = SOURCE_FIELDS[source].map(column => row[column]);
    const insert = db.query("INSERT INTO image_references(source_type, source_id, user_id, image_id) VALUES (?, ?, ?, ?)");
    for (const imageId of extractImageIds(values)) insert.run(source, id, row.user_id, imageId);
  }
  db.query("DELETE FROM image_reference_dirty WHERE source_type = ? AND source_id = ?").run(source, id);
}
function remainingSources(db: Database): number {
  const states = db.query("SELECT source_type, completed FROM image_reference_index_state").all() as Cursor[];
  return Object.keys(SOURCES).filter(source => !states.some(state => state.source_type === source && state.completed === 1)).length;
}

export interface ImageReferenceIndexStatus {
  available: boolean;
  ready: boolean;
  processed: number;
  pendingSources: number;
  dirtyRemaining: boolean;
}

/** Caller must hold a write transaction so source reads and invalidations agree. */
export function refreshImageReferenceIndex(db: Database, userId: string, maxRows = 100, budgetMs = 25): ImageReferenceIndexStatus {
  if (!hasImageReferenceIndex(db)) return { available: false, ready: false, processed: 0, pendingSources: 6, dirtyRemaining: false };
  const started = performance.now();
  const dirty = db.query("SELECT source_type, source_id, user_id FROM image_reference_dirty WHERE user_id = ? LIMIT ?").all(userId, maxRows) as Dirty[];
  let processed = 0;
  for (const row of dirty) {
    replaceReferences(db, row.source_type, row.source_id, fetchSource(db, row.source_type, row.source_id));
    processed++;
    if (performance.now() - started >= budgetMs) break;
  }
  const pendingSources = remainingSources(db);
  const dirtyRemaining = !!db.query("SELECT 1 FROM image_reference_dirty WHERE user_id = ? LIMIT 1").get(userId);
  return { available: true, ready: pendingSources === 0 && !dirtyRemaining, processed, pendingSources, dirtyRemaining };
}

/** One bounded, atomic batch; persisted cursors survive child interruption/restart. */
export function populateImageReferenceIndex(db: Database, maxRows = 100, budgetMs = 25): { processed: number; pending: boolean } {
  if (!hasImageReferenceIndex(db)) return { processed: 0, pending: false };
  // An idle worker must not acquire a writer lock. A write arriving just after
  // this check is covered by its trigger and the next batch/foreground refresh.
  if (remainingSources(db) === 0 && !db.query("SELECT 1 FROM image_reference_dirty LIMIT 1").get()) {
    return { processed: 0, pending: false };
  }
  return db.transaction(() => {
    const started = performance.now();
    let processed = 0;
    // Alternate backfill and dirty work by giving each at most half the batch.
    // Continuous generation must not starve historical coverage.
    const dirtyLimit = Math.max(1, Math.floor(maxRows / 2));
    const dirty = db.query("SELECT source_type, source_id, user_id FROM image_reference_dirty LIMIT ?").all(dirtyLimit) as Dirty[];
    for (const row of dirty) {
      replaceReferences(db, row.source_type, row.source_id, fetchSource(db, row.source_type, row.source_id));
      processed++;
      if (performance.now() - started >= budgetMs) break;
    }
    if (performance.now() - started < budgetMs && processed < maxRows) {
      const state = db.query("SELECT * FROM image_reference_index_state WHERE completed = 0 ORDER BY source_type LIMIT 1").get() as Cursor | null;
      if (state) {
        const source = state.source_type;
        const limit = maxRows - processed;
        let sql: string;
        let bindings: SQLQueryBindings[];
        if (source === "settings") {
          sql = `SELECT ${selectColumns(source)} FROM settings WHERE user_id IS NOT NULL${state.last_id === null ? "" : " AND (key, user_id) > (?, ?)"} ORDER BY key, user_id LIMIT ?`;
          bindings = state.last_id === null ? [limit] : [state.last_id, state.last_user_id, limit];
        } else {
          const from = source === "messages" ? "messages m LEFT JOIN chats c ON c.id = m.chat_id" : source;
          const id = source === "messages" ? "m.id" : "id";
          sql = `SELECT ${selectColumns(source)} FROM ${from}${state.last_id === null ? "" : ` WHERE ${id} > ?`} ORDER BY ${id} LIMIT ?`;
          bindings = state.last_id === null ? [limit] : [state.last_id, limit];
        }
        const rows = db.query(sql).all(...bindings) as SourceRow[];
        let last: SourceRow | undefined;
        for (const row of rows) {
          if (row.source_id === null) throw new Error(`Cannot index ${source} with a null source ID`);
          replaceReferences(db, source, row.source_id, row);
          processed++;
          last = row;
          if (performance.now() - started >= budgetMs) break;
        }
        if (last) db.query("UPDATE image_reference_index_state SET last_id = ?, last_user_id = ? WHERE source_type = ?")
          .run(source === "settings" ? String(last.key) : last.source_id, last.user_id, source);
        if (rows.length < limit && (!rows.length || last === rows.at(-1))) {
          db.query("UPDATE image_reference_index_state SET completed = 1 WHERE source_type = ?").run(source);
        }
      }
    }
    const pending = remainingSources(db) > 0 || !!db.query("SELECT 1 FROM image_reference_dirty LIMIT 1").get();
    return { processed, pending };
  }).immediate();
}

/** Only the supervised child runs background indexing, never the HTTP thread. */
export function startImageReferenceIndexer(db: Database): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let lastErrorAt = -Infinity;
  const tick = () => {
    if (stopped) return;
    let delay = 1000;
    try {
      if (populateImageReferenceIndex(db).pending) delay = 25;
    } catch (error) {
      // A competing writer is routine; leave the atomic batch/cursor untouched.
      if (!/SQLITE_BUSY|database is locked/i.test(String(error)) && performance.now() - lastErrorAt > 60_000) {
        console.warn(`[db] image-reference index batch failed: ${error instanceof Error ? error.message : String(error)}`);
        lastErrorAt = performance.now();
      }
    }
    timer = setTimeout(tick, delay);
    timer.unref();
  };
  timer = setTimeout(tick, 0);
  timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
