import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import type { Context, Next } from "hono";
import * as svc from "../services/generate.service";
import * as breakdownSvc from "../services/breakdown.service";
import * as poolSvc from "../services/generation-pool.service";
import * as summarizePoolSvc from "../services/summarize-pool.service";
import { getSummarizationPromptDefaults } from "../services/summarization-prompts.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const LOCALHOST_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function localhostOnly(c: Context, next: Next) {
  const info = getConnInfo(c);
  const addr = info.remote.address;
  if (!addr || !LOCALHOST_ADDRS.has(addr)) {
    return c.json({ error: "Extension endpoints are localhost-only" }, 403);
  }
  return next();
}

const app = new Hono();

function chatRoute(handler: (input: any) => Promise<any>, extras?: Record<string, string>) {
  return async (c: Context) => {
    const userId = c.get("userId");
    const body = await c.req.json();
    if (!body.chat_id) return c.json({ error: "chat_id is required" }, 400);
    try {
      const result = await handler({ ...body, userId, signal: c.req.raw.signal, ...extras });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  };
}

app.post("/", chatRoute(svc.startGeneration));
app.post("/regenerate", chatRoute(svc.startGeneration, { generation_type: "regenerate" }));
app.post("/continue", chatRoute(svc.startGeneration, { generation_type: "continue" }));
app.post("/dry-run", chatRoute(svc.dryRunGeneration));

app.post("/stop", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (body.generation_id) {
    const stopped = svc.stopGeneration(body.generation_id);
    return c.json({ stopped });
  }
  svc.stopUserGenerations(userId);
  return c.json({ stopped: true });
});

// --- Generation status / recovery ---

app.get("/active", (c) => {
  const userId = c.get("userId");
  const entries = poolSvc.getChatHeadPoolsForUser(userId);
  return c.json(entries.map((e) => ({
    generationId: e.generationId,
    chatId: e.chatId,
    status: e.status,
    generationType: e.generationType,
    characterName: e.characterName,
    characterId: e.characterId,
    model: e.model,
    startedAt: e.startedAt,
    councilRetryPending: e.councilRetryPending || false,
  })));
});

app.post("/acknowledge", async (c) => {
  const userId = c.get("userId");
  const { chatId } = await c.req.json<{ chatId: string }>();
  if (!chatId) return c.json({ error: "chatId required" }, 400);
  const generationIds = poolSvc.acknowledgeChat(userId, chatId);
  if (generationIds.length > 0) {
    eventBus.emit(EventType.GENERATION_ACKNOWLEDGED, { chatId, generationIds }, userId);
  }
  return c.json({ acknowledged: true, removed: generationIds.length, generationIds });
});

app.get("/status/:chatId", (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const entry = poolSvc.getPoolForChat(userId, chatId);
  if (!entry) return c.json({ active: false });
  const active = entry.status === "assembling" || entry.status === "council" || entry.status === "streaming";
  return c.json({
    active,
    generationId: entry.generationId,
    status: entry.status,
    councilRetryPending: entry.councilRetryPending || false,
    councilToolsFailure: entry.councilToolsFailure,
    content: entry.content,
    reasoning: entry.reasoning,
    tokenSeq: entry.tokenSeq,
    generationType: entry.generationType,
    targetMessageId: entry.targetMessageId,
    characterName: entry.characterName,
    characterId: entry.characterId,
    model: entry.model,
    startedAt: entry.startedAt,
    reasoningStartedAt: entry.reasoningStartedAt,
    reasoningDurationMs: entry.reasoningDurationMs,
    completedMessageId: entry.completedMessageId,
    completedAt: entry.completedAt,
    error: entry.error,
  });
});

// --- Council retry decision ---

app.post("/council-retry", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.generation_id) return c.json({ error: "generation_id is required" }, 400);
  const decision = body.decision as string;
  if (decision !== "continue" && decision !== "retry") {
    return c.json({ error: "decision must be 'continue' or 'retry'" }, 400);
  }
  const resolved = svc.resolveCouncilRetry(userId, body.generation_id, decision);
  if (!resolved) return c.json({ error: "No pending council retry for this generation" }, 404);
  return c.json({ resolved: true });
});

// --- Breakdown retrieval ---

app.get("/breakdown/:messageId", async (c) => {
  const userId = c.get("userId");
  const messageId = c.req.param("messageId");
  const data = breakdownSvc.getBreakdown(userId, messageId);
  if (!data) return c.json({ error: "No breakdown found for this message" }, 404);
  return c.json(data);
});

// --- Summarize endpoint (browser-accessible, uses sidecar connection fallback) ---

app.get("/summarize/prompt-defaults", (c) => {
  return c.json(getSummarizationPromptDefaults());
});

app.post("/summarize", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }

  try {
    const result = await svc.summarizeGenerate(userId, body);
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes("No connection") || err.message.includes("Unknown provider") || err.message.includes("No API key") ? 400 : 502;
    return c.json({ error: err.message }, status);
  }
});

app.get("/summarize/status/:chatId", (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const entry = summarizePoolSvc.getSummarizePoolEntry(userId, chatId);
  if (!entry) return c.json({ active: false });
  return c.json({
    active: true,
    generationId: entry.generationId,
    startedAt: entry.startedAt,
  });
});

// --- Extension endpoints (localhost-only, synchronous, stateless) ---

app.post("/raw", localhostOnly, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.provider) return c.json({ error: "provider is required" }, 400);
  if (!body.model) return c.json({ error: "model is required" }, 400);
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }

  try {
    const result = await svc.rawGenerate(userId, body);
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes("Unknown provider") || err.message.includes("No API key") ? 400 : 502;
    return c.json({ error: err.message }, status);
  }
});

app.post("/quiet", localhostOnly, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }

  try {
    const result = await svc.quietGenerate(userId, body);
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes("No connection") || err.message.includes("Unknown provider") || err.message.includes("No API key") ? 400 : 502;
    return c.json({ error: err.message }, status);
  }
});

app.post("/batch", localhostOnly, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.requests || !Array.isArray(body.requests) || body.requests.length === 0) {
    return c.json({ error: "requests array is required" }, 400);
  }
  if (body.requests.length > 20) {
    return c.json({ error: "Maximum 20 requests per batch" }, 400);
  }
  for (let i = 0; i < body.requests.length; i++) {
    const r = body.requests[i];
    if (!r.provider || !r.model || !r.messages || !Array.isArray(r.messages) || r.messages.length === 0) {
      return c.json({ error: `requests[${i}] must have provider, model, and messages` }, 400);
    }
  }

  const results = await svc.batchGenerate(userId, body);
  return c.json({ results });
});

export { app as generateRoutes };
