/**
 * Memory Cortex — Vault & Interlink service.
 *
 * Vaults are frozen snapshots of a chat's cortex state (entities + relations)
 * that can be attached to other chats as read-only knowledge.
 *
 * Interlinks are live bidirectional connections between two chats' cortex data,
 * allowing both chats to see each other's entities/relations during generation.
 */

import { getDb } from "../../db/connection";
import * as embeddingsSvc from "../embeddings.service";
import type {
  EntityType,
  EntityStatus,
  RelationType,
  RelationStatus,
  EntitySnapshot,
  RelationEdge,
  VaultCortexData,
} from "./types";

// ─── Row Types ────────────────────────────────────────────────

interface VaultRow {
  id: string;
  user_id: string;
  source_chat_id: string | null;
  name: string;
  description: string;
  entity_count: number;
  relation_count: number;
  chunk_count: number;
  created_at: number;
}

interface VaultChunkRow {
  id: string;
  vault_id: string;
  source_chunk_id: string;
  content: string;
  salience_score: number | null;
  emotional_tags: string;
  entity_names: string;
  source_created_at: number;
  copied_at: number;
}

interface VaultEntityRow {
  id: string;
  vault_id: string;
  name: string;
  entity_type: string;
  aliases: string;
  description: string;
  status: string;
  facts: string;
  emotional_valence: string;
  salience_avg: number;
}

interface VaultRelationRow {
  id: string;
  vault_id: string;
  source_entity_name: string;
  target_entity_name: string;
  relation_type: string;
  relation_label: string | null;
  strength: number;
  sentiment: number;
  status: string;
}

interface ChatLinkRow {
  id: string;
  user_id: string;
  chat_id: string;
  link_type: string;
  vault_id: string | null;
  target_chat_id: string | null;
  label: string;
  enabled: number;
  priority: number;
  created_at: number;
  // Joined fields
  vault_name?: string | null;
  target_chat_name?: string | null;
  vault_entity_count?: number | null;
  vault_relation_count?: number | null;
}

// ─── DTOs ─────────────────────────────────────────────────────

export interface Vault {
  id: string;
  userId: string;
  sourceChatId: string | null;
  sourceChatName: string | null;
  name: string;
  description: string;
  entityCount: number;
  relationCount: number;
  chunkCount: number;
  createdAt: number;
}

export interface VaultChunk {
  id: string;
  vaultId: string;
  sourceChunkId: string;
  content: string;
  salienceScore: number | null;
  emotionalTags: string[];
  entityNames: string[];
  sourceCreatedAt: number;
  copiedAt: number;
}

export interface VaultEntity {
  id: string;
  vaultId: string;
  name: string;
  entityType: EntityType;
  aliases: string[];
  description: string;
  status: EntityStatus;
  facts: string[];
  emotionalValence: Record<string, number>;
  salienceAvg: number;
}

export interface VaultRelation {
  id: string;
  vaultId: string;
  sourceEntityName: string;
  targetEntityName: string;
  relationType: RelationType;
  relationLabel: string | null;
  strength: number;
  sentiment: number;
  status: RelationStatus;
}

export interface ChatLink {
  id: string;
  userId: string;
  chatId: string;
  linkType: "vault" | "interlink";
  vaultId: string | null;
  vaultName: string | null;
  vaultEntityCount: number | null;
  vaultRelationCount: number | null;
  targetChatId: string | null;
  targetChatName: string | null;
  targetChatExists: boolean;
  label: string;
  enabled: boolean;
  priority: number;
  createdAt: number;
}

export class ChatLinkError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ChatLinkError";
    this.status = status;
  }
}

// ─── JSON Helpers ─────────────────────────────────────────────

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function safeJsonObject(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ─── Row Mappers ──────────────────────────────────────────────

function rowToVault(row: VaultRow & { source_chat_name?: string | null }): Vault {
  return {
    id: row.id,
    userId: row.user_id,
    sourceChatId: row.source_chat_id,
    sourceChatName: (row as any).source_chat_name ?? null,
    name: row.name,
    description: row.description,
    entityCount: row.entity_count,
    relationCount: row.relation_count,
    chunkCount: row.chunk_count ?? 0,
    createdAt: row.created_at,
  };
}

function rowToVaultChunk(row: VaultChunkRow): VaultChunk {
  return {
    id: row.id,
    vaultId: row.vault_id,
    sourceChunkId: row.source_chunk_id,
    content: row.content,
    salienceScore: row.salience_score,
    emotionalTags: safeJsonArray(row.emotional_tags),
    entityNames: safeJsonArray(row.entity_names),
    sourceCreatedAt: row.source_created_at,
    copiedAt: row.copied_at,
  };
}

function rowToVaultEntity(row: VaultEntityRow): VaultEntity {
  return {
    id: row.id,
    vaultId: row.vault_id,
    name: row.name,
    entityType: row.entity_type as EntityType,
    aliases: safeJsonArray(row.aliases),
    description: row.description,
    status: row.status as EntityStatus,
    facts: safeJsonArray(row.facts),
    emotionalValence: safeJsonObject(row.emotional_valence),
    salienceAvg: row.salience_avg,
  };
}

function rowToVaultRelation(row: VaultRelationRow): VaultRelation {
  return {
    id: row.id,
    vaultId: row.vault_id,
    sourceEntityName: row.source_entity_name,
    targetEntityName: row.target_entity_name,
    relationType: row.relation_type as RelationType,
    relationLabel: row.relation_label,
    strength: row.strength,
    sentiment: row.sentiment,
    status: row.status as RelationStatus,
  };
}

function rowToChatLink(row: ChatLinkRow): ChatLink {
  return {
    id: row.id,
    userId: row.user_id,
    chatId: row.chat_id,
    linkType: row.link_type as "vault" | "interlink",
    vaultId: row.vault_id,
    vaultName: row.vault_name ?? null,
    vaultEntityCount: row.vault_entity_count ?? null,
    vaultRelationCount: row.vault_relation_count ?? null,
    targetChatId: row.target_chat_id,
    targetChatName: row.target_chat_name ?? null,
    targetChatExists: row.link_type === "vault" || row.target_chat_name !== null,
    label: row.label,
    enabled: row.enabled === 1,
    priority: row.priority,
    createdAt: row.created_at,
  };
}

function getChatLinksByIds(linkIds: string[]): ChatLink[] {
  if (linkIds.length === 0) return [];

  const placeholders = linkIds.map(() => "?").join(", ");
  const rows = getDb().query(
    `SELECT
       l.*,
       v.name AS vault_name,
       v.entity_count AS vault_entity_count,
       v.relation_count AS vault_relation_count,
       tc.name AS target_chat_name
     FROM cortex_chat_links l
     LEFT JOIN cortex_vaults v ON v.id = l.vault_id
     LEFT JOIN chats tc ON tc.id = l.target_chat_id
     WHERE l.id IN (${placeholders})`,
  ).all(...linkIds) as ChatLinkRow[];

  const linkById = new Map(rows.map((row) => [row.id, rowToChatLink(row)]));
  return linkIds.map((id) => linkById.get(id)).filter((link): link is ChatLink => Boolean(link));
}

// ─── Vault CRUD ───────────────────────────────────────────────

/**
 * Create a vault by snapshotting the active entities, relations, and
 * vectorized chunks from a chat's cortex. The vector rows in LanceDB are
 * copied to source_type='vault_chunk' rows asynchronously so the vault
 * becomes self-contained — no live dependency on the source chat at query
 * time.
 */
export function createVault(
  userId: string,
  chatId: string,
  name: string,
  description?: string,
): Vault {
  const db = getDb();
  const vaultId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const snapshot = snapshotVaultContents(userId, chatId, vaultId, name, description, now);

  // Fire-and-forget LanceDB copy. Logged on failure; vault query falls back
  // to structural-only retrieval until a manual reindex re-runs the copy.
  if (snapshot.chunkIdMap.size > 0) {
    embeddingsSvc
      .copyChunksToVault(userId, chatId, vaultId, snapshot.chunkIdMap)
      .catch((err) => {
        console.warn(`[cortex] Vault ${vaultId} LanceDB copy failed:`, err);
      });
  }

  return {
    id: vaultId,
    userId,
    sourceChatId: chatId,
    sourceChatName: null, // caller can resolve if needed
    name,
    description: description ?? "",
    entityCount: snapshot.entityCount,
    relationCount: snapshot.relationCount,
    chunkCount: snapshot.chunkIdMap.size,
    createdAt: now,
  };
}

/**
 * Core SQLite snapshot step shared between createVault() and reindexVault().
 * Writes the vault header (on create) plus entities / relations / chunks in
 * a single transaction and returns a map of source chunk id → newly-created
 * vault chunk id for the caller to drive LanceDB row copy.
 */
function snapshotVaultContents(
  userId: string,
  chatId: string,
  vaultId: string,
  name: string | null,
  description: string | undefined,
  now: number,
  options?: { replaceExisting?: boolean },
): { entityCount: number; relationCount: number; chunkIdMap: Map<string, string> } {
  const db = getDb();

  return db.transaction(() => {
    if (name !== null && !options?.replaceExisting) {
      db.query(
        `INSERT INTO cortex_vaults (id, user_id, source_chat_id, name, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(vaultId, userId, chatId, name, description ?? "", now);
    } else if (options?.replaceExisting) {
      db.query(`DELETE FROM cortex_vault_entities WHERE vault_id = ?`).run(vaultId);
      db.query(`DELETE FROM cortex_vault_relations WHERE vault_id = ?`).run(vaultId);
      db.query(`DELETE FROM cortex_vault_chunks WHERE vault_id = ?`).run(vaultId);
    }

    // Copy active entities
    const entityRows = db.query(
      `SELECT * FROM memory_entities WHERE chat_id = ? AND status != 'inactive'`,
    ).all(chatId) as Array<{
      id: string; name: string; entity_type: string; aliases: string;
      description: string; status: string; facts: string;
      emotional_valence: string; salience_avg: number;
    }>;

    const entityNameMap = new Map<string, string>();
    for (const e of entityRows) {
      entityNameMap.set(e.id, e.name);
    }

    const insertEntity = db.query(
      `INSERT INTO cortex_vault_entities
         (id, vault_id, name, entity_type, aliases, description, status, facts, emotional_valence, salience_avg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entityRows) {
      insertEntity.run(
        crypto.randomUUID(), vaultId,
        e.name, e.entity_type, e.aliases, e.description,
        e.status, e.facts, e.emotional_valence, e.salience_avg,
      );
    }

    // Copy active relations (only those with both endpoints in our entity set)
    const relationRows = db.query(
      `SELECT * FROM memory_relations
       WHERE chat_id = ? AND status = 'active'
         AND superseded_by IS NULL AND merged_into IS NULL
         AND contradiction_flag != 'suspect'`,
    ).all(chatId) as Array<{
      id: string; source_entity_id: string; target_entity_id: string;
      relation_type: string; relation_label: string | null;
      strength: number; sentiment: number; status: string;
    }>;

    const insertRelation = db.query(
      `INSERT INTO cortex_vault_relations
         (id, vault_id, source_entity_name, target_entity_name, relation_type, relation_label, strength, sentiment, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let relationCount = 0;
    for (const r of relationRows) {
      const sourceName = entityNameMap.get(r.source_entity_id);
      const targetName = entityNameMap.get(r.target_entity_id);
      if (!sourceName || !targetName) continue;
      insertRelation.run(
        crypto.randomUUID(), vaultId,
        sourceName, targetName, r.relation_type, r.relation_label,
        r.strength, r.sentiment, r.status,
      );
      relationCount++;
    }

    // Copy vectorized chunks as vault chunks. Only chunks that are actually
    // vectorized (vectorized_at IS NOT NULL) get copied — non-vectorized
    // chunks have no LanceDB row to clone, so they'd be unsearchable anyway.
    const chunkRows = db.query(
      `SELECT cc.id, cc.content, cc.entity_ids, cc.created_at,
              ms.score AS salience_score, ms.emotional_tags AS emotional_tags
       FROM chat_chunks cc
       LEFT JOIN memory_salience ms ON ms.chunk_id = cc.id
       WHERE cc.chat_id = ? AND cc.vectorized_at IS NOT NULL
       ORDER BY cc.created_at ASC`,
    ).all(chatId) as Array<{
      id: string; content: string; entity_ids: string | null; created_at: number;
      salience_score: number | null; emotional_tags: string | null;
    }>;

    const insertChunk = db.query(
      `INSERT INTO cortex_vault_chunks
         (id, vault_id, source_chunk_id, content, salience_score, emotional_tags,
          entity_names, source_created_at, copied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const chunkIdMap = new Map<string, string>();
    for (const cc of chunkRows) {
      const vaultChunkId = crypto.randomUUID();
      chunkIdMap.set(cc.id, vaultChunkId);

      // Resolve entity ids → names using the vault-local name map
      // (source chat ids won't exist in target chat).
      let entityNames: string[] = [];
      if (cc.entity_ids) {
        try {
          const ids = JSON.parse(cc.entity_ids) as string[];
          entityNames = ids
            .map((id) => entityNameMap.get(id))
            .filter((n): n is string => !!n);
        } catch { /* ignore malformed */ }
      }

      insertChunk.run(
        vaultChunkId, vaultId, cc.id, cc.content,
        cc.salience_score, cc.emotional_tags ?? "[]",
        JSON.stringify(entityNames),
        cc.created_at, now,
      );
    }

    // Update counts
    db.query(
      `UPDATE cortex_vaults SET entity_count = ?, relation_count = ?, chunk_count = ? WHERE id = ?`,
    ).run(entityRows.length, relationCount, chunkIdMap.size, vaultId);

    return { entityCount: entityRows.length, relationCount, chunkIdMap };
  })();
}

/**
 * List all vaults owned by a user.
 */
export function listVaults(userId: string): Vault[] {
  const rows = getDb().query(
    `SELECT v.*, c.name AS source_chat_name
     FROM cortex_vaults v
     LEFT JOIN chats c ON c.id = v.source_chat_id
     WHERE v.user_id = ?
     ORDER BY v.created_at DESC`,
  ).all(userId) as Array<VaultRow & { source_chat_name: string | null }>;
  return rows.map(rowToVault);
}

/**
 * Get a vault with its entities and relations. Scoped to the caller — vaults
 * are per-user and never shared, so always require userId here.
 */
export function getVault(userId: string, vaultId: string): {
  vault: Vault;
  entities: VaultEntity[];
  relations: VaultRelation[];
} | null {
  const db = getDb();
  const vaultRow = db.query(
    `SELECT v.*, c.name AS source_chat_name
     FROM cortex_vaults v
     LEFT JOIN chats c ON c.id = v.source_chat_id
     WHERE v.id = ? AND v.user_id = ?`,
  ).get(vaultId, userId) as (VaultRow & { source_chat_name: string | null }) | null;
  if (!vaultRow) return null;

  const entityRows = db.query(
    `SELECT * FROM cortex_vault_entities WHERE vault_id = ? ORDER BY salience_avg DESC`,
  ).all(vaultId) as VaultEntityRow[];

  const relationRows = db.query(
    `SELECT * FROM cortex_vault_relations WHERE vault_id = ? ORDER BY strength DESC`,
  ).all(vaultId) as VaultRelationRow[];

  return {
    vault: rowToVault(vaultRow),
    entities: entityRows.map(rowToVaultEntity),
    relations: relationRows.map(rowToVaultRelation),
  };
}

/**
 * Delete a vault and all its data (CASCADE handles entities/relations/chunks).
 * Also removes any chat links referencing this vault and purges vault-scoped
 * LanceDB embedding rows.
 */
export function deleteVault(userId: string, vaultId: string): boolean {
  const db = getDb();
  const vault = db.query(
    `SELECT id FROM cortex_vaults WHERE id = ? AND user_id = ?`,
  ).get(vaultId, userId);
  if (!vault) return false;

  // Purge LanceDB rows first — if this fails, we still want to delete the
  // SQLite rows but log so the operator can trigger a manual cleanup.
  embeddingsSvc.deleteVaultChunks(userId, vaultId).catch((err) => {
    console.warn(`[cortex] Vault ${vaultId} LanceDB purge failed:`, err);
  });

  db.transaction(() => {
    db.query(`DELETE FROM cortex_chat_links WHERE vault_id = ?`).run(vaultId);
    db.query(`DELETE FROM cortex_vaults WHERE id = ?`).run(vaultId);
  })();
  return true;
}

// ─── Vault Chunk Access ───────────────────────────────────────

/**
 * List vault chunks in salience-descending order. Used by queryVaultCortex
 * for Phase 1 candidate pool assembly.
 */
export function getVaultChunks(vaultId: string): VaultChunk[] {
  const rows = getDb().query(
    `SELECT * FROM cortex_vault_chunks WHERE vault_id = ? ORDER BY salience_score DESC`,
  ).all(vaultId) as VaultChunkRow[];
  return rows.map(rowToVaultChunk);
}

/**
 * Fetch a single vault row by id scoped to a user. Used by the auto-reindex
 * path so callers can inspect `chunk_count` before deciding whether to
 * trigger a rebuild.
 */
export function getVaultRow(userId: string, vaultId: string): Vault | null {
  const row = getDb().query(
    `SELECT v.*, c.name AS source_chat_name
     FROM cortex_vaults v
     LEFT JOIN chats c ON c.id = v.source_chat_id
     WHERE v.id = ? AND v.user_id = ?`,
  ).get(vaultId, userId) as (VaultRow & { source_chat_name: string | null }) | null;
  return row ? rowToVault(row) : null;
}

// ─── Reindex ──────────────────────────────────────────────────

/**
 * Rebuild a vault's snapshot. Two recovery paths:
 *   1. Source chat exists and has vectorized chunks → re-snapshot from it.
 *      Used for pre-migration-061 vaults (chunk_count = 0) and for manual
 *      refresh after the source chat's cortex has been updated.
 *   2. Source chat is gone or has no vectors, but the vault already has
 *      snapshot content in cortex_vault_chunks → re-embed the stored text
 *      under the current embedding config. Used for recovery after
 *      forceResetLanceDB.
 *
 * If neither path is available (source chat gone AND vault has no stored
 * content), chunk_count is set to -1 as a sentinel so callers stop
 * auto-retrying.
 */
export async function reindexVault(
  userId: string,
  vaultId: string,
): Promise<{ mode: "from_source" | "re_embed" | "none"; chunkCount: number }> {
  const db = getDb();
  const vaultRow = db.query(
    `SELECT * FROM cortex_vaults WHERE id = ? AND user_id = ?`,
  ).get(vaultId, userId) as VaultRow | null;
  if (!vaultRow) throw new Error("Vault not found");

  const sourceChatId = vaultRow.source_chat_id;
  const sourceChatExists = sourceChatId
    ? !!db.query(`SELECT id FROM chats WHERE id = ? AND user_id = ?`).get(sourceChatId, userId)
    : false;

  const hasVectorizedSource = sourceChatExists && sourceChatId
    ? (db.query(
        `SELECT 1 FROM chat_chunks WHERE chat_id = ? AND vectorized_at IS NOT NULL LIMIT 1`,
      ).get(sourceChatId) != null)
    : false;

  // Path 1: fresh snapshot from the live source chat.
  if (sourceChatExists && hasVectorizedSource && sourceChatId) {
    // Purge old vault LanceDB rows first — snapshotVaultContents will create
    // new vault_chunk rows with fresh ids, and stale rows would accumulate
    // otherwise (vault_chunk ids are regenerated on each reindex).
    await embeddingsSvc.deleteVaultChunks(userId, vaultId);

    const snapshot = snapshotVaultContents(
      userId, sourceChatId, vaultId, null, undefined, Math.floor(Date.now() / 1000),
      { replaceExisting: true },
    );

    if (snapshot.chunkIdMap.size > 0) {
      await embeddingsSvc.copyChunksToVault(userId, sourceChatId, vaultId, snapshot.chunkIdMap);
    }
    return { mode: "from_source", chunkCount: snapshot.chunkIdMap.size };
  }

  // Path 2: re-embed the content already stored on the vault.
  const existingChunks = getVaultChunks(vaultId);
  if (existingChunks.length > 0) {
    await embeddingsSvc.deleteVaultChunks(userId, vaultId);
    const { embedded } = await embeddingsSvc.rebuildVaultEmbeddings(
      userId,
      vaultId,
      existingChunks.map((c) => ({ vaultChunkId: c.id, content: c.content })),
    );
    return { mode: "re_embed", chunkCount: embedded };
  }

  // Path 3: nothing to recover. Mark the vault so auto-reindex stops
  // retrying on every generation.
  db.query(`UPDATE cortex_vaults SET chunk_count = -1 WHERE id = ?`).run(vaultId);
  return { mode: "none", chunkCount: 0 };
}

/**
 * Rename a vault.
 */
export function renameVault(userId: string, vaultId: string, name: string): boolean {
  const result = getDb().query(
    `UPDATE cortex_vaults SET name = ? WHERE id = ? AND user_id = ?`,
  ).run(name, vaultId, userId);
  return (result as any).changes > 0;
}

// ─── Chat Link Management ─────────────────────────────────────

/**
 * Attach a vault or interlink to a chat.
 * For bidirectional interlinks, creates two link rows in a transaction.
 */
export function attachLink(
  userId: string,
  chatId: string,
  linkType: "vault" | "interlink",
  opts: {
    vaultId?: string;
    targetChatId?: string;
    label?: string;
    bidirectional?: boolean;
  },
): ChatLink[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const createdLinkIds: string[] = [];

  // Validate
  if (linkType === "vault") {
    if (!opts.vaultId) throw new ChatLinkError("vaultId is required for vault links");
    // Scope by user_id so a user can't attach someone else's vault by guessing UUIDs.
    const vault = db.query(
      `SELECT id FROM cortex_vaults WHERE id = ? AND user_id = ?`,
    ).get(opts.vaultId, userId);
    if (!vault) throw new ChatLinkError("Vault not found", 404);

    // Check for duplicate
    const existing = db.query(
      `SELECT id FROM cortex_chat_links WHERE chat_id = ? AND link_type = 'vault' AND vault_id = ?`,
    ).get(chatId, opts.vaultId);
    if (existing) throw new ChatLinkError("This vault is already linked to this chat", 409);
  } else {
    if (!opts.targetChatId) throw new ChatLinkError("targetChatId is required for interlinks");
    if (opts.targetChatId === chatId) throw new ChatLinkError("Cannot interlink a chat with itself");
    // Target chat must also belong to the caller; cross-user interlinks are not supported.
    const chat = db.query(
      `SELECT id FROM chats WHERE id = ? AND user_id = ?`,
    ).get(opts.targetChatId, userId);
    if (!chat) throw new ChatLinkError("Target chat not found", 404);

    // Check for duplicate
    const existing = db.query(
      `SELECT id FROM cortex_chat_links WHERE chat_id = ? AND link_type = 'interlink' AND target_chat_id = ?`,
    ).get(chatId, opts.targetChatId);
    if (existing) throw new ChatLinkError("This chat is already interlinked with the target", 409);
  }

  db.transaction(() => {
    // Primary link
    const id = crypto.randomUUID();
    db.query(
      `INSERT INTO cortex_chat_links (id, user_id, chat_id, link_type, vault_id, target_chat_id, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, chatId, linkType, opts.vaultId ?? null, opts.targetChatId ?? null, opts.label ?? "", now);
    createdLinkIds.push(id);

    // Bidirectional reverse link (interlinks only)
    if (linkType === "interlink" && opts.bidirectional && opts.targetChatId) {
      const reverseExisting = db.query(
        `SELECT id FROM cortex_chat_links WHERE chat_id = ? AND link_type = 'interlink' AND target_chat_id = ?`,
      ).get(opts.targetChatId, chatId);

      if (!reverseExisting) {
        const reverseId = crypto.randomUUID();
        db.query(
          `INSERT INTO cortex_chat_links (id, user_id, chat_id, link_type, vault_id, target_chat_id, label, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
        ).run(reverseId, userId, opts.targetChatId, "interlink", chatId, opts.label ?? "", now);
        createdLinkIds.push(reverseId);
      }
    }
  })();

  return getChatLinksByIds(createdLinkIds);
}

/**
 * Get all links for a chat with joined display names. Caller MUST verify chat
 * ownership before invoking — links are scoped per-chat and cortex routes
 * already gate on getChat(userId, chatId).
 */
export function getChatLinks(chatId: string): ChatLink[] {
  const rows = getDb().query(
    `SELECT
       l.*,
       v.name AS vault_name,
       v.entity_count AS vault_entity_count,
       v.relation_count AS vault_relation_count,
       tc.name AS target_chat_name
     FROM cortex_chat_links l
     LEFT JOIN cortex_vaults v ON v.id = l.vault_id
     LEFT JOIN chats tc ON tc.id = l.target_chat_id
     WHERE l.chat_id = ?
     ORDER BY l.priority ASC, l.created_at ASC`,
  ).all(chatId) as ChatLinkRow[];
  return rows.map(rowToChatLink);
}

/**
 * Remove a link. Verifies ownership.
 */
export function removeLink(userId: string, chatId: string, linkId: string): boolean {
  const result = getDb().query(
    `DELETE FROM cortex_chat_links WHERE id = ? AND chat_id = ? AND user_id = ?`,
  ).run(linkId, chatId, userId);
  return (result as any).changes > 0;
}

/**
 * Toggle a link's enabled state.
 */
export function toggleLink(userId: string, chatId: string, linkId: string, enabled: boolean): boolean {
  const result = getDb().query(
    `UPDATE cortex_chat_links SET enabled = ? WHERE id = ? AND chat_id = ? AND user_id = ?`,
  ).run(enabled ? 1 : 0, linkId, chatId, userId);
  return (result as any).changes > 0;
}

// ─── Assembly Helpers ─────────────────────────────────────────

/**
 * Convert vault entities into EntitySnapshot[] for prompt assembly.
 */
function vaultEntitiesToSnapshots(entities: VaultEntity[]): EntitySnapshot[] {
  return entities.map((e) => ({
    id: e.id,
    name: e.name,
    type: e.entityType,
    status: e.status,
    description: e.description,
    lastSeenAt: null,
    mentionCount: 0,
    topFacts: e.facts,
    emotionalProfile: e.emotionalValence,
    relationships: [],
  }));
}

/**
 * Convert vault relations into RelationEdge[] for prompt assembly.
 */
function vaultRelationsToEdges(relations: VaultRelation[]): RelationEdge[] {
  return relations.map((r) => ({
    sourceName: r.sourceEntityName,
    targetName: r.targetEntityName,
    type: r.relationType,
    label: r.relationLabel,
    strength: r.strength,
    sentiment: r.sentiment,
  }));
}

/**
 * Get vault data formatted for prompt assembly. Scoped to the caller — assembly
 * always knows which user's chat it's building for.
 */
export function getVaultDataForAssembly(userId: string, vaultId: string): VaultCortexData | null {
  const data = getVault(userId, vaultId);
  if (!data) return null;

  return {
    vaultId: data.vault.id,
    vaultName: data.vault.name,
    sourceChatId: data.vault.sourceChatId ?? undefined,
    entities: vaultEntitiesToSnapshots(data.entities),
    relations: vaultRelationsToEdges(data.relations),
  };
}

/**
 * Collect all enabled linked data for a chat.
 * Returns vault snapshots (ready for formatting) and interlink target chat IDs
 * (to be queried separately via queryCortex).
 *
 * Uses visitedChatIds to prevent circular interlink recursion.
 */
export function getLinkedCortexData(
  userId: string,
  chatId: string,
  visitedChatIds?: Set<string>,
): {
  vaults: VaultCortexData[];
  interlinkTargetChatIds: Array<{ chatId: string; chatName: string }>;
} {
  const visited = visitedChatIds ?? new Set([chatId]);
  visited.add(chatId);

  const links = getChatLinks(chatId).filter((l) => l.enabled);
  const vaults: VaultCortexData[] = [];
  const interlinkTargets: Array<{ chatId: string; chatName: string }> = [];

  for (const link of links) {
    if (link.linkType === "vault" && link.vaultId) {
      const vaultData = getVaultDataForAssembly(userId, link.vaultId);
      if (vaultData) vaults.push(vaultData);
    } else if (link.linkType === "interlink" && link.targetChatId) {
      // Skip if already visited (circular link guard)
      if (visited.has(link.targetChatId)) continue;
      visited.add(link.targetChatId);
      interlinkTargets.push({
        chatId: link.targetChatId,
        chatName: link.targetChatName ?? "Unknown chat",
      });
    }
  }

  return { vaults, interlinkTargetChatIds: interlinkTargets };
}
