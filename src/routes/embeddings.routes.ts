import { Hono } from "hono";
import { getDb } from "../db/connection";
import * as embeddingsSvc from "../services/embeddings.service";
import * as worldBooksSvc from "../services/world-books.service";
import * as chatsSvc from "../services/chats.service";
import * as vectorStoreCfg from "../services/vector-store-config.service";
import { getActiveVectorStore, type CollectionName, type TableHealth } from "../services/vector-store";

const app = new Hono();

app.get("/config", async (c) => {
  const userId = c.get("userId");
  return c.json(await embeddingsSvc.getEmbeddingConfig(userId));
});

app.put("/config", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    const updated = await embeddingsSvc.updateEmbeddingConfig(userId, body);
    return c.json(updated);
  } catch (err: any) {
    const msg = err?.message || "Failed to update embedding config";
    if (/managed by the server owner/i.test(msg)) {
      return c.json({ error: msg }, 403);
    }
    throw err;
  }
});

app.post("/models/preview", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const result = await embeddingsSvc.previewEmbeddingModels(userId, body);
  return c.json(result);
});

app.post("/test", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ text?: string }>();
  const sample = body.text?.trim() || "Lumiverse embedding connectivity test.";
  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  if (!cfg.enabled) {
    return c.json({
      error: "Embeddings are disabled. World books still fall back to keyword matching; enable embeddings to run a vector connectivity test.",
    }, 400);
  }
  if (!cfg.has_api_key) {
    return c.json({ error: "No embedding API key is configured." }, 400);
  }

  try {
    const result = await embeddingsSvc.testEmbeddingConfig(userId, sample);
    return c.json({ success: true, ...result, applied_dimensions: result.dimension });
  } catch (err: any) {
    const msg = err?.message || "Embedding test failed";
    const status = /disabled|not configured/i.test(msg) ? 400 : 502;
    return c.json({ error: msg }, status);
  }
});

app.post("/world-books/:bookId/reindex", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("bookId");
  const book = worldBooksSvc.getWorldBook(userId, bookId);
  if (!book) return c.json({ error: "World book not found" }, 404);
  const entries = worldBooksSvc.listEntries(userId, bookId);

  const body = await c.req.json<{ batch_size?: number }>().catch(() => ({} as { batch_size?: number }));
  const embeddingCfg = await embeddingsSvc.getEmbeddingConfig(userId);
  const batchSize = body.batch_size || embeddingCfg.batch_size;
  const wantsStream = c.req.header("accept")?.includes("text/event-stream");

  if (wantsStream) {
    // SSE streaming progress
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // Controller may already be closed/cancelled by the client.
          }
        };
        const send = (event: string, data: any) => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            return true;
          } catch {
            closed = true;
            clearInterval(heartbeat);
            return false;
          }
        };
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`:\n\n`));
          } catch {
            closed = true;
            clearInterval(heartbeat);
          }
        }, 5000);

        send("progress", {
          total: entries.length,
          current: 0,
          eligible: 0,
          indexed: 0,
          removed: 0,
          skipped_not_enabled: 0,
          skipped_disabled_or_empty: 0,
          failed: 0,
        });

        try {
          const result = await embeddingsSvc.reindexWorldBookEntries(userId, entries, {
            batchSize,
            force: true,
            onProgress: (progress) => {
              send("progress", progress);
            },
          });
          send("done", { success: true, ...result });
        } catch (err: any) {
          send("error", { error: err.message || "Reindex failed" });
        }
        close();
      },
      cancel() {
        // Client disconnected or request timed out.
      },
    });

    // Pull CORS headers from the Hono context so this raw Response
    // mirrors what the middleware would set on a normal c.json() reply.
    const origin = c.req.header("origin") || "";
    const corsHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    if (origin) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
      corsHeaders["Access-Control-Allow-Credentials"] = "true";
    }

    return new Response(stream, { headers: corsHeaders });
  }

  // Non-streaming fallback
  const result = await embeddingsSvc.reindexWorldBookEntries(userId, entries, { batchSize, force: true });
  return c.json({ success: true, ...result });
});

// --- Chat Memory Settings ---

app.get("/chat-memory-settings", async (c) => {
  const userId = c.get("userId");
  const settings = embeddingsSvc.loadChatMemorySettings(userId);
  return c.json(settings ?? embeddingsSvc.DEFAULT_CHAT_MEMORY_SETTINGS);
});

app.put("/chat-memory-settings", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const updated = embeddingsSvc.saveChatMemorySettings(userId, body);
  return c.json(updated);
});

app.post("/force-reset", async (c) => {
  try {
    const result = await embeddingsSvc.forceResetLanceDB();
    return c.json({ success: true, ...result });
  } catch (err: any) {
    return c.json({ error: err.message || "Force reset failed" }, 500);
  }
});

app.post("/optimize", async (c) => {
  try {
    const store = await getActiveVectorStore();
    await store.optimize(["embeddings", "embeddings_world_books"]);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message || "Optimize failed" }, 500);
  }
});

app.get("/health", async (c) => {
  try {
    const store = await getActiveVectorStore();
    const collections: CollectionName[] = ["embeddings", "embeddings_world_books"];
    const entries = await Promise.all(collections.map(async (name) => [name, await store.health(name)] as const));
    const tables = Object.fromEntries(entries) as Record<CollectionName, TableHealth>;
    const health = combineVectorHealth(tables);
    return c.json({ ...health, provider: store.id, capabilities: store.capabilities });
  } catch (err: any) {
    return c.json({ error: err.message || "Health check failed" }, 500);
  }
});

function combineVectorHealth(tables: Record<CollectionName, TableHealth>) {
  const values = Object.values(tables);
  const existing = values.filter((table) => table.exists);
  return {
    exists: existing.length > 0,
    rowCount: values.reduce((sum, table) => sum + table.rowCount, 0),
    vectorIndexReady: existing.length === 0 || existing.every((table) => table.vectorIndexReady),
    scalarIndexReady: existing.length === 0 || existing.every((table) => table.scalarIndexReady),
    ftsIndexReady: existing.length === 0 || existing.every((table) => table.ftsIndexReady),
    unindexedRowEstimate: values.reduce((sum, table) => sum + table.unindexedRowEstimate, 0),
    lastIndexRebuildAt: Math.max(0, ...values.map((table) => table.lastIndexRebuildAt)),
    indexes: values.flatMap((table, idx) => table.indexes.map((index) => ({
      name: `${idx === 0 ? "embeddings" : "embeddings_world_books"}:${index.name}`,
      type: index.type,
    }))),
    tables,
  };
}

// --- Vector Store (database backend) configuration — owner-gated, global ---

app.get("/vector-store/config", async (c) => {
  try {
    return c.json(await vectorStoreCfg.getVectorStoreConfigForApi());
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to read vector store config" }, 500);
  }
});

app.put("/vector-store/config", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await vectorStoreCfg.updateVectorStoreConfig(userId, body));
  } catch (err: any) {
    const msg = err?.message || "Failed to update vector store config";
    if (/managed by the server owner|managed by environment/i.test(msg)) {
      return c.json({ error: msg }, 403);
    }
    return c.json({ error: msg }, 400);
  }
});

app.post("/vector-store/test", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await vectorStoreCfg.testVectorStoreConnection(body);
  return c.json(result, result.ok ? 200 : 400);
});

app.post("/vector-store/switch", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await vectorStoreCfg.switchVectorStoreProvider(userId, body));
  } catch (err: any) {
    const msg = err?.message || "Failed to switch vector store";
    if (/managed by the server owner|managed by environment/i.test(msg)) {
      return c.json({ error: msg }, 403);
    }
    // Validation/reachability failures: reject without having persisted.
    return c.json({ error: msg }, 400);
  }
});

app.post("/chats/:chatId/recompile", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_chat_messages) {
    return c.json({ error: "Chat memory vectorization is not enabled" }, 400);
  }

  // 1. Rebuild chunks in SQLite (creates chunk rows, queues async vectorization)
  await chatsSvc.rebuildChatChunks(userId, chatId);

  // 2. Gather the freshly created chunks and embed them synchronously
  const chunks = chatsSvc.getChatChunks(userId, chatId);
  if (chunks.length > 0) {
    await embeddingsSvc.reindexChatMessages(
      userId,
      chatId,
      chunks.map(ch => ({
        chunkId: ch.id,
        content: ch.content,
        metadata: { chunkId: ch.id, messageIds: ch.message_ids },
      }))
    );

    // Mark all chunks as vectorized in SQLite
    const now = Math.floor(Date.now() / 1000);
    const db = getDb();
    const stmt = db.query("UPDATE chat_chunks SET vectorized_at = ?, vector_model = ? WHERE id = ?");
    for (const ch of chunks) {
      stmt.run(now, cfg.model, ch.id);
    }
  }

  const status = chatsSvc.getVectorizationStatus(userId, chatId);
  return c.json({
    success: true,
    totalChunks: status.totalChunks,
    vectorizedChunks: status.vectorizedChunks,
    pendingChunks: status.pendingChunks,
  });
});

app.post("/world-books/:bookId/search", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("bookId");
  const book = worldBooksSvc.getWorldBook(userId, bookId);
  if (!book) return c.json({ error: "World book not found" }, 404);

  const body = await c.req.json<{ query?: string; limit?: number }>();
  if (!body.query || !body.query.trim()) {
    return c.json({ error: "query is required" }, 400);
  }

  const results = await embeddingsSvc.searchWorldBookEntries(userId, bookId, body.query, body.limit ?? 8);
  return c.json({ results });
});

export { app as embeddingsRoutes };
