/**
 * Memory Cortex — Entity graph CRUD operations.
 *
 * SQLite-backed persistent storage for entities, mentions, and relationships.
 * All operations are synchronous (bun:sqlite is sync) except where noted.
 */

import { getDb } from "../../db/connection";
import { extractMentionExcerpt } from "./entity-extractor";
import type {
  MemoryEntity,
  MemoryEntityRow,
  MemoryMention,
  MemoryMentionRow,
  MemoryRelation,
  MemoryRelationRow,
  EntityType,
  EntityStatus,
  MentionRole,
  RelationType,
  RelationStatus,
  ExtractedEntity,
  ExtractedRelationship,
} from "./types";

// ─── Row Mappers ───────────────────────────────────────────────

function rowToEntity(row: MemoryEntityRow): MemoryEntity {
  return {
    id: row.id,
    chatId: row.chat_id,
    name: row.name,
    entityType: row.entity_type as EntityType,
    aliases: safeJsonArray(row.aliases),
    description: row.description,
    firstSeenChunkId: row.first_seen_chunk_id,
    lastSeenChunkId: row.last_seen_chunk_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    mentionCount: row.mention_count,
    salienceAvg: row.salience_avg,
    status: row.status as EntityStatus,
    statusChangedAt: row.status_changed_at,
    facts: safeJsonArray(row.facts),
    emotionalValence: safeJsonObject(row.emotional_valence),
    metadata: safeJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMention(row: MemoryMentionRow): MemoryMention {
  return {
    id: row.id,
    entityId: row.entity_id,
    chunkId: row.chunk_id,
    chatId: row.chat_id,
    role: row.role as MentionRole,
    excerpt: row.excerpt,
    sentiment: row.sentiment,
    createdAt: row.created_at,
  };
}

function rowToRelation(row: MemoryRelationRow): MemoryRelation {
  return {
    id: row.id,
    chatId: row.chat_id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationType: row.relation_type as RelationType,
    relationLabel: row.relation_label,
    strength: row.strength,
    sentiment: row.sentiment,
    evidenceChunkIds: safeJsonArray(row.evidence_chunk_ids),
    firstEstablishedAt: row.first_established_at,
    lastReinforcedAt: row.last_reinforced_at,
    status: row.status as RelationStatus,
    metadata: safeJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function safeJsonObject(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ─── Entity CRUD ───────────────────────────────────────────────

/** Get all entities for a chat */
export function getEntities(chatId: string): MemoryEntity[] {
  const rows = getDb()
    .query("SELECT * FROM memory_entities WHERE chat_id = ? ORDER BY mention_count DESC")
    .all(chatId) as MemoryEntityRow[];
  return rows.map(rowToEntity);
}

/** Get a single entity by ID */
export function getEntity(entityId: string): MemoryEntity | null {
  const row = getDb()
    .query("SELECT * FROM memory_entities WHERE id = ?")
    .get(entityId) as MemoryEntityRow | null;
  return row ? rowToEntity(row) : null;
}

/** Find an entity by name (case-insensitive) or alias within a chat.
 *  Uses indexed name lookup first, then a bounded alias scan (max 500 entities). */
export function findEntityByName(chatId: string, name: string): MemoryEntity | null {
  // Fast path: indexed exact name match
  const byName = getDb()
    .query("SELECT * FROM memory_entities WHERE chat_id = ? AND name = ? COLLATE NOCASE")
    .get(chatId, name) as MemoryEntityRow | null;
  if (byName) return rowToEntity(byName);

  // Slower path: scan aliases, but cap at 500 entities to prevent unbounded iteration.
  // Sorted by mention_count DESC so high-value entities are checked first.
  const candidates = getDb()
    .query("SELECT * FROM memory_entities WHERE chat_id = ? ORDER BY mention_count DESC LIMIT 500")
    .all(chatId) as MemoryEntityRow[];

  const lowerName = name.toLowerCase();
  for (const row of candidates) {
    const aliases = safeJsonArray(row.aliases);
    if (aliases.some((a) => a.toLowerCase() === lowerName)) {
      return rowToEntity(row);
    }
  }

  return null;
}

/** Get entities by IDs */
export function getEntitiesByIds(entityIds: string[]): MemoryEntity[] {
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = getDb()
    .query(`SELECT * FROM memory_entities WHERE id IN (${placeholders})`)
    .all(...entityIds) as MemoryEntityRow[];
  return rows.map(rowToEntity);
}

/** Create or update an entity. Returns the entity ID. */
export function upsertEntity(
  chatId: string,
  extracted: ExtractedEntity,
  chunkId: string,
  chunkTimestamp: number,
): string {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Check if entity already exists
  const existing = findEntityByName(chatId, extracted.name);

  if (existing) {
    // Update existing entity
    const newAliases = mergeAliases(existing.aliases, extracted.aliases);
    db.query(
      `UPDATE memory_entities SET
        last_seen_chunk_id = ?,
        last_seen_at = ?,
        mention_count = mention_count + 1,
        aliases = ?,
        updated_at = ?
       WHERE id = ?`,
    ).run(chunkId, chunkTimestamp, JSON.stringify(newAliases), now, existing.id);

    return existing.id;
  }

  // Create new entity
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO memory_entities
      (id, chat_id, name, entity_type, aliases, first_seen_chunk_id, last_seen_chunk_id,
       first_seen_at, last_seen_at, mention_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id, chatId, extracted.name, extracted.type,
    JSON.stringify(extracted.aliases),
    chunkId, chunkId, chunkTimestamp, chunkTimestamp,
    now, now,
  );

  return id;
}

/**
 * Update entity status (e.g., "deceased", "departed").
 * If a branchId is provided, the status change is recorded as a branch-scoped fact
 * instead of overwriting the global status — this prevents branch A's death from
 * clobbering branch B's living character.
 */
export function updateEntityStatus(
  entityId: string,
  status: EntityStatus,
  branchId?: string | null,
): void {
  const now = Math.floor(Date.now() / 1000);

  if (branchId) {
    // Branch-scoped: record as a fact rather than overwriting global status
    addEntityFacts(entityId, [`Status changed to: ${status}`], branchId);
  } else {
    // Global: direct status update (main branch or non-branching chat)
    getDb()
      .query("UPDATE memory_entities SET status = ?, status_changed_at = ?, updated_at = ? WHERE id = ?")
      .run(status, now, now, entityId);
  }
}

/**
 * Add facts to an entity (deduplicating).
 * Facts can optionally carry branch provenance — if a branchId is provided,
 * the fact is stored as "[branch:id] fact text" so it can be filtered later.
 */
export function addEntityFacts(
  entityId: string,
  newFacts: string[],
  branchId?: string | null,
): void {
  if (newFacts.length === 0) return;
  const db = getDb();
  const row = db.query("SELECT facts FROM memory_entities WHERE id = ?").get(entityId) as any;
  if (!row) return;

  const existing = safeJsonArray(row.facts);
  const lowerExisting = new Set(existing.map((f) => f.toLowerCase().replace(/^\[branch:[^\]]+\]\s*/, "")));

  const merged = [...existing];
  for (let fact of newFacts) {
    if (!fact) continue;
    // Add branch provenance tag if provided
    if (branchId) fact = `[branch:${branchId}] ${fact}`;
    const normalizedFact = fact.toLowerCase().replace(/^\[branch:[^\]]+\]\s*/, "");
    if (!lowerExisting.has(normalizedFact)) {
      merged.push(fact);
      lowerExisting.add(normalizedFact);
    }
  }

  // Keep only the most recent 20 facts
  const trimmed = merged.slice(-20);
  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE memory_entities SET facts = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(trimmed), now, entityId);
}

/**
 * Get facts for an entity, optionally filtered to a specific branch.
 * If branchId is provided, returns only facts from that branch or untagged facts.
 */
export function getEntityFacts(entityId: string, branchId?: string | null): string[] {
  const entity = getEntity(entityId);
  if (!entity) return [];

  if (!branchId) {
    // Return all facts, stripping branch tags for display
    return entity.facts.map((f) => f.replace(/^\[branch:[^\]]+\]\s*/, ""));
  }

  // Filter: include untagged facts + facts from this specific branch
  return entity.facts
    .filter((f) => {
      const match = f.match(/^\[branch:([^\]]+)\]/);
      return !match || match[1] === branchId;
    })
    .map((f) => f.replace(/^\[branch:[^\]]+\]\s*/, ""));
}

/** Update the running emotional valence for an entity */
export function updateEntityEmotionalValence(
  entityId: string,
  newTags: Record<string, number>,
): void {
  const db = getDb();
  const row = db.query("SELECT emotional_valence, mention_count FROM memory_entities WHERE id = ?").get(entityId) as any;
  if (!row) return;

  const existing = safeJsonObject(row.emotional_valence);
  const count = row.mention_count || 1;

  // Running average
  for (const [tag, value] of Object.entries(newTags)) {
    const prev = existing[tag] ?? 0;
    existing[tag] = prev + (value - prev) / count;
  }

  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE memory_entities SET emotional_valence = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(existing), now, entityId);
}

/** Update salience average for an entity */
export function updateEntitySalience(entityId: string, chunkSalience: number): void {
  const db = getDb();
  const row = db.query("SELECT salience_avg, mention_count FROM memory_entities WHERE id = ?").get(entityId) as any;
  if (!row) return;

  const count = row.mention_count || 1;
  const newAvg = row.salience_avg + (chunkSalience - row.salience_avg) / count;

  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE memory_entities SET salience_avg = ?, updated_at = ? WHERE id = ?")
    .run(newAvg, now, entityId);
}

/** Delete all entities for a chat (used in rebuild) */
export function deleteEntitiesForChat(chatId: string): void {
  getDb().query("DELETE FROM memory_entities WHERE chat_id = ?").run(chatId);
}

// ─── Mention CRUD ──────────────────────────────────────────────

/** Record an entity mention in a chunk */
export function upsertMention(
  entityId: string,
  chunkId: string,
  chatId: string,
  role: MentionRole,
  excerpt: string | null,
  sentiment: number,
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Use INSERT OR REPLACE with the unique constraint on (entity_id, chunk_id)
  db.query(
    `INSERT INTO memory_mentions (id, entity_id, chunk_id, chat_id, role, excerpt, sentiment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, chunk_id) DO UPDATE SET
       role = excluded.role,
       excerpt = excluded.excerpt,
       sentiment = excluded.sentiment`,
  ).run(crypto.randomUUID(), entityId, chunkId, chatId, role, excerpt, sentiment, now);
}

/** Get all mentions for an entity */
export function getMentionsForEntity(entityId: string): MemoryMention[] {
  const rows = getDb()
    .query("SELECT * FROM memory_mentions WHERE entity_id = ? ORDER BY created_at DESC")
    .all(entityId) as MemoryMentionRow[];
  return rows.map(rowToMention);
}

/** Get all mentions in a chunk */
export function getMentionsForChunk(chunkId: string): MemoryMention[] {
  const rows = getDb()
    .query("SELECT * FROM memory_mentions WHERE chunk_id = ?")
    .all(chunkId) as MemoryMentionRow[];
  return rows.map(rowToMention);
}

/** Get chunk IDs that mention any of the given entity IDs */
export function getChunkIdsForEntities(chatId: string, entityIds: string[]): string[] {
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = getDb()
    .query(
      `SELECT DISTINCT chunk_id FROM memory_mentions
       WHERE chat_id = ? AND entity_id IN (${placeholders})`,
    )
    .all(chatId, ...entityIds) as Array<{ chunk_id: string }>;
  return rows.map((r) => r.chunk_id);
}

/** Delete all mentions for a chat (used in rebuild) */
export function deleteMentionsForChat(chatId: string): void {
  getDb().query("DELETE FROM memory_mentions WHERE chat_id = ?").run(chatId);
}

// ─── Relation CRUD ─────────────────────────────────────────────

/** Create or reinforce a relationship between entities */
export function upsertRelation(
  chatId: string,
  rel: ExtractedRelationship,
  sourceEntityId: string,
  targetEntityId: string,
  chunkId: string,
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Check for existing relation of same type between same entities
  const existing = db
    .query(
      `SELECT * FROM memory_relations
       WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?`,
    )
    .get(sourceEntityId, targetEntityId, rel.type) as MemoryRelationRow | null;

  if (existing) {
    // Reinforce existing relation
    const evidenceIds = safeJsonArray(existing.evidence_chunk_ids);
    if (!evidenceIds.includes(chunkId)) {
      evidenceIds.push(chunkId);
    }
    // Running average for strength and sentiment
    const newStrength = Math.min(1.0, existing.strength + 0.05);
    const newSentiment = existing.sentiment + (rel.sentiment - existing.sentiment) * 0.3;

    db.query(
      `UPDATE memory_relations SET
        relation_label = COALESCE(?, relation_label),
        strength = ?,
        sentiment = ?,
        evidence_chunk_ids = ?,
        last_reinforced_at = ?,
        updated_at = ?
       WHERE id = ?`,
    ).run(
      rel.label || null, newStrength, newSentiment,
      JSON.stringify(evidenceIds), now, now, existing.id,
    );
  } else {
    // Create new relation
    db.query(
      `INSERT INTO memory_relations
        (id, chat_id, source_entity_id, target_entity_id, relation_type, relation_label,
         strength, sentiment, evidence_chunk_ids, first_established_at, last_reinforced_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(), chatId, sourceEntityId, targetEntityId,
      rel.type, rel.label || null, 0.5, rel.sentiment,
      JSON.stringify([chunkId]), now, now, now, now,
    );
  }
}

/** Get all relations for a chat */
export function getRelations(chatId: string): MemoryRelation[] {
  const rows = getDb()
    .query("SELECT * FROM memory_relations WHERE chat_id = ? AND status = 'active' ORDER BY strength DESC")
    .all(chatId) as MemoryRelationRow[];
  return rows.map(rowToRelation);
}

/** Get relations involving specific entity IDs */
export function getRelationsForEntities(chatId: string, entityIds: string[]): MemoryRelation[] {
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = getDb()
    .query(
      `SELECT * FROM memory_relations
       WHERE chat_id = ? AND status = 'active'
         AND (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))
       ORDER BY strength DESC`,
    )
    .all(chatId, ...entityIds, ...entityIds) as MemoryRelationRow[];
  return rows.map(rowToRelation);
}

/** Delete all relations for a chat (used in rebuild) */
export function deleteRelationsForChat(chatId: string): void {
  getDb().query("DELETE FROM memory_relations WHERE chat_id = ?").run(chatId);
}

// ─── Batch Ingestion ───────────────────────────────────────────

/**
 * Process a batch of extracted entities and relationships for a single chunk.
 * Upserts entities, records mentions, and creates/reinforces relationships.
 *
 * @returns Array of entity IDs that were involved
 */
export function ingestChunkEntities(
  chatId: string,
  chunkId: string,
  chunkTimestamp: number,
  extractedEntities: Array<ExtractedEntity & { mentionRole?: MentionRole }>,
  extractedRelationships: ExtractedRelationship[],
  chunkSalience: number,
  emotionalTags: string[],
  content: string,
): string[] {
  const db = getDb();
  const entityIdMap = new Map<string, string>(); // name → entity ID

  const transaction = db.transaction(() => {
    // 1. Upsert entities and record mentions
    for (const ext of extractedEntities) {
      const entityId = upsertEntity(chatId, ext, chunkId, chunkTimestamp);
      entityIdMap.set(ext.name.toLowerCase(), entityId);

      // Record mention
      const excerpt = extractMentionExcerpt(ext.name, content);
      upsertMention(
        entityId, chunkId, chatId,
        ext.mentionRole ?? ext.role ?? "present",
        excerpt,
        0, // Sentiment from mentions will be refined later
      );

      // Update entity salience
      updateEntitySalience(entityId, chunkSalience);

      // Update emotional valence if tags present
      if (emotionalTags.length > 0) {
        const tagValues: Record<string, number> = {};
        for (const tag of emotionalTags) {
          tagValues[tag] = 1.0;
        }
        updateEntityEmotionalValence(entityId, tagValues);
      }
    }

    // 2. Upsert relationships
    for (const rel of extractedRelationships) {
      const sourceId = entityIdMap.get(rel.source.toLowerCase());
      const targetId = entityIdMap.get(rel.target.toLowerCase());

      // Both entities must exist in this chunk's extraction
      if (sourceId && targetId) {
        upsertRelation(chatId, rel, sourceId, targetId, chunkId);
      }
    }
  });

  transaction();

  return [...entityIdMap.values()];
}

// ─── Entity Pruning ────────────────────────────────────────────

/** Hard ceiling: maximum active entities per chat before forced archival */
const MAX_ACTIVE_ENTITIES_PER_CHAT = 400;

/** Hard ceiling: maximum mentions per entity before oldest are trimmed */
const MAX_MENTIONS_PER_ENTITY = 200;

/** Hard ceiling: maximum relations per chat before weakest are pruned */
const MAX_RELATIONS_PER_CHAT = 300;

/**
 * Comprehensive entity graph pruning. Handles:
 *
 * 1. Stale entity archival (mention_count <= threshold, not seen recently)
 * 2. Hard entity cap enforcement (archive lowest-value entities over ceiling)
 * 3. Mention table trimming (cap mentions per entity, delete for archived entities)
 * 4. Weak relation pruning (remove low-strength, single-evidence relations)
 *
 * @returns Summary of what was pruned
 */
export function pruneStaleEntities(
  chatId: string,
  staleAfterMessages: number,
): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const staleThreshold = now - (staleAfterMessages * 60);
  let totalArchived = 0;

  // ── 1. Archive stale low-mention entities ──
  // Entities with <=2 mentions and no recent activity get archived.
  // Character-type entities have a higher tolerance (<=1 mention only).
  const staleResult = db.query(
    `UPDATE memory_entities SET status = 'inactive', status_changed_at = ?, updated_at = ?
     WHERE chat_id = ? AND status = 'active' AND last_seen_at < ?
       AND ((entity_type != 'character' AND mention_count <= 2)
            OR (entity_type = 'character' AND mention_count <= 1))`,
  ).run(now, now, chatId, staleThreshold);
  totalArchived += staleResult.changes;

  // ── 2. Enforce hard entity cap ──
  // If active entities exceed ceiling, archive the lowest-salience ones.
  const activeCount = db
    .query("SELECT COUNT(*) as c FROM memory_entities WHERE chat_id = ? AND status != 'inactive'")
    .get(chatId) as any;

  if (activeCount?.c > MAX_ACTIVE_ENTITIES_PER_CHAT) {
    const excess = activeCount.c - MAX_ACTIVE_ENTITIES_PER_CHAT;
    // Archive the lowest-value entities: low salience, low mention count
    const toArchive = db
      .query(
        `SELECT id FROM memory_entities
         WHERE chat_id = ? AND status != 'inactive'
         ORDER BY salience_avg ASC, mention_count ASC
         LIMIT ?`,
      )
      .all(chatId, excess) as Array<{ id: string }>;

    if (toArchive.length > 0) {
      const ids = toArchive.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      db.query(
        `UPDATE memory_entities SET status = 'inactive', status_changed_at = ?, updated_at = ?
         WHERE id IN (${placeholders})`,
      ).run(now, now, ...ids);
      totalArchived += toArchive.length;
    }
  }

  // ── 3. Clean up mentions for archived entities ──
  // Mentions for inactive entities are dead weight — remove them.
  db.query(
    `DELETE FROM memory_mentions WHERE chat_id = ? AND entity_id IN (
       SELECT id FROM memory_entities WHERE chat_id = ? AND status = 'inactive'
     )`,
  ).run(chatId, chatId);

  // ── 4. Trim excessive mentions per entity ──
  // Cap at MAX_MENTIONS_PER_ENTITY per entity, keeping most recent.
  const heavyEntities = db
    .query(
      `SELECT entity_id, COUNT(*) as c FROM memory_mentions
       WHERE chat_id = ? GROUP BY entity_id HAVING c > ?`,
    )
    .all(chatId, MAX_MENTIONS_PER_ENTITY) as Array<{ entity_id: string; c: number }>;

  for (const { entity_id, c } of heavyEntities) {
    const excess = c - MAX_MENTIONS_PER_ENTITY;
    db.query(
      `DELETE FROM memory_mentions WHERE id IN (
         SELECT id FROM memory_mentions
         WHERE entity_id = ? ORDER BY created_at ASC LIMIT ?
       )`,
    ).run(entity_id, excess);
  }

  // ── 5. Prune weak relations ──
  // Relations with strength < 0.3 and only 1 evidence chunk that haven't
  // been reinforced recently are likely noise.
  const relationStaleThreshold = now - (staleAfterMessages * 120); // 2x the entity threshold
  db.query(
    `DELETE FROM memory_relations
     WHERE chat_id = ? AND strength < 0.3
       AND json_array_length(evidence_chunk_ids) <= 1
       AND last_reinforced_at < ?`,
  ).run(chatId, relationStaleThreshold);

  // ── 6. Enforce hard relation cap ──
  const relationCount = db
    .query("SELECT COUNT(*) as c FROM memory_relations WHERE chat_id = ?")
    .get(chatId) as any;

  if (relationCount?.c > MAX_RELATIONS_PER_CHAT) {
    const excess = relationCount.c - MAX_RELATIONS_PER_CHAT;
    db.query(
      `DELETE FROM memory_relations WHERE id IN (
         SELECT id FROM memory_relations
         WHERE chat_id = ?
         ORDER BY strength ASC, last_reinforced_at ASC
         LIMIT ?
       )`,
    ).run(chatId, excess);
  }

  if (totalArchived > 0) {
    console.info(`[memory-cortex] Pruned ${totalArchived} entities for chat ${chatId}`);
  }

  return totalArchived;
}

/**
 * Get active (non-archived) entities only. Used by retrieval to skip noise.
 */
export function getActiveEntities(chatId: string, limit = 500): MemoryEntity[] {
  const rows = getDb()
    .query(
      `SELECT * FROM memory_entities
       WHERE chat_id = ? AND status != 'inactive'
       ORDER BY mention_count DESC LIMIT ?`,
    )
    .all(chatId, limit) as MemoryEntityRow[];
  return rows.map(rowToEntity);
}

// ─── Entity Description Population ─────────────────────────────

/**
 * Auto-populate an entity's description from its first mention excerpt.
 * Only sets description if currently empty.
 */
export function populateEntityDescription(entityId: string, excerpt: string): void {
  if (!excerpt) return;
  const db = getDb();
  const row = db.query("SELECT description FROM memory_entities WHERE id = ?").get(entityId) as any;
  if (row && !row.description) {
    const now = Math.floor(Date.now() / 1000);
    // Clean up the excerpt:
    // 1. Strip chunk format prefix: [CHARACTER | Name]: or [USER | Name]:
    // 2. Strip leading/trailing ellipsis
    // 3. Trim whitespace
    let cleaned = excerpt
      .replace(/^\.*\s*\[(?:CHARACTER|USER)\s*\|\s*[^\]]*\]\s*:\s*/i, "")
      .replace(/^\.{3}\s*/, "")
      .replace(/\s*\.{3}$/, "")
      .trim();
    // Take just the first sentence for a concise description
    const sentenceEnd = cleaned.search(/[.!?]\s/);
    if (sentenceEnd > 15 && sentenceEnd < cleaned.length - 5) {
      cleaned = cleaned.slice(0, sentenceEnd + 1);
    }
    if (cleaned.length > 10) {
      db.query("UPDATE memory_entities SET description = ?, updated_at = ? WHERE id = ?")
        .run(cleaned, now, entityId);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function mergeAliases(existing: string[], incoming: string[]): string[] {
  const set = new Set(existing.map((a) => a.toLowerCase()));
  const merged = [...existing];
  for (const alias of incoming) {
    if (alias && !set.has(alias.toLowerCase())) {
      merged.push(alias);
      set.add(alias.toLowerCase());
    }
  }
  return merged;
}
