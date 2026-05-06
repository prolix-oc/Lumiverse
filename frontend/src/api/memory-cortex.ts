import { get, put, post, del, patch } from "./client";

// ─── Types ─────────────────────────────────────────────────────

export interface CortexConfig {
  enabled: boolean;
  autoWarmup: boolean;
  presetMode: "simple" | "standard" | "advanced" | null;
  entityTracking: boolean;
  entityExtractionMode: "heuristic" | "sidecar" | "off";
  thoughtMarkers: {
    prefix: string;
    suffix: string;
  };
  salienceScoring: boolean;
  salienceScoringMode: "heuristic" | "sidecar";
  sidecar: {
    connectionProfileId: string | null;
    model: string | null;
    temperature: number;
    topP: number;
    maxTokens: number;
    chunkBatchSize: number;
    rebuildConcurrency: number;
    requestsPerMinute: number;
  };
  formatterMode: "shadow" | "attributed" | "clinical" | "minimal";
  useChatMemoryFormatting: boolean;
  contextTokenBudget: number;
  retrievalTimeoutMs: number;
  sidecarTimeoutMs: number;
  consolidation: {
    enabled: boolean;
    chunkThreshold: number;
    chunksPerConsolidation: number;
    arcThreshold: number;
    useSidecar: boolean;
    maxTokensPerSummary: number;
  };
  retrieval: {
    useFusedScoring: boolean;
    emotionalResonance: boolean;
    diversitySelection: boolean;
    entityContextInjection: boolean;
    relationshipInjection: boolean;
    arcInjection: boolean;
    maxEntitySnapshots: number;
    maxRelationships: number;
  };
  decay: {
    halfLifeTurns: number;
    reinforcementWeight: number;
    coreMemoryThreshold: number;
    coreMemoryFlags: string[];
  };
  entityPruning: {
    enabled: boolean;
    staleAfterMessages: number;
    minConfidence: number;
  };
  entityWhitelist: string[];
  entityExtractionFilters: Record<
    "character" | "location" | "item" | "faction" | "concept" | "event",
    {
      protectedTerms: string[];
      rejectedTerms: string[];
      cleanupPatterns: string[];
    }
  >;
}

export interface SalienceBreakdown {
  mentionComponent: number;
  arcComponent: number;
  graphComponent: number;
  total: number;
}

export interface CortexEntity {
  id: string;
  chatId: string;
  name: string;
  entityType: string;
  aliases: string[];
  description: string;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  mentionCount: number;
  salienceAvg: number;
  status: string;
  facts: string[];
  emotionalValence: Record<string, number>;
  // Heuristics engine fields
  factExtractionStatus: "never" | "attempted_empty" | "ok";
  factExtractionLastAttempt: number | null;
  salienceBreakdown: SalienceBreakdown;
  lastMentionTimestamp: number | null;
  recentMentionCount: number;
  confidence: "confirmed" | "provisional";
}

export interface CortexRelation {
  id: string;
  chatId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  relationLabel: string | null;
  strength: number;
  sentiment: number;
  evidenceChunkIds: string[];
  firstEstablishedAt: number | null;
  lastReinforcedAt: number | null;
  status: string;
  // Heuristics engine fields
  contradictionFlag: "none" | "temporal" | "complex" | "suspect";
  contradictionPeerId: string | null;
  sentimentRange: [number, number] | null;
  supersededBy: string | null;
  edgeSalience: number;
  decayRate: number;
  labelAliases: string[];
  mergedInto: string | null;
  // Enriched by route
  sourceName?: string;
  targetName?: string;
}

export interface CortexUsageStats {
  chunkCount: number;
  vectorizedChunkCount: number;
  entityCount: number;
  activeEntityCount: number;
  consolidationCount: number;
  salienceRecordCount: number;
  mentionCount: number;
  relationCount: number;
  estimatedEmbeddingCalls: number;
  ingestionTelemetry: CortexIngestionTelemetry;
}

export interface CortexIngestionTimings {
  mode: "heuristic" | "sidecar" | "mixed";
  fontMs: number;
  heuristicMs: number;
  heuristicSalienceMs: number;
  heuristicEntityMs: number;
  heuristicRelationshipMs: number;
  heuristicAliasMs: number;
  sidecarMs: number;
  graphMs: number;
  dbMs: number;
  totalMs: number;
  completedAt: number;
  chunkId: string;
}

export interface CortexIngestionTelemetry {
  samples: number;
  last: CortexIngestionTimings | null;
  averages: {
    fontMs: number;
    heuristicMs: number;
    sidecarMs: number;
    graphMs: number;
    dbMs: number;
    totalMs: number;
  };
}

export interface CortexIngestionStatus {
  chatId: string;
  status: "idle" | "processing" | "complete" | "error";
  phase: "queued" | "font" | "heuristics" | "sidecar" | "persisting" | "complete" | "error";
  chunkId: string | null;
  startedAt: number | null;
  updatedAt: number;
  pendingJobs: number;
  error?: string;
  timings?: CortexIngestionTimings | null;
}

export interface CortexHealthCheck {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  message: string;
}

export interface CortexProbeStatus {
  attempted: boolean;
  success: boolean | null;
  message: string;
  durationMs?: number | null;
  timedOut?: boolean;
  error?: string | null;
}

export interface CortexWarmupResponse {
  status: "started" | "complete" | "skipped";
  reason: string;
  chatId: string;
  chatMemory: {
    status: "started" | "complete" | "skipped";
    reason: string;
  };
  cortex: {
    status: "started" | "complete" | "skipped";
    reason: string;
  };
}

export interface CortexHealthReport {
  generatedAt: string;
  healthy: boolean;
  summary: {
    failures: number;
    warnings: number;
    passes: number;
    info: number;
  };
  config: {
    enabled: boolean;
    presetMode: "simple" | "standard" | "advanced" | null;
    formatterMode: "shadow" | "attributed" | "clinical" | "minimal";
    entityExtractionMode: "heuristic" | "sidecar" | "off";
    salienceScoringMode: "heuristic" | "sidecar";
    sidecarConnectionProfileId: string | null;
  };
  embeddings: {
    enabled: boolean;
    hasApiKey: boolean;
    vectorizeChatMessages: boolean;
    provider: string;
    model: string;
    dimensions: number | null;
    ready: boolean;
    connectivity: CortexProbeStatus & {
      dimension: number | null;
    };
  };
  sidecar: {
    required: boolean;
    configured: boolean;
    connectionProfileId: string | null;
    connectionName: string | null;
    provider: string | null;
    model: string | null;
    hasApiKey: boolean;
    ready: boolean;
    connectivity: CortexProbeStatus;
  };
  chat: {
    id: string;
    name: string | null;
    exists: boolean;
    messageCount: number;
    chunkCount: number;
    vectorizedChunkCount: number;
    pendingChunkCount: number;
    entityCount: number;
    activeEntityCount: number;
    relationCount: number;
    consolidationCount: number;
    rebuildStatus: {
      status: string;
      current?: number;
      total?: number;
      percent?: number;
      error?: string;
    };
  } | null;
  checks: CortexHealthCheck[];
}

// ─── Vault & Interlink Types ──────────────────────────────────

export interface CortexVault {
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

export interface CortexChatLink {
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

export interface CortexFontColor {
  id: string;
  chatId: string;
  entityId: string | null;
  characterName: string | null;
  entityName: string | null;
  displayName: string | null;
  hexColor: string;
  usageType: string;
  confidence: number;
  sampleCount: number;
  sampleExcerpt: string | null;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeFontColor(raw: any): CortexFontColor {
  const characterName = normalizeOptionalString(raw.characterName ?? raw.character_name);
  const entityName = normalizeOptionalString(raw.entityName ?? raw.entity_name);

  return {
    id: String(raw.id),
    chatId: String(raw.chatId ?? raw.chat_id ?? ""),
    entityId: raw.entityId ?? raw.entity_id ?? null,
    characterName,
    entityName,
    displayName: characterName || entityName,
    hexColor: String(raw.hexColor ?? raw.hex_color ?? ""),
    usageType: String(raw.usageType ?? raw.usage_type ?? "unknown"),
    confidence: Number(raw.confidence ?? 0),
    sampleCount: Number(raw.sampleCount ?? raw.sample_count ?? 0),
    sampleExcerpt: raw.sampleExcerpt ?? raw.sample_excerpt ?? null,
  };
}

// ─── API ───────────────────────────────────────────────────────

const BASE = "/memory-cortex";

export const memoryCortexApi = {
  // Config
  getConfig: () => get<CortexConfig>(`${BASE}/config`),
  updateConfig: (data: Partial<CortexConfig>) => put<CortexConfig>(`${BASE}/config`, data),
  applyPreset: (mode: string) => post<CortexConfig>(`${BASE}/config/preset`, { mode }),
  getHealth: (options?: { chatId?: string; probeConnectivity?: boolean }) =>
    get<CortexHealthReport>(`${BASE}/health`, {
      chatId: options?.chatId,
      probeConnectivity: options?.probeConnectivity ? "1" : undefined,
    }),

  // Entities
  getEntities: (chatId: string, status?: string) =>
    get<{ data: CortexEntity[]; total: number }>(`${BASE}/chats/${chatId}/entities`, status ? { status } : undefined),
  updateEntity: (chatId: string, entityId: string, data: Partial<CortexEntity>) =>
    put<CortexEntity>(`${BASE}/chats/${chatId}/entities/${entityId}`, data),
  deleteEntity: (chatId: string, entityId: string) =>
    del<{ success: boolean }>(`${BASE}/chats/${chatId}/entities/${entityId}`),
  mergeEntities: (chatId: string, sourceId: string, targetId: string) =>
    post<CortexEntity>(`${BASE}/chats/${chatId}/entities/merge`, { sourceId, targetId }),

  // Font Colors
  getColors: async (chatId: string): Promise<{ data: CortexFontColor[]; total: number }> => {
    const res = await get<{ data: any[]; total: number }>(`${BASE}/chats/${chatId}/colors`);
    return {
      ...res,
      data: res.data.map(normalizeFontColor),
    };
  },
  deleteColor: (chatId: string, colorId: string) =>
    del<{ success: boolean }>(`${BASE}/chats/${chatId}/colors/${colorId}`),

  // Relations
  getRelations: (chatId: string) =>
    get<{ data: CortexRelation[]; total: number }>(`${BASE}/chats/${chatId}/relations`),
  getAllRelations: (chatId: string) =>
    get<{ data: CortexRelation[]; total: number }>(`${BASE}/chats/${chatId}/relations/all`),

  // Heuristics engine
  migrateHeuristics: (chatId: string) =>
    post<{ status: string; edgesRekeyed: number; strengthsRecomputed: number; contradictionsDetected: number; edgesConsolidated: number; salienceBreakdownsComputed: number }>(`${BASE}/chats/${chatId}/migrate-heuristics`),
  getEntitiesNeedingFacts: (chatId: string) =>
    get<{ data: CortexEntity[]; total: number }>(`${BASE}/chats/${chatId}/entities/needs-facts`),

  // Consolidations
  getConsolidations: (chatId: string, tier?: number) =>
    get<{ data: any[]; total: number }>(`${BASE}/chats/${chatId}/consolidations`, tier != null ? { tier } : undefined),

  // Chunks
  getChunks: (chatId: string, limit = 50, offset = 0) =>
    get<{ data: any[]; total: number }>(`${BASE}/chats/${chatId}/chunks`, { limit, offset }),

  // Salience
  getSalience: (chatId: string, limit = 50, offset = 0) =>
    get<{ data: any[]; total: number }>(`${BASE}/chats/${chatId}/salience`, { limit, offset }),

  // Stats
  getStats: (chatId: string) => get<CortexUsageStats>(`${BASE}/chats/${chatId}/cortex-stats`),

  // Rebuild
  rebuild: (chatId: string) =>
    post<{ status: string; chatId: string }>(`${BASE}/chats/${chatId}/rebuild`),
  getRebuildStatus: (chatId: string) =>
    get<{ status: string; current?: number; total?: number; percent?: number; result?: any; error?: string }>(`${BASE}/chats/${chatId}/rebuild-status`),
  getIngestionStatus: (chatId: string) =>
    get<CortexIngestionStatus>(`${BASE}/chats/${chatId}/ingestion-status`),
  warm: (chatId: string, options?: { force?: boolean }) =>
    post<CortexWarmupResponse>(`${BASE}/chats/${chatId}/warm`, options?.force ? { force: true } : {}),

  // Vaults
  createVault: (chatId: string, name: string, description?: string) =>
    post<CortexVault>(`${BASE}/vaults`, { chatId, name, description }),
  listVaults: () =>
    get<{ data: CortexVault[] }>(`${BASE}/vaults`),
  getVault: (vaultId: string) =>
    get<{ vault: CortexVault; entities: any[]; relations: any[] }>(`${BASE}/vaults/${vaultId}`),
  renameVault: (vaultId: string, name: string) =>
    put<{ success: boolean }>(`${BASE}/vaults/${vaultId}`, { name }),
  deleteVault: (vaultId: string) =>
    del<{ success: boolean }>(`${BASE}/vaults/${vaultId}`),

  // Chat Links
  getChatLinks: (chatId: string) =>
    get<{ data: CortexChatLink[] }>(`${BASE}/chats/${chatId}/links`),
  attachLink: (chatId: string, body: {
    linkType: "vault" | "interlink";
    vaultId?: string;
    targetChatId?: string;
    label?: string;
    bidirectional?: boolean;
  }) =>
    post<{ data: CortexChatLink[] }>(`${BASE}/chats/${chatId}/links`, body),
  toggleLink: (chatId: string, linkId: string, enabled: boolean) =>
    patch<{ success: boolean }>(`${BASE}/chats/${chatId}/links/${linkId}`, { enabled }),
  removeLink: (chatId: string, linkId: string) =>
    del<{ success: boolean }>(`${BASE}/chats/${chatId}/links/${linkId}`),
};
