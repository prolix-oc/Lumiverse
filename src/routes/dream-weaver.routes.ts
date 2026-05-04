import { Hono } from "hono";
import * as dreamWeaverSvc from "../services/dream-weaver/dream-weaver.service";
import * as messagesSvc from "../services/dream-weaver/messages.service";
import { listTools, getTool } from "../services/dream-weaver/tools/registry";
import { normalizeComfyUIWorkflow } from "../image-gen/comfyui-import";
import { discoverCapabilities, getComfyUIObjectInfo } from "../image-gen/comfyui-discovery";
import { detectInjectionPoints } from "../image-gen/comfyui-workflow-parser";
import {
  readComfyUIConfig,
  writeComfyUIConfig,
} from "../services/dream-weaver/visual-studio/comfyui-workflow-storage";
import { buildComfyUIWorkflowFieldOptions } from "../services/dream-weaver/visual-studio/comfyui-workflow-field-options";
import type { ComfyUIFieldMapping } from "../services/dream-weaver/visual-studio/comfyui-workflow-patch";
import {
  getConnection,
  updateConnection,
  imageGenConnectionSecretKey,
} from "../services/image-gen-connections.service";
import { getImageGenSettings } from "../services/image-gen.service";
import * as imagesSvc from "../services/images.service";
import * as secretsSvc from "../services/secrets.service";
import {
  startDreamWeaverVisualJob,
  getDreamWeaverVisualJob,
} from "../services/dream-weaver/visual-studio/service";
import { suggestVisualTags } from "../services/dream-weaver/visual-studio/tag-suggester";
import { getDWGenParams, createDWTimeout } from "../services/dream-weaver/dw-gen-params";
import type { DreamWeaverVisualAsset } from "../types/dream-weaver";

const app = new Hono();

function getSessionMessage(userId: string, sessionId: string, messageId: string) {
  const session = dreamWeaverSvc.getSession(userId, sessionId);
  if (!session) return { error: "Session not found" as const, status: 404 as const };
  const message = messagesSvc.getMessage(userId, messageId);
  if (!message || message.session_id !== sessionId) {
    return { error: "Message not found" as const, status: 404 as const };
  }
  return { session, message };
}

const HELP_TOOL = {
  name: "help",
  displayName: "Help",
  category: "lifecycle" as const,
  userInvocable: true,
  slashCommand: "/help",
  description: "Show available Dream Weaver tools and command examples.",
  conflictMode: "append" as const,
};

const DREAM_SOURCE_TOOL = {
  name: "dream_source",
  displayName: "Add Dream Source",
  category: "lifecycle" as const,
  userInvocable: true,
  slashCommand: "/dream",
  description: "Add dream/source material to the studio without running generation.",
  conflictMode: "append" as const,
};

function publicDreamWeaverTextError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("no connection")) return "Choose a text connection before running Dream Weaver tools.";
    if (lower.includes("no model")) return "Choose a model before running Dream Weaver tools.";
    if (error.name === "AbortError" || lower.includes("abort") || lower.includes("timed out")) {
      return "Tag generation timed out.";
    }
  }
  return fallback;
}

function buildToolHelpText(): string {
  const tools = [HELP_TOOL, DREAM_SOURCE_TOOL, ...listTools().filter((tool) => tool.userInvocable)];
  const lines = [
    "Available Dream Weaver tools",
    "",
    "Type a slash command, then add optional guidance after it. Examples:",
    "/appearance make the hair shorter and less polished",
    "/personality push the cruelty into subtle social control",
    "/add_lorebook add a rumor about the school parking lot",
    "",
    ...tools.map((tool) => {
      const command = tool.slashCommand ?? `/${tool.name}`;
      return `${command} — ${tool.displayName}: ${tool.description}`;
    }),
  ];
  return lines.join("\n");
}

// Create session
app.post("/sessions", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const session = dreamWeaverSvc.createSession(userId, body);
  return c.json(session, 201);
});

// List sessions
app.get("/sessions", (c) => {
  const userId = c.get("userId");
  const sessions = dreamWeaverSvc.listSessions(userId);
  return c.json(sessions);
});

// Get session
app.get("/sessions/:id", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const session = dreamWeaverSvc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

// Update session
app.put("/sessions/:id", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const session = await dreamWeaverSvc.updateSession(userId, sessionId, body);
  return c.json(session);
});

// Finalize
app.post("/sessions/:id/finalize", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  let body: { accepted_portrait_image_id?: string | null } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    const result = await dreamWeaverSvc.finalize(userId, sessionId, body);
    return c.json(result);
  } catch (error: any) {
    const message = error?.message || "Finalize failed";
    if (
      message.includes("Workspace incomplete")
      || message.includes("Session not found")
      || message.includes("Portrait image not found")
    ) {
      return c.json({ error: message }, message.includes("Session not found") ? 404 : 400);
    }
    throw error;
  }
});

// Delete session
app.delete("/sessions/:id", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  dreamWeaverSvc.deleteSession(userId, sessionId);
  return c.json({ success: true });
});

app.get("/tools", (c) => {
  const tools = [HELP_TOOL, DREAM_SOURCE_TOOL, ...listTools()].map((t) => ({
    name: t.name,
    displayName: t.displayName,
    category: t.category,
    userInvocable: t.userInvocable,
    slashCommand: t.slashCommand ?? null,
    description: t.description,
    conflictMode: t.conflictMode,
  }));
  return c.json({ tools });
});

app.get("/sessions/:id/messages", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const session = dreamWeaverSvc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const messages = messagesSvc.listMessages(userId, sessionId);
  return c.json({ messages });
});

app.get("/sessions/:id/draft", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const session = dreamWeaverSvc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const draft = messagesSvc.deriveWorkspace(userId, sessionId);
  return c.json({ draft });
});

app.put("/sessions/:id/visual-assets", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const body = await c.req.json() as { visual_assets?: unknown };
  try {
    const draft = dreamWeaverSvc.updateVisualAssets(userId, sessionId, body.visual_assets);
    return c.json({ draft });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update visual assets";
    const status = message === "Session not found" ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

app.post("/sessions/:id/dream", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const session = dreamWeaverSvc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  try {
    dreamWeaverSvc.appendDreamSource(userId, sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not add dream source";
    return c.json({ error: message }, 422);
  }
  return c.json({ ok: true });
});

app.post("/sessions/:id/invoke", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const body = await c.req.json() as {
    tool: string;
    args?: Record<string, unknown>;
    nudge_text?: string | null;
    supersedes_id?: string | null;
    raw?: string | null;
  };

  const session = dreamWeaverSvc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  if (body.tool === "help") {
    const userCommand = messagesSvc.appendMessage({
      sessionId,
      userId,
      kind: "user_command",
      payload: {
        raw: body.raw?.trim() || "/help",
        parsed: { tool: "help", args: {} },
      },
    });
    const note = messagesSvc.appendMessage({
      sessionId,
      userId,
      kind: "system_note",
      payload: {
        text: buildToolHelpText(),
        level: "info",
      },
    });
    return c.json({ userCommandId: userCommand.id, cardId: note.id });
  }

  if (body.tool === "dream_source") {
    const content = (body.nudge_text ?? body.raw ?? "").replace(/^\/dream\b/i, "").trim();
    if (!content) return c.json({ error: "Dream source text is required" }, 400);
    const userCommand = messagesSvc.appendMessage({
      sessionId,
      userId,
      kind: "user_command",
      payload: {
        raw: body.raw?.trim() || `/dream ${content}`,
        parsed: { tool: "dream_source", args: {} },
      },
    });
    const source = messagesSvc.appendMessage({
      sessionId,
      userId,
      kind: "source_card",
      payload: {
        id: crypto.randomUUID(),
        type: "dream",
        title: "Dream",
        content,
        tone: session.tone,
        constraints: session.constraints,
        dislikes: session.dislikes,
      },
      status: "accepted",
    });
    return c.json({ userCommandId: userCommand.id, cardId: source.id });
  }

  const tool = getTool(body.tool);
  if (!tool) return c.json({ error: `Unknown tool: ${body.tool}` }, 400);

  const isRetryOrNudge = !!body.supersedes_id;
  if (!tool.userInvocable && !isRetryOrNudge) {
    return c.json({ error: `Tool ${body.tool} is not user-invocable` }, 403);
  }

  const workspace = messagesSvc.deriveWorkspace(userId, sessionId);
  if (workspace.sources.length === 0) {
    return c.json({ error: "Add source material with /dream before running generation tools." }, 400);
  }

  if (body.supersedes_id) {
    const checked = getSessionMessage(userId, sessionId, body.supersedes_id);
    if ("error" in checked) return c.json({ error: checked.error }, checked.status);
    messagesSvc.markSuperseded(userId, body.supersedes_id);
  }

  let userCommandId: string | null = null;
  if (tool.userInvocable) {
    const um = messagesSvc.appendMessage({
      sessionId,
      userId,
      kind: "user_command",
      payload: {
        raw: body.raw?.trim() || tool.slashCommand || `/${tool.name}`,
        parsed: { tool: tool.name, args: body.args ?? {} },
      },
    });
    userCommandId = um.id;
  }

  const card = messagesSvc.appendMessage({
    sessionId,
    userId,
    kind: "tool_card",
    payload: {
      tool: tool.name,
      args: body.args ?? {},
      output: null,
      error: null,
      nudge_text: body.nudge_text ?? null,
      duration_ms: null,
      token_usage: null,
    },
    toolName: tool.name,
    status: "running",
    supersedesId: body.supersedes_id ?? null,
  });

  void dreamWeaverSvc.runToolCard(userId, card.id);

  return c.json({ userCommandId, cardId: card.id });
});

app.post("/sessions/:id/suite", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  try {
    const result = await dreamWeaverSvc.runDefaultSuite(userId, sessionId);
    return c.json(result, 201);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Suite failed";
    if (message === "Session not found") return c.json({ error: message }, 404);
    if (message.includes("Add source material")) return c.json({ error: message }, 400);
    return c.json({ error: "Suite failed. Check the connection and try again." }, 422);
  }
});

app.put("/sessions/:sid/messages/:mid/source", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sid");
  const checked = getSessionMessage(userId, sessionId, c.req.param("mid"));
  if ("error" in checked) return c.json({ error: checked.error }, checked.status);

  const body = await c.req.json().catch(() => ({})) as { content?: unknown };
  if (typeof body.content !== "string") {
    return c.json({ error: "Dream source text is required" }, 400);
  }

  try {
    const updated = messagesSvc.updateSourceMessageContent(userId, sessionId, c.req.param("mid"), body.content);
    return c.json(updated);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Could not update source";
    if (message === "Message not found") return c.json({ error: message }, 404);
    if (message === "Not a source message") return c.json({ error: message }, 400);
    if (message.includes("required")) return c.json({ error: message }, 400);
    throw error;
  }
});

app.post("/sessions/:sid/messages/:mid/accept", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sid");
  const checked = getSessionMessage(userId, sessionId, c.req.param("mid"));
  if ("error" in checked) return c.json({ error: checked.error }, checked.status);
  const updated = messagesSvc.acceptToolCard(userId, c.req.param("mid"));
  return c.json(updated);
});

app.post("/sessions/:sid/messages/:mid/reject", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sid");
  const checked = getSessionMessage(userId, sessionId, c.req.param("mid"));
  if ("error" in checked) return c.json({ error: checked.error }, checked.status);
  const updated = messagesSvc.rejectToolCard(userId, c.req.param("mid"));
  return c.json(updated);
});

app.post("/sessions/:sid/messages/:mid/cancel", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sid");
  const messageId = c.req.param("mid");
  const checked = getSessionMessage(userId, sessionId, messageId);
  if ("error" in checked) return c.json({ error: checked.error }, checked.status);
  dreamWeaverSvc.cancelToolCard(userId, messageId);
  return c.json({ ok: true });
});

// Import ComfyUI workflow
app.post("/visual/workflows/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  const { connectionId, workflow } = body;
  if (!connectionId || typeof connectionId !== "string") {
    return c.json({ error: "connectionId is required" }, 400);
  }
  if (workflow === undefined || workflow === null) {
    return c.json({ error: "workflow is required" }, 400);
  }

  const connection = getConnection(userId, connectionId);
  if (!connection) return c.json({ error: "Connection not found" }, 404);

  if (connection.provider !== "comfyui") {
    return c.json({ error: "Connection is not a ComfyUI connection" }, 400);
  }

  const objectInfo = await getComfyUIObjectInfo(connection.api_url || "http://localhost:8188");

  let normalized: ReturnType<typeof normalizeComfyUIWorkflow>;
  try {
    normalized = normalizeComfyUIWorkflow(workflow, objectInfo ?? undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }

  const detected = detectInjectionPoints(normalized.apiWorkflow);
  const mappings: ComfyUIFieldMapping[] = detected
    .filter((p) => p.suggestedAs !== null)
    .map((p) => ({
      nodeId: p.nodeId,
      fieldName: p.fieldName,
      mappedAs: p.suggestedAs as ComfyUIFieldMapping["mappedAs"],
      autoDetected: true,
    }));

  const config = {
    workflow_json: normalized.graphWorkflow,
    workflow_api_json: normalized.apiWorkflow,
    workflow_format: normalized.format,
    field_mappings: mappings,
    field_options: buildComfyUIWorkflowFieldOptions(normalized.apiWorkflow, objectInfo),
    imported_at: Date.now(),
  };

  const nextMetadata = writeComfyUIConfig(connection.metadata, config);
  await updateConnection(userId, connectionId, { metadata: nextMetadata });

  return c.json({ config });
});

// Update field mappings for an imported workflow
app.put("/visual/workflows/:connectionId/mappings", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("connectionId");
  const body = await c.req.json();

  if (!Array.isArray(body.mappings)) {
    return c.json({ error: "mappings must be an array" }, 400);
  }

  const connection = getConnection(userId, connectionId);
  if (!connection) return c.json({ error: "Connection not found" }, 404);

  const existing = readComfyUIConfig(connection.metadata);
  if (!existing) {
    return c.json({ error: "No workflow imported for this connection" }, 400);
  }

  const nextConfig = { ...existing, field_mappings: body.mappings as ComfyUIFieldMapping[] };
  const nextMetadata = writeComfyUIConfig(connection.metadata, nextConfig);
  await updateConnection(userId, connectionId, { metadata: nextMetadata });

  return c.json({ config: nextConfig });
});

// Get imported workflow config for a connection
app.get("/visual/workflows/:connectionId", (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("connectionId");

  const connection = getConnection(userId, connectionId);
  if (!connection) return c.json({ error: "Connection not found" }, 404);

  const config = readComfyUIConfig(connection.metadata);
  return c.json({ config });
});

// Get discovered ComfyUI capabilities for a connection
app.get("/visual/comfyui/:connectionId/capabilities", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("connectionId");
  const forceRefresh = c.req.query("refresh") === "1";

  const connection = getConnection(userId, connectionId);
  if (!connection) return c.json({ error: "Connection not found" }, 404);
  if (connection.provider !== "comfyui") {
    return c.json({ error: "Connection is not a ComfyUI connection" }, 400);
  }

  const capabilities = await discoverCapabilities(
    connection.api_url || "http://localhost:8188",
    forceRefresh,
  );

  return c.json({ capabilities });
});

// Suggest a compact positive tag block using the Dream Weaver text connection
app.post("/visual/tag-suggestions", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  const { sessionId } = body as {
    sessionId: string;
  };
  if (!sessionId) {
    return c.json({ error: "sessionId is required" }, 400);
  }

  const session = dreamWeaverSvc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const workspace = messagesSvc.deriveWorkspace(userId, sessionId);
  const draft = dreamWeaverSvc.getLegacyDraftSnapshot(userId, sessionId);
  if (!workspace.name && !workspace.personality) {
    return c.json({ error: "Generate or accept card fields first." }, 400);
  }

  const dwParams = getDWGenParams(userId);
  const dwAbort = createDWTimeout(dwParams);

  try {
    const result = await suggestVisualTags({
      userId,
      connectionId: session.connection_id,
      model: session.model,
      draft,
      params: dwParams,
      signal: dwAbort?.signal,
    });
    return c.json(result);
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || error.message.includes("abort"));
    const message = isAbort
      ? "Tag generation timed out."
      : publicDreamWeaverTextError(error, "Tag generation failed. Check the text connection and try again.");
    return c.json({ error: message }, 422);
  } finally {
    dwAbort?.cleanup();
  }
});

// Start a visual generation job
app.post("/visual/jobs", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  const { sessionId, asset, connectionId } = body as {
    sessionId: string;
    asset: DreamWeaverVisualAsset;
    connectionId: string;
  };

  if (!sessionId || !asset || !connectionId) {
    return c.json({ error: "sessionId, asset, and connectionId are required" }, 400);
  }

  const connection = getConnection(userId, connectionId);
  if (!connection) return c.json({ error: "Connection not found" }, 404);
  const session = dreamWeaverSvc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (asset.asset_type !== "card_portrait") {
    return c.json({ error: "Only card portrait assets can be generated from Dream Weaver" }, 400);
  }
  const draft = dreamWeaverSvc.getLegacyDraftSnapshot(userId, sessionId);

  const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(connectionId)) ?? "";

  const imageGenSettings = getImageGenSettings(userId);
  const timeoutSecs = imageGenSettings.generationTimeoutSeconds ?? 300;
  const controller = timeoutSecs > 0 ? new AbortController() : null;
  const timeoutHandle = controller
    ? setTimeout(() => controller.abort(new Error(`Dream Weaver generation timed out after ${timeoutSecs}s`)), timeoutSecs * 1000)
    : null;

  const job = startDreamWeaverVisualJob({
    userId,
    sessionId,
    draft,
    asset,
    connection,
    apiKey,
    signal: controller?.signal,
    onSettled: timeoutHandle !== null ? () => clearTimeout(timeoutHandle) : undefined,
    persistResult: async ({ job, result }) => {
      if (!result.image_url || !result.image_url.startsWith("data:image/")) {
        console.debug("[DreamWeaver:Visual] persistResult: no data URL to persist (job=%s, has_url=%s)", job.id, Boolean(result.image_url));
        return result;
      }

      try {
        const image = await imagesSvc.saveImageFromDataUrl(
          userId,
          result.image_url,
          `${imagesSvc.IMAGE_GEN_FILENAME_PREFIX}dream-weaver-${job.sessionId}-${job.assetId}.png`,
        );
        console.debug("[DreamWeaver:Visual] persistResult: saved image=%s (job=%s)", image.id, job.id);

        return {
          ...result,
          image_id: image.id,
          image_url: undefined,
        };
      } catch (err) {
        console.error("[DreamWeaver:Visual] persistResult: failed to save image (job=%s) error=%s", job.id, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
  });

  return c.json(job, 201);
});

// Get visual job status
app.get("/visual/jobs/:jobId", (c) => {
  const userId = c.get("userId");
  const jobId = c.req.param("jobId");
  const job = getDreamWeaverVisualJob(userId, jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

export { app as dreamWeaverRoutes };
