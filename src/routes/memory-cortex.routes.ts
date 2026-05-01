/**
 * Memory Cortex API routes.
 *
 * Provides endpoints for:
 *   - Configuration CRUD and preset application
 *   - Entity graph browsing and management
 *   - Relationship viewing
 *   - Usage statistics
 *   - Cortex rebuild trigger
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/connection";
import { getProvider } from "../llm/registry";
import * as chatsSvc from "../services/chats.service";
import * as connectionsSvc from "../services/connections.service";
import * as embeddingsSvc from "../services/embeddings.service";
import * as memoryCortex from "../services/memory-cortex";
import * as vectorizationQueue from "../services/vectorization-queue.service";
import { ChatLinkError } from "../services/memory-cortex/vault";
import { getCharacter } from "../services/characters.service";
import { getChat } from "../services/chats.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const app = new Hono();

/**
 * Ownership gate: returns the chat if the caller owns it, otherwise emits a 404
 * Response that the route handler must return immediately. Memory-cortex service
 * functions take chatId without a userId scope, so EVERY :chatId route must
 * check ownership here before touching cortex data.
 */
function ensureChatOwnership(c: Context, chatId: string):
  | { ok: true; userId: string }
  | { ok: false; response: Response } {
  const userId = c.get("userId");
  const chat = getChat(userId, chatId);
  if (!chat) return { ok: false, response: c.json({ error: "Chat not found" }, 404) };
  return { ok: true, userId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

async function resolveCortexParticipants(userId: string, chat: ReturnType<typeof getChat>) {
  const characterNames: string[] = [];
  const aliasMaps: Map<string, string>[] = [];

  if (!chat) return { characterNames, descriptionAliases: undefined as Map<string, string> | undefined };

  const character = getCharacter(userId, chat.character_id);
  if (character) {
    const normalized = memoryCortex.normalizeCharacterName(character.name);
    characterNames.push(normalized);
    aliasMaps.push(memoryCortex.extractDescriptionAliases(normalized, character.description, character.personality, character.scenario));
  }

  if (chat.metadata?.character_ids) {
    for (const cid of chat.metadata.character_ids as string[]) {
      const ch = getCharacter(userId, cid);
      if (!ch) continue;
      const normalized = memoryCortex.normalizeCharacterName(ch.name);
      if (!characterNames.includes(normalized)) {
        characterNames.push(normalized);
        aliasMaps.push(memoryCortex.extractDescriptionAliases(normalized, ch.description, ch.personality));
      }
    }
  }

  try {
    const { resolvePersonaOrDefault } = require("../services/personas.service");
    const persona = resolvePersonaOrDefault(userId);
    if (persona?.name) {
      const normalized = memoryCortex.normalizeCharacterName(persona.name);
      if (!characterNames.includes(normalized)) {
        characterNames.push(normalized);
        aliasMaps.push(memoryCortex.extractDescriptionAliases(normalized, persona.description));
      }
    }
  } catch { /* non-fatal */ }

  const descriptionAliases = memoryCortex.mergeDescriptionAliases(...aliasMaps);
  return {
    characterNames,
    descriptionAliases: descriptionAliases.size > 0 ? descriptionAliases : undefined,
  };
}

type CortexGenerateRawFn = (opts: {
  connectionId: string;
  messages: Array<{ role: string; content: string }>;
  parameters: Record<string, any>;
  tools?: any[];
  signal?: AbortSignal;
}) => Promise<{ content: string; tool_calls?: any[] }>;

interface CortexFreshnessSnapshot {
  ltcmConfigHash: string | null;
  rebuildSignature: string;
  sourceChunkCount: number;
  sourceChunkUpdatedAt: number;
}

interface StoredCortexFreshnessSnapshot extends CortexFreshnessSnapshot {
  completedAt: number;
}

interface WarmupComponentResult {
  status: "started" | "complete" | "skipped";
  reason: string;
}

interface WarmupResponse {
  status: "started" | "complete" | "skipped";
  reason: string;
  chatId: string;
  chatMemory: WarmupComponentResult;
  cortex: WarmupComponentResult;
}

function getChunkFreshnessSnapshot(chatId: string): Pick<CortexFreshnessSnapshot, "sourceChunkCount" | "sourceChunkUpdatedAt"> {
  const row = getDb()
    .query("SELECT COUNT(*) as chunkCount, MAX(updated_at) as maxUpdatedAt FROM chat_chunks WHERE chat_id = ?")
    .get(chatId) as { chunkCount?: number; maxUpdatedAt?: number | null } | null;

  return {
    sourceChunkCount: row?.chunkCount ?? 0,
    sourceChunkUpdatedAt: row?.maxUpdatedAt ?? 0,
  };
}

function parseStoredCortexFreshness(chat: ReturnType<typeof getChat>): StoredCortexFreshnessSnapshot | null {
  const raw = chat?.metadata?.cortex_rebuild_state;
  if (!isRecord(raw)) return null;

  const rebuildSignature = optionalTrimmedString(raw.rebuildSignature);
  if (!rebuildSignature) return null;

  return {
    ltcmConfigHash: typeof raw.ltcmConfigHash === "string" ? raw.ltcmConfigHash : null,
    rebuildSignature,
    sourceChunkCount: typeof raw.sourceChunkCount === "number" ? raw.sourceChunkCount : -1,
    sourceChunkUpdatedAt: typeof raw.sourceChunkUpdatedAt === "number" ? raw.sourceChunkUpdatedAt : -1,
    completedAt: typeof raw.completedAt === "number" ? raw.completedAt : 0,
  };
}

function getStoredChatMemoryHash(chat: ReturnType<typeof getChat>): string | null {
  const hash = chat?.metadata?.ltcm_config_hash;
  return typeof hash === "string" && hash.trim().length > 0 ? hash : null;
}

async function buildCortexFreshnessSnapshot(
  userId: string,
  chatId: string,
  cortexConfig: memoryCortex.MemoryCortexConfig,
): Promise<CortexFreshnessSnapshot> {
  return {
    ltcmConfigHash: await chatsSvc.getCurrentChatMemoryHash(userId),
    rebuildSignature: memoryCortex.getCortexWarmupSignature(cortexConfig),
    ...getChunkFreshnessSnapshot(chatId),
  };
}

function isCortexFresh(
  chat: ReturnType<typeof getChat>,
  snapshot: CortexFreshnessSnapshot,
): boolean {
  const stored = parseStoredCortexFreshness(chat);
  if (!stored) return false;

  return stored.ltcmConfigHash === snapshot.ltcmConfigHash
    && stored.rebuildSignature === snapshot.rebuildSignature
    && stored.sourceChunkCount === snapshot.sourceChunkCount
    && stored.sourceChunkUpdatedAt === snapshot.sourceChunkUpdatedAt;
}

function stampCortexFreshnessSnapshot(
  userId: string,
  chatId: string,
  snapshot: CortexFreshnessSnapshot,
): void {
  const chat = getChat(userId, chatId);
  if (!chat) return;

  const metadata = {
    ...chat.metadata,
    cortex_rebuild_state: {
      ...snapshot,
      completedAt: Math.floor(Date.now() / 1000),
    },
  };

  getDb().query("UPDATE chats SET metadata = ? WHERE id = ? AND user_id = ?").run(
    JSON.stringify(metadata),
    chatId,
    userId,
  );
}

function startTrackedCortexRebuild(options: {
  userId: string;
  chatId: string;
  characterNames: string[];
  descriptionAliases?: Map<string, string>;
  generateRawFn?: CortexGenerateRawFn;
  sidecarConnectionId?: string;
  snapshot: CortexFreshnessSnapshot;
  source?: "warmup";
}): void {
  const { userId, chatId, characterNames, descriptionAliases, generateRawFn, sidecarConnectionId, snapshot, source } = options;

  memoryCortex.rebuildCortex(
    userId,
    chatId,
    characterNames,
    generateRawFn,
    sidecarConnectionId,
    (current, total) => {
      eventBus.emit(EventType.CORTEX_REBUILD_PROGRESS, {
        chatId,
        status: "processing",
        current,
        total,
        percent: Math.round((current / total) * 100),
        ...(source ? { source } : {}),
      }, userId);
    },
    descriptionAliases,
    { resumable: source === "warmup", warmupSignature: snapshot.rebuildSignature },
  ).then((result) => {
    try {
      stampCortexFreshnessSnapshot(userId, chatId, snapshot);
    } catch (err) {
      console.warn("[memory-cortex] Failed to stamp rebuild freshness state:", err);
    }

    eventBus.emit(EventType.CORTEX_REBUILD_PROGRESS, {
      chatId,
      status: "complete",
      ...(source ? { source } : {}),
      ...result,
    }, userId);
  }).catch((err) => {
    console.error(source === "warmup" ? "[memory-cortex] Warmup rebuild failed:" : "[memory-cortex] Rebuild failed:", err);
    eventBus.emit(EventType.CORTEX_REBUILD_PROGRESS, {
      chatId,
      status: "error",
      ...(source ? { source } : {}),
      error: err?.message || (source === "warmup" ? "Warmup failed" : "Rebuild failed"),
    }, userId);
  });
}

async function warmLongTermChatMemory(options: {
  userId: string;
  chatId: string;
  force: boolean;
  embeddings: Awaited<ReturnType<typeof embeddingsSvc.getEmbeddingConfig>>;
}): Promise<WarmupComponentResult> {
  const { userId, chatId, force, embeddings } = options;

  if (!embeddings.enabled || !embeddings.vectorize_chat_messages) {
    return { status: "skipped", reason: "chat_vectorization_disabled" };
  }

  const chatMemorySettings = embeddingsSvc.loadChatMemorySettings(userId) ?? embeddingsSvc.DEFAULT_CHAT_MEMORY_SETTINGS;
  if (!force && !chatMemorySettings.autoWarmup) {
    return { status: "skipped", reason: "chat_memory_auto_warmup_disabled" };
  }

  if (chatsSvc.isChatChunkRebuildInProgress(chatId)) {
    return { status: "skipped", reason: "chunk_rebuild_in_progress" };
  }

  if (force) {
    await chatsSvc.rebuildChatChunks(userId, chatId);
    return { status: "complete", reason: "chat_memory_rebuilt" };
  }

  const rebuilt = await chatsSvc.ensureChatMemoryFresh(userId, chatId);
  if (rebuilt) {
    return { status: "complete", reason: "chat_memory_warmed" };
  }

  const resumedChunks = vectorizationQueue.queuePendingChatChunkVectorization(userId, chatId, 4);
  if (resumedChunks > 0) {
    return { status: "complete", reason: "chat_memory_warmup_resumed" };
  }

  return { status: "skipped", reason: "chat_memory_already_fresh" };
}

function resolveCortexSidecarAdapter(
  userId: string,
  cortexConfig: memoryCortex.MemoryCortexConfig,
): {
  generateRawFn?: CortexGenerateRawFn;
  sidecarConnectionId?: string;
  unavailableReason?: string;
} {
  if (!memoryCortex.shouldUseCortexSidecar(cortexConfig)) return {};

  const sidecarConnectionId = cortexConfig.sidecar?.connectionProfileId || undefined;
  if (!sidecarConnectionId) return { unavailableReason: "sidecar_not_configured" };

  const sidecarConn = connectionsSvc.getConnection(userId, sidecarConnectionId);
  if (!sidecarConn) return { unavailableReason: "sidecar_connection_missing" };

  const provider = getProvider(sidecarConn.provider);
  if (!provider) return { unavailableReason: "sidecar_provider_missing" };

  const apiKeyRequired = provider.capabilities.apiKeyRequired ?? true;
  if (apiKeyRequired && !sidecarConn.has_api_key) {
    return { unavailableReason: "sidecar_api_key_missing" };
  }

  const sidecarProvider = sidecarConn.provider;
  const generateRawFn: CortexGenerateRawFn = memoryCortex.createCortexSidecarGenerateRawAdapter({
    userId,
    sidecarProvider,
    cortexConfig,
  });

  return { generateRawFn, sidecarConnectionId };
}

// ─── Configuration ─────────────────────────────────────────────

/** GET /config — Get the current cortex configuration */
app.get("/config", (c) => {
  const userId = c.get("userId");
  return c.json(memoryCortex.getCortexConfig(userId));
});

/** PUT /config — Update cortex configuration (partial merge) */
app.put("/config", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const config = memoryCortex.putCortexConfig(userId, body);
  return c.json(config);
});

/** POST /config/preset — Apply a preset mode (simple, standard, advanced) */
app.post("/config/preset", async (c) => {
  const userId = c.get("userId");
  const { mode } = await c.req.json();
  if (!mode || !["simple", "standard", "advanced"].includes(mode)) {
    return c.json({ error: "Invalid preset mode. Use: simple, standard, advanced" }, 400);
  }
  const config = memoryCortex.applyCortexPreset(userId, mode);
  return c.json(config);
});

// ─── Entities ──────────────────────────────────────────────────

/** GET /health — Diagnose common Memory Cortex blockers and readiness */
app.get("/health", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.query("chatId")?.trim() || null;
  const probeConnectivity = ["1", "true", "yes", "on"].includes(
    (c.req.query("probeConnectivity") || "").toLowerCase(),
  );

  const config = memoryCortex.getCortexConfig(userId);
  const embeddings = await embeddingsSvc.getEmbeddingConfig(userId);

  const checks: Array<{
    key: string;
    label: string;
    status: "pass" | "warn" | "fail" | "info";
    message: string;
  }> = [];

  const pushCheck = (
    key: string,
    label: string,
    status: "pass" | "warn" | "fail" | "info",
    message: string,
  ) => {
    checks.push({ key, label, status, message });
  };

  const getProbeErrorMessage = (err: unknown, fallback: string) => {
    if (err instanceof Error && err.message.trim()) return err.message;
    if (typeof err === "string" && err.trim()) return err;
    return fallback;
  };

  pushCheck(
    "cortex_enabled",
    "Memory Cortex enabled",
    config.enabled ? "pass" : "warn",
    config.enabled
      ? "Memory Cortex is enabled."
      : "Memory Cortex is turned off. Turn it on before expecting entity tracking or cortex retrieval.",
  );

  pushCheck(
    "embeddings_enabled",
    "Embeddings enabled",
    embeddings.enabled ? "pass" : "fail",
    embeddings.enabled
      ? "Embeddings are enabled."
      : "Embeddings are off. Chat chunks and long-term memory vectorization will not run until embeddings are enabled.",
  );

  pushCheck(
    "chat_vectorization_enabled",
    "Chat vectorization enabled",
    embeddings.vectorize_chat_messages ? "pass" : "fail",
    embeddings.vectorize_chat_messages
      ? "Chat message vectorization is enabled."
      : "Vectorize Chat Messages is off. Memory Cortex depends on chat_chunks being created from chat memory.",
  );

  pushCheck(
    "embedding_api_key",
    "Embedding API key",
    embeddings.has_api_key ? "pass" : "fail",
    embeddings.has_api_key
      ? "An embedding API key is configured."
      : "No embedding API key is configured. Embeddings cannot be generated until a key is saved.",
  );

  pushCheck(
    "embedding_dimensions",
    "Embedding dimensions",
    embeddings.dimensions ? "pass" : "warn",
    embeddings.dimensions
      ? `Embedding dimensions are set to ${embeddings.dimensions}.`
      : "Embedding dimensions have not been confirmed yet. Running a live probe will verify the embedding connection.",
  );

  let embeddingConnectivity: {
    attempted: boolean;
    success: boolean | null;
    message: string;
    dimension: number | null;
    durationMs: number | null;
    timedOut: boolean;
    error: string | null;
  } = {
    attempted: false,
    success: null,
    message: "Live embedding probe not run.",
    dimension: embeddings.dimensions,
    durationMs: null,
    timedOut: false,
    error: null,
  };
  const embeddingProbePromise = (async () => {
    if (!(probeConnectivity && embeddings.enabled && embeddings.has_api_key)) {
      return embeddingConnectivity;
    }

    const startedAt = Date.now();
    try {
      const result = await embeddingsSvc.testEmbeddingConfig(userId, "Memory Cortex health check.");
      const durationMs = Date.now() - startedAt;
      return {
        attempted: true,
        success: true,
        message: `Embedding request succeeded (${result.dimension} dimensions).`,
        dimension: result.dimension,
        durationMs,
        timedOut: false,
        error: null,
      };
    } catch (err: unknown) {
      const message = getProbeErrorMessage(err, "Embedding probe failed.");
      return {
        attempted: true,
        success: false,
        message,
        dimension: embeddings.dimensions,
        durationMs: Date.now() - startedAt,
        timedOut: err instanceof Error && err.name === "TimeoutError",
        error: message,
      };
    }
  })();

  const sidecarConnectionId = config.sidecar?.connectionProfileId || null;
  const sidecarRequired =
    config.entityExtractionMode === "sidecar" ||
    config.salienceScoringMode === "sidecar" ||
    config.consolidation.useSidecar;

  const sidecarProfile = sidecarConnectionId
    ? connectionsSvc.getConnection(userId, sidecarConnectionId)
    : null;
  const sidecarProvider = sidecarProfile ? getProvider(sidecarProfile.provider) : null;
  const sidecarApiKeyRequired = sidecarProvider?.capabilities.apiKeyRequired ?? true;
  const sidecarHasApiKey = sidecarProfile
    ? (!sidecarApiKeyRequired || !!sidecarProfile.has_api_key)
    : false;
  const sidecarReady = !sidecarRequired || !!(sidecarProfile && sidecarProvider && sidecarHasApiKey);

  if (sidecarRequired && !sidecarConnectionId) {
    pushCheck(
      "sidecar_required",
      "Sidecar connection",
      "fail",
      "Sidecar-assisted cortex features are enabled, but no sidecar connection is selected.",
    );
  } else if (sidecarConnectionId && !sidecarProfile) {
    pushCheck(
      "sidecar_exists",
      "Sidecar connection",
      sidecarRequired ? "fail" : "warn",
      "The selected sidecar connection profile no longer exists.",
    );
  } else if (sidecarConnectionId && !sidecarProvider) {
    pushCheck(
      "sidecar_provider",
      "Sidecar provider",
      sidecarRequired ? "fail" : "warn",
      `The selected provider "${sidecarProfile?.provider}" is not available.`,
    );
  } else if (sidecarConnectionId && !sidecarHasApiKey) {
    pushCheck(
      "sidecar_api_key",
      "Sidecar API key",
      sidecarRequired ? "fail" : "warn",
      "The selected sidecar connection is missing its API key.",
    );
  } else if (sidecarRequired) {
    pushCheck(
      "sidecar_ready",
      "Sidecar readiness",
      "pass",
      "A valid sidecar connection is configured for cortex features that require it.",
    );
  } else if (sidecarConnectionId) {
    pushCheck(
      "sidecar_optional",
      "Sidecar connection",
      "info",
      "A sidecar connection is configured, but current cortex modes can still run in heuristic mode.",
    );
  } else {
    pushCheck(
      "sidecar_optional",
      "Sidecar connection",
      "info",
      "No sidecar connection is configured. Heuristic cortex mode can still run without it.",
    );
  }

  let sidecarConnectivity: {
    attempted: boolean;
    success: boolean | null;
    message: string;
    durationMs: number | null;
    timedOut: boolean;
    error: string | null;
  } = {
    attempted: false,
    success: null,
    message: "Live sidecar probe not run.",
    durationMs: null,
    timedOut: false,
    error: null,
  };
  const sidecarProbePromise = (async () => {
    if (!(probeConnectivity && sidecarConnectionId && sidecarProfile)) {
      return sidecarConnectivity;
    }

    try {
      const result = await connectionsSvc.testConnection(userId, sidecarConnectionId);
      return {
        attempted: true,
        success: result.success,
        message: result.message,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        error: result.error,
      };
    } catch (err: unknown) {
      const message = getProbeErrorMessage(err, "Sidecar probe failed.");
      return {
        attempted: true,
        success: false,
        message,
        durationMs: null,
        timedOut: err instanceof Error && err.name === "TimeoutError",
        error: message,
      };
    }
  })();

  [embeddingConnectivity, sidecarConnectivity] = await Promise.all([
    embeddingProbePromise,
    sidecarProbePromise,
  ]);

  if (embeddingConnectivity.attempted) {
    pushCheck(
      "embedding_probe",
      "Embedding connectivity",
      embeddingConnectivity.success ? "pass" : "fail",
      embeddingConnectivity.message,
    );
  }

  if (sidecarConnectivity.attempted) {
    pushCheck(
      "sidecar_probe",
      "Sidecar connectivity",
      sidecarConnectivity.success ? "pass" : "fail",
      sidecarConnectivity.message,
    );
  }

  let chatReport: {
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
    rebuildStatus: any;
  } | null = null;

  if (chatId) {
    const chat = getChat(userId, chatId);
    if (!chat) {
      chatReport = {
        id: chatId,
        name: null,
        exists: false,
        messageCount: 0,
        chunkCount: 0,
        vectorizedChunkCount: 0,
        pendingChunkCount: 0,
        entityCount: 0,
        activeEntityCount: 0,
        relationCount: 0,
        consolidationCount: 0,
        rebuildStatus: { status: "idle" },
      };
      pushCheck(
        "chat_exists",
        "Selected chat",
        "fail",
        "The requested chat could not be found.",
      );
    } else {
      const db = getDb();
      const messageCount = (db.query("SELECT COUNT(*) as c FROM messages WHERE chat_id = ?").get(chatId) as any)?.c ?? 0;
      const vectorStatus = chatsSvc.getVectorizationStatus(userId, chatId);
      const stats = memoryCortex.getCortexUsageStats(chatId);
      const rebuildStatus = memoryCortex.getRebuildStatus(chatId) ?? { status: "idle" };

      chatReport = {
        id: chatId,
        name: chat.name || null,
        exists: true,
        messageCount,
        chunkCount: vectorStatus.totalChunks,
        vectorizedChunkCount: vectorStatus.vectorizedChunks,
        pendingChunkCount: vectorStatus.pendingChunks,
        entityCount: stats.entityCount,
        activeEntityCount: stats.activeEntityCount,
        relationCount: stats.relationCount,
        consolidationCount: stats.consolidationCount,
        rebuildStatus,
      };

      pushCheck(
        "chat_loaded",
        "Selected chat",
        "pass",
        `Chat "${chat.name || chatId}" is available for diagnostics.`,
      );

      if (messageCount === 0) {
        pushCheck(
          "chat_messages",
          "Chat messages",
          "warn",
          "This chat has no messages yet, so there is nothing for Memory Cortex to process.",
        );
      } else if (vectorStatus.totalChunks === 0) {
        pushCheck(
          "chat_chunks",
          "Chat chunks",
          "fail",
          "No chat_chunks exist for this chat. Recompile chat memory after enabling chat vectorization.",
        );
      } else if (vectorStatus.vectorizedChunks === 0) {
        pushCheck(
          "chat_chunks_vectorized",
          "Chunk vectorization",
          "fail",
          "Chat chunks exist, but none are vectorized yet. Check your embedding setup, then recompile chat memory.",
        );
      } else if (vectorStatus.pendingChunks > 0) {
        pushCheck(
          "chat_chunks_vectorized",
          "Chunk vectorization",
          "warn",
          `${vectorStatus.pendingChunks} chat chunk(s) are still waiting on vectorization.`,
        );
      } else {
        pushCheck(
          "chat_chunks_vectorized",
          "Chunk vectorization",
          "pass",
          "Chat chunks exist and are vectorized.",
        );
      }

      if (rebuildStatus.status === "processing") {
        pushCheck(
          "cortex_rebuild",
          "Cortex rebuild",
          "info",
          `A rebuild is currently running (${rebuildStatus.percent ?? 0}% complete).`,
        );
      } else if (stats.entityCount > 0 || stats.relationCount > 0 || stats.consolidationCount > 0) {
        pushCheck(
          "cortex_output",
          "Cortex output",
          "pass",
          `Cortex data exists for this chat (${stats.entityCount} entities, ${stats.relationCount} relations).`,
        );
      } else if (messageCount >= 4 && config.enabled) {
        pushCheck(
          "cortex_output",
          "Cortex output",
          "warn",
          "No cortex entities or relations were found for this chat yet. Run a rebuild after chat vectorization is healthy.",
        );
      } else {
        pushCheck(
          "cortex_output",
          "Cortex output",
          "info",
          "This chat may still be too small for meaningful cortex extraction.",
        );
      }
    }
  } else {
    pushCheck(
      "chat_context",
      "Selected chat",
      "info",
      "No chat was selected. Open diagnostics from an active chat to see chunk and cortex stats for that chat.",
    );
  }

  const summary = {
    failures: checks.filter((check) => check.status === "fail").length,
    warnings: checks.filter((check) => check.status === "warn").length,
    passes: checks.filter((check) => check.status === "pass").length,
    info: checks.filter((check) => check.status === "info").length,
  };

  return c.json({
    generatedAt: new Date().toISOString(),
    healthy: summary.failures === 0,
    summary,
    config: {
      enabled: config.enabled,
      presetMode: config.presetMode,
      formatterMode: config.formatterMode,
      entityExtractionMode: config.entityExtractionMode,
      salienceScoringMode: config.salienceScoringMode,
      sidecarConnectionProfileId: sidecarConnectionId,
    },
    embeddings: {
      enabled: embeddings.enabled,
      hasApiKey: embeddings.has_api_key,
      vectorizeChatMessages: embeddings.vectorize_chat_messages,
      provider: embeddings.provider,
      model: embeddings.model,
      dimensions: embeddingConnectivity.dimension,
      ready: embeddings.enabled && embeddings.vectorize_chat_messages && embeddings.has_api_key,
      connectivity: embeddingConnectivity,
    },
    sidecar: {
      required: sidecarRequired,
      configured: !!sidecarConnectionId,
      connectionProfileId: sidecarConnectionId,
      connectionName: sidecarProfile?.name ?? null,
      provider: sidecarProfile?.provider ?? null,
      model: config.sidecar?.model || sidecarProfile?.model || null,
      hasApiKey: sidecarHasApiKey,
      ready: sidecarReady,
      connectivity: sidecarConnectivity,
    },
    chat: chatReport,
    checks,
  });
});

/** GET /chats/:chatId/entities — List entities for a chat */
app.get("/chats/:chatId/entities", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const status = c.req.query("status"); // "active", "inactive", or omit for all
  const entities = memoryCortex.getEntities(chatId);

  const filtered = status
    ? entities.filter((e) => e.status === status)
    : entities;

  // Enrich each entity with its most recent mention excerpt so the UI
  // can show the actual chunk text that triggered classification
  const { getDb } = require("../db/connection");
  const db = getDb();
  const enriched = filtered.map((e) => {
    const mention = db.query(
      "SELECT excerpt FROM memory_mentions WHERE entity_id = ? AND excerpt IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    ).get(e.id) as any;
    return { ...e, latestExcerpt: mention?.excerpt ?? null };
  });

  return c.json({
    data: enriched,
    total: enriched.length,
  });
});

/** GET /chats/:chatId/entities/:entityId — Get a single entity */
app.get("/chats/:chatId/entities/:entityId", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const entity = memoryCortex.findEntity(chatId, c.req.param("entityId"));
  if (!entity) return c.json({ error: "Entity not found" }, 404);
  return c.json(entity);
});

/** PUT /chats/:chatId/entities/:entityId — Update an entity (manual edit) */
app.put("/chats/:chatId/entities/:entityId", async (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const entityId = c.req.param("entityId");
  const body = await c.req.json();

  // Find the entity first (scoped to this chat — prevents cross-chat hijack via entity ID)
  const entities = memoryCortex.getEntities(chatId);
  const entity = entities.find((e) => e.id === entityId);
  if (!entity) return c.json({ error: "Entity not found" }, 404);

  // Allow updating: name, entity_type, aliases, description, status, facts
  const { getDb } = require("../db/connection");
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const updates: string[] = [];
  const params: any[] = [];

  if (body.name !== undefined) { updates.push("name = ?"); params.push(body.name); }
  if (body.entity_type !== undefined) { updates.push("entity_type = ?"); params.push(body.entity_type); }
  if (body.aliases !== undefined) { updates.push("aliases = ?"); params.push(JSON.stringify(body.aliases)); }
  if (body.description !== undefined) { updates.push("description = ?"); params.push(body.description); }
  if (body.facts !== undefined) { updates.push("facts = ?"); params.push(JSON.stringify(body.facts)); }
  if (body.status !== undefined) {
    updates.push("status = ?", "status_changed_at = ?");
    params.push(body.status, now);
  }

  if (updates.length === 0) return c.json({ error: "No fields to update" }, 400);

  updates.push("updated_at = ?");
  params.push(now, entityId, chatId);

  // Scope WHERE by chat_id as defense-in-depth: even if a global entity ID leaks,
  // the chat-ownership gate above plus this filter prevents cross-chat writes.
  db.query(`UPDATE memory_entities SET ${updates.join(", ")} WHERE id = ? AND chat_id = ?`).run(...params);

  const updated = memoryCortex.getEntities(chatId).find((e) => e.id === entityId);
  return c.json(updated);
});

/** DELETE /chats/:chatId/entities/:entityId — Delete an entity */
app.delete("/chats/:chatId/entities/:entityId", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const entityId = c.req.param("entityId");
  const { getDb } = require("../db/connection");
  const db = getDb();

  // Scope deletes by chat_id so a leaked entity ID can't take down another chat's data.
  db.query(
    `DELETE FROM memory_relations WHERE chat_id = ? AND (source_entity_id = ? OR target_entity_id = ?)`,
  ).run(chatId, entityId, entityId);
  const result = db.query("DELETE FROM memory_entities WHERE id = ? AND chat_id = ?").run(entityId, chatId);

  if (result.changes === 0) return c.json({ error: "Entity not found" }, 404);
  return c.json({ success: true });
});

/** POST /chats/:chatId/entities/merge — Merge two entities into one */
app.post("/chats/:chatId/entities/merge", async (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const { sourceId, targetId } = await c.req.json();

  if (!sourceId || !targetId) return c.json({ error: "sourceId and targetId required" }, 400);
  if (sourceId === targetId) return c.json({ error: "Cannot merge entity with itself" }, 400);

  const entities = memoryCortex.getEntities(chatId);
  const source = entities.find((e) => e.id === sourceId);
  const target = entities.find((e) => e.id === targetId);

  if (!source || !target) return c.json({ error: "One or both entities not found" }, 404);

  const { getDb } = require("../db/connection");
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  db.transaction(() => {
    // Merge aliases (source name becomes an alias on target)
    const targetAliases = [...target.aliases];
    if (!targetAliases.includes(source.name)) targetAliases.push(source.name);
    for (const alias of source.aliases) {
      if (!targetAliases.includes(alias)) targetAliases.push(alias);
    }

    // Merge facts (deduplicated)
    const targetFacts = [...target.facts];
    const lowerFacts = new Set(targetFacts.map((f) => f.toLowerCase()));
    for (const fact of source.facts) {
      if (!lowerFacts.has(fact.toLowerCase())) {
        targetFacts.push(fact);
      }
    }

    // Update target entity
    db.query(
      `UPDATE memory_entities SET
        aliases = ?, facts = ?,
        mention_count = mention_count + ?,
        salience_avg = MAX(salience_avg, ?),
        updated_at = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify(targetAliases), JSON.stringify(targetFacts.slice(-20)),
      source.mentionCount, source.salienceAvg, now, targetId,
    );

    // Re-point all source mentions to target
    db.query("UPDATE memory_mentions SET entity_id = ? WHERE entity_id = ?")
      .run(targetId, sourceId);

    // Re-point all source relations to target
    db.query("UPDATE memory_relations SET source_entity_id = ? WHERE source_entity_id = ?")
      .run(targetId, sourceId);
    db.query("UPDATE memory_relations SET target_entity_id = ? WHERE target_entity_id = ?")
      .run(targetId, sourceId);

    // Delete source entity
    db.query("DELETE FROM memory_entities WHERE id = ?").run(sourceId);
  })();

  const merged = memoryCortex.getEntities(chatId).find((e) => e.id === targetId);
  return c.json(merged);
});

// ─── Font Colors ──────────────────────────────────────────────

/** GET /chats/:chatId/colors — Get font color attributions with entity names */
app.get("/chats/:chatId/colors", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const colorMap = memoryCortex.getColorMap(chatId);

  // Resolve entity names for display
  const { getDb } = require("../db/connection");
  const db = getDb();
  const enriched = colorMap.map((m: any) => {
    let entityName: string | null = null;
    if (m.entityId) {
      const row = db.query("SELECT name FROM memory_entities WHERE id = ?").get(m.entityId) as any;
      entityName = row?.name ?? null;
    }
    return { ...m, entityName };
  });

  return c.json({ data: enriched, total: enriched.length });
});

/** DELETE /chats/:chatId/colors/:id — Delete a color attribution */
app.delete("/chats/:chatId/colors/:id", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const { getDb } = require("../db/connection");
  // Scope by chat_id so the integer :id can never delete another chat's color row.
  const result = getDb()
    .query("DELETE FROM memory_font_colors WHERE id = ? AND chat_id = ?")
    .run(c.req.param("id"), chatId);
  if (result.changes === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

// ─── Relations ─────────────────────────────────────────────────

/** GET /chats/:chatId/relations — List relations with resolved entity names */
app.get("/chats/:chatId/relations", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const relations = memoryCortex.getRelations(chatId);

  // Resolve entity names for display
  const { getDb } = require("../db/connection");
  const db = getDb();
  const nameCache = new Map<string, string>();
  const resolveName = (id: string) => {
    if (nameCache.has(id)) return nameCache.get(id)!;
    const row = db.query("SELECT name FROM memory_entities WHERE id = ?").get(id) as any;
    const name = row?.name ?? id.slice(0, 8);
    nameCache.set(id, name);
    return name;
  };

  const enriched = relations.map((r) => ({
    ...r,
    sourceName: resolveName(r.sourceEntityId),
    targetName: resolveName(r.targetEntityId),
  }));

  return c.json({ data: enriched, total: enriched.length });
});

// ─── Consolidations ────────────────────────────────────────────

/** GET /chats/:chatId/consolidations — List consolidations */
app.get("/chats/:chatId/consolidations", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const tier = c.req.query("tier") ? parseInt(c.req.query("tier")!, 10) : undefined;
  const consolidations = memoryCortex.getConsolidations(chatId, tier);
  return c.json({ data: consolidations, total: consolidations.length });
});

// ─── Chunks ────────────────────────────────────────────────────

/** GET /chats/:chatId/chunks — List memory chunks with salience data */
app.get("/chats/:chatId/chunks", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const { getDb } = require("../db/connection");
  const db = getDb();

  const rows = db.query(
    `SELECT cc.id, cc.chat_id, cc.content, cc.token_count, cc.message_count,
            cc.retrieval_count, cc.last_retrieved_at, cc.vectorized_at,
            cc.salience_score, cc.emotional_tags, cc.entity_ids,
            cc.created_at, cc.updated_at
     FROM chat_chunks cc
     WHERE cc.chat_id = ?
     ORDER BY cc.created_at DESC
     LIMIT ? OFFSET ?`,
  ).all(chatId, limit, offset);

  const countRow = db.query("SELECT COUNT(*) as c FROM chat_chunks WHERE chat_id = ?").get(chatId) as any;

  return c.json({ data: rows, total: countRow?.c ?? 0, limit, offset });
});

// ─── Salience ──────────────────────────────────────────────────

/** GET /chats/:chatId/salience — List salience records with emotional/narrative data */
app.get("/chats/:chatId/salience", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const { getDb } = require("../db/connection");
  const db = getDb();

  const rows = db.query(
    `SELECT ms.*, cc.content as chunk_content, cc.message_count
     FROM memory_salience ms
     LEFT JOIN chat_chunks cc ON cc.id = ms.chunk_id
     WHERE ms.chat_id = ?
     ORDER BY ms.score DESC
     LIMIT ? OFFSET ?`,
  ).all(chatId, limit, offset);

  const countRow = db.query("SELECT COUNT(*) as c FROM memory_salience WHERE chat_id = ?").get(chatId) as any;

  return c.json({ data: rows, total: countRow?.c ?? 0, limit, offset });
});

// ─── Usage Stats ───────────────────────────────────────────────

/** GET /chats/:chatId/cortex-stats — Get usage stats for a chat's cortex */
app.get("/chats/:chatId/cortex-stats", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const stats = memoryCortex.getCortexUsageStats(chatId);
  const telemetry = memoryCortex.getIngestionTelemetry(chatId);
  return c.json({ ...stats, ingestionTelemetry: telemetry });
});

app.get("/chats/:chatId/ingestion-status", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const status = memoryCortex.getIngestionStatus(chatId);
  if (!status) return c.json({ status: "idle", phase: "complete", chatId, chunkId: null, startedAt: null, updatedAt: Date.now(), pendingJobs: 0, timings: null });
  return c.json(status);
});

// ─── Rebuild ───────────────────────────────────────────────────

/** GET /chats/:chatId/rebuild-status — Check if a rebuild is running (survives browser close) */
app.get("/chats/:chatId/rebuild-status", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const status = memoryCortex.getRebuildStatus(chatId);
  if (!status) return c.json({ status: "idle" });
  return c.json(status);
});

/** POST /chats/:chatId/rebuild — Rebuild cortex from canonical chunks.
 *  Returns immediately with { status: "started" }. Progress is streamed via
 *  CORTEX_REBUILD_PROGRESS WebSocket events. Final result sent as status: "complete". */
app.post("/chats/:chatId/rebuild", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");

  const chat = getChat(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const cortexConfig = memoryCortex.getCortexConfig(userId);
  if (!cortexConfig.enabled) {
    return c.json({ status: "skipped", reason: "cortex_disabled", chatId });
  }

  const { characterNames, descriptionAliases } = await resolveCortexParticipants(userId, chat);
  const sidecar = resolveCortexSidecarAdapter(userId, cortexConfig);
  if (sidecar.unavailableReason) {
    return c.json({ status: "skipped", reason: sidecar.unavailableReason, chatId });
  }

  const snapshot = await buildCortexFreshnessSnapshot(userId, chatId, cortexConfig);

  // Run rebuild in the background — return immediately so Bun doesn't timeout
  startTrackedCortexRebuild({
    userId,
    chatId,
    characterNames,
    descriptionAliases,
    generateRawFn: sidecar.generateRawFn,
    sidecarConnectionId: sidecar.sidecarConnectionId,
    snapshot,
  });

  return c.json({ status: "started", chatId });
});

app.post("/chats/:chatId/warm", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const body = await c.req.json().catch(() => ({})) as { force?: boolean };
  const force = body.force === true;
  const chat = getChat(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const embeddings = await embeddingsSvc.getEmbeddingConfig(userId);
  const config = memoryCortex.getCortexConfig(userId);

  const chatMemory = await warmLongTermChatMemory({
    userId,
    chatId,
    force,
    embeddings,
  });

  const freshChat = getChat(userId, chatId);
  if (!freshChat) return c.json({ error: "Chat not found" }, 404);

  const currentChatMemoryHash = await chatsSvc.getCurrentChatMemoryHash(userId);
  const storedChatMemoryHash = getStoredChatMemoryHash(freshChat);
  const chatMemoryFresh = !!currentChatMemoryHash && storedChatMemoryHash === currentChatMemoryHash;

  let cortex: WarmupComponentResult;
  if (!config.enabled) {
    cortex = { status: "skipped", reason: "cortex_disabled" };
  } else if (!force && !config.autoWarmup) {
    cortex = { status: "skipped", reason: "cortex_auto_warmup_disabled" };
  } else if (!embeddings.enabled || !embeddings.vectorize_chat_messages) {
    cortex = { status: "skipped", reason: "chat_vectorization_disabled" };
  } else if (chatsSvc.isChatChunkRebuildInProgress(chatId)) {
    cortex = { status: "skipped", reason: "chunk_rebuild_in_progress" };
  } else if (!force && !chatMemoryFresh) {
    cortex = { status: "skipped", reason: "chat_memory_stale" };
  } else {
    const sidecar = resolveCortexSidecarAdapter(userId, config);
    if (sidecar.unavailableReason) {
      cortex = { status: "skipped", reason: sidecar.unavailableReason };
    } else {
      const stats = memoryCortex.getCortexUsageStats(chatId);
      const rebuild = memoryCortex.getRebuildStatus(chatId);
      const ingestion = memoryCortex.getIngestionStatus(chatId);

      if (rebuild?.status === "processing") {
        cortex = { status: "skipped", reason: "rebuild_in_progress" };
      } else if (ingestion?.status === "processing") {
        cortex = { status: "skipped", reason: "ingestion_in_progress" };
      } else if (stats.chunkCount === 0) {
        cortex = { status: "skipped", reason: "no_chunks" };
      } else if (!force && stats.chunkCount <= 2 && Math.floor(Date.now() / 1000) - freshChat.updated_at < 20) {
        cortex = { status: "skipped", reason: "recent_chat" };
      } else {
        const snapshot = await buildCortexFreshnessSnapshot(userId, chatId, config);
        if (!force && isCortexFresh(freshChat, snapshot)) {
          cortex = { status: "skipped", reason: "already_ready" };
        } else {
          const coverage = memoryCortex.getCortexWarmupCoverage(chatId, snapshot.rebuildSignature);
          if (!force && coverage.pendingChunks === 0 && !coverage.requiresFullRebuild) {
            stampCortexFreshnessSnapshot(userId, chatId, snapshot);
            cortex = { status: "skipped", reason: "already_ready" };
          } else {
            const { characterNames, descriptionAliases } = await resolveCortexParticipants(userId, freshChat);
            startTrackedCortexRebuild({
              userId,
              chatId,
              characterNames,
              descriptionAliases,
              generateRawFn: sidecar.generateRawFn,
              sidecarConnectionId: sidecar.sidecarConnectionId,
              snapshot,
              ...(force ? {} : { source: "warmup" as const }),
            });
            cortex = { status: "started", reason: force ? "rebuild_started" : "warmup_started" };
          }
        }
      }
    }
  }

  const response: WarmupResponse = {
    status: cortex.status === "started"
      ? "started"
      : chatMemory.status === "complete"
        ? "complete"
        : "skipped",
    reason: cortex.status === "started"
      ? cortex.reason
      : chatMemory.status === "complete"
        ? chatMemory.reason
        : cortex.reason !== "cortex_disabled" || chatMemory.reason === "chat_vectorization_disabled"
          ? cortex.reason
          : chatMemory.reason,
    chatId,
    chatMemory,
    cortex,
  };

  return c.json(response);
});

// ─── Heuristics Engine Migration ──────────────────────────────

/**
 * POST /chats/:chatId/migrate-heuristics — Run the heuristics engine data migration.
 * Rekeys edges through canonical resolver, recomputes strength, detects contradictions,
 * consolidates edge types, and computes salience breakdowns.
 */
app.post("/chats/:chatId/migrate-heuristics", async (c) => {
  const chatId = c.req.param("chatId");
  const chat = getChat(c.get("userId"), chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const result = memoryCortex.runHeuristicsMigration(chatId, (step, count) => {
    eventBus.emit(EventType.CORTEX_REBUILD_PROGRESS, {
      chatId,
      status: "processing",
      step,
      count,
    }, c.get("userId"));
  });

  return c.json({ status: "complete", ...result });
});

/** GET /chats/:chatId/relations/all — List ALL relations including superseded/suspect/merged (diagnostics) */
app.get("/chats/:chatId/relations/all", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const relations = memoryCortex.getAllRelationsUnfiltered(chatId);

  const db = getDb();
  const nameCache = new Map<string, string>();
  const resolveName = (id: string) => {
    if (nameCache.has(id)) return nameCache.get(id)!;
    const row = db.query("SELECT name FROM memory_entities WHERE id = ?").get(id) as any;
    const name = row?.name ?? id.slice(0, 8);
    nameCache.set(id, name);
    return name;
  };

  const enriched = relations.map((r) => ({
    ...r,
    sourceName: resolveName(r.sourceEntityId),
    targetName: resolveName(r.targetEntityId),
  }));

  return c.json({ data: enriched, total: enriched.length });
});

/** GET /chats/:chatId/entities/needs-facts — Get entities needing fact extraction */
app.get("/chats/:chatId/entities/needs-facts", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const threshold = parseFloat(c.req.query("threshold") || "0.45");
  const entities = memoryCortex.getEntitiesNeedingFactExtraction(chatId, threshold, 20);
  return c.json({ data: entities, total: entities.length });
});

// ─── Vaults ──────────────────────────────────────────────────

/** POST /vaults — Create a vault by snapshotting a chat's cortex state */
app.post("/vaults", async (c) => {
  const userId = c.get("userId");
  const { chatId, name, description } = await c.req.json();
  if (!chatId || !name) {
    return c.json({ error: "chatId and name are required" }, 400);
  }
  const chat = getChat(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  try {
    const vault = memoryCortex.createVault(userId, chatId, name, description);
    eventBus.emit(EventType.CORTEX_VAULT_CREATED, {
      vaultId: vault.id, name: vault.name,
      entityCount: vault.entityCount, relationCount: vault.relationCount,
    }, userId);
    return c.json(vault, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

/** GET /vaults — List all vaults owned by the user */
app.get("/vaults", (c) => {
  const userId = c.get("userId");
  return c.json({ data: memoryCortex.listVaults(userId) });
});

/** GET /vaults/:id — Get vault with entities and relations */
app.get("/vaults/:id", (c) => {
  const userId = c.get("userId");
  const vaultId = c.req.param("id");
  const data = memoryCortex.getVault(userId, vaultId);
  if (!data) return c.json({ error: "Vault not found" }, 404);
  return c.json(data);
});

/** PUT /vaults/:id — Rename a vault */
app.put("/vaults/:id", async (c) => {
  const userId = c.get("userId");
  const vaultId = c.req.param("id");
  const { name } = await c.req.json();
  if (!name) return c.json({ error: "name is required" }, 400);
  const ok = memoryCortex.renameVault(userId, vaultId, name);
  if (!ok) return c.json({ error: "Vault not found or not owned" }, 404);
  return c.json({ success: true });
});

/** DELETE /vaults/:id — Delete a vault and all associated data */
app.delete("/vaults/:id", (c) => {
  const userId = c.get("userId");
  const vaultId = c.req.param("id");
  const ok = memoryCortex.deleteVault(userId, vaultId);
  if (!ok) return c.json({ error: "Vault not found or not owned" }, 404);
  return c.json({ success: true });
});

/** POST /vaults/:id/reindex — Rebuild the vault's chunk snapshot.
 *  Either re-snapshots from the live source chat (when it still exists and
 *  has vectorized chunks) or re-embeds the vault's existing stored content
 *  against the current embedding config. Idempotent. */
app.post("/vaults/:id/reindex", async (c) => {
  const userId = c.get("userId");
  const vaultId = c.req.param("id");
  try {
    const result = await memoryCortex.reindexVault(userId, vaultId);
    // Invalidate linked-cortex cache on every chat this vault is attached to
    // so the next generation picks up the refreshed snapshot.
    memoryCortex.invalidateLinkedCortexCacheForVault(vaultId);
    eventBus.emit(EventType.CORTEX_VAULT_REINDEXED, {
      vaultId, mode: result.mode, chunkCount: result.chunkCount,
    }, userId);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message ?? "Reindex failed" }, err.message === "Vault not found" ? 404 : 500);
  }
});

// ─── Chat Links ──────────────────────────────────────────────

/** POST /chats/:chatId/links — Attach a vault or interlink to a chat */
app.post("/chats/:chatId/links", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const chat = getChat(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!isRecord(body)) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }

  const linkTypeRaw = body.linkType ?? body.link_type;
  const linkTypeValue = typeof linkTypeRaw === "string" ? linkTypeRaw.trim() : "";
  if (!linkTypeValue || !["vault", "interlink"].includes(linkTypeValue)) {
    return c.json({ error: "linkType must be 'vault' or 'interlink'" }, 400);
  }
  const linkType = linkTypeValue as "vault" | "interlink";

  const vaultId = optionalTrimmedString(body.vaultId ?? body.vault_id);
  const targetChatId = optionalTrimmedString(body.targetChatId ?? body.target_chat_id);
  const label = optionalTrimmedString(body.label);
  const bidirectionalRaw = body.bidirectional ?? body.bidirectional_link;
  if (
    body.label !== undefined && typeof body.label !== "string"
  ) {
    return c.json({ error: "label must be a string when provided" }, 400);
  }
  if (
    bidirectionalRaw !== undefined && optionalBoolean(bidirectionalRaw) === undefined
  ) {
    return c.json({ error: "bidirectional must be a boolean when provided" }, 400);
  }
  const bidirectional = optionalBoolean(bidirectionalRaw);

  try {
    const links = memoryCortex.attachLink(userId, chatId, linkType, {
      vaultId, targetChatId, label, bidirectional,
    });
    memoryCortex.invalidateLinkedCortexCache(chatId);
    for (const link of links) {
      memoryCortex.invalidateLinkedCortexCache(link.chatId);
    }
    for (const link of links) {
      eventBus.emit(EventType.CORTEX_LINK_CHANGED, {
        chatId: link.chatId, linkId: link.id, action: "attached",
      }, userId);
    }
    return c.json({ data: links }, 201);
  } catch (err: any) {
    if (err instanceof ChatLinkError) {
      return c.json({ error: err.message }, { status: err.status as 400 | 404 | 409 });
    }
    console.error("[memory-cortex] failed to attach chat link:", err);
    return c.json({ error: "Failed to attach chat link" }, 500);
  }
});

/** GET /chats/:chatId/links — List links for a chat */
app.get("/chats/:chatId/links", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  return c.json({ data: memoryCortex.getChatLinks(chatId) });
});

/** PATCH /chats/:chatId/links/:linkId — Toggle link enabled state */
app.patch("/chats/:chatId/links/:linkId", async (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const userId = owned.userId;
  const linkId = c.req.param("linkId");
  const { enabled } = await c.req.json();
  if (typeof enabled !== "boolean") {
    return c.json({ error: "enabled (boolean) is required" }, 400);
  }
  const ok = memoryCortex.toggleLink(userId, chatId, linkId, enabled);
  if (!ok) return c.json({ error: "Link not found or not owned" }, 404);
  memoryCortex.invalidateLinkedCortexCache(chatId);
  eventBus.emit(EventType.CORTEX_LINK_CHANGED, {
    chatId, linkId, action: "toggled",
  }, userId);
  return c.json({ success: true });
});

/** DELETE /chats/:chatId/links/:linkId — Remove a link */
app.delete("/chats/:chatId/links/:linkId", (c) => {
  const chatId = c.req.param("chatId");
  const owned = ensureChatOwnership(c, chatId);
  if (!owned.ok) return owned.response;
  const userId = owned.userId;
  const linkId = c.req.param("linkId");
  const ok = memoryCortex.removeLink(userId, chatId, linkId);
  if (!ok) return c.json({ error: "Link not found or not owned" }, 404);
  memoryCortex.invalidateLinkedCortexCache(chatId);
  eventBus.emit(EventType.CORTEX_LINK_CHANGED, {
    chatId, linkId, action: "removed",
  }, userId);
  return c.json({ success: true });
});

export { app as memoryCortexRoutes };
