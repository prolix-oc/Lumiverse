import type { ChatMemoryResultDTO } from "lumiverse-spindle-types";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import * as chatsSvc from "../services/chats.service";
import * as settingsSvc from "../services/settings.service";
import * as promptAssemblySvc from "../services/prompt-assembly.service";
import * as embeddingsSvc from "../services/embeddings.service";
import * as memoryCortexSvc from "../services/memory-cortex";
import * as entityGraphSvc from "../services/memory-cortex/entity-graph";
import * as cortexConsolidationSvc from "../services/memory-cortex/consolidation";
import * as cortexVaultSvc from "../services/memory-cortex/vault";
import * as chatMemoryCacheSvc from "../services/chat-memory-cache.service";
import * as vectorizationQueueSvc from "../services/vectorization-queue.service";
import { getDb } from "../db/connection";

type MemoryPermission = "chats" | "memories";
export type WorkerHostMemoryApiContext = {
  hasPermission: (permission: MemoryPermission) => boolean;
  resolveEffectiveUserId: (requestUserId?: string) => string | null;
  enforceScopedUser: (userId: string | null | undefined) => void;
  postResponse: (message: { type: "response"; requestId: string; result?: unknown; error?: string }) => void;
};

/** Handles chat-memory retrieval and the Memory Cortex extension API. */
export class WorkerHostMemoryApi {
  constructor(private readonly context: WorkerHostMemoryApiContext) {}

  private hasPermission(permission: MemoryPermission): boolean { return this.context.hasPermission(permission); }
  private resolveEffectiveUserId(userId?: string): string | null { return this.context.resolveEffectiveUserId(userId); }
  private enforceScopedUser(userId: string | null | undefined): void { this.context.enforceScopedUser(userId); }
  private postToWorker(message: { type: "response"; requestId: string; result?: unknown; error?: string }): void { this.context.postResponse(message); }


  // ─── Chat Memories (gated: "chats") ─────────────────────────────────

  async handleChatsGetMemories(
    requestId: string,
    chatId: string,
    topK?: number,
    userId?: string,
  ): Promise<void> {
    try {
      if (!this.hasPermission("chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const chat = chatsSvc.getChat(resolvedUserId, chatId);
      if (!chat) throw new Error("Chat not found");

      const messages = chatsSvc.getMessages(resolvedUserId, chatId);

      // Load chat memory settings the same way prompt-assembly does
      const chatMemSettingsRaw = settingsSvc.getSetting(resolvedUserId, "chatMemorySettings")?.value;
      const chatMemSettings = chatMemSettingsRaw
        ? embeddingsSvc.normalizeChatMemorySettings(chatMemSettingsRaw)
        : null;

      // Per-chat overrides from chat metadata
      let perChatOverrides = (chat.metadata?.memory_settings as any) ?? null;

      // Apply topK override from request
      if (topK != null && topK > 0) {
        perChatOverrides = { ...(perChatOverrides || {}), retrievalTopK: topK };
      }

      const memoryResult = await promptAssemblySvc.collectChatVectorMemory(
        resolvedUserId, chatId, messages, chatMemSettings, perChatOverrides,
      );

      const result: ChatMemoryResultDTO = {
        chunks: memoryResult.chunks.map((c) => ({
          content: c.content,
          score: c.score,
          metadata: (typeof c.metadata === "object" && c.metadata) ? c.metadata : {},
        })),
        formatted: memoryResult.formatted,
        count: memoryResult.count,
        enabled: memoryResult.enabled,
        queryPreview: memoryResult.queryPreview,
        settingsSource: memoryResult.settingsSource,
        chunksAvailable: memoryResult.chunksAvailable,
        chunksPending: memoryResult.chunksPending,
        retrievalMode: memoryResult.retrievalMode,
      };

      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Memory Cortex & Long-Term Chat Memory (gated: "memories") ───────

  private requireMemoriesPermission(): void {
    if (!this.hasPermission("memories")) {
      throw new Error(`${PERMISSION_DENIED_PREFIX} memories — Memories permission not granted`);
    }
  }

  /** Permission + userId resolution + chat ownership check used by every
   *  chat-scoped memories.* handler. Returns the resolved userId. */
  private resolveMemoriesChatContext(chatId: string, userId?: string): string {
    this.requireMemoriesPermission();
    const resolvedUserId = this.resolveEffectiveUserId(userId);
    if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
    this.enforceScopedUser(resolvedUserId);
    const chat = chatsSvc.getChat(resolvedUserId, chatId);
    if (!chat) throw new Error("Chat not found");
    return resolvedUserId;
  }

  /** Permission + userId resolution + entity ownership check (via chat). */
  private resolveMemoriesEntityContext(
    entityId: string,
    userId?: string,
  ): { userId: string; chatId: string } {
    this.requireMemoriesPermission();
    const resolvedUserId = this.resolveEffectiveUserId(userId);
    if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
    this.enforceScopedUser(resolvedUserId);
    const entity = entityGraphSvc.getEntity(entityId);
    if (!entity) throw new Error("Entity not found");
    const chat = chatsSvc.getChat(resolvedUserId, entity.chatId);
    if (!chat) throw new Error("Entity not owned by caller");
    return { userId: resolvedUserId, chatId: entity.chatId };
  }

  /** Permission + userId resolution + vault ownership check. */
  private resolveMemoriesVaultContext(vaultId: string, userId?: string): string {
    this.requireMemoriesPermission();
    const resolvedUserId = this.resolveEffectiveUserId(userId);
    if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
    this.enforceScopedUser(resolvedUserId);
    const vault = cortexVaultSvc.getVaultRow(resolvedUserId, vaultId);
    if (!vault) throw new Error("Vault not found");
    return resolvedUserId;
  }

  handleMemoriesConfigGet(requestId: string, userId?: string): void {
    try {
      this.requireMemoriesPermission();
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);
      const config = memoryCortexSvc.getCortexConfig(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: config });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesConfigPut(requestId: string, patch: any, userId?: string): void {
    try {
      this.requireMemoriesPermission();
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);
      if (!patch || typeof patch !== "object") throw new Error("patch must be an object");
      const config = memoryCortexSvc.putCortexConfig(resolvedUserId, patch);
      this.postToWorker({ type: "response", requestId, result: config });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesQueryCortex(requestId: string, query: any): void {
    (async () => {
      try {
        this.requireMemoriesPermission();
        if (!query || typeof query !== "object") throw new Error("query is required");
        if (typeof query.chatId !== "string" || !query.chatId) throw new Error("query.chatId is required");
        const resolvedUserId = this.resolveEffectiveUserId(query.userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);
        const chat = chatsSvc.getChat(resolvedUserId, query.chatId);
        if (!chat) throw new Error("Chat not found");

        const result = await memoryCortexSvc.queryCortex({
          chatId: query.chatId,
          userId: resolvedUserId,
          queryText: typeof query.queryText === "string" ? query.queryText : "",
          entityFilter: Array.isArray(query.entityFilter) ? query.entityFilter : undefined,
          timeRange: query.timeRange,
          emotionalContext: Array.isArray(query.emotionalContext) ? query.emotionalContext : undefined,
          generationType: typeof query.generationType === "string" ? query.generationType : "normal",
          topK: typeof query.topK === "number" && query.topK > 0 ? query.topK : 10,
          includeConsolidations: query.includeConsolidations !== false,
          includeRelationships: query.includeRelationships !== false,
          excludeMessageIds: Array.isArray(query.excludeMessageIds) ? query.excludeMessageIds : undefined,
        });
        this.postToWorker({ type: "response", requestId, result });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleMemoriesQueryLinked(
    requestId: string,
    chatId: string,
    queryText: string | undefined,
    userId?: string,
  ): void {
    (async () => {
      try {
        const resolvedUserId = this.resolveMemoriesChatContext(chatId, userId);
        const result = await memoryCortexSvc.queryLinkedCortex(chatId, resolvedUserId, undefined, queryText);
        this.postToWorker({ type: "response", requestId, result });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleMemoriesGetCached(requestId: string, chatId: string): void {
    try {
      this.requireMemoriesPermission();
      // Cached reads return null for chats the caller never populated, and
      // the cache is only filled by callers that already had ownership.
      const result = memoryCortexSvc.getCachedCortexResult(chatId);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesGetCachedLinked(requestId: string, chatId: string): void {
    try {
      this.requireMemoriesPermission();
      const result = memoryCortexSvc.getCachedLinkedCortexResult(chatId);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesInvalidateCache(requestId: string, chatId: string): void {
    try {
      this.resolveMemoriesChatContext(chatId);
      memoryCortexSvc.invalidateCortexCache(chatId);
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesInvalidateLinkedCache(requestId: string, chatId: string): void {
    try {
      this.resolveMemoriesChatContext(chatId);
      memoryCortexSvc.invalidateLinkedCortexCache(chatId);
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesEntitiesList(
    requestId: string,
    chatId: string,
    activeOnly: boolean | undefined,
    limit: number | undefined,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const entities = activeOnly === false
        ? entityGraphSvc.getEntities(chatId)
        : entityGraphSvc.getActiveEntities(chatId, typeof limit === "number" && limit > 0 ? limit : 500);
      this.postToWorker({ type: "response", requestId, result: entities });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesEntitiesGet(requestId: string, entityId: string, userId?: string): void {
    try {
      this.requireMemoriesPermission();
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);
      const entity = entityGraphSvc.getEntity(entityId);
      if (!entity) {
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }
      const chat = chatsSvc.getChat(resolvedUserId, entity.chatId);
      if (!chat) {
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }
      this.postToWorker({ type: "response", requestId, result: entity });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesEntitiesFindByName(
    requestId: string,
    chatId: string,
    name: string,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const entity = entityGraphSvc.findEntityByName(chatId, name);
      this.postToWorker({ type: "response", requestId, result: entity });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesEntitiesUpsert(
    requestId: string,
    chatId: string,
    entity: any,
    chunkId: string | null,
    createdAt: number | undefined,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      if (!entity || typeof entity.name !== "string" || !entity.name.trim()) {
        throw new Error("entity.name is required");
      }
      if (typeof entity.type !== "string") throw new Error("entity.type is required");
      const ts = typeof createdAt === "number" && createdAt > 0 ? createdAt : Math.floor(Date.now() / 1000);
      const id = entityGraphSvc.upsertEntity(
        chatId,
        {
          name: entity.name,
          type: entity.type,
          aliases: Array.isArray(entity.aliases) ? entity.aliases : [],
          confidence: typeof entity.confidence === "number" ? entity.confidence : 0.9,
          role: entity.role,
          provisional: !!entity.provisional,
        },
        // Empty-string sentinel matches the host's own ingestion path for
        // mentions that aren't attributed to a chunk yet.
        chunkId ?? "",
        ts,
      );
      // Extensions can flag an upsert as a curated edit so future rebuilds
      // preserve the row's curated fields. Mirrors the REST PUT semantics.
      if (entity.markUserEdited === true) {
        entityGraphSvc.markEntityUserEdited(id);
      }
      const result = entityGraphSvc.getEntity(id);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesEntitiesUpdateStatus(
    requestId: string,
    entityId: string,
    patch: any,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesEntityContext(entityId, userId);
      if (!patch || typeof patch.status !== "string") throw new Error("patch.status is required");
      entityGraphSvc.updateEntityStatus(entityId, patch.status);
      const result = entityGraphSvc.getEntity(entityId);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesEntitiesAddFacts(
    requestId: string,
    entityId: string,
    facts: string[],
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesEntityContext(entityId, userId);
      if (!Array.isArray(facts)) throw new Error("facts must be an array of strings");
      entityGraphSvc.addEntityFacts(entityId, facts);
      const result = entityGraphSvc.getEntity(entityId);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesEntitiesGetFacts(
    requestId: string,
    entityId: string,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesEntityContext(entityId, userId);
      const facts = entityGraphSvc.getEntityFacts(entityId);
      this.postToWorker({ type: "response", requestId, result: facts });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesEntitiesUpdateEmotionalValence(
    requestId: string,
    entityId: string,
    valence: Record<string, number>,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesEntityContext(entityId, userId);
      if (!valence || typeof valence !== "object") throw new Error("valence must be an object");
      entityGraphSvc.updateEntityEmotionalValence(entityId, valence);
      const result = entityGraphSvc.getEntity(entityId);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesRelationsList(requestId: string, chatId: string, userId?: string): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const relations = entityGraphSvc.getRelations(chatId);
      this.postToWorker({ type: "response", requestId, result: relations });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesRelationsListAll(requestId: string, chatId: string, userId?: string): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const relations = entityGraphSvc.getAllRelationsUnfiltered(chatId);
      this.postToWorker({ type: "response", requestId, result: relations });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesRelationsForEntity(
    requestId: string,
    chatId: string,
    entityId: string,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const relations = entityGraphSvc.getActiveEdgesForEntity(chatId, entityId);
      this.postToWorker({ type: "response", requestId, result: relations });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesRelationsForEntities(
    requestId: string,
    chatId: string,
    entityIds: string[],
    limit: number | undefined,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      if (!Array.isArray(entityIds)) throw new Error("entityIds must be an array");
      const relations = entityGraphSvc.getRelationsForEntities(chatId, entityIds, limit);
      this.postToWorker({ type: "response", requestId, result: relations });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesRelationsUpsert(
    requestId: string,
    chatId: string,
    relation: any,
    chunkId: string | null,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      if (!relation || typeof relation !== "object") throw new Error("relation is required");
      if (typeof relation.source !== "string" || !relation.source) throw new Error("relation.source is required");
      if (typeof relation.target !== "string" || !relation.target) throw new Error("relation.target is required");
      if (typeof relation.type !== "string") throw new Error("relation.type is required");

      const sourceEntity = entityGraphSvc.findEntityByName(chatId, relation.source);
      const targetEntity = entityGraphSvc.findEntityByName(chatId, relation.target);
      if (!sourceEntity || !targetEntity) {
        // Silent drop matches the ingestion pipeline's behaviour for edges
        // whose endpoints aren't in the graph yet.
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }

      entityGraphSvc.upsertRelation(
        chatId,
        {
          source: relation.source,
          target: relation.target,
          type: relation.type,
          label: typeof relation.label === "string" ? relation.label : "",
          sentiment: typeof relation.sentiment === "number" ? relation.sentiment : 0,
        },
        sourceEntity.id,
        targetEntity.id,
        chunkId ?? "",
      );

      const created = entityGraphSvc
        .getRelations(chatId)
        .find(
          (r) =>
            r.sourceEntityId === sourceEntity.id &&
            r.targetEntityId === targetEntity.id &&
            r.relationType === relation.type,
        ) ?? null;
      // Extensions can flag a relation upsert as a curated edit so future
      // rebuilds preserve the curated fields (label, strength, sentiment).
      if (created && relation.markUserEdited === true) {
        entityGraphSvc.markRelationUserEdited(created.id);
      }
      this.postToWorker({ type: "response", requestId, result: created });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesConsolidationsList(
    requestId: string,
    chatId: string,
    tier: number | undefined,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const consolidations = cortexConsolidationSvc.getConsolidations(chatId, tier);
      this.postToWorker({ type: "response", requestId, result: consolidations });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesConsolidationsLatestArc(
    requestId: string,
    chatId: string,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const arc = cortexConsolidationSvc.getLatestArc(chatId);
      this.postToWorker({ type: "response", requestId, result: arc });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesConsolidationsRun(requestId: string, chatId: string, userId?: string): void {
    (async () => {
      try {
        const resolvedUserId = this.resolveMemoriesChatContext(chatId, userId);
        const cortexConfig = memoryCortexSvc.getCortexConfig(resolvedUserId);
        if (!cortexConfig.consolidation?.enabled) {
          throw new Error("Consolidation is disabled in cortex config");
        }
        // Fire-and-forget — never block the worker on background consolidation.
        // Heuristic / extractive mode runs without a sidecar generate fn;
        // sidecar mode requires route-layer plumbing to resolve a connection,
        // which we don't replicate here on purpose (keeps the worker surface
        // simple and predictable).
        void cortexConsolidationSvc
          .maybeConsolidate(resolvedUserId, chatId, cortexConfig.consolidation)
          .catch((err) => console.warn("[Spindle:memories] consolidations.run() failed:", err));
        this.postToWorker({ type: "response", requestId, result: undefined });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleMemoriesSalienceGet(
    requestId: string,
    chatId: string,
    limit: number | undefined,
    offset: number | undefined,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const lim = Math.min(typeof limit === "number" && limit > 0 ? limit : 100, 500);
      const off = typeof offset === "number" && offset >= 0 ? offset : 0;
      const rows = getDb()
        .query(
          `SELECT chunk_id, chat_id, score, score_source, emotional_tags, status_changes,
                  narrative_flags, has_dialogue, has_action, has_internal_thought,
                  word_count, scored_at, scored_by
             FROM memory_salience
            WHERE chat_id = ?
            ORDER BY scored_at DESC
            LIMIT ? OFFSET ?`,
        )
        .all(chatId, lim, off) as Array<{
          chunk_id: string;
          chat_id: string;
          score: number;
          score_source: string;
          emotional_tags: string;
          status_changes: string;
          narrative_flags: string;
          has_dialogue: number;
          has_action: number;
          has_internal_thought: number;
          word_count: number;
          scored_at: number;
          scored_by: string | null;
        }>;

      const parseJsonArr = (raw: string): any[] => {
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
      };

      const result = rows.map((r) => ({
        chunkId: r.chunk_id,
        chatId: r.chat_id,
        score: r.score,
        scoreSource: r.score_source,
        emotionalTags: parseJsonArr(r.emotional_tags),
        statusChanges: parseJsonArr(r.status_changes),
        narrativeFlags: parseJsonArr(r.narrative_flags),
        hasDialogue: !!r.has_dialogue,
        hasAction: !!r.has_action,
        hasInternalThought: !!r.has_internal_thought,
        wordCount: r.word_count,
        scoredAt: r.scored_at,
        scoredBy: r.scored_by,
      }));
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesVaultsList(requestId: string, userId?: string): void {
    try {
      this.requireMemoriesPermission();
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);
      const vaults = cortexVaultSvc.listVaults(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: vaults });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesVaultsGet(requestId: string, vaultId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveMemoriesVaultContext(vaultId, userId);
      const contents = cortexVaultSvc.getVault(resolvedUserId, vaultId);
      const vault = cortexVaultSvc.getVaultRow(resolvedUserId, vaultId);
      const result = contents && vault
        ? { vault, entities: contents.entities, relations: contents.relations }
        : null;
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesVaultsGetChunks(
    requestId: string,
    vaultId: string,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesVaultContext(vaultId, userId);
      const chunks = cortexVaultSvc.getVaultChunks(vaultId);
      this.postToWorker({ type: "response", requestId, result: chunks });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesVaultsCreate(requestId: string, input: any, userId?: string): void {
    try {
      this.requireMemoriesPermission();
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);
      if (!input || typeof input.chatId !== "string" || !input.chatId) throw new Error("input.chatId is required");
      if (typeof input.name !== "string" || !input.name.trim()) throw new Error("input.name is required");
      const chat = chatsSvc.getChat(resolvedUserId, input.chatId);
      if (!chat) throw new Error("Chat not found");
      const vault = cortexVaultSvc.createVault(
        resolvedUserId,
        input.chatId,
        input.name.trim(),
        typeof input.description === "string" ? input.description : undefined,
      );
      this.postToWorker({ type: "response", requestId, result: vault });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesVaultsRename(
    requestId: string,
    vaultId: string,
    name: string,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolveMemoriesVaultContext(vaultId, userId);
      if (typeof name !== "string" || !name.trim()) throw new Error("name is required");
      const ok = cortexVaultSvc.renameVault(resolvedUserId, vaultId, name.trim());
      this.postToWorker({ type: "response", requestId, result: ok });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesVaultsDelete(requestId: string, vaultId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveMemoriesVaultContext(vaultId, userId);
      const ok = cortexVaultSvc.deleteVault(resolvedUserId, vaultId);
      this.postToWorker({ type: "response", requestId, result: ok });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesVaultsReindex(
    requestId: string,
    vaultId: string,
    userId?: string,
  ): void {
    (async () => {
      try {
        const resolvedUserId = this.resolveMemoriesVaultContext(vaultId, userId);
        const result = await cortexVaultSvc.reindexVault(resolvedUserId, vaultId);
        this.postToWorker({ type: "response", requestId, result });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleMemoriesLinksList(requestId: string, chatId: string, userId?: string): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const links = cortexVaultSvc.getChatLinks(chatId);
      this.postToWorker({ type: "response", requestId, result: links });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesLinksAttach(requestId: string, input: any, userId?: string): void {
    try {
      if (!input || typeof input.chatId !== "string" || !input.chatId) throw new Error("input.chatId is required");
      if (input.linkType !== "vault" && input.linkType !== "interlink") {
        throw new Error("input.linkType must be 'vault' or 'interlink'");
      }
      const resolvedUserId = this.resolveMemoriesChatContext(input.chatId, userId);
      const links = cortexVaultSvc.attachLink(resolvedUserId, input.chatId, input.linkType, {
        vaultId: typeof input.vaultId === "string" ? input.vaultId : undefined,
        targetChatId: typeof input.targetChatId === "string" ? input.targetChatId : undefined,
        label: typeof input.label === "string" ? input.label : undefined,
        bidirectional: !!input.bidirectional,
      });
      this.postToWorker({ type: "response", requestId, result: links });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesLinksRemove(
    requestId: string,
    chatId: string,
    linkId: string,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolveMemoriesChatContext(chatId, userId);
      const ok = cortexVaultSvc.removeLink(resolvedUserId, chatId, linkId);
      this.postToWorker({ type: "response", requestId, result: ok });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesLinksToggle(
    requestId: string,
    chatId: string,
    linkId: string,
    enabled: boolean,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolveMemoriesChatContext(chatId, userId);
      const ok = cortexVaultSvc.toggleLink(resolvedUserId, chatId, linkId, enabled);
      this.postToWorker({ type: "response", requestId, result: ok });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesChatChunksList(
    requestId: string,
    chatId: string,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolveMemoriesChatContext(chatId, userId);
      const rows = chatsSvc.getChatChunks(resolvedUserId, chatId);
      const result = rows.map((row: any) => ({
        id: row.id,
        chatId: row.chat_id,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        messageIds: row.message_ids,
        content: row.content,
        tokenCount: row.token_count,
        messageCount: row.message_count,
        vectorizedAt: row.vectorized_at,
        vectorModel: row.vector_model,
        retrievalCount: row.retrieval_count,
        lastRetrievedAt: row.last_retrieved_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  async handleMemoriesChatMemoryGet(
    requestId: string,
    chatId: string,
    topK: number | undefined,
    userId?: string,
  ): Promise<void> {
    try {
      const resolvedUserId = this.resolveMemoriesChatContext(chatId, userId);
      const chat = chatsSvc.getChat(resolvedUserId, chatId);
      if (!chat) throw new Error("Chat not found");

      const messages = chatsSvc.getMessages(resolvedUserId, chatId);
      const chatMemSettingsRaw = settingsSvc.getSetting(resolvedUserId, "chatMemorySettings")?.value;
      const chatMemSettings = chatMemSettingsRaw
        ? embeddingsSvc.normalizeChatMemorySettings(chatMemSettingsRaw)
        : null;

      let perChatOverrides = (chat.metadata?.memory_settings as any) ?? null;
      if (topK != null && topK > 0) {
        perChatOverrides = { ...(perChatOverrides || {}), retrievalTopK: topK };
      }

      const memoryResult = await promptAssemblySvc.collectChatVectorMemory(
        resolvedUserId, chatId, messages, chatMemSettings, perChatOverrides,
      );

      const result: ChatMemoryResultDTO = {
        chunks: memoryResult.chunks.map((c) => ({
          content: c.content,
          score: c.score,
          metadata: (typeof c.metadata === "object" && c.metadata) ? c.metadata : {},
        })),
        formatted: memoryResult.formatted,
        count: memoryResult.count,
        enabled: memoryResult.enabled,
        queryPreview: memoryResult.queryPreview,
        settingsSource: memoryResult.settingsSource,
        chunksAvailable: memoryResult.chunksAvailable,
        chunksPending: memoryResult.chunksPending,
        retrievalMode: memoryResult.retrievalMode,
      };
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesChatMemoryWarm(
    requestId: string,
    chatId: string,
    force: boolean | undefined,
    userId?: string,
  ): void {
    (async () => {
      try {
        const resolvedUserId = this.resolveMemoriesChatContext(chatId, userId);
        const embeddings = await embeddingsSvc.getEmbeddingConfig(resolvedUserId);
        if (!embeddings.enabled || !embeddings.vectorize_chat_messages) {
          this.postToWorker({
            type: "response",
            requestId,
            result: { status: "skipped", reason: "chat_vectorization_disabled" },
          });
          return;
        }

        if (chatsSvc.isChatChunkRebuildInProgress(chatId)) {
          this.postToWorker({
            type: "response",
            requestId,
            result: { status: "skipped", reason: "chunk_rebuild_in_progress" },
          });
          return;
        }

        if (force) {
          await chatsSvc.rebuildChatChunks(resolvedUserId, chatId);
          this.postToWorker({
            type: "response",
            requestId,
            result: { status: "complete", reason: "chat_memory_rebuilt", rebuilt: true },
          });
          return;
        }

        const rebuilt = await chatsSvc.ensureChatMemoryFresh(resolvedUserId, chatId);
        if (rebuilt) {
          this.postToWorker({
            type: "response",
            requestId,
            result: { status: "complete", reason: "chat_memory_warmed", rebuilt: true },
          });
          return;
        }

        const queued = vectorizationQueueSvc.queuePendingChatChunkVectorization(resolvedUserId, chatId, 4);
        if (queued > 0) {
          this.postToWorker({
            type: "response",
            requestId,
            result: { status: "queued", reason: "chat_memory_warmup_resumed", vectorizationsQueued: queued },
          });
          return;
        }

        this.postToWorker({
          type: "response",
          requestId,
          result: { status: "skipped", reason: "chat_memory_already_fresh" },
        });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  handleMemoriesChatMemoryInvalidate(
    requestId: string,
    chatId: string,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      chatMemoryCacheSvc.invalidateChatMemoryCache(chatId);
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesStatsUsage(requestId: string, chatId: string, userId?: string): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const stats = memoryCortexSvc.getCortexUsageStats(chatId);
      this.postToWorker({ type: "response", requestId, result: stats });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesStatsIngestionStatus(
    requestId: string,
    chatId: string,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const status = memoryCortexSvc.getIngestionStatus(chatId);
      this.postToWorker({ type: "response", requestId, result: status });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleMemoriesStatsIngestionTelemetry(
    requestId: string,
    chatId: string,
    userId?: string,
  ): void {
    try {
      this.resolveMemoriesChatContext(chatId, userId);
      const telemetry = memoryCortexSvc.getIngestionTelemetry(chatId);
      this.postToWorker({ type: "response", requestId, result: telemetry });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Toast (free tier) ───────────────────────────────────────────────

}
