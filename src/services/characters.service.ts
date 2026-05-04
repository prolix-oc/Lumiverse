import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Character, CharacterSummary, CreateCharacterInput, UpdateCharacterInput } from "../types/character";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import * as filesSvc from "./files.service";
import * as imagesSvc from "./images.service";
import { deleteRegexScriptsByCharacterId } from "./regex-scripts.service";
import { deleteAutoManagedCharacterWorldBooks } from "./world-books.service";

// ─── Summary queries (lightweight, for character browser) ─────────────────

const SUMMARY_COLUMNS = `c.id, c.name, c.creator, c.tags, c.image_id, c.created_at, c.updated_at,
  (json_array_length(c.alternate_greetings) > 0) as has_alternate_greetings`;

function rowToSummary(row: any): CharacterSummary {
  return {
    id: row.id,
    name: row.name,
    creator: row.creator,
    tags: JSON.parse(row.tags),
    image_id: row.image_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_alternate_greetings: !!row.has_alternate_greetings,
  };
}

/**
 * Build an FTS5 MATCH query for the trigram tokenizer. Each whitespace-delimited
 * token is wrapped in a quoted phrase (substring needle); tokens are AND-ed
 * together. Embedded double quotes are escaped by doubling per FTS5 syntax.
 *
 * Returns "" when the trimmed input is shorter than the trigram minimum (3
 * chars). Callers must fall back to LIKE in that case — see `buildLikeFallback`.
 */
function sanitizeFtsQuery(input: string): string {
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

export interface SummaryQueryOptions {
  search?: string;
  tags?: string[];
  sort?: string;
  direction?: "asc" | "desc";
  favoriteIds?: string[];
  filterMode?: "all" | "favorites" | "non-favorites";
  seed?: number;
}

const UUID_HEX_SQL = "LOWER(REPLACE(c.id, '-', ''))";

function normalizeShuffleSeed(seed?: number): number {
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    return Math.floor(Date.now() / 86_400_000);
  }
  return Math.trunc(seed);
}

function buildDiscoverBoostSql(lastChatParam = "?"): string {
  return `(
    CASE WHEN COALESCE(cs.chat_count, 0) = 0 THEN 0.18 ELSE 0 END
    + (MIN(COALESCE((${lastChatParam} - cs.last_chat_at) / 86400.0, 365.0), 365.0) / 365.0) * 0.08
    + CASE
        WHEN COALESCE(cs.chat_count, 0) = 0 THEN 0.04
        ELSE (MIN(MAX(24 - COALESCE(cs.chat_count, 0), 0), 24) / 24.0) * 0.04
      END
  )`;
}

function buildHexDigitPermutation(seed: number): string[] {
  const digits = "0123456789abcdef".split("");
  let state = (Math.abs(seed) % 0x7fffffff) || 1;
  for (let i = digits.length - 1; i > 0; i -= 1) {
    state = (state * 48271) % 0x7fffffff;
    const swapIndex = state % (i + 1);
    [digits[i], digits[swapIndex]] = [digits[swapIndex], digits[i]];
  }
  return digits;
}

function advanceShufflePrng(state: number): number {
  return (state * 48271) % 0x7fffffff;
}

function buildShuffleWeights(seed: number, count: number): number[] {
  let state = (Math.abs(seed) % 0x7fffffff) || 1;
  return Array.from({ length: count }, () => {
    state = advanceShufflePrng(state);
    return (state % 1009) + 17;
  });
}

function buildTranslatedHexCharSql(position: number, permutation: string[]): string {
  const cases = permutation
    .map((mappedDigit, index) => `WHEN '${index.toString(16)}' THEN '${mappedDigit}'`)
    .join(" ");
  return `(CASE SUBSTR(${UUID_HEX_SQL}, ${position}, 1) ${cases} ELSE '0' END)`;
}

function buildTranslatedHexValueSql(position: number, permutation: string[]): string {
  const cases = permutation
    .map((mappedDigit, index) => `WHEN '${index.toString(16)}' THEN ${parseInt(mappedDigit, 16)}`)
    .join(" ");
  return `(CASE SUBSTR(${UUID_HEX_SQL}, ${position}, 1) ${cases} ELSE 0 END)`;
}

function buildSeededShuffleSql(seed: number): string {
  const permutation = buildHexDigitPermutation(seed);
  return Array.from({ length: 32 }, (_, index) => buildTranslatedHexCharSql(index + 1, permutation)).join(" || ");
}

function buildSeededShuffleValueSql(seed: number): string {
  const permutation = buildHexDigitPermutation(seed);
  const weights = buildShuffleWeights(seed, 32);
  const terms = weights.map((weight, index) => `(${buildTranslatedHexValueSql(index + 1, permutation)} * ${weight})`);
  return `(((${terms.join(" + ")}) % 65521) / 65521.0)`;
}

export function listCharacterSummaries(
  userId: string,
  pagination: PaginationParams,
  options: SummaryQueryOptions = {}
): PaginatedResult<CharacterSummary> {
  const db = getDb();
  const { search, tags, sort, direction = "desc", favoriteIds, filterMode = "all", seed } = options;

  if (filterMode === "favorites" && (!favoriteIds || favoriteIds.length === 0)) {
    return {
      data: [],
      total: 0,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  }

  // Use discover sort if requested
  if (sort === "discover") {
    return listCharacterSummariesDiscover(userId, pagination, options);
  }

  const whereClauses: string[] = ["c.user_id = ?"];
  const whereParams: any[] = [userId];

  // FTS5 (trigram) search — falls back to LIKE for 1–2 char queries that
  // trigram cannot match (common for 2-char CJK names like 魔王).
  let fromClause = "characters c";
  let usedFts = false;
  if (search) {
    const ftsQuery = sanitizeFtsQuery(search);
    if (ftsQuery) {
      fromClause = "characters c JOIN characters_fts fts ON fts.rowid = c.rowid";
      whereClauses.push("characters_fts MATCH ?");
      whereParams.push(ftsQuery);
      usedFts = true;
    } else {
      const trimmed = search.trim();
      if (trimmed) {
        const like = `%${escapeLike(trimmed)}%`;
        whereClauses.push(
          "(c.name LIKE ? ESCAPE '\\' OR c.creator LIKE ? ESCAPE '\\' OR c.tags LIKE ? ESCAPE '\\')"
        );
        whereParams.push(like, like, like);
      }
    }
  }

  // Tag AND filter
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      whereClauses.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ?)");
      whereParams.push(tag);
    }
  }

  // Favorites filter
  if (filterMode === "favorites" && favoriteIds && favoriteIds.length > 0) {
    whereClauses.push(`c.id IN (${favoriteIds.map(() => "?").join(",")})`);
    whereParams.push(...favoriteIds);
  } else if (filterMode === "non-favorites" && favoriteIds && favoriteIds.length > 0) {
    whereClauses.push(`c.id NOT IN (${favoriteIds.map(() => "?").join(",")})`);
    whereParams.push(...favoriteIds);
  }

  const whereStr = whereClauses.join(" AND ");

  // Sort
  let orderBy: string;
  if (usedFts && !sort) {
    orderBy = "ORDER BY rank"; // FTS5 relevance — only valid when MATCH was used
  } else if (search && !sort) {
    orderBy = "ORDER BY c.updated_at DESC"; // LIKE fallback has no rank column
  } else {
    switch (sort) {
      case "name":
        orderBy = `ORDER BY c.name ${direction === "desc" ? "DESC" : "ASC"}`;
        break;
      case "created":
        orderBy = `ORDER BY c.created_at ${direction === "desc" ? "DESC" : "ASC"}`;
        break;
      case "recent":
      default:
        orderBy = `ORDER BY c.updated_at ${direction === "desc" ? "DESC" : "ASC"}`;
        break;
      }
  }

  return paginatedQuery(
    `SELECT ${SUMMARY_COLUMNS} FROM ${fromClause} WHERE ${whereStr} ${orderBy}`,
    `SELECT COUNT(*) as count FROM ${fromClause} WHERE ${whereStr}`,
    whereParams,
    pagination,
    rowToSummary
  );
}

function listCharacterSummariesDiscover(
  userId: string,
  pagination: PaginationParams,
  options: SummaryQueryOptions = {}
): PaginatedResult<CharacterSummary> {
  const db = getDb();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const shuffleSeed = normalizeShuffleSeed(options.seed);
  const { search, tags, favoriteIds, filterMode = "all" } = options;

  if (filterMode === "favorites" && (!favoriteIds || favoriteIds.length === 0)) {
    return {
      data: [],
      total: 0,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  }

  const whereClauses: string[] = ["c.user_id = ?"];
  const whereParams: any[] = [userId];

  let extraJoin = "";
  if (search) {
    const ftsQuery = sanitizeFtsQuery(search);
    if (ftsQuery) {
      extraJoin = "JOIN characters_fts fts ON fts.rowid = c.rowid";
      whereClauses.push("characters_fts MATCH ?");
      whereParams.push(ftsQuery);
    } else {
      const trimmed = search.trim();
      if (trimmed) {
        const like = `%${escapeLike(trimmed)}%`;
        whereClauses.push(
          "(c.name LIKE ? ESCAPE '\\' OR c.creator LIKE ? ESCAPE '\\' OR c.tags LIKE ? ESCAPE '\\')"
        );
        whereParams.push(like, like, like);
      }
    }
  }

  if (tags && tags.length > 0) {
    for (const tag of tags) {
      whereClauses.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ?)");
      whereParams.push(tag);
    }
  }

  if (filterMode === "favorites" && favoriteIds && favoriteIds.length > 0) {
    whereClauses.push(`c.id IN (${favoriteIds.map(() => "?").join(",")})`);
    whereParams.push(...favoriteIds);
  } else if (filterMode === "non-favorites" && favoriteIds && favoriteIds.length > 0) {
    whereClauses.push(`c.id NOT IN (${favoriteIds.map(() => "?").join(",")})`);
    whereParams.push(...favoriteIds);
  }

  const whereStr = whereClauses.join(" AND ");
  const discoverBoostSql = buildDiscoverBoostSql();
  const shuffleKeySql = buildSeededShuffleSql(shuffleSeed);
  const shuffleValueSql = buildSeededShuffleValueSql(shuffleSeed);

  const countRow = db
    .query(`SELECT COUNT(*) as count FROM characters c ${extraJoin} WHERE ${whereStr}`)
    .get(...whereParams) as { count: number } | null;
  const total = countRow?.count ?? 0;

  const dataSql = `
    SELECT ${SUMMARY_COLUMNS}
    FROM characters c
    ${extraJoin}
    LEFT JOIN (
      SELECT character_id,
             COUNT(*)        AS chat_count,
             MAX(updated_at) AS last_chat_at
      FROM chats
      WHERE user_id = ? AND COALESCE(json_extract(metadata, '$.group'), 0) != 1
      GROUP BY character_id
    ) cs ON cs.character_id = c.id
    WHERE ${whereStr}
    ORDER BY ((${shuffleValueSql}) - (${discoverBoostSql})) ASC,
             ${shuffleKeySql} ASC,
             c.updated_at DESC,
             c.id ASC
    LIMIT ? OFFSET ?
  `;

  // Params: chats subquery userId, then where params, then discover params, then pagination
  const rows = db
    .query(dataSql)
    .all(
      userId,
      ...whereParams,
      nowSeconds,
      pagination.limit,
      pagination.offset,
    ) as any[];

  return {
    data: rows.map(rowToSummary),
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

// ─── Tags query ───────────────────────────────────────────────────────────

export function listCharacterTags(userId: string): { tag: string; count: number }[] {
  const rows = getDb()
    .query(
      `SELECT value as tag, COUNT(*) as count
       FROM characters, json_each(characters.tags)
       WHERE user_id = ?
       GROUP BY value ORDER BY count DESC`
    )
    .all(userId) as any[];
  return rows;
}

// ─── Avatar info (lightweight, no JSON parsing) ───────────────────────────

export function getCharacterAvatarInfo(
  userId: string,
  id: string
): { image_id: string | null; avatar_path: string | null } | null {
  const row = getDb()
    .query("SELECT image_id, avatar_path FROM characters WHERE id = ? AND user_id = ?")
    .get(id, userId) as any;
  if (!row) return null;
  return { image_id: row.image_id || null, avatar_path: row.avatar_path || null };
}

export type CharacterSortMode = "recent" | "discover";

function rowToCharacter(row: any): Character {
  return {
    ...row,
    avatar_path: row.avatar_path || null,
    image_id: row.image_id || null,
    tags: JSON.parse(row.tags),
    alternate_greetings: JSON.parse(row.alternate_greetings),
    extensions: JSON.parse(row.extensions),
  };
}

/** Lightweight listing of all characters for manifest building (name, creator, extensions, created_at). */
export function listCharactersForManifest(userId: string): Array<{ name: string; creator: string; extensions: Record<string, any>; created_at: number }> {
  const db = getDb();
  const rows = db.query("SELECT name, creator, extensions, created_at FROM characters WHERE user_id = ?").all(userId) as any[];
  return rows.map((row) => ({
    name: row.name,
    creator: row.creator,
    extensions: JSON.parse(row.extensions),
    created_at: row.created_at,
  }));
}

export function listCharacters(userId: string, pagination: PaginationParams): PaginatedResult<Character> {
  return paginatedQuery(
    "SELECT * FROM characters WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM characters WHERE user_id = ?",
    [userId],
    pagination,
    rowToCharacter
  );
}

/**
 * Discovery sort: surfaces characters the user hasn't interacted with recently,
 * while still producing a broad seeded shuffle across the full gallery.
 *
 * Ordering model:
 *   - Seeded shuffle key generates a stable full-list permutation per seed.
 *   - Discover boost nudges untouched and stale characters upward without locking the
 *     first page to the same cohort every time.
 */
export function listCharactersDiscover(
  userId: string,
  pagination: PaginationParams,
  seed?: number
): PaginatedResult<Character> {
  const db = getDb();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const shuffleSeed = normalizeShuffleSeed(seed);
  const discoverBoostSql = buildDiscoverBoostSql();
  const shuffleKeySql = buildSeededShuffleSql(shuffleSeed);
  const shuffleValueSql = buildSeededShuffleValueSql(shuffleSeed);

  const countRow = db
    .query("SELECT COUNT(*) as count FROM characters WHERE user_id = ?")
    .get(userId) as { count: number } | null;
  const total = countRow?.count ?? 0;

  const dataSql = `
    SELECT c.*
    FROM characters c
    LEFT JOIN (
      SELECT character_id,
             COUNT(*)        AS chat_count,
             MAX(updated_at) AS last_chat_at
      FROM chats
      WHERE user_id = ? AND COALESCE(json_extract(metadata, '$.group'), 0) != 1
      GROUP BY character_id
    ) cs ON cs.character_id = c.id
    WHERE c.user_id = ?
    ORDER BY ((${shuffleValueSql}) - (${discoverBoostSql})) ASC,
             ${shuffleKeySql} ASC,
             c.updated_at DESC,
             c.id ASC
    LIMIT ? OFFSET ?
  `;

  const rows = db
    .query(dataSql)
    .all(userId, userId, nowSeconds, pagination.limit, pagination.offset) as any[];

  return {
    data: rows.map(rowToCharacter),
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

// Prepared statement for hot-path character fetch
let _stmtCharById: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtCharByIdGen = -1;

export function getCharacter(userId: string, id: string): Character | null {
  const gen = require("../db/connection").getDbGeneration() as number;
  if (!_stmtCharById || _stmtCharByIdGen !== gen) {
    _stmtCharById = getDb().query("SELECT * FROM characters WHERE id = ? AND user_id = ?");
    _stmtCharByIdGen = gen;
  }
  const row = _stmtCharById.get(id, userId) as any;
  if (!row) return null;
  return rowToCharacter(row);
}

/**
 * Batch-load multiple characters by ID in a single query.
 */
export function getCharactersByIds(userId: string, ids: string[]): Map<string, Character> {
  if (ids.length === 0) return new Map();
  const ph = ids.map(() => "?").join(", ");
  const rows = getDb()
    .query(`SELECT * FROM characters WHERE id IN (${ph}) AND user_id = ?`)
    .all(...ids, userId) as any[];
  const result = new Map<string, Character>();
  for (const row of rows) result.set(row.id, rowToCharacter(row));
  return result;
}

export function createCharacter(userId: string, input: CreateCharacterInput): Character {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO characters (id, user_id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, tags, alternate_greetings, extensions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.name,
      input.description || "",
      input.personality || "",
      input.scenario || "",
      input.first_mes || "",
      input.mes_example || "",
      input.creator || "",
      input.creator_notes || "",
      input.system_prompt || "",
      input.post_history_instructions || "",
      JSON.stringify(input.tags || []),
      JSON.stringify(input.alternate_greetings || []),
      JSON.stringify(input.extensions || {}),
      now,
      now
    );

  const character = getCharacter(userId, id)!;
  eventBus.emit(EventType.CHARACTER_CREATED, { id, character }, userId);
  return character;
}

export function updateCharacter(userId: string, id: string, input: UpdateCharacterInput): Character | null {
  const existing = getCharacter(userId, id);
  if (!existing) return null;

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

  const jsonFields = ["tags", "alternate_greetings", "extensions"] as const;
  for (const field of jsonFields) {
    if (input[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(JSON.stringify(input[field]));
    }
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE characters SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const updated = getCharacter(userId, id)!;
  eventBus.emit(EventType.CHARACTER_EDITED, { id, character: updated }, userId);
  return updated;
}

export function setCharacterAvatar(userId: string, id: string, avatarPath: string): boolean {
  const result = getDb()
    .query("UPDATE characters SET avatar_path = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(avatarPath, Math.floor(Date.now() / 1000), id, userId);
  return result.changes > 0;
}

export function setCharacterImage(userId: string, id: string, imageId: string): boolean {
  const result = getDb()
    .query("UPDATE characters SET image_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(imageId, Math.floor(Date.now() / 1000), id, userId);
  return result.changes > 0;
}

export async function replaceCharacterAvatar(userId: string, id: string, file: File): Promise<Character | null> {
  const existing = getCharacter(userId, id);
  if (!existing) return null;

  if (existing.image_id) imagesSvc.deleteImage(userId, existing.image_id);
  if (existing.avatar_path) await filesSvc.deleteAvatar(existing.avatar_path);

  const image = await imagesSvc.uploadImage(userId, file);
  setCharacterImage(userId, id, image.id);
  setCharacterAvatar(userId, id, image.filename);

  const updated = getCharacter(userId, id);
  if (!updated) return null;

  eventBus.emit(EventType.CHARACTER_EDITED, { id, character: updated }, userId);
  return updated;
}

export function duplicateCharacter(userId: string, id: string): Character | null {
  const existing = getCharacter(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO characters (id, user_id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, avatar_path, image_id, tags, alternate_greetings, extensions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId,
      userId,
      `${existing.name} (Copy)`,
      existing.description,
      existing.personality,
      existing.scenario,
      existing.first_mes,
      existing.mes_example,
      existing.creator,
      existing.creator_notes,
      existing.system_prompt,
      existing.post_history_instructions,
      existing.avatar_path,
      existing.image_id,
      JSON.stringify(existing.tags),
      JSON.stringify(existing.alternate_greetings),
      JSON.stringify(existing.extensions),
      now,
      now
    );

  const character = getCharacter(userId, newId)!;
  eventBus.emit(EventType.CHARACTER_CREATED, { id: newId, character }, userId);
  return character;
}

export function findCharactersByName(userId: string, name: string): Character[] {
  const rows = getDb()
    .query("SELECT * FROM characters WHERE user_id = ? AND name = ? ORDER BY updated_at DESC")
    .all(userId, name) as any[];
  return rows.map(rowToCharacter);
}

export function characterExistsByName(userId: string, name: string): boolean {
  const row = getDb()
    .query("SELECT 1 FROM characters WHERE user_id = ? AND name = ? LIMIT 1")
    .get(userId, name) as any;
  return !!row;
}

export function findCharacterBySourceFilename(userId: string, sourceFilename: string): Character | null {
  const row = getDb()
    .query(
      "SELECT * FROM characters WHERE user_id = ? AND json_extract(extensions, '$._lumiverse_source_filename') = ? LIMIT 1"
    )
    .get(userId, sourceFilename) as any;
  return row ? rowToCharacter(row) : null;
}

export function setCharacterSourceFilename(userId: string, id: string, sourceFilename: string): void {
  const char = getCharacter(userId, id);
  if (!char) return;
  const extensions = { ...(char.extensions ?? {}), _lumiverse_source_filename: sourceFilename };
  getDb()
    .query("UPDATE characters SET extensions = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(JSON.stringify(extensions), Math.floor(Date.now() / 1000), id, userId);
}

export function deleteCharacter(userId: string, id: string): boolean {
  const existing = getCharacter(userId, id);
  if (!existing) return false;

  const result = getDb().query("DELETE FROM characters WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    deleteAutoManagedCharacterWorldBooks(userId, id);
    deleteRegexScriptsByCharacterId(userId, id);
    eventBus.emit(EventType.CHARACTER_DELETED, { id }, userId);
  }
  return result.changes > 0;
}
