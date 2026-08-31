import { createHash } from "node:crypto";
import { Hono } from "hono";
import * as svc from "../services/presets.service";
import * as stashSvc from "../services/prompt-stash.service";
import * as presetExportSvc from "../services/preset-export.service";
import { PresetRevisionConflictError } from "../types/preset";
import { AgentConfigValidationError } from "../types/agents";
import { parsePagination } from "../services/pagination";
import { REVALIDATE_PRIVATE, ifNoneMatchSatisfies } from "../utils/http-cache";
import { getAgentRuntimeHostLimits } from "../services/agent-runtime-limits";
import {
  acknowledgeRuntimeRepair,
  RuntimeDecisionError,
} from "../services/agent-runtime-decision.service";
import { AgentConfigRevisionConflictError, duplicatePresetWithAgentConfig, encodePortableAgentConfig, getAgentRuntimeSharedDraft, getPortablePresetRuntimeEnvelope, getPresetAgentConfig, importPortablePreset, importPortablePresetRuntime, parsePortablePresetPayload, parsePortablePresetRuntimeImportRequest, saveAgentRuntimeSharedDraft } from "../services/agent-config-portability.service";
import { materializePortableSealedPresetImport, PortableSealedPresetError } from "../lumihub/sealed-presets";

const app = new Hono();
const MAX_BULK_PRESET_IDS = 200;

function parseBulkPresetIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_PRESET_IDS) return null;
  const ids = value.filter((id): id is string => typeof id === "string" && !!id.trim()).map((id) => id.trim());
  if (ids.length !== value.length) return null;
  return [...new Set(ids)];
}

function userEtagScope(userId: string): string {
  return createHash("sha256").update(userId).digest("base64url");
}
const PORTABLE_PUBLIC_ERROR_CODES: Record<string, true> = {
  AGENT_RUNTIME_PORTABLE_INVALID: true,
  AGENT_RUNTIME_PORTABLE_STALE: true,
  AGENT_RUNTIME_PORTABLE_CONTRADICTORY: true,
  AGENT_RUNTIME_PORTABLE_REGEX_INVALID: true,
  AGENT_RUNTIME_PORTABLE_PRESET_INVALID: true,
  AGENT_RUNTIME_PORTABLE_CONFIG_REFERENCE_INVALID: true,
  AGENT_RUNTIME_PORTABLE_COGNITION_INVALID: true,
  PORTABLE_PRESET_INVALID: true,
  PORTABLE_PROMPT_BLOCK_INVALID: true,
  PORTABLE_EXPORT_UNSTABLE: true,
  LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE: true,
  LUMIHUB_LINK_UNAVAILABLE: true,
  LUMIHUB_SEALED_RESOLUTION_FAILED: true,
  LUMIHUB_SEALED_DIGEST_MISMATCH: true,
  PRESET_REVISION_CONFLICT: true,
  PRESET_REVISION_REQUIRED: true,
  AGENT_CONFIG_REVISION_CONFLICT: true,
  AGENT_CONFIG_REVISION_REQUIRED: true,
};

function portablePublicErrorCode(error: unknown, fallback: string): string {
  if (error instanceof PortableSealedPresetError) return error.code;
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const body = record?.body && typeof record.body === "object" ? record.body as Record<string, unknown> : null;
  const candidate = typeof body?.code === "string"
    ? body.code
    : typeof record?.code === "string"
      ? record.code
      : error instanceof Error ? error.message.match(/^[A-Z][A-Z0-9_]+/)?.[0] : undefined;
  return candidate && PORTABLE_PUBLIC_ERROR_CODES[candidate] ? candidate : fallback;
}

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listPresets(userId, pagination));
});

app.get("/registry", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const provider = c.req.query("provider") || undefined;
  const engine = c.req.query("engine") || undefined;

  // Hashing the filtered `(id, cache_revision)` sequence catches every update
  // and delete/create replacement without reading preset JSON blobs.
  const sig = svc.getPresetRegistrySignature(userId, provider, engine);
  const etag = `W/"presets-reg-${sig}-${pagination.limit}-${pagination.offset}"`;
  if (ifNoneMatchSatisfies(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": REVALIDATE_PRIVATE, Vary: "Cookie, Accept-Encoding" } });
  }
  c.header("ETag", etag);
  c.header("Cache-Control", REVALIDATE_PRIVATE);
  c.header("Vary", "Cookie, Accept-Encoding");
  return c.json(svc.listPresetRegistry(userId, pagination, provider, engine));
});

app.post("/bulk-delete", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = body ? parseBulkPresetIds(body.ids) : null;
  if (!ids) return c.json({ error: "ids must be a non-empty array of at most 200 strings" }, 400);
  const deleted = ids.filter((id) => svc.deletePreset(c.get("userId"), id));
  return c.json({ deleted });
});

app.post("/bulk-export/prepare", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = body ? parseBulkPresetIds(body.ids) : null;
  if (!ids) return c.json({ error: "ids must be a non-empty array of at most 200 strings" }, 400);
  const prepared = presetExportSvc.preparePresetBulkExport(c.get("userId"), ids);
  if (!prepared) return c.json({ error: "No exportable presets found" }, 404);
  return c.json(prepared);
});

app.get("/bulk-export/:downloadId", (c) => {
  const prepared = presetExportSvc.consumePreparedPresetExport(c.get("userId"), c.req.param("downloadId"));
  if (!prepared) return c.json({ error: "Export session not found. Prepare the export again." }, 404);
  const stream = presetExportSvc.buildPresetBulkExportStream(
    prepared.userId,
    prepared.presetIds,
    c.req.raw.signal,
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${prepared.filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Transfer-Encoding": "chunked",
      "X-Accel-Buffering": "no",
    },
  });
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.provider) return c.json({ error: "name and provider are required" }, 400);
  try {
    return c.json(svc.createPreset(userId, body), 201);
  } catch (err) {
    if (err instanceof AgentConfigValidationError) {
      return c.json({ error: err.message, code: err.code, path: err.path }, 400);
    }
    throw err;
  }
});

app.get("/stash", (c) => {
  return c.json(stashSvc.listPromptStash(c.get("userId")));
});

app.post("/stash", async (c) => {
  const body = await c.req.json();
  try {
    if (!body?.block || typeof body.block !== "object") return c.json({ error: "block is required" }, 400);
    const userId = c.get("userId");
    const sourcePreset = typeof body.sourcePresetId === "string"
      ? svc.getPreset(userId, body.sourcePresetId)
      : null;
    return c.json(
      stashSvc.addPromptBlockToStash(
        userId,
        body.block,
        sourcePreset ? { id: sourcePreset.id, name: sourcePreset.name } : undefined,
      ),
      201,
    );
  } catch (err: any) {
    return c.json({ error: err?.message || "Unable to add prompt block to stash" }, 400);
  }
});

app.delete("/stash/:stashId", (c) => {
  const result = stashSvc.removePromptBlockFromStash(c.get("userId"), c.req.param("stashId"));
  if (!result.removed) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true, ...result });
});

app.get("/agent-runtime-limits", (c) => {
  return c.json(getAgentRuntimeHostLimits());
});

app.get("/:id/agent-config", (c) => {
  const editor = getAgentRuntimeSharedDraft(c.get("userId"), c.req.param("id"));
  if (!editor) return c.json({ error: "Not found" }, 404);
  return c.json(editor);
});

app.put("/:id/agent-config", async (c) => {
  try {
    const body = await c.req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("AGENT_RUNTIME_DRAFT_INVALID");
    const allowedKeys: Record<string, true> = { config: true, slotBindings: true, taskTemplates: true, reviewAcknowledgements: true, promptOrder: true, expectedPresetRevision: true, expectedConfigRevision: true };
    for (const key of Object.keys(body)) if (!allowedKeys[key]) throw new Error("AGENT_RUNTIME_DRAFT_UNKNOWN_FIELD");
    for (const key of Object.keys(allowedKeys)) if (!Object.hasOwn(body, key)) throw new Error("AGENT_RUNTIME_DRAFT_MISSING_FIELD");
    const result = saveAgentRuntimeSharedDraft(c.get("userId"), c.req.param("id"), {
      config: body.config, slotBindings: body.slotBindings, taskTemplates: body.taskTemplates, reviewAcknowledgements: body.reviewAcknowledgements, promptOrder: body.promptOrder, expectedPresetRevision: body.expectedPresetRevision, expectedConfigRevision: body.expectedConfigRevision,
    });
    return c.json(result);
  } catch (error: any) {
    const message = error?.message || "Invalid agent runtime draft";
    const errorCode = typeof error?.code === "string" ? error.code : undefined;
    const code = errorCode === "PRESET_REVISION_CONFLICT" || errorCode === "AGENT_CONFIG_REVISION_CONFLICT"
      ? errorCode
      : message === "PRESET_REVISION_CONFLICT" || message === "AGENT_CONFIG_REVISION_CONFLICT"
        ? message
        : message === "PRESET_REVISION_REQUIRED" || message === "AGENT_CONFIG_REVISION_REQUIRED"
          ? message
          : "AGENT_CONFIG_INVALID";
    if (error instanceof AgentConfigRevisionConflictError) {
      const presetId = c.req.param("id");
      const canonicalPreset = svc.getPreset(c.get("userId"), presetId);
      const canonicalEditor = getAgentRuntimeSharedDraft(c.get("userId"), presetId);
      return c.json({
        error: message,
        code,
        preset_id: presetId,
        expectedConfigRevision: error.expectedConfigRevision,
        actualConfigRevision: error.actualConfigRevision,
        preset: canonicalPreset,
        editor: canonicalEditor,
        configRevision: canonicalEditor?.configRevision ?? error.actualConfigRevision,
      }, 409);
    }
    return c.json({ error: message, code }, code.endsWith("CONFLICT") ? 409 : code === "PRESET_REVISION_REQUIRED" || code === "AGENT_CONFIG_REVISION_REQUIRED" ? 428 : 400);
  }
});

app.post("/:id/agent-runtime/repair-acknowledgement", async (c) => {
  const userId = c.get("userId");
  const presetId = c.req.param("id");
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Request body must be an object", code: "INVALID_REQUEST" }, 400);
    }
    const keys = Object.keys(body);
    if (keys.some((key) => key !== "expectedPresetRevision" && key !== "reasonCode")) {
      return c.json({ error: "Only expectedPresetRevision and reasonCode are allowed", code: "INVALID_REQUEST" }, 400);
    }
    if (!Object.hasOwn(body, "expectedPresetRevision")) {
      return c.json({ error: "expectedPresetRevision is required", code: "PRESET_REVISION_REQUIRED" }, 428);
    }
    if (!Object.hasOwn(body, "reasonCode")) {
      return c.json({ error: "reasonCode is required", code: "INVALID_REQUEST" }, 400);
    }
    const expectedPresetRevision = body.expectedPresetRevision;
    if (!(
      (typeof expectedPresetRevision === "number" && Number.isSafeInteger(expectedPresetRevision) && expectedPresetRevision >= 0)
      || (typeof expectedPresetRevision === "string" && expectedPresetRevision.length > 0 && expectedPresetRevision.length <= 512)
    )) {
      return c.json({ error: "expectedPresetRevision must be a revision", code: "INVALID_REQUEST" }, 400);
    }
    if (typeof body.reasonCode !== "string" || body.reasonCode.trim().length === 0 || body.reasonCode.length > 512) {
      return c.json({ error: "reasonCode must be a bounded string", code: "INVALID_REQUEST" }, 400);
    }
    const acknowledgement = acknowledgeRuntimeRepair(
      userId,
      presetId,
      expectedPresetRevision,
      body.reasonCode,
    );
    return c.json(acknowledgement);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400);
    }
    if (error instanceof RuntimeDecisionError) {
      if (error.code === "not_found") return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
      if (error.code === "decision_refresh_required") {
        return c.json({
          error: error.message,
          code: "PRESET_REVISION_CONFLICT",
          ...(error.details ?? {}),
        }, 409);
      }
      return c.json({ error: error.message, code: error.code.toUpperCase() }, error.status as 400 | 404 | 409 | 428 | 503);
    }
    return c.json({ error: "Repair acknowledgement unavailable", code: "RUNTIME_REPAIR_ACKNOWLEDGEMENT_UNAVAILABLE" }, 503);
  }
});

app.get("/:id/agent-runtime/portable", (c) => {
  try {
    const envelope = getPortablePresetRuntimeEnvelope(c.get("userId"), c.req.param("id"));
    if (!envelope) return c.json({ error: "Not found" }, 404);
    return c.json(envelope);
  } catch (error: unknown) {
    const code = portablePublicErrorCode(error, "AGENT_RUNTIME_PORTABLE_INVALID")
    return c.json({ error: code, code }, 400);
  }
});
app.post("/import-portable", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = parsePortablePresetRuntimeImportRequest(body);
    const materializedPreset = await materializePortableSealedPresetImport(c.get("userId"), parsed.preset);
    const result = importPortablePresetRuntime(c.get("userId"), {
      ...parsed,
      preset: materializedPreset,
    });
    return c.json(result, 201);
  } catch (error: unknown) {
    const code = portablePublicErrorCode(error, "AGENT_RUNTIME_PORTABLE_INVALID");
    const status = code === "PRESET_REVISION_CONFLICT"
      ? 409
      : code === "PRESET_REVISION_REQUIRED"
        ? 428
        : 400;
    return c.json({ error: code, code }, status);
  }
});

app.get("/:id/agent-config/portable", (c) => {
  const projection = getPresetAgentConfig(c.get("userId"), c.req.param("id"));
  if (!projection) return c.json({ error: "Not found" }, 404);
  return c.json(JSON.parse(encodePortableAgentConfig(projection.config)));
});

app.post("/agent-config/portable/import", async (c) => {
  try {
    const body = await c.req.json();
    const boundedPreset = parsePortablePresetPayload(body);
    const materialized = await materializePortableSealedPresetImport(c.get("userId"), boundedPreset);
    return c.json(importPortablePreset(c.get("userId"), materialized), 201);
  } catch (error: unknown) {
    const code = portablePublicErrorCode(error, "PORTABLE_PRESET_INVALID");
    return c.json({ error: code, code }, 400);
  }
});

app.post("/:id/duplicate", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json(duplicatePresetWithAgentConfig(c.get("userId"), c.req.param("id"), typeof body?.name === "string" ? body.name : undefined), 201);
  } catch (error: any) {
    return c.json({ error: error?.message || "Preset not found" }, error?.message === "Preset not found" ? 404 : 400);
  }
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  // The full preset embeds both prompt data and the normalized Agent Runtime.
  // Its validator must advance when either independently versioned half changes.
  const revision = svc.getPresetRepresentationRevision(userId, id);
  if (revision == null) return c.json({ error: "Not found" }, 404);

  const etag = `W/"preset-${id}-${revision.cacheRevision}-${revision.agentConfigRevision}-${userEtagScope(userId)}"`;
  if (ifNoneMatchSatisfies(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": REVALIDATE_PRIVATE, Vary: "Cookie, Accept-Encoding" } });
  }

  const preset = svc.getPreset(userId, id);
  if (!preset) return c.json({ error: "Not found" }, 404); // deleted between lookups
  c.header("ETag", etag);
  c.header("Cache-Control", REVALIDATE_PRIVATE);
  c.header("Vary", "Cookie, Accept-Encoding");
  return c.json(preset);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (
    typeof body.expected_cache_revision !== "number"
    || !Number.isSafeInteger(body.expected_cache_revision)
    || body.expected_cache_revision < 0
  ) {
    return c.json({
      error: "expected_cache_revision is required",
      code: "PRESET_REVISION_REQUIRED",
    }, 428);
  }
  if (
    Object.hasOwn(body, "agent_config")
    && body.agent_config !== undefined
    && (
      typeof body.expected_config_revision !== "number"
      || !Number.isSafeInteger(body.expected_config_revision)
      || body.expected_config_revision < 0
    )
  ) {
    return c.json({
      error: "expected_config_revision is required when agent_config is submitted",
      code: "AGENT_CONFIG_REVISION_REQUIRED",
    }, 428);
  }
  try {
    const preset = svc.updatePreset(userId, c.req.param("id"), body);
    if (!preset) return c.json({ error: "Not found" }, 404);
    return c.json(preset);
  } catch (err) {
    if (err instanceof PresetRevisionConflictError) {
      return c.json({
        error: err.message,
        code: err.code,
        expected_cache_revision: err.expectedCacheRevision,
        actual_cache_revision: err.actualCacheRevision,
      }, 409);
    }
    if (err instanceof AgentConfigRevisionConflictError) {
      const canonical = svc.getPreset(userId, c.req.param("id"));
      return c.json({
        error: err.message,
        code: err.code,
        preset_id: err.presetId,
        expected_config_revision: err.expectedConfigRevision,
        actual_config_revision: err.actualConfigRevision,
        preset: canonical,
        agent_config_revision: canonical?.agent_config_revision ?? err.actualConfigRevision,
        agent_config: canonical?.agent_config ?? null,
        agent_config_review: canonical?.agent_config_review ?? null,
        cache_revision: canonical?.cache_revision ?? null,
      }, 409);
    }
    if (err instanceof Error && err.message === "AGENT_CONFIG_REVISION_REQUIRED") {
      return c.json({ error: err.message, code: "AGENT_CONFIG_REVISION_REQUIRED" }, 428);
    }
    if (err instanceof AgentConfigValidationError) {
      return c.json({ error: err.message, code: err.code, path: err.path }, 400);
    }
    throw err;
  }
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  if (!svc.deletePreset(userId, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as presetsRoutes };
