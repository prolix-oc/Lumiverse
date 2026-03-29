import { get, put, post, del } from "./client";

// ─── Types ─────────────────────────────────────────────────────

export interface CortexConfig {
  enabled: boolean;
  presetMode: "simple" | "standard" | "advanced" | null;
  entityTracking: boolean;
  entityExtractionMode: "heuristic" | "sidecar" | "off";
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
  };
  formatterMode: "shadow" | "attributed" | "clinical" | "minimal";
  contextTokenBudget: number;
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
}

export interface CortexHealthCheck {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  message: string;
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
    connectivity: {
      attempted: boolean;
      success: boolean | null;
      message: string;
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
    connectivity: {
      attempted: boolean;
      success: boolean | null;
      message: string;
    };
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
  getColors: (chatId: string) =>
    get<{ data: any[]; total: number }>(`${BASE}/chats/${chatId}/colors`),
  deleteColor: (chatId: string, colorId: string) =>
    del<{ success: boolean }>(`${BASE}/chats/${chatId}/colors/${colorId}`),

  // Relations
  getRelations: (chatId: string) =>
    get<{ data: any[]; total: number }>(`${BASE}/chats/${chatId}/relations`),

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
};
