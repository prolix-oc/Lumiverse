import { getDb } from "../db/connection";
import type {
  Pack, PackWithItems,
  LumiaItem, LoomItem, LoomTool,
  CreatePackInput, UpdatePackInput,
  CreateLumiaItemInput, UpdateLumiaItemInput,
  CreateLoomItemInput, UpdateLoomItemInput,
  CreateLoomToolInput, UpdateLoomToolInput,
  PackImportPayload,
} from "../types/pack";
import type { RegexPlacement, RegexTarget, RegexMacroMode } from "../types/regex-script";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import * as regexScriptsSvc from "./regex-scripts.service";

// --- Row mappers ---

function rowToPack(row: any): Pack {
  return {
    ...row,
    is_custom: !!row.is_custom,
    extras: JSON.parse(row.extras),
  };
}

function rowToLumiaItem(row: any): LumiaItem {
  return { ...row };
}

function rowToLoomItem(row: any): LoomItem {
  return { ...row };
}

function rowToLoomTool(row: any): LoomTool {
  return {
    ...row,
    store_in_deliberation: !!row.store_in_deliberation,
    input_schema: JSON.parse(row.input_schema),
  };
}

// --- Pack CRUD ---

export function listPacks(userId: string, pagination: PaginationParams): PaginatedResult<Pack> {
  return paginatedQuery(
    "SELECT * FROM packs WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM packs WHERE user_id = ?",
    [userId],
    pagination,
    rowToPack
  );
}

export function getPack(userId: string, id: string): Pack | null {
  const row = getDb().query("SELECT * FROM packs WHERE id = ? AND user_id = ?").get(id, userId) as any;
  return row ? rowToPack(row) : null;
}

export function createPack(userId: string, input: CreatePackInput): Pack {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `INSERT INTO packs (id, user_id, name, author, cover_url, version, is_custom, source_url, extras, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, userId,
      input.name,
      input.author || "",
      input.cover_url || null,
      input.version || "1.0.0",
      input.is_custom !== false ? 1 : 0,
      input.source_url || null,
      JSON.stringify(input.extras || {}),
      now, now
    );
  return getPack(userId, id)!;
}

export function updatePack(userId: string, id: string, input: UpdatePackInput): Pack | null {
  const existing = getPack(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.author !== undefined) { fields.push("author = ?"); values.push(input.author); }
  if (input.cover_url !== undefined) { fields.push("cover_url = ?"); values.push(input.cover_url); }
  if (input.version !== undefined) { fields.push("version = ?"); values.push(input.version); }
  if (input.is_custom !== undefined) { fields.push("is_custom = ?"); values.push(input.is_custom ? 1 : 0); }
  if (input.source_url !== undefined) { fields.push("source_url = ?"); values.push(input.source_url); }
  if (input.extras !== undefined) { fields.push("extras = ?"); values.push(JSON.stringify(input.extras)); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE packs SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  return getPack(userId, id)!;
}

export function deletePack(userId: string, id: string): boolean {
  return getDb().query("DELETE FROM packs WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

export function repairOldLumiverseGenderMapping(userId: string, id: string): PackWithItems | null {
  const pack = getPack(userId, id);
  if (!pack) return null;

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  db.transaction(() => {
    const items = db.query("SELECT id, gender_identity FROM lumia_items WHERE pack_id = ?").all(id) as Array<{ id: string; gender_identity: number }>;
    const updateStmt = db.query("UPDATE lumia_items SET gender_identity = ?, updated_at = ? WHERE id = ?");

    for (const item of items) {
      updateStmt.run(remapLegacyLumiverseGenderIdentity(item.gender_identity), now, item.id);
    }

    db.query("UPDATE packs SET updated_at = ? WHERE id = ? AND user_id = ?").run(now, id, userId);
  })();

  return getPackWithItems(userId, id);
}

// Prepared statements for pack item queries (avoid re-compiling on every call)
let _stmtPackById: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtLumiaByPack: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtLoomByPack: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtToolsByPack: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;

function getPackStmts() {
  const db = getDb();
  if (!_stmtPackById) _stmtPackById = db.query("SELECT * FROM packs WHERE id = ? AND user_id = ?");
  if (!_stmtLumiaByPack) _stmtLumiaByPack = db.query("SELECT * FROM lumia_items WHERE pack_id = ? ORDER BY sort_order ASC");
  if (!_stmtLoomByPack) _stmtLoomByPack = db.query("SELECT * FROM loom_items WHERE pack_id = ? ORDER BY sort_order ASC");
  if (!_stmtToolsByPack) _stmtToolsByPack = db.query("SELECT * FROM loom_tools WHERE pack_id = ? ORDER BY sort_order ASC");
  return { packById: _stmtPackById, lumiaByPack: _stmtLumiaByPack, loomByPack: _stmtLoomByPack, toolsByPack: _stmtToolsByPack };
}

export function getPackWithItems(userId: string, id: string): PackWithItems | null {
  const stmts = getPackStmts();
  const row = stmts.packById.get(id, userId) as any;
  if (!row) return null;
  const pack = rowToPack(row);

  const lumia_items = (stmts.lumiaByPack.all(id) as any[]).map(rowToLumiaItem);
  const loom_items = (stmts.loomByPack.all(id) as any[]).map(rowToLoomItem);
  const loom_tools = (stmts.toolsByPack.all(id) as any[]).map(rowToLoomTool);
  const regex_scripts = regexScriptsSvc.getRegexScriptsByPackId(userId, id);

  return { ...pack, lumia_items, loom_items, loom_tools, regex_scripts };
}

/** List all packs with their items in a single efficient batch. */
export function listPacksWithItems(userId: string, pagination: PaginationParams): PaginatedResult<PackWithItems> {
  const result = listPacks(userId, pagination);
  if (result.data.length === 0) return { ...result, data: [] };

  const stmts = getPackStmts();
  const packsWithItems: PackWithItems[] = result.data.map((pack) => {
    const lumia_items = (stmts.lumiaByPack.all(pack.id) as any[]).map(rowToLumiaItem);
    const loom_items = (stmts.loomByPack.all(pack.id) as any[]).map(rowToLoomItem);
    const loom_tools = (stmts.toolsByPack.all(pack.id) as any[]).map(rowToLoomTool);
    const regex_scripts = regexScriptsSvc.getRegexScriptsByPackId(userId, pack.id);
    return { ...pack, lumia_items, loom_items, loom_tools, regex_scripts };
  });

  return { ...result, data: packsWithItems };
}

// --- Lumia Item CRUD ---

export function listLumiaItems(userId: string, packId: string): LumiaItem[] {
  const pack = getPack(userId, packId);
  if (!pack) return [];
  return (getDb().query("SELECT * FROM lumia_items WHERE pack_id = ? ORDER BY sort_order ASC").all(packId) as any[]).map(rowToLumiaItem);
}

export function getLumiaItem(userId: string, id: string): LumiaItem | null {
  const row = getDb().query(
    "SELECT li.* FROM lumia_items li JOIN packs p ON li.pack_id = p.id WHERE li.id = ? AND p.user_id = ?"
  ).get(id, userId) as any;
  return row ? rowToLumiaItem(row) : null;
}

export function createLumiaItem(userId: string, packId: string, input: CreateLumiaItemInput): LumiaItem | null {
  const pack = getPack(userId, packId);
  if (!pack) return null;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `INSERT INTO lumia_items (id, pack_id, name, avatar_url, author_name, definition, personality, behavior, gender_identity, version, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, packId,
      input.name,
      input.avatar_url || null,
      input.author_name || "",
      input.definition || "",
      input.personality || "",
      input.behavior || "",
      input.gender_identity ?? 3,
      input.version || "1.0.0",
      input.sort_order ?? 0,
      now, now
    );
  return getLumiaItem(userId, id)!;
}

export function updateLumiaItem(userId: string, id: string, input: UpdateLumiaItemInput): LumiaItem | null {
  const existing = getLumiaItem(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.avatar_url !== undefined) { fields.push("avatar_url = ?"); values.push(input.avatar_url); }
  if (input.author_name !== undefined) { fields.push("author_name = ?"); values.push(input.author_name); }
  if (input.definition !== undefined) { fields.push("definition = ?"); values.push(input.definition); }
  if (input.personality !== undefined) { fields.push("personality = ?"); values.push(input.personality); }
  if (input.behavior !== undefined) { fields.push("behavior = ?"); values.push(input.behavior); }
  if (input.gender_identity !== undefined) { fields.push("gender_identity = ?"); values.push(input.gender_identity); }
  if (input.version !== undefined) { fields.push("version = ?"); values.push(input.version); }
  if (input.sort_order !== undefined) { fields.push("sort_order = ?"); values.push(input.sort_order); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  getDb().query(`UPDATE lumia_items SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getLumiaItem(userId, id)!;
}

export function deleteLumiaItem(userId: string, id: string): boolean {
  const item = getLumiaItem(userId, id);
  if (!item) return false;
  return getDb().query("DELETE FROM lumia_items WHERE id = ?").run(id).changes > 0;
}

// --- Loom Item CRUD ---

export function listLoomItems(userId: string, packId: string): LoomItem[] {
  const pack = getPack(userId, packId);
  if (!pack) return [];
  return (getDb().query("SELECT * FROM loom_items WHERE pack_id = ? ORDER BY sort_order ASC").all(packId) as any[]).map(rowToLoomItem);
}

export function getLoomItem(userId: string, id: string): LoomItem | null {
  const row = getDb().query(
    "SELECT li.* FROM loom_items li JOIN packs p ON li.pack_id = p.id WHERE li.id = ? AND p.user_id = ?"
  ).get(id, userId) as any;
  return row ? rowToLoomItem(row) : null;
}

export function createLoomItem(userId: string, packId: string, input: CreateLoomItemInput): LoomItem | null {
  const pack = getPack(userId, packId);
  if (!pack) return null;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `INSERT INTO loom_items (id, pack_id, name, content, category, author_name, version, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, packId,
      input.name,
      input.content || "",
      input.category || "narrative_style",
      input.author_name || "",
      input.version || "1.0.0",
      input.sort_order ?? 0,
      now, now
    );
  return getLoomItem(userId, id)!;
}

export function updateLoomItem(userId: string, id: string, input: UpdateLoomItemInput): LoomItem | null {
  const existing = getLoomItem(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.content !== undefined) { fields.push("content = ?"); values.push(input.content); }
  if (input.category !== undefined) { fields.push("category = ?"); values.push(input.category); }
  if (input.author_name !== undefined) { fields.push("author_name = ?"); values.push(input.author_name); }
  if (input.version !== undefined) { fields.push("version = ?"); values.push(input.version); }
  if (input.sort_order !== undefined) { fields.push("sort_order = ?"); values.push(input.sort_order); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  getDb().query(`UPDATE loom_items SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getLoomItem(userId, id)!;
}

export function deleteLoomItem(userId: string, id: string): boolean {
  const item = getLoomItem(userId, id);
  if (!item) return false;
  return getDb().query("DELETE FROM loom_items WHERE id = ?").run(id).changes > 0;
}

// --- Loom Tool CRUD ---

export function listLoomTools(userId: string, packId: string): LoomTool[] {
  const pack = getPack(userId, packId);
  if (!pack) return [];
  return (getDb().query("SELECT * FROM loom_tools WHERE pack_id = ? ORDER BY sort_order ASC").all(packId) as any[]).map(rowToLoomTool);
}

export function getLoomTool(userId: string, id: string): LoomTool | null {
  const row = getDb().query(
    "SELECT lt.* FROM loom_tools lt JOIN packs p ON lt.pack_id = p.id WHERE lt.id = ? AND p.user_id = ?"
  ).get(id, userId) as any;
  return row ? rowToLoomTool(row) : null;
}

export function createLoomTool(userId: string, packId: string, input: CreateLoomToolInput): LoomTool | null {
  const pack = getPack(userId, packId);
  if (!pack) return null;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `INSERT INTO loom_tools (id, pack_id, tool_name, display_name, description, prompt, input_schema, result_variable, store_in_deliberation, author_name, version, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, packId,
      input.tool_name,
      input.display_name || "",
      input.description || "",
      input.prompt || "",
      JSON.stringify(input.input_schema || {}),
      input.result_variable || "",
      input.store_in_deliberation ? 1 : 0,
      input.author_name || "",
      input.version || "1.0.0",
      input.sort_order ?? 0,
      now, now
    );
  return getLoomTool(userId, id)!;
}

export function updateLoomTool(userId: string, id: string, input: UpdateLoomToolInput): LoomTool | null {
  const existing = getLoomTool(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.tool_name !== undefined) { fields.push("tool_name = ?"); values.push(input.tool_name); }
  if (input.display_name !== undefined) { fields.push("display_name = ?"); values.push(input.display_name); }
  if (input.description !== undefined) { fields.push("description = ?"); values.push(input.description); }
  if (input.prompt !== undefined) { fields.push("prompt = ?"); values.push(input.prompt); }
  if (input.input_schema !== undefined) { fields.push("input_schema = ?"); values.push(JSON.stringify(input.input_schema)); }
  if (input.result_variable !== undefined) { fields.push("result_variable = ?"); values.push(input.result_variable); }
  if (input.store_in_deliberation !== undefined) { fields.push("store_in_deliberation = ?"); values.push(input.store_in_deliberation ? 1 : 0); }
  if (input.author_name !== undefined) { fields.push("author_name = ?"); values.push(input.author_name); }
  if (input.version !== undefined) { fields.push("version = ?"); values.push(input.version); }
  if (input.sort_order !== undefined) { fields.push("sort_order = ?"); values.push(input.sort_order); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  getDb().query(`UPDATE loom_tools SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getLoomTool(userId, id)!;
}

export function deleteLoomTool(userId: string, id: string): boolean {
  const item = getLoomTool(userId, id);
  if (!item) return false;
  return getDb().query("DELETE FROM loom_tools WHERE id = ?").run(id).changes > 0;
}

// --- Cross-pack queries ---

/** Fetch multiple Lumia items by IDs in a single query (used by council member loading). */
export function getLumiaItemsByIds(userId: string, ids: string[]): Map<string, LumiaItem> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = getDb()
    .query(`SELECT li.* FROM lumia_items li JOIN packs p ON li.pack_id = p.id WHERE li.id IN (${placeholders}) AND p.user_id = ?`)
    .all(...ids, userId) as any[];
  const result = new Map<string, LumiaItem>();
  for (const row of rows) {
    result.set(row.id, rowToLumiaItem(row));
  }
  return result;
}

/** Fetch every Lumia item across all packs for a user (used by randomLumia macro). */
export function getAllLumiaItems(userId: string): LumiaItem[] {
  return (getDb()
    .query("SELECT li.* FROM lumia_items li JOIN packs p ON li.pack_id = p.id WHERE p.user_id = ? ORDER BY li.name ASC")
    .all(userId) as any[]).map(rowToLumiaItem);
}

/** Fetch every Loom item across all packs for a user, optionally filtered by category. */
export function getAllLoomItems(userId: string, category?: string): LoomItem[] {
  if (category) {
    return (getDb()
      .query("SELECT li.* FROM loom_items li JOIN packs p ON li.pack_id = p.id WHERE p.user_id = ? AND li.category = ? ORDER BY li.name ASC")
      .all(userId, category) as any[]).map(rowToLoomItem);
  }
  return (getDb()
    .query("SELECT li.* FROM loom_items li JOIN packs p ON li.pack_id = p.id WHERE p.user_id = ? ORDER BY li.name ASC")
    .all(userId) as any[]).map(rowToLoomItem);
}

// --- Import / Export ---

/**
 * Normalizes a raw pack payload to PackImportPayload format.
 * Handles:
 * - Extension format fields (packName, lumiaName, lumiaDefinition, loomName, loomContent, etc.)
 * - Wrapper objects ({ pack: {...} } or { success: true, pack: {...} })
 * - snake_case tool fields (tool_name, display_name, input_schema, etc.)
 * - Category normalization (utility/utilities → loom_utility, etc.)
 */
function normalizeImportedGenderIdentity(value: unknown): 0 | 1 | 2 | 3 {
  const num = Number(value);
  if (num === 0 || num === 1 || num === 2 || num === 3) return num;
  return 3;
}

function remapLegacyLumiverseGenderIdentity(value: unknown): 0 | 1 | 2 | 3 {
  const num = Number(value);
  if (num === 0) return 3;
  if (num === 1) return 0;
  if (num === 2) return 1;
  return 3;
}

function normalizePackPayload(raw: any): PackImportPayload {
  // Unwrap { pack: {...} } wrapper
  const data = raw.pack && typeof raw.pack === "object" && !Array.isArray(raw.pack) ? raw.pack : raw;

  // If it already has standard `name` + `lumiaItems` array with `definition` fields, it's likely
  // already in PackImportPayload format. But we still normalize to handle mixed formats.

  const normCategory = (c: string): "narrative_style" | "loom_utility" | "retrofit" => {
    const lower = (c || "").toLowerCase();
    if (lower.includes("utility") || lower.includes("utilities")) return "loom_utility";
    if (lower.includes("retrofit")) return "retrofit";
    return "narrative_style";
  };

  return {
    name: data.name || data.packName || undefined,
    author: data.author ?? data.packAuthor ?? undefined,
    coverUrl: data.coverUrl || undefined,
    version: data.version != null ? String(data.version) : undefined,
    sourceUrl: data.sourceUrl || data.source_url || undefined,
    extras: data.extras ?? (data.packExtras?.length ? { items: data.packExtras } : undefined),
    lumiaItems: (data.lumiaItems || []).map((item: any) => ({
      name: item.name || item.lumiaName || "Unknown",
      avatarUrl: item.avatarUrl || item.avatar_url || undefined,
      authorName: item.authorName || item.author_name || "",
      definition: item.definition || item.lumiaDefinition || "",
      personality: item.personality || item.lumiaPersonality || "",
      behavior: item.behavior || item.lumiaBehavior || "",
      genderIdentity: normalizeImportedGenderIdentity(item.genderIdentity ?? item.gender_identity),
      version: item.version != null ? String(item.version) : undefined,
      sortOrder: item.sortOrder ?? item.sort_order ?? undefined,
    })),
    loomItems: (data.loomItems || []).map((item: any) => ({
      name: item.name || item.loomName || "Unknown",
      content: item.content || item.loomContent || "",
      category: normCategory(item.category || item.loomCategory || ""),
      authorName: item.authorName || item.author_name || "",
      version: item.version != null ? String(item.version) : undefined,
      sortOrder: item.sortOrder ?? item.sort_order ?? undefined,
    })),
    loomTools: (data.loomTools || []).map((tool: any) => ({
      toolName: tool.toolName || tool.tool_name || "unknown_tool",
      displayName: tool.displayName || tool.display_name || "",
      description: tool.description || "",
      prompt: tool.prompt || "",
      inputSchema: tool.inputSchema || tool.input_schema || {},
      resultVariable: tool.resultVariable || tool.result_variable || "",
      storeInDeliberation: tool.storeInDeliberation ?? tool.store_in_deliberation ?? false,
      authorName: tool.authorName || tool.author_name || "",
      version: tool.version != null ? String(tool.version) : undefined,
      sortOrder: tool.sortOrder ?? tool.sort_order ?? undefined,
    })),
    regexScripts: (data.regexScripts || data.regex_scripts || []).map((s: any, i: number) => ({
      name: s.name || s.scriptName || `Script ${i + 1}`,
      scriptId: s.scriptId || s.script_id || "",
      findRegex: s.findRegex || s.find_regex || "",
      replaceString: s.replaceString || s.replace_string || "",
      flags: s.flags || "gi",
      placement: s.placement || ["ai_output"],
      target: s.target || "response",
      minDepth: s.minDepth ?? s.min_depth ?? null,
      maxDepth: s.maxDepth ?? s.max_depth ?? null,
      trimStrings: s.trimStrings || s.trim_strings || [],
      runOnEdit: s.runOnEdit ?? s.run_on_edit ?? false,
      substituteMacros: s.substituteMacros || s.substitute_macros || "none",
      disabled: s.disabled ?? false,
      sortOrder: s.sortOrder ?? s.sort_order ?? i,
      description: s.description || "",
      metadata: s.metadata || {},
    })),
  };
}

export function importPack(userId: string, rawPayload: PackImportPayload): PackWithItems {
  const payload = normalizePackPayload(rawPayload);
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db.transaction(() => {
    db.query(
      `INSERT INTO packs (id, user_id, name, author, cover_url, version, is_custom, source_url, extras, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, userId,
      payload.name || "Imported Pack",
      payload.author || "",
      payload.coverUrl || null,
      payload.version || "1.0.0",
      0, // downloaded pack, not custom
      payload.sourceUrl || null,
      JSON.stringify(payload.extras || {}),
      now, now
    );

    for (let i = 0; i < (payload.lumiaItems || []).length; i++) {
      const item = payload.lumiaItems![i];
      db.query(
        `INSERT INTO lumia_items (id, pack_id, name, avatar_url, author_name, definition, personality, behavior, gender_identity, version, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(), id,
        item.name,
        item.avatarUrl || null,
        item.authorName || "",
        item.definition || "",
        item.personality || "",
        item.behavior || "",
        item.genderIdentity ?? 3,
        item.version || "1.0.0",
        item.sortOrder ?? i,
        now, now
      );
    }

    for (let i = 0; i < (payload.loomItems || []).length; i++) {
      const item = payload.loomItems![i];
      db.query(
        `INSERT INTO loom_items (id, pack_id, name, content, category, author_name, version, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(), id,
        item.name,
        item.content || "",
        item.category || "narrative_style",
        item.authorName || "",
        item.version || "1.0.0",
        item.sortOrder ?? i,
        now, now
      );
    }

    for (let i = 0; i < (payload.loomTools || []).length; i++) {
      const tool = payload.loomTools![i];
      db.query(
        `INSERT INTO loom_tools (id, pack_id, tool_name, display_name, description, prompt, input_schema, result_variable, store_in_deliberation, author_name, version, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(), id,
        tool.toolName,
        tool.displayName || "",
        tool.description || "",
        tool.prompt || "",
        JSON.stringify(tool.inputSchema || {}),
        tool.resultVariable || "",
        tool.storeInDeliberation ? 1 : 0,
        tool.authorName || "",
        tool.version || "1.0.0",
        tool.sortOrder ?? i,
        now, now
      );
    }

    // Import embedded regex scripts with folder set to pack name and pack_id for association
    for (let i = 0; i < (payload.regexScripts || []).length; i++) {
      const s = payload.regexScripts![i];
      if (!s.name || !s.findRegex) continue;
      regexScriptsSvc.createRegexScript(userId, {
        name: s.name,
        script_id: s.scriptId || "",
        find_regex: s.findRegex,
        replace_string: s.replaceString || "",
        flags: s.flags || "gi",
        placement: (s.placement as RegexPlacement[]) || ["ai_output"],
        scope: "global",
        scope_id: null,
        target: (s.target as RegexTarget) || "response",
        min_depth: s.minDepth ?? null,
        max_depth: s.maxDepth ?? null,
        trim_strings: s.trimStrings || [],
        run_on_edit: s.runOnEdit ?? false,
        substitute_macros: (s.substituteMacros as RegexMacroMode) || "none",
        disabled: s.disabled ?? false,
        sort_order: s.sortOrder ?? i,
        description: s.description || "",
        folder: payload.name || "Imported Pack",
        pack_id: id,
        metadata: s.metadata || {},
      });
    }
  })();

  return getPackWithItems(userId, id)!;
}

export function exportPack(userId: string, id: string): PackImportPayload | null {
  const pack = getPackWithItems(userId, id);
  if (!pack) return null;

  return {
    name: pack.name,
    author: pack.author,
    coverUrl: pack.cover_url || undefined,
    version: pack.version,
    sourceUrl: pack.source_url || undefined,
    extras: pack.extras,
    lumiaItems: pack.lumia_items.map((item) => ({
      name: item.name,
      avatarUrl: item.avatar_url || undefined,
      authorName: item.author_name,
      definition: item.definition,
      personality: item.personality,
      behavior: item.behavior,
      genderIdentity: item.gender_identity,
      version: item.version,
      sortOrder: item.sort_order,
    })),
    loomItems: pack.loom_items.map((item) => ({
      name: item.name,
      content: item.content,
      category: item.category,
      authorName: item.author_name,
      version: item.version,
      sortOrder: item.sort_order,
    })),
    loomTools: pack.loom_tools.map((tool) => ({
      toolName: tool.tool_name,
      displayName: tool.display_name,
      description: tool.description,
      prompt: tool.prompt,
      inputSchema: tool.input_schema,
      resultVariable: tool.result_variable,
      storeInDeliberation: tool.store_in_deliberation,
      authorName: tool.author_name,
      version: tool.version,
      sortOrder: tool.sort_order,
    })),
    regexScripts: pack.regex_scripts.length > 0
      ? pack.regex_scripts.map((s) => ({
          name: s.name,
          scriptId: s.script_id || undefined,
          findRegex: s.find_regex,
          replaceString: s.replace_string || undefined,
          flags: s.flags,
          placement: s.placement,
          target: s.target,
          minDepth: s.min_depth,
          maxDepth: s.max_depth,
          trimStrings: s.trim_strings.length > 0 ? s.trim_strings : undefined,
          runOnEdit: s.run_on_edit || undefined,
          substituteMacros: s.substitute_macros !== "none" ? s.substitute_macros : undefined,
          disabled: s.disabled || undefined,
          sortOrder: s.sort_order,
          description: s.description || undefined,
          metadata: Object.keys(s.metadata).length > 0 ? s.metadata : undefined,
        }))
      : undefined,
  };
}
