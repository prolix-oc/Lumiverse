import { isDatabaseUnavailable } from "../db/execution";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as svc from "../services/presets.service";
import * as stashSvc from "../services/prompt-stash.service";
import * as presetExportSvc from "../services/preset-export.service";
import { PresetRevisionConflictError } from "../types/preset";
import { parsePagination } from "../services/pagination";
import { REVALIDATE_PRIVATE, ifNoneMatchSatisfies } from "../utils/http-cache";

const app = new Hono();
const MAX_BULK_PRESET_IDS = 200;
export const MAX_PRESET_BODY_BYTES = 50 * 1024 * 1024;

const presetBodyLimit = bodyLimit({
  maxSize: MAX_PRESET_BODY_BYTES,
  onError: (c) => c.json({ error: "Request body too large" }, 413),
});

function parseBulkPresetIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_PRESET_IDS) return null;
  const ids = value.filter((id): id is string => typeof id === "string" && !!id.trim()).map((id) => id.trim());
  if (ids.length !== value.length) return null;
  return [...new Set(ids)];
}

function userEtagScope(userId: string): string {
  return createHash("sha256").update(userId).digest("base64url");
}

app.get("/", async (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(await svc.listPresetsAsync(userId, pagination));
});

app.get("/registry", async (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const provider = c.req.query("provider") || undefined;
  const engine = c.req.query("engine") || undefined;

  // Hashing the filtered `(id, cache_revision)` sequence catches every update
  // and delete/create replacement without reading preset JSON blobs.
  const sig = await svc.getPresetRegistrySignatureAsync(userId, provider, engine);
  const etag = `W/"presets-reg-${sig}-${pagination.limit}-${pagination.offset}"`;
  if (ifNoneMatchSatisfies(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": REVALIDATE_PRIVATE, Vary: "Cookie, Accept-Encoding" } });
  }
  c.header("ETag", etag);
  c.header("Cache-Control", REVALIDATE_PRIVATE);
  c.header("Vary", "Cookie, Accept-Encoding");
  return c.json(await svc.listPresetRegistryAsync(userId, pagination, provider, engine));
});

app.post("/bulk-delete", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = body ? parseBulkPresetIds(body.ids) : null;
  if (!ids) return c.json({ error: "ids must be a non-empty array of at most 200 strings" }, 400);
  const deleted: string[] = [];
  for (const id of ids) if (await svc.deletePresetAsync(c.get("userId"), id)) deleted.push(id);
  return c.json({ deleted });
});

app.post("/bulk-export/prepare", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = body ? parseBulkPresetIds(body.ids) : null;
  if (!ids) return c.json({ error: "ids must be a non-empty array of at most 200 strings" }, 400);
  const prepared = await presetExportSvc.preparePresetBulkExportAsync(c.get("userId"), ids);
  if (!prepared) return c.json({ error: "No exportable presets found" }, 404);
  return c.json(prepared);
});

app.get("/bulk-export/:downloadId", async (c) => {
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

app.post("/", presetBodyLimit, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.provider) return c.json({ error: "name and provider are required" }, 400);
  return c.json(await svc.createPresetAsync(userId, body), 201);
});

app.get("/stash", async (c) => {
  return c.json(await stashSvc.listPromptStashAsync(c.get("userId")));
});

app.post("/stash", async (c) => {
  const body = await c.req.json();
  try {
    if (!body?.block || typeof body.block !== "object") return c.json({ error: "block is required" }, 400);
    const userId = c.get("userId");
    const sourcePreset = typeof body.sourcePresetId === "string"
      ? await svc.getPresetAsync(userId, body.sourcePresetId)
      : null;
    return c.json(
      await stashSvc.addPromptBlockToStashAsync(
        userId,
        body.block,
        sourcePreset ? { id: sourcePreset.id, name: sourcePreset.name } : undefined,
      ),
      201,
    );
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) throw err;
    return c.json({ error: err?.message || "Unable to add prompt block to stash" }, 400);
  }
});

app.delete("/stash/:stashId", async (c) => {
  const deleted = await stashSvc.removePromptBlockFromStashAsync(c.get("userId"), c.req.param("stashId"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.get("/:id/capabilities", async (c) => {
  const capabilities = await svc.getPresetCapabilitiesAsync(c.get("userId"), c.req.param("id"));
  return capabilities ? c.json(capabilities) : c.json({ error: "Not found" }, 404);
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  // A dedicated monotonic revision drives this ETag, so same-second updates
  // invalidate cache entries without altering the user's visible update time.
  const cacheRevision = await svc.getPresetCacheRevisionAsync(userId, id);
  if (cacheRevision == null) return c.json({ error: "Not found" }, 404);

  const etag = `W/"preset-${id}-${cacheRevision}-${userEtagScope(userId)}"`;
  if (ifNoneMatchSatisfies(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": REVALIDATE_PRIVATE, Vary: "Cookie, Accept-Encoding" } });
  }

  const preset = await svc.getPresetAsync(userId, id);
  if (!preset) return c.json({ error: "Not found" }, 404); // deleted between lookups
  c.header("ETag", etag);
  c.header("Cache-Control", REVALIDATE_PRIVATE);
  c.header("Vary", "Cookie, Accept-Encoding");
  return c.json(preset);
});

app.put("/:id", presetBodyLimit, async (c) => {
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
  try {
    const preset = await svc.updatePresetAsync(userId, c.req.param("id"), body);
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
    throw err;
  }
});

app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  if (!(await svc.deletePresetAsync(userId, c.req.param("id")))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as presetsRoutes };
