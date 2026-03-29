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
import { getDb } from "../db/connection";
import { getProvider } from "../llm/registry";
import * as chatsSvc from "../services/chats.service";
import * as connectionsSvc from "../services/connections.service";
import * as embeddingsSvc from "../services/embeddings.service";
import * as memoryCortex from "../services/memory-cortex";
import { getCharacter } from "../services/characters.service";
import { getChat } from "../services/chats.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const app = new Hono();

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
  } = {
    attempted: false,
    success: null,
    message: "Live embedding probe not run.",
    dimension: embeddings.dimensions,
  };

  if (probeConnectivity && embeddings.enabled && embeddings.has_api_key) {
    try {
      const result = await embeddingsSvc.testEmbeddingConfig(userId, "Memory Cortex health check.");
      embeddingConnectivity = {
        attempted: true,
        success: true,
        message: `Embedding request succeeded (${result.dimension} dimensions).`,
        dimension: result.dimension,
      };
      pushCheck(
        "embedding_probe",
        "Embedding connectivity",
        "pass",
        embeddingConnectivity.message,
      );
    } catch (err: any) {
      const message = err?.message || "Embedding probe failed.";
      embeddingConnectivity = {
        attempted: true,
        success: false,
        message,
        dimension: embeddings.dimensions,
      };
      pushCheck(
        "embedding_probe",
        "Embedding connectivity",
        "fail",
        message,
      );
    }
  }

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
  } = {
    attempted: false,
    success: null,
    message: "Live sidecar probe not run.",
  };

  if (probeConnectivity && sidecarConnectionId && sidecarProfile) {
    const result = await connectionsSvc.testConnection(userId, sidecarConnectionId);
    sidecarConnectivity = {
      attempted: true,
      success: result.success,
      message: result.message,
    };
    pushCheck(
      "sidecar_probe",
      "Sidecar connectivity",
      result.success ? "pass" : "fail",
      result.message,
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
  const entity = memoryCortex.findEntity(c.req.param("chatId"), c.req.param("entityId"));
  if (!entity) return c.json({ error: "Entity not found" }, 404);
  return c.json(entity);
});

/** PUT /chats/:chatId/entities/:entityId — Update an entity (manual edit) */
app.put("/chats/:chatId/entities/:entityId", async (c) => {
  const chatId = c.req.param("chatId");
  const entityId = c.req.param("entityId");
  const body = await c.req.json();

  // Find the entity first
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
  params.push(now, entityId);

  db.query(`UPDATE memory_entities SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  const updated = memoryCortex.getEntities(chatId).find((e) => e.id === entityId);
  return c.json(updated);
});

/** DELETE /chats/:chatId/entities/:entityId — Delete an entity */
app.delete("/chats/:chatId/entities/:entityId", (c) => {
  const entityId = c.req.param("entityId");
  const { getDb } = require("../db/connection");
  const db = getDb();

  // CASCADE will handle mentions, but we need to clean relations manually
  db.query("DELETE FROM memory_relations WHERE source_entity_id = ? OR target_entity_id = ?")
    .run(entityId, entityId);
  const result = db.query("DELETE FROM memory_entities WHERE id = ?").run(entityId);

  if (result.changes === 0) return c.json({ error: "Entity not found" }, 404);
  return c.json({ success: true });
});

/** POST /chats/:chatId/entities/merge — Merge two entities into one */
app.post("/chats/:chatId/entities/merge", async (c) => {
  const chatId = c.req.param("chatId");
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
  const { getDb } = require("../db/connection");
  const result = getDb().query("DELETE FROM memory_font_colors WHERE id = ?").run(c.req.param("id"));
  if (result.changes === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

// ─── Relations ─────────────────────────────────────────────────

/** GET /chats/:chatId/relations — List relations with resolved entity names */
app.get("/chats/:chatId/relations", (c) => {
  const chatId = c.req.param("chatId");
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
  const tier = c.req.query("tier") ? parseInt(c.req.query("tier")!, 10) : undefined;
  const consolidations = memoryCortex.getConsolidations(chatId, tier);
  return c.json({ data: consolidations, total: consolidations.length });
});

// ─── Chunks ────────────────────────────────────────────────────

/** GET /chats/:chatId/chunks — List memory chunks with salience data */
app.get("/chats/:chatId/chunks", (c) => {
  const chatId = c.req.param("chatId");
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
  const stats = memoryCortex.getCortexUsageStats(chatId);
  return c.json(stats);
});

// ─── Rebuild ───────────────────────────────────────────────────

/** GET /chats/:chatId/rebuild-status — Check if a rebuild is running (survives browser close) */
app.get("/chats/:chatId/rebuild-status", (c) => {
  const chatId = c.req.param("chatId");
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

  // Gather character names for entity extraction (AI characters + user persona)
  const characterNames: string[] = [];
  const character = getCharacter(userId, chat.character_id);
  if (character) characterNames.push(character.name);
  if (chat.metadata?.character_ids) {
    for (const cid of chat.metadata.character_ids as string[]) {
      const ch = getCharacter(userId, cid);
      if (ch && !characterNames.includes(ch.name)) characterNames.push(ch.name);
    }
  }
  try {
    const { resolvePersonaOrDefault } = require("../services/personas.service");
    const persona = resolvePersonaOrDefault(userId);
    if (persona?.name && !characterNames.includes(persona.name)) {
      characterNames.push(persona.name);
    }
  } catch { /* non-fatal */ }

  // Build sidecar adapter if Tier 2 is configured
  const cortexConfig = memoryCortex.getCortexConfig(userId);
  const sidecarConnectionId = cortexConfig.sidecar?.connectionProfileId || undefined;

  let generateRawFn: ((opts: { connectionId: string; messages: Array<{ role: string; content: string }>; parameters: Record<string, any> }) => Promise<{ content: string }>) | undefined;

  if (sidecarConnectionId) {
    // Resolve provider for structured output injection
    const { getConnection } = require("../services/connections.service");
    const sidecarConn = getConnection(userId, sidecarConnectionId);
    const sidecarProvider = sidecarConn?.provider ?? null;

    generateRawFn = async (opts: any) => {
      const { quietGenerate } = await import("../services/generate.service");
      const toolChoiceParams = sidecarProvider
        ? memoryCortex.getToolChoiceParams(sidecarProvider)
        : {};
      const sidecarParams: Record<string, any> = {
        temperature: cortexConfig.sidecar?.temperature ?? 0.1,
        top_p: cortexConfig.sidecar?.topP ?? 1.0,
        max_tokens: cortexConfig.sidecar?.maxTokens ?? 4096,
        ...toolChoiceParams,
        ...opts.parameters,
      };
      if (cortexConfig.sidecar?.model) sidecarParams.model = cortexConfig.sidecar.model;
      const result = await quietGenerate(userId, {
        connection_id: opts.connectionId,
        messages: opts.messages as any,
        parameters: sidecarParams,
        tools: opts.tools,
      });
      return {
        content: typeof result.content === "string" ? result.content : "",
        tool_calls: result.tool_calls,
      };
    };
  }

  // Run rebuild in the background — return immediately so Bun doesn't timeout
  memoryCortex.rebuildCortex(
    userId, chatId, characterNames, generateRawFn, sidecarConnectionId,
    // Progress callback: streams WS events to the client
    (current, total) => {
      eventBus.emit(EventType.CORTEX_REBUILD_PROGRESS, {
        chatId,
        status: "processing",
        current,
        total,
        percent: Math.round((current / total) * 100),
      }, userId);
    },
  ).then((result) => {
    eventBus.emit(EventType.CORTEX_REBUILD_PROGRESS, {
      chatId,
      status: "complete",
      ...result,
    }, userId);
  }).catch((err) => {
    console.error("[memory-cortex] Rebuild failed:", err);
    eventBus.emit(EventType.CORTEX_REBUILD_PROGRESS, {
      chatId,
      status: "error",
      error: err?.message || "Rebuild failed",
    }, userId);
  });

  return c.json({ status: "started", chatId });
});

export { app as memoryCortexRoutes };
