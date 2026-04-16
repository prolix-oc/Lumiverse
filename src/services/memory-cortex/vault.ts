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
  created_at: number;
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
  createdAt: number;
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
    createdAt: row.created_at,
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

// ─── Vault CRUD ───────────────────────────────────────────────

/**
 * Create a vault by snapshotting the active entities and relations from a chat's cortex.
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

  const result = db.transaction(() => {
    // Insert vault header
    db.query(
      `INSERT INTO cortex_vaults (id, user_id, source_chat_id, name, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(vaultId, userId, chatId, name, description ?? "", now);

    // Copy active entities
    const entityRows = db.query(
      `SELECT * FROM memory_entities WHERE chat_id = ? AND status != 'inactive'`,
    ).all(chatId) as Array<{
      id: string; name: string; entity_type: string; aliases: string;
      description: string; status: string; facts: string;
      emotional_valence: string; salience_avg: number;
    }>;

    // Build entity ID→name map for relation denormalization
    const entityNameMap = new Map<string, string>();
    for (const e of entityRows) {
      entityNameMap.set(e.id, e.name);
    }

    // Insert vault entities
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
      if (!sourceName || !targetName) continue; // skip orphaned relations
      insertRelation.run(
        crypto.randomUUID(), vaultId,
        sourceName, targetName, r.relation_type, r.relation_label,
        r.strength, r.sentiment, r.status,
      );
      relationCount++;
    }

    // Update counts
    db.query(
      `UPDATE cortex_vaults SET entity_count = ?, relation_count = ? WHERE id = ?`,
    ).run(entityRows.length, relationCount, vaultId);

    return { entityCount: entityRows.length, relationCount };
  })();

  return {
    id: vaultId,
    userId,
    sourceChatId: chatId,
    sourceChatName: null, // caller can resolve if needed
    name,
    description: description ?? "",
    entityCount: result.entityCount,
    relationCount: result.relationCount,
    createdAt: now,
  };
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
 * Delete a vault and all its data (CASCADE handles entities/relations).
 * Also removes any chat links referencing this vault.
 */
export function deleteVault(userId: string, vaultId: string): boolean {
  const db = getDb();
  const vault = db.query(
    `SELECT id FROM cortex_vaults WHERE id = ? AND user_id = ?`,
  ).get(vaultId, userId);
  if (!vault) return false;

  db.transaction(() => {
    db.query(`DELETE FROM cortex_chat_links WHERE vault_id = ?`).run(vaultId);
    db.query(`DELETE FROM cortex_vaults WHERE id = ?`).run(vaultId);
  })();
  return true;
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

  // Validate
  if (linkType === "vault") {
    if (!opts.vaultId) throw new Error("vaultId is required for vault links");
    // Scope by user_id so a user can't attach someone else's vault by guessing UUIDs.
    const vault = db.query(
      `SELECT id FROM cortex_vaults WHERE id = ? AND user_id = ?`,
    ).get(opts.vaultId, userId);
    if (!vault) throw new Error("Vault not found");

    // Check for duplicate
    const existing = db.query(
      `SELECT id FROM cortex_chat_links WHERE chat_id = ? AND link_type = 'vault' AND vault_id = ?`,
    ).get(chatId, opts.vaultId);
    if (existing) throw new Error("This vault is already linked to this chat");
  } else {
    if (!opts.targetChatId) throw new Error("targetChatId is required for interlinks");
    if (opts.targetChatId === chatId) throw new Error("Cannot interlink a chat with itself");
    // Target chat must also belong to the caller; cross-user interlinks are not supported.
    const chat = db.query(
      `SELECT id FROM chats WHERE id = ? AND user_id = ?`,
    ).get(opts.targetChatId, userId);
    if (!chat) throw new Error("Target chat not found");

    // Check for duplicate
    const existing = db.query(
      `SELECT id FROM cortex_chat_links WHERE chat_id = ? AND link_type = 'interlink' AND target_chat_id = ?`,
    ).get(chatId, opts.targetChatId);
    if (existing) throw new Error("This chat is already interlinked with the target");
  }

  const links: ChatLink[] = [];

  db.transaction(() => {
    // Primary link
    const id = crypto.randomUUID();
    db.query(
      `INSERT INTO cortex_chat_links (id, user_id, chat_id, link_type, vault_id, target_chat_id, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, chatId, linkType, opts.vaultId ?? null, opts.targetChatId ?? null, opts.label ?? "", now);

    links.push({
      id,
      userId,
      chatId,
      linkType,
      vaultId: opts.vaultId ?? null,
      vaultName: null,
      vaultEntityCount: null,
      vaultRelationCount: null,
      targetChatId: opts.targetChatId ?? null,
      targetChatName: null,
      targetChatExists: true,
      label: opts.label ?? "",
      enabled: true,
      priority: 0,
      createdAt: now,
    });

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

        links.push({
          id: reverseId,
          userId,
          chatId: opts.targetChatId,
          linkType: "interlink",
          vaultId: null,
          vaultName: null,
          vaultEntityCount: null,
          vaultRelationCount: null,
          targetChatId: chatId,
          targetChatName: null,
          targetChatExists: true,
          label: opts.label ?? "",
          enabled: true,
          priority: 0,
          createdAt: now,
        });
      }
    }
  })();

  return links;
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
export function removeLink(userId: string, linkId: string): boolean {
  const result = getDb().query(
    `DELETE FROM cortex_chat_links WHERE id = ? AND user_id = ?`,
  ).run(linkId, userId);
  return (result as any).changes > 0;
}

/**
 * Toggle a link's enabled state.
 */
export function toggleLink(userId: string, linkId: string, enabled: boolean): boolean {
  const result = getDb().query(
    `UPDATE cortex_chat_links SET enabled = ? WHERE id = ? AND user_id = ?`,
  ).run(enabled ? 1 : 0, linkId, userId);
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
