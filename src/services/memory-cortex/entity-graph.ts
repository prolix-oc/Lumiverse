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
  ContradictionFlag,
  FactExtractionStatus,
  EntityConfidence,
  SalienceBreakdown,
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
    factExtractionStatus: (row.fact_extraction_status ?? "never") as FactExtractionStatus,
    factExtractionLastAttempt: row.fact_extraction_last_attempt ?? null,
    salienceBreakdown: safeJsonObject(row.salience_breakdown) as unknown as SalienceBreakdown,
    lastMentionTimestamp: row.last_mention_timestamp ?? null,
    recentMentionCount: row.recent_mention_count ?? 0,
    confidence: (row.confidence ?? "confirmed") as EntityConfidence,
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
    contradictionFlag: (row.contradiction_flag ?? "none") as ContradictionFlag,
    contradictionPeerId: row.contradiction_peer_id ?? null,
    sentimentRange: row.sentiment_range ? JSON.parse(row.sentiment_range) : null,
    supersededBy: row.superseded_by ?? null,
    arcIds: safeJsonArray(row.arc_ids),
    firstSeenArcId: row.first_seen_arc_id ?? null,
    lastSeenArcId: row.last_seen_arc_id ?? null,
    lastEvidenceTimestamp: row.last_evidence_timestamp ?? null,
    decayRate: row.decay_rate ?? 0.05,
    edgeSalience: row.edge_salience ?? 0,
    labelAliases: safeJsonArray(row.label_aliases),
    canonicalEdgeId: row.canonical_edge_id ?? null,
    mergedInto: row.merged_into ?? null,
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

// ─── Canonical Resolution (BUG 1 fix) ─────────────────────────
// Every edge write resolves source/target through this function.
// Prevents entity graph fracture ("Pulchra" vs "Pulchra Fellini").

/** Common title prefixes to strip during normalization */
const TITLE_PREFIXES = /^(?:lord|lady|sir|dame|king|queen|prince|princess|duke|duchess|count|countess|baron|baroness|master|mistress|captain|commander|general|professor|doctor|dr|the)\s+/i;

/** Normalize an entity name for fuzzy matching */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(TITLE_PREFIXES, "")
    .replace(/['''\u2019]/g, "'") // normalize apostrophes
    .replace(/[^\w\s'-]/g, "") // strip non-word chars except hyphen/apostrophe
    .trim();
}

/**
 * Resolve a name or ID to a canonical entity ID.
 *
 * Resolution order:
 *   1. Direct entity ID match
 *   2. Exact name match (case-insensitive)
 *   3. Alias lookup
 *   4. Normalized name fuzzy match (strip titles, lowercase)
 *
 * @returns Entity ID if resolved, null if genuinely new
 */
export function resolveCanonicalId(
  nameOrId: string,
  chatId: string,
): string | null {
  const db = getDb();

  // 1. Direct entity ID match
  const byId = db
    .query("SELECT id FROM memory_entities WHERE id = ?")
    .get(nameOrId) as { id: string } | null;
  if (byId) return byId.id;

  // 2. Exact name match (case-insensitive) — uses idx_me_chat_name index
  const byName = db
    .query("SELECT id FROM memory_entities WHERE chat_id = ? AND name = ? COLLATE NOCASE")
    .get(chatId, nameOrId) as { id: string } | null;
  if (byName) return byName.id;

  // 3. Alias lookup — scan active entities, cap at 500
  const candidates = db
    .query("SELECT id, aliases FROM memory_entities WHERE chat_id = ? ORDER BY mention_count DESC LIMIT 500")
    .all(chatId) as Array<{ id: string; aliases: string }>;

  const lowerName = nameOrId.toLowerCase();
  for (const row of candidates) {
    const aliases = safeJsonArray(row.aliases);
    if (aliases.some((a) => a.toLowerCase() === lowerName)) {
      return row.id;
    }
  }

  // 4. Normalized fuzzy match — strip titles, check both incoming and stored names
  const normalized = normalizeEntityName(nameOrId);
  if (normalized.length < 2) return null;

  const allEntities = db
    .query("SELECT id, name, aliases FROM memory_entities WHERE chat_id = ? ORDER BY mention_count DESC LIMIT 500")
    .all(chatId) as Array<{ id: string; name: string; aliases: string }>;

  for (const row of allEntities) {
    // Check if normalized stored name matches
    if (normalizeEntityName(row.name) === normalized) return row.id;

    // Check if any alias normalizes to the same
    const aliases = safeJsonArray(row.aliases);
    if (aliases.some((a) => normalizeEntityName(a) === normalized)) return row.id;

    // Check if incoming is a substring of stored name or vice versa (for "Pulchra" matching "Pulchra Fellini")
    const storedNorm = normalizeEntityName(row.name);
    if (storedNorm.length >= 3 && normalized.length >= 3) {
      // Shorter name is contained within longer name as a word boundary match
      const shorter = storedNorm.length <= normalized.length ? storedNorm : normalized;
      const longer = storedNorm.length <= normalized.length ? normalized : storedNorm;
      if (longer.startsWith(shorter + " ") || longer.endsWith(" " + shorter)) {
        return row.id;
      }
    }
  }

  return null; // Genuinely new entity
}

// ─── Logarithmic Strength Curve (BUG 2 fix) ──────────────────

/** Tuning constant — lower k = slower confidence growth */
const STRENGTH_K = 0.15;

/**
 * Compute edge strength from evidence count using a logarithmic confidence curve.
 * Replaces the old linear strength=0.5 + 0.05*n formula.
 *
 * Results at k=0.15:
 *   1 chunk  → 0.14 (14%)
 *   3 chunks → 0.36 (36%)
 *   5 chunks → 0.53 (53%)
 *   7 chunks → 0.65 (65%)
 *  12 chunks → 0.84 (84%)
 *  23 chunks → 0.97 (97%)
 */
export function computeStrength(evidenceCount: number): number {
  return 1 - Math.exp(-STRENGTH_K * evidenceCount);
}

/** Minimum strength floor for user-confirmed (pinned) relationships */
const PINNED_STRENGTH_FLOOR = 0.85;

// ─── Contradiction Detection (BUG 3 fix) ──────────────────────

/**
 * Detect and resolve contradictions when writing an edge that conflicts with an existing one.
 *
 * Resolution logic:
 *   1. TEMPORAL — edges from different arcs: newer supersedes older
 *   2. COMPLEX — same arc, both with evidence_count >= 3: flag both as complex
 *   3. SUSPECT — incoming has evidence_count = 1, existing >= 3: mark incoming as suspect
 */
function detectAndResolveContradiction(
  existingRow: MemoryRelationRow,
  incomingSentiment: number,
  incomingEvidenceCount: number,
  incomingArcId: string | null,
): {
  contradictionFlag: ContradictionFlag;
  action: "write_normal" | "mark_superseded" | "mark_complex" | "mark_suspect";
  supersededEdgeId?: string;
} {
  const existingSentiment = existingRow.sentiment;

  // No contradiction if sentiments have the same sign (or either is neutral)
  if (
    Math.sign(existingSentiment) === Math.sign(incomingSentiment) ||
    Math.abs(existingSentiment) < 0.1 ||
    Math.abs(incomingSentiment) < 0.1
  ) {
    return { contradictionFlag: "none", action: "write_normal" };
  }

  const existingArcIds = safeJsonArray(existingRow.arc_ids);
  const existingEvidenceCount = safeJsonArray(existingRow.evidence_chunk_ids).length;

  // 1. TEMPORAL — different arcs
  if (incomingArcId && existingArcIds.length > 0 && !existingArcIds.includes(incomingArcId)) {
    return {
      contradictionFlag: "temporal",
      action: "mark_superseded",
      supersededEdgeId: existingRow.id,
    };
  }

  // 2. COMPLEX — same arc context, both well-evidenced
  if (existingEvidenceCount >= 3 && incomingEvidenceCount >= 3) {
    return { contradictionFlag: "complex", action: "mark_complex" };
  }

  // 3. SUSPECT — incoming is weakly evidenced against a well-established edge
  if (incomingEvidenceCount <= 1 && existingEvidenceCount >= 3) {
    return { contradictionFlag: "suspect", action: "mark_suspect" };
  }

  // Default: write normally (early-stage edges, both weakly evidenced)
  return { contradictionFlag: "none", action: "write_normal" };
}

// ─── Edge Type Consolidation (IMP 5) ──────────────────────────

/** Types that can subsume or merge with each other */
const TYPE_HIERARCHY: Record<string, {
  mergeableWith?: string[];
  sentimentTolerance?: number;
  subsumes?: string[];
  alwaysIndependent?: boolean;
}> = {
  ally: { mergeableWith: ["custom"], sentimentTolerance: 0.3 },
  custom: { mergeableWith: ["ally"], sentimentTolerance: 0.3 },
  lover: { subsumes: ["ally", "custom"] },
  located_in: { alwaysIndependent: true },
  enemy: { alwaysIndependent: true },
};

/** Check if two edges between the same pair should merge */
export function shouldMergeEdges(edgeA: MemoryRelation, edgeB: MemoryRelation): boolean {
  if (edgeA.sourceEntityId !== edgeB.sourceEntityId) return false;
  if (edgeA.targetEntityId !== edgeB.targetEntityId) return false;

  const hierA = TYPE_HIERARCHY[edgeA.relationType];
  if (!hierA || hierA.alwaysIndependent) return false;

  // Subsumption: lover subsumes ally
  if (hierA.subsumes?.includes(edgeB.relationType)) return true;

  // Mergeable: ally/custom when sentiment is close
  if (!hierA.mergeableWith?.includes(edgeB.relationType)) return false;
  const sentimentDelta = Math.abs(edgeA.sentiment - edgeB.sentiment);
  return sentimentDelta <= (hierA.sentimentTolerance ?? 0.3);
}

// ─── Independent Edge Decay (IMP 1) ──────────────────────────

/**
 * Compute decay rate for an edge based on its strength and arc weight.
 * High strength + high arc weight = slow decay (narratively durable).
 * Low strength = fast decay (unconfirmed, should be corroborated or drop).
 */
export function computeEdgeDecayRate(strength: number, arcWeightModifier = 1.0): number {
  const base = 0.05;
  // Clamp strength to avoid division by zero
  const clampedStrength = Math.max(0.01, strength);
  const clampedArcWeight = Math.max(0.1, arcWeightModifier);
  return base * (1 / clampedStrength) * (1 / clampedArcWeight);
}

/**
 * Compute current edge salience factoring in temporal decay.
 * Used by retrieval to filter "what relationships are currently active and confident."
 */
export function computeEdgeSalience(
  strength: number,
  decayRate: number,
  lastEvidenceTimestamp: number,
  now?: number,
): number {
  const currentTime = now ?? Math.floor(Date.now() / 1000);
  const age = Math.max(0, currentTime - lastEvidenceTimestamp);
  // Age in "turns" (~60s each, rough approximation)
  const ageInTurns = age / 60;
  return strength * Math.exp(-decayRate * ageInTurns);
}

// ─── Graph Centrality (IMP 3) ─────────────────────────────────

/**
 * Compute single-hop weighted centrality for an entity.
 * NOT full PageRank — single-hop approximation of TextRank.
 * Uses previous tick's salience to avoid circular dependency.
 */
export function computeGraphCentrality(
  entityId: string,
  chatId: string,
): number {
  const db = getDb();

  // Get active edges for this entity (not superseded, not suspect)
  const edges = db
    .query(
      `SELECT source_entity_id, target_entity_id, strength FROM memory_relations
       WHERE chat_id = ? AND status = 'active'
         AND contradiction_flag NOT IN ('suspect')
         AND superseded_by IS NULL AND merged_into IS NULL
         AND (source_entity_id = ? OR target_entity_id = ?)`,
    )
    .all(chatId, entityId, entityId) as Array<{
      source_entity_id: string;
      target_entity_id: string;
      strength: number;
    }>;

  if (edges.length === 0) return 0;

  let weightedSum = 0;
  for (const edge of edges) {
    const peerId = edge.source_entity_id === entityId
      ? edge.target_entity_id
      : edge.source_entity_id;

    // Use peer's current salience_avg as proxy for "previous tick"
    const peer = db
      .query("SELECT salience_avg FROM memory_entities WHERE id = ?")
      .get(peerId) as { salience_avg: number } | null;

    weightedSum += edge.strength * (peer?.salience_avg ?? 0);
  }

  return weightedSum / edges.length; // Normalized
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
  const confidence = extracted.provisional ? "provisional" : "confirmed";
  db.query(
    `INSERT INTO memory_entities
      (id, chat_id, name, entity_type, aliases, first_seen_chunk_id, last_seen_chunk_id,
       first_seen_at, last_seen_at, mention_count, last_mention_timestamp,
       confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id, chatId, extracted.name, extracted.type,
    JSON.stringify(extracted.aliases),
    chunkId, chunkId, chunkTimestamp, chunkTimestamp,
    chunkTimestamp, confidence,
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
  // BUG 4: Update fact_extraction_status when facts are successfully added
  const newFactsAdded = trimmed.length > existing.length;
  db.query(
    `UPDATE memory_entities SET
      facts = ?,
      fact_extraction_status = CASE WHEN ? THEN 'ok' ELSE fact_extraction_status END,
      updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(trimmed), newFactsAdded ? 1 : 0, now, entityId);
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

/** Update last_mention_timestamp and recent_mention_count for an entity (IMP 2) */
export function updateEntityMentionTimestamp(entityId: string, timestamp: number): void {
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `UPDATE memory_entities SET
        last_mention_timestamp = ?,
        recent_mention_count = recent_mention_count + 1,
        updated_at = ?
       WHERE id = ?`,
    )
    .run(timestamp, now, entityId);
}

/**
 * Update fact extraction status on an entity (BUG 4).
 * Called after a fact extraction attempt to track success/failure.
 */
export function updateFactExtractionStatus(
  entityId: string,
  status: FactExtractionStatus,
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `UPDATE memory_entities SET
        fact_extraction_status = ?,
        fact_extraction_last_attempt = ?,
        updated_at = ?
       WHERE id = ?`,
    )
    .run(status, now, now, entityId);
}

/**
 * Get entities that need fact extraction (BUG 4).
 * Returns entities with salience > threshold and fact_extraction_status != 'ok'.
 * Also returns 'attempted_empty' entities that have been mentioned since last attempt.
 */
export function getEntitiesNeedingFactExtraction(
  chatId: string,
  salienceThreshold = 0.45,
  limit = 10,
): MemoryEntity[] {
  const rows = getDb()
    .query(
      `SELECT * FROM memory_entities
       WHERE chat_id = ? AND status != 'inactive'
         AND salience_avg > ?
         AND (
           fact_extraction_status = 'never'
           OR (fact_extraction_status = 'attempted_empty'
               AND last_mention_timestamp > COALESCE(fact_extraction_last_attempt, 0))
         )
       ORDER BY salience_avg DESC
       LIMIT ?`,
    )
    .all(chatId, salienceThreshold, limit) as MemoryEntityRow[];
  return rows.map(rowToEntity);
}

/**
 * Update salience breakdown for an entity (IMP 2).
 * Decomposes salience into mention, arc, and graph components.
 */
export function updateSalienceBreakdown(
  entityId: string,
  chatId: string,
): void {
  const db = getDb();
  const entity = getEntity(entityId);
  if (!entity) return;

  const now = Math.floor(Date.now() / 1000);

  // Mention component: recency-weighted mention frequency
  const mentionAge = entity.lastMentionTimestamp
    ? Math.max(0, now - entity.lastMentionTimestamp)
    : now;
  const mentionDecay = Math.exp(-0.01 * (mentionAge / 60));
  const mentionComponent = Math.min(1.0,
    (Math.log2(1 + entity.mentionCount) / 10) * mentionDecay,
  );

  // Arc component: from existing salience (approximation until arcs are fully tracked)
  // This will be the portion of salience not explained by mentions or graph
  const arcComponent = Math.max(0, entity.salienceAvg - mentionComponent * 0.5);

  // Graph component: single-hop weighted centrality
  const graphComponent = computeGraphCentrality(entityId, chatId);

  // Total: weighted sum
  const total = mentionComponent * 0.4 + arcComponent * 0.4 + graphComponent * 0.2;

  const breakdown: SalienceBreakdown = {
    mentionComponent,
    arcComponent,
    graphComponent,
    total,
  };

  db.query(
    `UPDATE memory_entities SET
      salience_breakdown = ?,
      salience_avg = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(breakdown), total, now, entityId);
}

/**
 * Merge duplicate edge pairs that resolve to the same canonical source/target.
 * Used during data migration. Sums evidence counts, weighted-average sentiment.
 */
export function mergeEdgePair(canonicalId: string, absorbedId: string): void {
  const db = getDb();
  const canonical = db.query("SELECT * FROM memory_relations WHERE id = ?").get(canonicalId) as MemoryRelationRow | null;
  const absorbed = db.query("SELECT * FROM memory_relations WHERE id = ?").get(absorbedId) as MemoryRelationRow | null;
  if (!canonical || !absorbed) return;

  const now = Math.floor(Date.now() / 1000);
  const canonicalEvidence = safeJsonArray(canonical.evidence_chunk_ids);
  const absorbedEvidence = safeJsonArray(absorbed.evidence_chunk_ids);
  const mergedEvidence = [...new Set([...canonicalEvidence, ...absorbedEvidence])];

  const newStrength = computeStrength(mergedEvidence.length);
  const canonicalWeight = canonicalEvidence.length;
  const absorbedWeight = absorbedEvidence.length;
  const totalWeight = canonicalWeight + absorbedWeight;
  const newSentiment = totalWeight > 0
    ? (canonical.sentiment * canonicalWeight + absorbed.sentiment * absorbedWeight) / totalWeight
    : canonical.sentiment;

  const canonicalArcIds = safeJsonArray(canonical.arc_ids);
  const absorbedArcIds = safeJsonArray(absorbed.arc_ids);
  const mergedArcIds = [...new Set([...canonicalArcIds, ...absorbedArcIds])];

  const existingLabelAliases = safeJsonArray(canonical.label_aliases);
  if (absorbed.relation_label && !existingLabelAliases.includes(absorbed.relation_label)) {
    existingLabelAliases.push(absorbed.relation_label);
  }

  const newDecayRate = computeEdgeDecayRate(newStrength);
  const newEdgeSalience = computeEdgeSalience(newStrength, newDecayRate, now);

  db.query(
    `UPDATE memory_relations SET
      evidence_chunk_ids = ?,
      strength = ?,
      sentiment = ?,
      arc_ids = ?,
      label_aliases = ?,
      decay_rate = ?,
      edge_salience = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(mergedEvidence), newStrength, newSentiment,
    JSON.stringify(mergedArcIds), JSON.stringify(existingLabelAliases),
    newDecayRate, newEdgeSalience, now, canonicalId,
  );

  // Mark absorbed edge as merged
  db.query(
    `UPDATE memory_relations SET
      canonical_edge_id = ?,
      merged_into = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(canonicalId, canonicalId, now, absorbedId);
}

/**
 * Run edge type consolidation for a chat (IMP 5).
 * Finds parallel edges between the same pair that should merge per TYPE_HIERARCHY.
 */
export function consolidateEdgeTypes(chatId: string): number {
  const relations = getAllRelationsUnfiltered(chatId);
  let mergeCount = 0;

  // Group by source→target pair
  const pairMap = new Map<string, MemoryRelation[]>();
  for (const rel of relations) {
    if (rel.mergedInto || rel.supersededBy) continue; // Skip already merged/superseded
    const key = `${rel.sourceEntityId}→${rel.targetEntityId}`;
    const group = pairMap.get(key) ?? [];
    group.push(rel);
    pairMap.set(key, group);
  }

  for (const [, edges] of pairMap) {
    if (edges.length < 2) continue;

    // Sort by evidence count descending (canonical = most evidence)
    edges.sort((a, b) => b.evidenceChunkIds.length - a.evidenceChunkIds.length);

    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        if (edges[j].mergedInto) continue;

        // Check subsumption first (e.g., lover subsumes ally)
        const hierI = TYPE_HIERARCHY[edges[i].relationType];
        if (hierI?.subsumes?.includes(edges[j].relationType)) {
          mergeEdgePair(edges[i].id, edges[j].id);
          edges[j] = { ...edges[j], mergedInto: edges[i].id } as MemoryRelation;
          mergeCount++;
          continue;
        }

        if (shouldMergeEdges(edges[i], edges[j])) {
          mergeEdgePair(edges[i].id, edges[j].id);
          edges[j] = { ...edges[j], mergedInto: edges[i].id } as MemoryRelation;
          mergeCount++;
        }
      }
    }
  }

  if (mergeCount > 0) {
    console.info(`[memory-cortex] Consolidated ${mergeCount} edge pairs for chat ${chatId}`);
  }
  return mergeCount;
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

/**
 * Create or reinforce a relationship between entities.
 *
 * BUG 1 fix: Resolves source/target through canonical resolver before any write.
 * BUG 2 fix: Uses logarithmic strength curve instead of linear 0.5 + 0.05.
 * BUG 3 fix: Detects and flags contradictions at write time.
 */
export function upsertRelation(
  chatId: string,
  rel: ExtractedRelationship,
  sourceEntityId: string,
  targetEntityId: string,
  chunkId: string,
  arcId?: string | null,
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // ── BUG 1: Canonical resolution for both endpoints ──
  const canonicalSourceId = resolveCanonicalId(sourceEntityId, chatId) ?? sourceEntityId;
  const canonicalTargetId = resolveCanonicalId(targetEntityId, chatId) ?? targetEntityId;

  // Check for existing relation of same type between canonical entities
  const existing = db
    .query(
      `SELECT * FROM memory_relations
       WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?
         AND merged_into IS NULL`,
    )
    .get(canonicalSourceId, canonicalTargetId, rel.type) as MemoryRelationRow | null;

  if (existing) {
    // Reinforce existing relation
    const evidenceIds = safeJsonArray(existing.evidence_chunk_ids);
    if (!evidenceIds.includes(chunkId)) {
      evidenceIds.push(chunkId);
    }

    // ── BUG 2: Logarithmic strength from evidence count ──
    const newStrength = computeStrength(evidenceIds.length);
    const newSentiment = existing.sentiment + (rel.sentiment - existing.sentiment) * 0.3;

    // Track arc provenance
    const existingArcIds = safeJsonArray(existing.arc_ids);
    if (arcId && !existingArcIds.includes(arcId)) {
      existingArcIds.push(arcId);
    }

    // ── IMP 1: Recompute decay rate ──
    const newDecayRate = computeEdgeDecayRate(newStrength);
    const newEdgeSalience = computeEdgeSalience(newStrength, newDecayRate, now);

    db.query(
      `UPDATE memory_relations SET
        relation_label = COALESCE(?, relation_label),
        strength = ?,
        sentiment = ?,
        evidence_chunk_ids = ?,
        last_reinforced_at = ?,
        last_evidence_timestamp = ?,
        arc_ids = ?,
        last_seen_arc_id = COALESCE(?, last_seen_arc_id),
        decay_rate = ?,
        edge_salience = ?,
        updated_at = ?
       WHERE id = ?`,
    ).run(
      rel.label || null, newStrength, newSentiment,
      JSON.stringify(evidenceIds), now, now,
      JSON.stringify(existingArcIds),
      arcId || null,
      newDecayRate, newEdgeSalience,
      now, existing.id,
    );
  } else {
    // ── BUG 3: Check for contradicting edges before creating ──
    // Look for ANY existing edge between these entities (any type) with opposing sentiment
    const opposingEdges = db
      .query(
        `SELECT * FROM memory_relations
         WHERE source_entity_id = ? AND target_entity_id = ?
           AND status = 'active' AND merged_into IS NULL AND superseded_by IS NULL`,
      )
      .all(canonicalSourceId, canonicalTargetId) as MemoryRelationRow[];

    let contradictionFlag: ContradictionFlag = "none";
    let contradictionPeerId: string | null = null;
    let sentimentRange: [number, number] | null = null;

    for (const opposing of opposingEdges) {
      if (Math.sign(opposing.sentiment) !== Math.sign(rel.sentiment) &&
          Math.abs(opposing.sentiment) >= 0.1 && Math.abs(rel.sentiment) >= 0.1) {
        const resolution = detectAndResolveContradiction(
          opposing,
          rel.sentiment,
          1, // New edge starts with 1 evidence
          arcId ?? null,
        );

        if (resolution.action === "mark_superseded") {
          // Newer supersedes older
          db.query(
            `UPDATE memory_relations SET
              contradiction_flag = 'temporal',
              superseded_by = ?
             WHERE id = ?`,
          ).run(crypto.randomUUID(), opposing.id); // Will be updated with the new edge's ID below
          contradictionFlag = "none"; // The new edge is canonical
        } else if (resolution.action === "mark_complex") {
          contradictionFlag = "complex";
          contradictionPeerId = opposing.id;
          sentimentRange = [
            Math.min(opposing.sentiment, rel.sentiment),
            Math.max(opposing.sentiment, rel.sentiment),
          ];
          // Also flag the existing edge
          db.query(
            `UPDATE memory_relations SET
              contradiction_flag = 'complex',
              sentiment_range = ?
             WHERE id = ?`,
          ).run(JSON.stringify(sentimentRange), opposing.id);
        } else if (resolution.action === "mark_suspect") {
          contradictionFlag = "suspect";
          contradictionPeerId = opposing.id;
        }
        break; // Handle first contradiction found
      }
    }

    // ── BUG 2: Initial strength from log curve (1 evidence = ~14%) ──
    const initialStrength = computeStrength(1);
    const initialDecayRate = computeEdgeDecayRate(initialStrength);
    const initialEdgeSalience = computeEdgeSalience(initialStrength, initialDecayRate, now);

    const newEdgeId = crypto.randomUUID();

    db.query(
      `INSERT INTO memory_relations
        (id, chat_id, source_entity_id, target_entity_id, relation_type, relation_label,
         strength, sentiment, evidence_chunk_ids, first_established_at, last_reinforced_at,
         last_evidence_timestamp, arc_ids, first_seen_arc_id, last_seen_arc_id,
         decay_rate, edge_salience,
         contradiction_flag, contradiction_peer_id, sentiment_range,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newEdgeId, chatId, canonicalSourceId, canonicalTargetId,
      rel.type, rel.label || null, initialStrength, rel.sentiment,
      JSON.stringify([chunkId]), now, now, now,
      JSON.stringify(arcId ? [arcId] : []),
      arcId || null, arcId || null,
      initialDecayRate, initialEdgeSalience,
      contradictionFlag, contradictionPeerId,
      sentimentRange ? JSON.stringify(sentimentRange) : null,
      now, now,
    );

    // If we superseded an existing edge, update its superseded_by with the actual new edge ID
    if (opposingEdges.length > 0) {
      for (const opposing of opposingEdges) {
        const oppRow = db.query("SELECT superseded_by FROM memory_relations WHERE id = ?").get(opposing.id) as any;
        if (oppRow?.superseded_by && oppRow.superseded_by !== newEdgeId) {
          db.query("UPDATE memory_relations SET superseded_by = ? WHERE id = ?").run(newEdgeId, opposing.id);
        }
      }
    }

    // Update contradiction_peer_id on the new edge pointing to existing
    if (contradictionPeerId) {
      db.query("UPDATE memory_relations SET contradiction_peer_id = ? WHERE id = ?")
        .run(newEdgeId, contradictionPeerId);
    }
  }
}

/** Get all relations for a chat (excludes superseded, suspect, and merged edges) */
export function getRelations(chatId: string): MemoryRelation[] {
  const rows = getDb()
    .query(
      `SELECT * FROM memory_relations
       WHERE chat_id = ? AND status = 'active'
         AND superseded_by IS NULL AND merged_into IS NULL
         AND contradiction_flag != 'suspect'
       ORDER BY edge_salience DESC, strength DESC`,
    )
    .all(chatId) as MemoryRelationRow[];
  return rows.map(rowToRelation);
}

/** Get all relations for a chat including superseded/suspect (for diagnostics) */
export function getAllRelationsUnfiltered(chatId: string): MemoryRelation[] {
  const rows = getDb()
    .query("SELECT * FROM memory_relations WHERE chat_id = ? ORDER BY strength DESC")
    .all(chatId) as MemoryRelationRow[];
  return rows.map(rowToRelation);
}

/** Get relations involving specific entity IDs (excludes superseded, suspect, merged) */
export function getRelationsForEntities(chatId: string, entityIds: string[]): MemoryRelation[] {
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = getDb()
    .query(
      `SELECT * FROM memory_relations
       WHERE chat_id = ? AND status = 'active'
         AND superseded_by IS NULL AND merged_into IS NULL
         AND contradiction_flag != 'suspect'
         AND (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))
       ORDER BY edge_salience DESC, strength DESC`,
    )
    .all(chatId, ...entityIds, ...entityIds) as MemoryRelationRow[];
  return rows.map(rowToRelation);
}

/** Get active edges for an entity (used by graph centrality computation) */
export function getActiveEdgesForEntity(chatId: string, entityId: string): MemoryRelation[] {
  const rows = getDb()
    .query(
      `SELECT * FROM memory_relations
       WHERE chat_id = ? AND status = 'active'
         AND superseded_by IS NULL AND merged_into IS NULL
         AND contradiction_flag NOT IN ('suspect')
         AND (source_entity_id = ? OR target_entity_id = ?)`,
    )
    .all(chatId, entityId, entityId) as MemoryRelationRow[];
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
  arcId?: string | null,
): string[] {
  const db = getDb();
  const entityIdMap = new Map<string, string>(); // name → entity ID

  const transaction = db.transaction(() => {
    // 1. Upsert entities and record mentions
    for (const ext of extractedEntities) {
      const entityId = upsertEntity(chatId, ext, chunkId, chunkTimestamp);
      entityIdMap.set(ext.name.toLowerCase(), entityId);

      // Also register aliases so canonical resolution can find them
      for (const alias of ext.aliases) {
        entityIdMap.set(alias.toLowerCase(), entityId);
      }

      // Record mention
      const excerpt = extractMentionExcerpt(ext.name, content);
      upsertMention(
        entityId, chunkId, chatId,
        ext.mentionRole ?? ext.role ?? "present",
        excerpt,
        0, // Sentiment from mentions will be refined later
      );

      // Update entity salience (with breakdown)
      updateEntitySalience(entityId, chunkSalience);

      // Update last_mention_timestamp and recent_mention_count
      updateEntityMentionTimestamp(entityId, chunkTimestamp);

      // Update emotional valence if tags present
      if (emotionalTags.length > 0) {
        const tagValues: Record<string, number> = {};
        for (const tag of emotionalTags) {
          tagValues[tag] = 1.0;
        }
        updateEntityEmotionalValence(entityId, tagValues);
      }
    }

    // 2. Upsert relationships — BUG 1 fix: resolve through canonical ID first
    for (const rel of extractedRelationships) {
      // Try canonical resolution first, then fall back to local map
      const sourceId = resolveCanonicalId(rel.source, chatId)
        ?? entityIdMap.get(rel.source.toLowerCase());
      const targetId = resolveCanonicalId(rel.target, chatId)
        ?? entityIdMap.get(rel.target.toLowerCase());

      // Both entities must resolve
      if (sourceId && targetId) {
        upsertRelation(chatId, rel, sourceId, targetId, chunkId, arcId);
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
  // Relations with low edge salience and only 1 evidence chunk that haven't
  // been reinforced recently are likely noise. Also prune merged edges.
  const relationStaleThreshold = now - (staleAfterMessages * 120); // 2x the entity threshold
  db.query(
    `DELETE FROM memory_relations
     WHERE chat_id = ? AND strength < 0.3
       AND json_array_length(evidence_chunk_ids) <= 1
       AND last_reinforced_at < ?
       AND contradiction_flag != 'complex'`,
  ).run(chatId, relationStaleThreshold);

  // Clean up merged edges that are old
  db.query(
    `DELETE FROM memory_relations
     WHERE chat_id = ? AND merged_into IS NOT NULL AND updated_at < ?`,
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

// ─── Data Migration Pass ──────────────────────────────────────
// One-time migration for existing data. Follows the exact sequence
// from CORTEX_PLAN.md steps 2-8.

export interface MigrationResult {
  edgesRekeyed: number;
  edgesMerged: number;
  strengthsRecomputed: number;
  contradictionsDetected: number;
  edgesConsolidated: number;
  factStatusBackfilled: number;
  salienceBreakdownsComputed: number;
}

/**
 * Run the full heuristics engine data migration pass for a chat.
 *
 * Migration order (from CORTEX_PLAN.md):
 *   2. Rekey existing edges through canonical resolver
 *   3. Recompute strength via log curve
 *   5. Run contradiction detection on all edge pairs
 *   6. Run edge type consolidation
 *   7. Backfill fact_extraction_status (handled by SQL migration 047)
 *   8. Compute salience breakdowns
 *
 * Safe to run multiple times — idempotent.
 */
export function runHeuristicsMigration(
  chatId: string,
  onProgress?: (step: string, count: number) => void,
): MigrationResult {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result: MigrationResult = {
    edgesRekeyed: 0,
    edgesMerged: 0,
    strengthsRecomputed: 0,
    contradictionsDetected: 0,
    edgesConsolidated: 0,
    factStatusBackfilled: 0,
    salienceBreakdownsComputed: 0,
  };

  console.info(`[memory-cortex] Starting heuristics migration for chat ${chatId}`);

  // ── Step 2: Rekey edges through canonical resolver ──
  const allEdges = db
    .query("SELECT * FROM memory_relations WHERE chat_id = ?")
    .all(chatId) as MemoryRelationRow[];

  for (const edge of allEdges) {
    const canonicalSource = resolveCanonicalId(edge.source_entity_id, chatId);
    const canonicalTarget = resolveCanonicalId(edge.target_entity_id, chatId);

    if (canonicalSource && canonicalTarget &&
        (canonicalSource !== edge.source_entity_id || canonicalTarget !== edge.target_entity_id)) {
      // Check if an edge already exists at the canonical pair+type
      const existingCanonical = db
        .query(
          `SELECT id FROM memory_relations
           WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ? AND id != ?`,
        )
        .get(canonicalSource, canonicalTarget, edge.relation_type, edge.id) as { id: string } | null;

      if (existingCanonical) {
        // Merge into existing canonical edge
        mergeEdgePair(existingCanonical.id, edge.id);
        result.edgesMerged++;
      } else {
        // Rekey to canonical IDs
        db.query(
          `UPDATE memory_relations SET source_entity_id = ?, target_entity_id = ?, updated_at = ? WHERE id = ?`,
        ).run(canonicalSource, canonicalTarget, now, edge.id);
      }
      result.edgesRekeyed++;
    }
  }
  onProgress?.("rekey", result.edgesRekeyed);

  // ── Step 3: Recompute strength via log curve ──
  const activeEdges = db
    .query("SELECT id, evidence_chunk_ids, last_reinforced_at FROM memory_relations WHERE chat_id = ? AND merged_into IS NULL")
    .all(chatId) as Array<{ id: string; evidence_chunk_ids: string; last_reinforced_at: number | null }>;

  for (const edge of activeEdges) {
    const evidenceCount = safeJsonArray(edge.evidence_chunk_ids).length;
    const newStrength = computeStrength(evidenceCount);
    const lastEvidence = edge.last_reinforced_at ?? now;
    const newDecayRate = computeEdgeDecayRate(newStrength);
    const newEdgeSalience = computeEdgeSalience(newStrength, newDecayRate, lastEvidence, now);

    db.query(
      `UPDATE memory_relations SET
        strength = ?, decay_rate = ?, edge_salience = ?,
        last_evidence_timestamp = COALESCE(last_evidence_timestamp, ?),
        updated_at = ?
       WHERE id = ?`,
    ).run(newStrength, newDecayRate, newEdgeSalience, lastEvidence, now, edge.id);
    result.strengthsRecomputed++;
  }
  onProgress?.("strength", result.strengthsRecomputed);

  // ── Step 5: Run contradiction detection ──
  // Group edges by source→target pair
  const pairMap = new Map<string, MemoryRelationRow[]>();
  const freshEdges = db
    .query("SELECT * FROM memory_relations WHERE chat_id = ? AND merged_into IS NULL AND superseded_by IS NULL")
    .all(chatId) as MemoryRelationRow[];

  for (const edge of freshEdges) {
    const key = `${edge.source_entity_id}→${edge.target_entity_id}`;
    const group = pairMap.get(key) ?? [];
    group.push(edge);
    pairMap.set(key, group);
  }

  for (const [, edges] of pairMap) {
    if (edges.length < 2) continue;
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        if (Math.sign(edges[i].sentiment) !== Math.sign(edges[j].sentiment) &&
            Math.abs(edges[i].sentiment) >= 0.1 && Math.abs(edges[j].sentiment) >= 0.1) {
          const evI = safeJsonArray(edges[i].evidence_chunk_ids).length;
          const evJ = safeJsonArray(edges[j].evidence_chunk_ids).length;

          if (evI >= 3 && evJ >= 3) {
            // Complex relationship
            const range: [number, number] = [
              Math.min(edges[i].sentiment, edges[j].sentiment),
              Math.max(edges[i].sentiment, edges[j].sentiment),
            ];
            db.query(
              `UPDATE memory_relations SET
                contradiction_flag = 'complex',
                contradiction_peer_id = ?,
                sentiment_range = ?
               WHERE id = ?`,
            ).run(edges[j].id, JSON.stringify(range), edges[i].id);
            db.query(
              `UPDATE memory_relations SET
                contradiction_flag = 'complex',
                contradiction_peer_id = ?,
                sentiment_range = ?
               WHERE id = ?`,
            ).run(edges[i].id, JSON.stringify(range), edges[j].id);
          } else {
            // Suspect: weaker edge is suspect
            const [stronger, weaker] = evI >= evJ ? [edges[i], edges[j]] : [edges[j], edges[i]];
            db.query(
              `UPDATE memory_relations SET contradiction_flag = 'suspect', contradiction_peer_id = ? WHERE id = ?`,
            ).run(stronger.id, weaker.id);
          }
          result.contradictionsDetected++;
        }
      }
    }
  }
  onProgress?.("contradictions", result.contradictionsDetected);

  // ── Step 6: Edge type consolidation ──
  result.edgesConsolidated = consolidateEdgeTypes(chatId);
  onProgress?.("consolidation", result.edgesConsolidated);

  // ── Step 8: Compute salience breakdowns ──
  const entities = db
    .query("SELECT id FROM memory_entities WHERE chat_id = ? AND status != 'inactive'")
    .all(chatId) as Array<{ id: string }>;

  for (const { id } of entities) {
    updateSalienceBreakdown(id, chatId);
    result.salienceBreakdownsComputed++;
  }
  onProgress?.("salience", result.salienceBreakdownsComputed);

  console.info(
    `[memory-cortex] Migration complete: ${result.edgesRekeyed} rekeyed, ${result.strengthsRecomputed} recomputed, ` +
    `${result.contradictionsDetected} contradictions, ${result.edgesConsolidated} consolidated, ` +
    `${result.salienceBreakdownsComputed} salience breakdowns`,
  );

  return result;
}

/**
 * Promote provisional entities that have appeared in >= corroborationThreshold chunks.
 * Decay provisional entities that haven't been corroborated after maxAge chunks.
 * Called during Phase 1 processing.
 */
export function processProvisionalEntities(
  chatId: string,
  corroborationThreshold = 2,
  maxAge = 50,
): { promoted: number; decayed: number } {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let promoted = 0;
  let decayed = 0;

  // Promote provisional entities with enough mentions
  const toPromote = db
    .query(
      `UPDATE memory_entities SET confidence = 'confirmed', updated_at = ?
       WHERE chat_id = ? AND confidence = 'provisional' AND mention_count >= ?`,
    )
    .run(now, chatId, corroborationThreshold);
  promoted = toPromote.changes;

  // Decay old provisional entities that were never corroborated
  const totalChunks = db
    .query("SELECT COUNT(*) as c FROM chat_chunks WHERE chat_id = ?")
    .get(chatId) as any;
  const chunkCount = totalChunks?.c ?? 0;

  if (chunkCount > maxAge) {
    const staleProvisional = db
      .query(
        `DELETE FROM memory_entities
         WHERE chat_id = ? AND confidence = 'provisional'
           AND mention_count < ?
           AND created_at < ?`,
      )
      .run(chatId, corroborationThreshold, now - (maxAge * 60));
    decayed = staleProvisional.changes;
  }

  return { promoted, decayed };
}
