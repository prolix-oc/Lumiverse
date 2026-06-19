import { Hono } from "hono";
import * as svc from "../services/presets.service";
import { parsePagination } from "../services/pagination";
import { REVALIDATE_PRIVATE, ifNoneMatchSatisfies } from "../utils/http-cache";

const app = new Hono();

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

  // ETag from a cheap signature of the filtered set + the page window, so a
  // repeat open returns 304 (no body) until a preset is created/edited/deleted.
  const sig = svc.getPresetRegistrySignature(userId, provider, engine);
  const etag = `"presets-reg-${sig.count}-${sig.maxUpdatedAt}-${provider ?? ""}-${engine ?? ""}-${pagination.limit}-${pagination.offset}"`;
  if (ifNoneMatchSatisfies(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": REVALIDATE_PRIVATE } });
  }
  c.header("ETag", etag);
  c.header("Cache-Control", REVALIDATE_PRIVATE);
  return c.json(svc.listPresetRegistry(userId, pagination, provider, engine));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.provider) return c.json({ error: "name and provider are required" }, 400);
  return c.json(svc.createPreset(userId, body), 201);
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  // Cheap updated_at lookup drives the ETag, so a cache hit returns 304 without
  // reading + JSON-parsing the full (potentially large) preset or transferring
  // its body. updated_at is bumped on every update, so the ETag is never stale.
  const updatedAt = svc.getPresetUpdatedAt(userId, id);
  if (updatedAt == null) return c.json({ error: "Not found" }, 404);

  const etag = `"preset-${id}-${updatedAt}"`;
  if (ifNoneMatchSatisfies(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": REVALIDATE_PRIVATE } });
  }

  const preset = svc.getPreset(userId, id);
  if (!preset) return c.json({ error: "Not found" }, 404); // deleted between lookups
  c.header("ETag", etag);
  c.header("Cache-Control", REVALIDATE_PRIVATE);
  return c.json(preset);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const preset = svc.updatePreset(userId, c.req.param("id"), body);
  if (!preset) return c.json({ error: "Not found" }, 404);
  return c.json(preset);
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  if (!svc.deletePreset(userId, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as presetsRoutes };
