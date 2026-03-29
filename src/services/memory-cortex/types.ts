/**
 * Memory Cortex — Type definitions for the hybrid memory architecture.
 *
 * All entity, salience, relationship, consolidation, and retrieval types
 * live here. SQLite row shapes use snake_case; service-layer DTOs use camelCase.
 */

// ─── Entity Types ──────────────────────────────────────────────

export type EntityType = "character" | "location" | "item" | "faction" | "concept" | "event";
export type EntityStatus = "active" | "inactive" | "deceased" | "destroyed" | "unknown";
export type MentionRole = "subject" | "object" | "present" | "referenced" | "absent";
export type RelationType =
  | "ally"
  | "enemy"
  | "lover"
  | "parent"
  | "child"
  | "sibling"
  | "mentor"
  | "rival"
  | "owns"
  | "member_of"
  | "located_in"
  | "fears"
  | "serves"
  | "custom";
export type RelationStatus = "active" | "broken" | "dormant" | "former";
export type ContradictionFlag = "none" | "temporal" | "complex" | "suspect";
export type FactExtractionStatus = "never" | "attempted_empty" | "ok";
export type EntityConfidence = "confirmed" | "provisional";

/** SQLite row shape for memory_entities */
export interface MemoryEntityRow {
  id: string;
  chat_id: string;
  name: string;
  entity_type: string;
  aliases: string; // JSON array
  description: string;
  first_seen_chunk_id: string | null;
  last_seen_chunk_id: string | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
  mention_count: number;
  salience_avg: number;
  status: string;
  status_changed_at: number | null;
  facts: string; // JSON array
  emotional_valence: string; // JSON object
  metadata: string; // JSON object
  created_at: number;
  updated_at: number;
  // Heuristics engine additions
  fact_extraction_status: string; // FactExtractionStatus
  fact_extraction_last_attempt: number | null;
  salience_breakdown: string; // JSON: SalienceBreakdown
  last_mention_timestamp: number | null;
  recent_mention_count: number;
  confidence: string; // EntityConfidence
}

/** Salience breakdown — decomposed salience inputs for transparent scoring */
export interface SalienceBreakdown {
  mentionComponent: number;
  arcComponent: number;
  graphComponent: number;
  total: number;
}

/** Service-layer entity DTO */
export interface MemoryEntity {
  id: string;
  chatId: string;
  name: string;
  entityType: EntityType;
  aliases: string[];
  description: string;
  firstSeenChunkId: string | null;
  lastSeenChunkId: string | null;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  mentionCount: number;
  salienceAvg: number;
  status: EntityStatus;
  statusChangedAt: number | null;
  facts: string[];
  emotionalValence: Record<string, number>;
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  // Heuristics engine additions
  factExtractionStatus: FactExtractionStatus;
  factExtractionLastAttempt: number | null;
  salienceBreakdown: SalienceBreakdown;
  lastMentionTimestamp: number | null;
  recentMentionCount: number;
  confidence: EntityConfidence;
}

/** SQLite row shape for memory_mentions */
export interface MemoryMentionRow {
  id: string;
  entity_id: string;
  chunk_id: string;
  chat_id: string;
  role: string;
  excerpt: string | null;
  sentiment: number;
  created_at: number;
}

/** Service-layer mention DTO */
export interface MemoryMention {
  id: string;
  entityId: string;
  chunkId: string;
  chatId: string;
  role: MentionRole;
  excerpt: string | null;
  sentiment: number;
  createdAt: number;
}

/** SQLite row shape for memory_relations */
export interface MemoryRelationRow {
  id: string;
  chat_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  relation_label: string | null;
  strength: number;
  sentiment: number;
  evidence_chunk_ids: string; // JSON array
  first_established_at: number | null;
  last_reinforced_at: number | null;
  status: string;
  metadata: string; // JSON object
  created_at: number;
  updated_at: number;
  // Heuristics engine additions
  contradiction_flag: string; // ContradictionFlag
  contradiction_peer_id: string | null;
  sentiment_range: string | null; // JSON: [float, float]
  superseded_by: string | null;
  arc_ids: string; // JSON array
  first_seen_arc_id: string | null;
  last_seen_arc_id: string | null;
  last_evidence_timestamp: number | null;
  decay_rate: number;
  edge_salience: number;
  label_aliases: string; // JSON array
  canonical_edge_id: string | null;
  merged_into: string | null;
}

/** Service-layer relation DTO */
export interface MemoryRelation {
  id: string;
  chatId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: RelationType;
  relationLabel: string | null;
  strength: number;
  sentiment: number;
  evidenceChunkIds: string[];
  firstEstablishedAt: number | null;
  lastReinforcedAt: number | null;
  status: RelationStatus;
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  // Heuristics engine additions
  contradictionFlag: ContradictionFlag;
  contradictionPeerId: string | null;
  sentimentRange: [number, number] | null;
  supersededBy: string | null;
  arcIds: string[];
  firstSeenArcId: string | null;
  lastSeenArcId: string | null;
  lastEvidenceTimestamp: number | null;
  decayRate: number;
  edgeSalience: number;
  labelAliases: string[];
  canonicalEdgeId: string | null;
  mergedInto: string | null;
}

// ─── Salience Types ────────────────────────────────────────────

export type SalienceSource = "heuristic" | "sidecar";

export type EmotionalTag =
  | "grief"
  | "joy"
  | "tension"
  | "dread"
  | "intimacy"
  | "betrayal"
  | "revelation"
  | "resolve"
  | "humor"
  | "melancholy"
  | "awe"
  | "fury";

export type NarrativeFlag =
  | "first_meeting"
  | "death"
  | "promise"
  | "confession"
  | "departure"
  | "transformation"
  | "battle"
  | "discovery"
  | "reunion"
  | "loss";

export interface StatusChange {
  entity: string;
  change: string;
  detail: string;
}

/** SQLite row shape for memory_salience */
export interface MemorySalienceRow {
  id: string;
  chunk_id: string;
  chat_id: string;
  score: number;
  score_source: string;
  emotional_tags: string; // JSON array
  status_changes: string; // JSON array
  narrative_flags: string; // JSON array
  has_dialogue: number;
  has_action: number;
  has_internal_thought: number;
  word_count: number;
  scored_at: number;
  scored_by: string | null;
  created_at: number;
}

/** Service-layer salience result */
export interface SalienceResult {
  score: number;
  source: SalienceSource;
  emotionalTags: EmotionalTag[];
  statusChanges: StatusChange[];
  narrativeFlags: NarrativeFlag[];
  hasDialogue: boolean;
  hasAction: boolean;
  hasInternalThought: boolean;
  wordCount: number;
}

// ─── Consolidation Types ───────────────────────────────────────

/** SQLite row shape for memory_consolidations */
export interface MemoryConsolidationRow {
  id: string;
  chat_id: string;
  tier: number;
  title: string | null;
  summary: string;
  source_chunk_ids: string; // JSON array
  source_consolidation_ids: string; // JSON array
  entity_ids: string; // JSON array
  message_range_start: number | null;
  message_range_end: number | null;
  time_range_start: number | null;
  time_range_end: number | null;
  salience_avg: number;
  emotional_tags: string; // JSON array
  token_count: number;
  vectorized_at: number | null;
  vector_model: string | null;
  created_at: number;
  updated_at: number;
}

/** Service-layer consolidation DTO */
export interface MemoryConsolidation {
  id: string;
  chatId: string;
  tier: number;
  title: string | null;
  summary: string;
  sourceChunkIds: string[];
  sourceConsolidationIds: string[];
  entityIds: string[];
  messageRangeStart: number | null;
  messageRangeEnd: number | null;
  timeRangeStart: number | null;
  timeRangeEnd: number | null;
  salienceAvg: number;
  emotionalTags: EmotionalTag[];
  tokenCount: number;
  vectorizedAt: number | null;
  vectorModel: string | null;
  createdAt: number;
  updatedAt: number;
}

// ─── Extraction Types (from sidecar) ──────────────────────────

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  aliases: string[];
  confidence: number;
  role?: MentionRole;
  /** Provisional entities from NP chunker need corroboration before promotion */
  provisional?: boolean;
}

/** Result from the NP chunker (Phase 1 only) */
export interface NPCandidate {
  text: string;
  isSubjectPosition: boolean;
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  type: RelationType;
  label: string;
  sentiment: number;
}

export interface SidecarFontColor {
  hexColor: string;
  characterName: string;
  usageType: "speech" | "thought" | "narration";
}

export interface SidecarExtractionResult {
  score: number;
  emotionalTags: EmotionalTag[];
  narrativeFlags: NarrativeFlag[];
  statusChanges: StatusChange[];
  keyFacts: string[];
  entitiesPresent: ExtractedEntity[];
  relationshipsShown: ExtractedRelationship[];
  fontColors: SidecarFontColor[];
}

// ─── Retrieval Types ───────────────────────────────────────────

export interface CortexQuery {
  chatId: string;
  userId: string;
  queryText: string;
  entityFilter?: string[];
  timeRange?: { start?: number; end?: number };
  emotionalContext?: EmotionalTag[];
  generationType: string;
  topK: number;
  includeConsolidations: boolean;
  includeRelationships: boolean;
  /** Message IDs to exclude from retrieval (e.g., regeneration target) */
  excludeMessageIds?: string[];
}

export interface CortexMemory {
  source: "chunk" | "consolidation";
  sourceId: string;
  content: string;
  finalScore: number;
  components: {
    semantic: number;
    salience: number;
    recency: number;
    reinforcement: number;
    emotional: number;
    entity: number;
  };
  emotionalTags: EmotionalTag[];
  entityNames: string[];
  messageRange: [number, number];
  timeRange: [number, number];
}

export interface EntitySnapshot {
  id: string;
  name: string;
  type: EntityType;
  status: EntityStatus;
  description: string;
  lastSeenAt: number | null;
  mentionCount: number;
  topFacts: string[];
  emotionalProfile: Record<string, number>;
  relationships: Array<{
    targetName: string;
    type: RelationType;
    label: string | null;
    strength: number;
    sentiment: number;
  }>;
}

export interface RelationEdge {
  sourceName: string;
  targetName: string;
  type: RelationType;
  label: string | null;
  strength: number;
  sentiment: number;
}

export interface CortexStats {
  candidatePoolSize: number;
  vectorSearchResults: number;
  entitiesMatched: number;
  scoreFusionApplied: boolean;
  topScore: number;
  retrievalTimeMs: number;
}

export interface CortexResult {
  memories: CortexMemory[];
  entityContext: EntitySnapshot[];
  activeRelationships: RelationEdge[];
  arcContext: string | null;
  stats: CortexStats;
}

// ─── Ingestion Pipeline Types ──────────────────────────────────

/** Data produced during chunk ingestion for cortex processing */
export interface ChunkIngestionData {
  chunkId: string;
  chatId: string;
  userId: string;
  content: string;
  messageIds: string[];
  startMessageIndex: number;
  endMessageIndex: number;
  createdAt: number;
}
