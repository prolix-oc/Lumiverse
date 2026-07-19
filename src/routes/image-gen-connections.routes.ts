import { Hono } from "hono";
import * as svc from "../services/image-gen-connections.service";
import { getImageProviderList } from "../image-gen/registry";
import { normalizeComfyUIWorkflow, detectComfyUIWorkflowFormat, findUnsupportedApiNodeTypes } from "../image-gen/comfyui-import";
import { discoverCapabilities, getComfyUIObjectInfo, resolveComfyTarget } from "../image-gen/comfyui-discovery";
import {
  readComfyUIConfig,
  readComfyUIWorkflowLibrary,
  syncActiveComfyUIWorkflowToLibrary,
  writeComfyUIConfig,
  writeComfyUIWorkflowLibrary,
} from "../image-gen/comfyui-workflow-storage";
import type { ComfyUIWorkflowLibrary } from "../image-gen/comfyui-workflow-storage";
import { buildComfyUIWorkflowFieldOptions } from "../image-gen/comfyui-workflow-field-options";
import type { ComfyUIFieldMapping } from "../image-gen/comfyui-workflow-patch";
import { parsePagination } from "../services/pagination";
import * as secretsSvc from "../services/secrets.service";
import { imageGenConnectionSecretKey } from "../services/image-gen-connections.service";

function isComfyCapableConnection(provider: string): boolean {
  return provider === "comfyui" || provider === "swarmui";
}

function summarizeComfyWorkflowLibrary(library: ComfyUIWorkflowLibrary) {
  return {
    workflows: library.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      updated_at: entry.updated_at,
      node_count: Object.keys(entry.config.workflow_api_json ?? {}).length,
    })),
    active_id: library.activeId,
  };
}

function getComfyCapableConnection(userId: string, connectionId: string) {
  const connection = svc.getConnection(userId, connectionId);
  if (!connection) return { connection: null, error: "Connection not found", status: 404 as const };
  if (!isComfyCapableConnection(connection.provider)) {
    return { connection: null, error: "Connection does not support ComfyUI workflows", status: 400 as const };
  }
  return { connection, error: null, status: null };
}

async function resolveComfyConnectionTarget(
  userId: string,
  connection: { id: string; provider: string; api_url?: string | null },
) {
  const apiKey = connection.provider === "swarmui"
    ? await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(connection.id))
    : undefined;
  return resolveComfyTarget(connection, apiKey ?? undefined);
}

// Side-effect import: registers all image gen providers in the registry
import "../image-gen/index";

const app = new Hono();

/** List all image gen providers with capabilities */
app.get("/providers", (c) => {
  const providers = getImageProviderList().map((p) => ({
    id: p.name,
    name: p.displayName,
    capabilities: p.capabilities,
  }));
  return c.json({ providers });
});

/** List image gen connections (paginated) */
app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listConnections(userId, pagination));
});

/** Create image gen connection */
app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.provider) {
    return c.json({ error: "name and provider are required" }, 400);
  }
  const conn = await svc.createConnection(userId, body);
  return c.json(conn, 201);
});

app.post("/models/preview", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.provider) return c.json({ error: "provider is required" }, 400);
  const result = await svc.listConnectionModelsPreview(userId, body);
  return c.json(result);
});

/** Get image gen connection by ID */
app.get("/:id", (c) => {
  const userId = c.get("userId");
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn);
});

/** Update image gen connection */
app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const conn = await svc.updateConnection(userId, c.req.param("id"), body);
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn);
});

/** Delete image gen connection */
app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  if (!(await svc.deleteConnection(userId, c.req.param("id")))) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ success: true });
});

/** Test image gen connection */
app.post("/:id/test", async (c) => {
  const userId = c.get("userId");
  const result = await svc.testConnection(userId, c.req.param("id"));
  return c.json(result);
});

/** List available models for connection */
app.get("/:id/models", async (c) => {
  const userId = c.get("userId");
  const result = await svc.listConnectionModels(userId, c.req.param("id"));
  return c.json(result);
});

app.post("/:id/comfyui/workflow/import", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");
  const body = await c.req.json();
  const workflow = body?.workflow;

  if (workflow === undefined || workflow === null) {
    return c.json({ error: "workflow is required" }, 400);
  }

  const connection = svc.getConnection(userId, connectionId);
  if (!connection) return c.json({ error: "Connection not found" }, 404);
  if (!isComfyCapableConnection(connection.provider)) {
    return c.json({ error: "Connection does not support ComfyUI workflows" }, 400);
  }

  if (detectComfyUIWorkflowFormat(workflow) === "ui_workflow") {
    return c.json({
      error:
        "That's the UI workflow export. Import the API-format export instead: in ComfyUI enable Settings -> Enable Dev mode Options, then use Save (API Format).",
    }, 400);
  }

  const target = await resolveComfyConnectionTarget(userId, connection);
  const objectInfo = await getComfyUIObjectInfo(target.baseUrl, false, { cookie: target.cookie });
  let normalized: ReturnType<typeof normalizeComfyUIWorkflow>;
  try {
    normalized = normalizeComfyUIWorkflow(workflow, objectInfo ?? undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }

  const config = {
    workflow_json: normalized.graphWorkflow,
    workflow_api_json: normalized.apiWorkflow,
    workflow_format: normalized.format,
    field_mappings: [] as ComfyUIFieldMapping[],
    field_options: buildComfyUIWorkflowFieldOptions(normalized.apiWorkflow, objectInfo),
    imported_at: Date.now(),
  };

  await svc.updateConnection(userId, connectionId, {
    metadata: syncActiveComfyUIWorkflowToLibrary(connection.metadata, config, Date.now()),
  });

  return c.json({ config: { ...config, unknown_nodes: normalized.unknownNodes } });
});

app.get("/:id/comfyui/workflow", async (c) => {
  const userId = c.get("userId");
  const connection = svc.getConnection(userId, c.req.param("id"));
  if (!connection) return c.json({ error: "Connection not found" }, 404);
  if (!isComfyCapableConnection(connection.provider)) {
    return c.json({ error: "Connection does not support ComfyUI workflows" }, 400);
  }

  const config = readComfyUIConfig(connection.metadata);
  if (!config) return c.json({ config: null });

  const target = await resolveComfyConnectionTarget(userId, connection);
  const objectInfo = await getComfyUIObjectInfo(target.baseUrl, false, { cookie: target.cookie });
  const unknownNodes = findUnsupportedApiNodeTypes(config.workflow_api_json, objectInfo);

  return c.json({ config: { ...config, unknown_nodes: unknownNodes } });
});

app.put("/:id/comfyui/workflow/mappings", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");
  const body = await c.req.json();
  if (!Array.isArray(body?.mappings)) {
    return c.json({ error: "mappings must be an array" }, 400);
  }

  const connection = svc.getConnection(userId, connectionId);
  if (!connection) return c.json({ error: "Connection not found" }, 404);
  if (!isComfyCapableConnection(connection.provider)) {
    return c.json({ error: "Connection does not support ComfyUI workflows" }, 400);
  }

  const existing = readComfyUIConfig(connection.metadata);
  if (!existing) return c.json({ error: "No workflow imported for this connection" }, 400);

  const config = { ...existing, field_mappings: body.mappings as ComfyUIFieldMapping[] };
  await svc.updateConnection(userId, connectionId, {
    metadata: syncActiveComfyUIWorkflowToLibrary(connection.metadata, config, Date.now()),
  });

  return c.json({ config });
});

app.get("/:id/comfyui/workflows", (c) => {
  const userId = c.get("userId");
  const { connection, error, status } = getComfyCapableConnection(userId, c.req.param("id"));
  if (!connection) return c.json({ error }, status);
  return c.json(summarizeComfyWorkflowLibrary(readComfyUIWorkflowLibrary(connection.metadata)));
});

app.post("/:id/comfyui/workflows", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");
  const body = await c.req.json();
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);

  const { connection, error, status } = getComfyCapableConnection(userId, connectionId);
  if (!connection) return c.json({ error }, status);

  const config = readComfyUIConfig(connection.metadata);
  if (!config) return c.json({ error: "No workflow imported for this connection" }, 400);

  const library = readComfyUIWorkflowLibrary(connection.metadata);
  const entry = { id: crypto.randomUUID(), name, updated_at: Date.now(), config };
  const next = { entries: [...library.entries, entry], activeId: entry.id };
  await svc.updateConnection(userId, connectionId, {
    metadata: writeComfyUIWorkflowLibrary(connection.metadata, next),
  });

  return c.json(summarizeComfyWorkflowLibrary(next), 201);
});

app.put("/:id/comfyui/workflows/:workflowId", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");
  const workflowId = c.req.param("workflowId");
  const body = await c.req.json();
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);

  const { connection, error, status } = getComfyCapableConnection(userId, connectionId);
  if (!connection) return c.json({ error }, status);

  const library = readComfyUIWorkflowLibrary(connection.metadata);
  if (!library.entries.some((e) => e.id === workflowId)) {
    return c.json({ error: "Workflow not found" }, 404);
  }

  const next = {
    entries: library.entries.map((e) => (e.id === workflowId ? { ...e, name } : e)),
    activeId: library.activeId,
  };
  await svc.updateConnection(userId, connectionId, {
    metadata: writeComfyUIWorkflowLibrary(connection.metadata, next),
  });

  return c.json(summarizeComfyWorkflowLibrary(next));
});

app.post("/:id/comfyui/workflows/:workflowId/activate", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");
  const workflowId = c.req.param("workflowId");

  const { connection, error, status } = getComfyCapableConnection(userId, connectionId);
  if (!connection) return c.json({ error }, status);

  const library = readComfyUIWorkflowLibrary(connection.metadata);
  const entry = library.entries.find((e) => e.id === workflowId);
  if (!entry) return c.json({ error: "Workflow not found" }, 404);

  const next = { entries: library.entries, activeId: entry.id };
  const metadata = writeComfyUIWorkflowLibrary(
    writeComfyUIConfig(connection.metadata, entry.config),
    next,
  );
  await svc.updateConnection(userId, connectionId, { metadata });

  const target = await resolveComfyConnectionTarget(userId, connection);
  const objectInfo = await getComfyUIObjectInfo(target.baseUrl, false, { cookie: target.cookie });
  const unknownNodes = findUnsupportedApiNodeTypes(entry.config.workflow_api_json, objectInfo);

  return c.json({
    config: { ...entry.config, unknown_nodes: unknownNodes },
    ...summarizeComfyWorkflowLibrary(next),
  });
});

app.delete("/:id/comfyui/workflows/:workflowId", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");
  const workflowId = c.req.param("workflowId");

  const { connection, error, status } = getComfyCapableConnection(userId, connectionId);
  if (!connection) return c.json({ error }, status);

  const library = readComfyUIWorkflowLibrary(connection.metadata);
  if (!library.entries.some((e) => e.id === workflowId)) {
    return c.json({ error: "Workflow not found" }, 404);
  }

  const next = {
    entries: library.entries.filter((e) => e.id !== workflowId),
    activeId: library.activeId === workflowId ? null : library.activeId,
  };
  await svc.updateConnection(userId, connectionId, {
    metadata: writeComfyUIWorkflowLibrary(connection.metadata, next),
  });

  return c.json(summarizeComfyWorkflowLibrary(next));
});

app.get("/:id/comfyui/capabilities", async (c) => {
  const userId = c.get("userId");
  const connection = svc.getConnection(userId, c.req.param("id"));
  if (!connection) return c.json({ error: "Connection not found" }, 404);
  if (!isComfyCapableConnection(connection.provider)) {
    return c.json({ error: "Connection does not support ComfyUI workflows" }, 400);
  }

  const target = await resolveComfyConnectionTarget(userId, connection);
  const capabilities = await discoverCapabilities(
    target.baseUrl,
    c.req.query("refresh") === "1",
    { cookie: target.cookie },
  );
  return c.json({ capabilities });
});

app.get("/:id/nanogpt-usage", async (c) => {
  const userId = c.get("userId");
  const result = await svc.fetchNanoGptSubscriptionUsage(userId, c.req.param("id"));
  if (!result) return c.json({ error: "Failed to fetch NanoGPT usage" }, 502);
  return c.json(result);
});

/** List models for a specific component subtype (e.g. "vae", "text_encoders") */
app.get("/:id/models/:subtype", async (c) => {
  const userId = c.get("userId");
  const result = await svc.listConnectionModelsBySubtype(
    userId,
    c.req.param("id"),
    c.req.param("subtype"),
  );
  return c.json(result);
});

/** Set or update API key */
app.put("/:id/api-key", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.api_key) return c.json({ error: "api_key is required" }, 400);
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  await svc.setConnectionApiKey(userId, c.req.param("id"), body.api_key);
  return c.json({ success: true });
});

/** Remove API key */
app.delete("/:id/api-key", async (c) => {
  const userId = c.get("userId");
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  await svc.clearConnectionApiKey(userId, c.req.param("id"));
  return c.json({ success: true });
});

/** Duplicate image gen connection */
app.post("/:id/duplicate", async (c) => {
  const userId = c.get("userId");
  const conn = await svc.duplicateConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn, 201);
});

export { app as imageGenConnectionsRoutes };
