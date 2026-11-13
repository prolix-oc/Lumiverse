import type { Database } from "bun:sqlite";
import { hasImageReferenceIndex, isIndexableImageId, extractImageIds, refreshImageReferenceIndex } from "./image-reference-index";
import { createImageReferenceDiagnostics, timeImageReferenceStage, type ImageReferenceDiagnostics } from "./image-reference-diagnostics";
const WALLPAPER_LIBRARY_OWNER = "lumiverse.wallpaper";
function hasImageReference(db: Database, sql: string, params: any[], diagnostics: ImageReferenceDiagnostics): boolean {
  const stage = /FROM\s+(\w+)/i.exec(sql)?.[1] ?? "reference";
  return timeImageReferenceStage(diagnostics, stage, () => {
    try {
      const row = db.query(sql).get(...params) as { found?: number } | undefined;
      return !!row?.found;
    } catch (error) {
      if (!/no such (table|column)/i.test(String((error as Error)?.message ?? error))) throw error;
      // Some focused tests construct partial schemas; missing tables/columns mean
      // there cannot be a reference in that test database.
      return false;
    }
  });
}

function scanOneImage(db: Database, userId: string, id: string, diagnostics: ImageReferenceDiagnostics): boolean {
  const needle = `%${id}%`;
  return (
    hasImageReference(db,
      "SELECT 1 AS found FROM images WHERE user_id = ? AND id = ? AND owner_extension_identifier = ? LIMIT 1",
      [userId, id, WALLPAPER_LIBRARY_OWNER], diagnostics,
    ) ||
    hasImageReference(db,
      `SELECT 1 AS found
         FROM character_gallery cg
         JOIN characters c ON c.id = cg.character_id
        WHERE cg.user_id = ? AND cg.image_id = ? AND c.deleting = 0
        LIMIT 1`,
      [userId, id], diagnostics,
    ) ||
    hasImageReference(db,
      `SELECT 1 AS found FROM characters
       WHERE user_id = ? AND deleting = 0 AND (
         image_id = ? OR extensions LIKE ? OR description LIKE ? OR personality LIKE ? OR scenario LIKE ?
         OR first_mes LIKE ? OR mes_example LIKE ? OR creator_notes LIKE ? OR system_prompt LIKE ?
         OR post_history_instructions LIKE ? OR alternate_greetings LIKE ?
       ) LIMIT 1`,
      [userId, id, needle, needle, needle, needle, needle, needle, needle, needle, needle, needle], diagnostics,
    ) ||
    hasImageReference(db,
      "SELECT 1 AS found FROM personas WHERE user_id = ? AND (image_id = ? OR metadata LIKE ?) LIMIT 1",
      [userId, id, needle], diagnostics,
    ) ||
    hasImageReference(db,
      "SELECT 1 AS found FROM presets WHERE user_id = ? AND metadata LIKE ? LIMIT 1",
      [userId, needle], diagnostics,
    ) ||
    hasImageReference(db,
      "SELECT 1 AS found FROM theme_assets WHERE user_id = ? AND image_id = ? LIMIT 1",
      [userId, id], diagnostics,
    ) ||
    hasImageReference(db,
      "SELECT 1 AS found FROM chats WHERE user_id = ? AND metadata LIKE ? LIMIT 1",
      [userId, needle], diagnostics,
    ) ||
    hasImageReference(db,
      `SELECT 1 AS found FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE c.user_id = ? AND (m.extra LIKE ? OR m.swipes LIKE ? OR m.content LIKE ?) LIMIT 1`,
      [userId, needle, needle, needle], diagnostics,
    ) ||
    hasImageReference(db,
      "SELECT 1 AS found FROM settings WHERE user_id = ? AND value LIKE ? LIMIT 1",
      [userId, needle], diagnostics,
    )
  );
}


const IN_CHUNK = 400;
const MESSAGES_PAGE = 2000;
const BULK_SCAN_MIN_CANDIDATES = 8;

function bulkRows(db: Database, sql: string, params: any[]): any[] {
  try {
    return db.query(sql).all(...params) as any[];
  } catch (err: any) {
    if (/no such (table|column)/i.test(String(err?.message ?? err))) return [];
    throw err;
  }
}


function scanLegacyReferences(db: Database, userId: string, candidates: ReadonlySet<string>, diagnostics: ImageReferenceDiagnostics): Set<string> {
  if (candidates.size < BULK_SCAN_MIN_CANDIDATES || [...candidates].some(id => !isIndexableImageId(id))) {
    const referenced = new Set<string>();
    for (const id of candidates) {
      if (scanOneImage(db, userId, id, diagnostics)) referenced.add(id);
    }
    return referenced;
  }
  const byLower = new Map<string, string[]>();
  for (const id of candidates) byLower.set(id.toLowerCase(), [...(byLower.get(id.toLowerCase()) ?? []), id]);
  const referenced = new Set<string>();
  const done = () => referenced.size >= candidates.size;

  const scanText = (text: unknown): void => {
    if (typeof text !== "string" || text.length === 0) return;
    for (const id of extractImageIds([text])) {
      for (const original of byLower.get(id) ?? []) referenced.add(original);
    }
  };
  const markHit = (hit: unknown): void => {
    if (typeof hit !== "string") return;
    const orig = byLower.get(hit.toLowerCase());
    for (const original of orig ?? []) referenced.add(original);
  };

  try {
    const ids = [...candidates];
    const exactColumnQueries: ReadonlyArray<{ sql: (marks: string) => string; head: any[] }> = [
      {
        sql: (m) => `SELECT id AS hit FROM images WHERE user_id = ? AND owner_extension_identifier = ? AND id IN (${m})`,
        head: [userId, WALLPAPER_LIBRARY_OWNER],
      },
      {
        sql: (m) => `SELECT cg.image_id AS hit
                       FROM character_gallery cg
                       JOIN characters c ON c.id = cg.character_id
                      WHERE cg.user_id = ? AND c.deleting = 0 AND cg.image_id IN (${m})`,
        head: [userId],
      },
      { sql: (m) => `SELECT image_id AS hit FROM characters WHERE user_id = ? AND deleting = 0 AND image_id IN (${m})`, head: [userId] },
      { sql: (m) => `SELECT image_id AS hit FROM personas WHERE user_id = ? AND image_id IN (${m})`, head: [userId] },
      { sql: (m) => `SELECT image_id AS hit FROM theme_assets WHERE user_id = ? AND image_id IN (${m})`, head: [userId] },
    ];
    for (let i = 0; i < ids.length && !done(); i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const marks = chunk.map(() => "?").join(",");
      for (const q of exactColumnQueries) {
        const sql = q.sql(marks);
        timeImageReferenceStage(diagnostics, /FROM\s+(\w+)/i.exec(sql)?.[1] ?? "exact", () => {
          for (const row of bulkRows(db, sql, [...q.head, ...chunk])) markHit(row.hit);
        });
      }
    }

    if (!done()) {
      timeImageReferenceStage(diagnostics, "settings", () => {
        for (const row of bulkRows(db, "SELECT value FROM settings WHERE user_id = ?", [userId])) scanText(row.value);
      });
    }
    if (!done()) {
      timeImageReferenceStage(diagnostics, "chats", () => {
        for (const row of bulkRows(db, "SELECT metadata FROM chats WHERE user_id = ?", [userId])) scanText(row.metadata);
      });
    }
    if (!done()) {
      timeImageReferenceStage(diagnostics, "personas", () => {
        for (const row of bulkRows(db, "SELECT metadata FROM personas WHERE user_id = ?", [userId])) scanText(row.metadata);
      });
    }
    if (!done()) {
      timeImageReferenceStage(diagnostics, "presets", () => {
        for (const row of bulkRows(db, "SELECT metadata FROM presets WHERE user_id = ?", [userId])) scanText(row.metadata);
      });
    }
    if (!done()) timeImageReferenceStage(diagnostics, "characters", () => {
      const rows = bulkRows(db,
        `SELECT extensions, description, personality, scenario, first_mes, mes_example,
                creator_notes, system_prompt, post_history_instructions, alternate_greetings
         FROM characters WHERE user_id = ? AND deleting = 0`,
        [userId],
      );
      for (const row of rows) {
        for (const v of Object.values(row)) scanText(v);
        if (done()) break;
      }
    });

    if (!done()) timeImageReferenceStage(diagnostics, "messages", () => {
      let lastRowId = -1;
      while (!done()) {
        const rows = bulkRows(db,
          `SELECT m.rowid AS rid, m.extra, m.swipes, m.content
           FROM messages m JOIN chats c ON c.id = m.chat_id
           WHERE c.user_id = ? AND m.rowid > ?
           ORDER BY m.rowid LIMIT ${MESSAGES_PAGE}`,
          [userId, lastRowId],
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          scanText(row.extra);
          scanText(row.swipes);
          scanText(row.content);
        }
        lastRowId = rows[rows.length - 1].rid;
        if (rows.length < MESSAGES_PAGE) break;
      }
    });
  } catch (err) {
    console.error(`[images] findReferencedImageIds failed, failing closed (no deletions): ${err instanceof Error ? err.message : String(err)}`);
    return new Set(candidates);
  }
  return referenced;
}


export function isImageReferenced(db: Database, userId: string, id: string): boolean {
  return findReferencedImageIds(db, userId, new Set([id])).has(id);
}

/** Check current sources and index coverage in one snapshot. Legacy IDs retain LIKE semantics. */
export function findReferencedImageIds(
  db: Database, userId: string, candidates: ReadonlySet<string>,
  diagnostics = createImageReferenceDiagnostics(candidates.size),
): Set<string> {
  if (!candidates.size) return new Set();
  try {
    const referenced = db.transaction(() => {
      const indexable = [...candidates].every(isIndexableImageId);
      if (indexable && hasImageReferenceIndex(db)) {
        const status = timeImageReferenceStage(diagnostics, "refresh", () =>
          refreshImageReferenceIndex(db, userId));
        diagnostics.dirtyProcessed = status.processed;
        diagnostics.pendingSources = status.pendingSources;
        if (status.ready) {
          diagnostics.strategy = "indexed";
          return timeImageReferenceStage(diagnostics, "lookup", () => {
            const found = new Set<string>();
            for (const id of candidates) {
              const hit = db.query(`SELECT 1 AS found FROM image_references WHERE user_id = ? AND image_id = ? LIMIT 1`).get(userId, id.toLowerCase());
              if (hit) { found.add(id); continue; }
              // These exact references use dedicated B-tree indexes; no text is scanned.
              const exact = [
                { sql: "SELECT 1 AS found FROM images WHERE user_id = ? AND id = ? AND owner_extension_identifier = ?", params: [userId, id, WALLPAPER_LIBRARY_OWNER] },
                { sql: "SELECT 1 AS found FROM character_gallery cg JOIN characters c ON c.id = cg.character_id WHERE cg.user_id = ? AND cg.image_id = ? AND c.deleting = 0 LIMIT 1", params: [userId, id] },
                { sql: "SELECT 1 AS found FROM characters WHERE user_id = ? AND image_id = ? AND deleting = 0 LIMIT 1", params: [userId, id] },
                { sql: "SELECT 1 AS found FROM personas WHERE user_id = ? AND image_id = ? LIMIT 1", params: [userId, id] },
                { sql: "SELECT 1 AS found FROM theme_assets WHERE user_id = ? AND image_id = ? LIMIT 1", params: [userId, id] },
              ];
              if (exact.some(query => db.query(query.sql).get(...query.params))) found.add(id);
            }
            return found;
          });
        }
        diagnostics.strategy = status.pendingSources > 0 ? "backfill" : "dirty-fallback";
      }
      return scanLegacyReferences(db, userId, candidates, diagnostics);
    }).immediate();
    diagnostics.referencedCount = referenced.size;
    return referenced;
  } catch (error) {
    // Index/scan errors cannot authorize a deletion. Rollback also restores dirty
    // markers so the next request can repair or retry safely.
    diagnostics.strategy = "index-error";
    diagnostics.referencedCount = candidates.size;
    console.error(`[images] reference check failed, retaining candidates: ${error instanceof Error ? error.message : String(error)}`);
    return new Set(candidates);
  }
}
