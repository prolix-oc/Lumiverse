import { Hono } from "hono";
import * as dreamWeaverSvc from "../services/dream-weaver/dream-weaver.service";
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
import type { DreamWeaverVisualAsset, DW_DRAFT_V1 } from "../types/dream-weaver";

const app = new Hono();

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

// Generate draft
app.post("/sessions/:id/generate", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const session = dreamWeaverSvc.generateDraft(userId, sessionId);
  return c.json(session);
});

// Generate world package (fire-and-forget — progress via WS events)
app.post("/sessions/:id/generate/world", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const session = dreamWeaverSvc.generateWorld(userId, sessionId);
  return c.json(session);
});

// Finalize
app.post("/sessions/:id/finalize", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const result = await dreamWeaverSvc.finalize(userId, sessionId);
  return c.json(result);
});

// Extend draft (additive generation)
app.post("/sessions/:id/extend", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const result = await dreamWeaverSvc.extendDraft(userId, sessionId, body);
  return c.json(result);
});

// Delete session
app.delete("/sessions/:id", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  dreamWeaverSvc.deleteSession(userId, sessionId);
  return c.json({ success: true });
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

  const { sessionId, draft: providedDraft } = body as {
    sessionId: string;
    draft?: DW_DRAFT_V1 | null;
  };
  if (!sessionId) {
    return c.json({ error: "sessionId is required" }, 400);
  }

  const session = dreamWeaverSvc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const draft = providedDraft ?? dreamWeaverSvc.parseStoredDreamWeaverDraft(session.draft);
  if (!draft) {
    return c.json({ error: "Generate a Soul draft first." }, 400);
  }

  const dwParams = getDWGenParams(userId);
  const dwAbort = createDWTimeout(dwParams);

  try {
    const result = await suggestVisualTags({
      userId,
      connectionId: session.connection_id,
      draft,
      params: dwParams,
      signal: dwAbort?.signal,
    });
    return c.json(result);
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || error.message.includes("abort"));
    const message = isAbort
      ? "Tag generation timed out."
      : error instanceof Error ? error.message : "Tag generation failed.";
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
    draft: dreamWeaverSvc.parseStoredDreamWeaverDraft(session.draft),
    asset,
    connection,
    apiKey,
    signal: controller?.signal,
    onSettled: timeoutHandle !== null ? () => clearTimeout(timeoutHandle) : undefined,
    persistResult: async ({ job, result }) => {
      if (!result.image_url || !result.image_url.startsWith("data:image/")) {
        return result;
      }

      const image = await imagesSvc.saveImageFromDataUrl(
        userId,
        result.image_url,
        `${imagesSvc.IMAGE_GEN_FILENAME_PREFIX}dream-weaver-${job.sessionId}-${job.assetId}.png`,
      );

      return {
        ...result,
        image_id: image.id,
        image_url: undefined,
      };
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
