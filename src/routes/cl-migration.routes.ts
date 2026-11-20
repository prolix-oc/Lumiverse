import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ArchiveValidationError } from "../services/user-data/import.service";
import { ClMigrationError, clMigrationArchivePath, deleteClMigrationJob, getClMigrationJob, listClMigrationJobs, stageClMigrationBundle, startClMigration } from "../migration/cl-migration.service";

const app = new Hono();

// The app supplies requireAuth. Keep this check for independently mounted callers as well.
app.use("*", async (c, next) => {
  if (!c.get("userId")) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

app.onError((error, c) => {
  if (error instanceof ClMigrationError) return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
  if (error instanceof ArchiveValidationError) return c.json({ error: error.message, code: error.code }, error.code === "size" ? 413 : 422);
  console.error("[cl-migration] request failed", error);
  return c.json({ error: "CharacterLibrary migration request failed" }, 500);
});

app.put("/bundles", async (c) => {
  const body = c.req.raw.body;
  if (!body) throw new ClMigrationError(400, "empty_body", "Upload a CharacterLibrary full bundle ZIP");
  const rawSize = c.req.header("content-length");
  const declaredSize = rawSize === undefined ? null : Number(rawSize);
  if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) throw new ClMigrationError(400, "invalid_size", "Invalid Content-Length");
  const preview = await stageClMigrationBundle({ userId: c.get("userId"), body, declaredSize, filename: c.req.query("filename"), sourceId: c.req.query("sourceId") });
  return c.json(preview, 201);
});

app.get("/jobs", (c) => c.json({ jobs: listClMigrationJobs(c.get("userId")) }));
app.get("/jobs/:jobId", (c) => {
  const job = getClMigrationJob(c.get("userId"), c.req.param("jobId"));
  if (!job) throw new ClMigrationError(404, "not_found", "Migration not found");
  return c.json(job);
});

app.post("/jobs/:jobId/execute", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { throw new ClMigrationError(400, "invalid_json", "Invalid JSON body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ClMigrationError(400, "invalid_options", "Options must be a JSON object");
  const options = body as Record<string, unknown>;
  if (Object.keys(options).some((key) => key !== "enableRegex") || (options.enableRegex !== undefined && typeof options.enableRegex !== "boolean")) {
    throw new ClMigrationError(400, "invalid_options", "Only the boolean enableRegex option is supported; migration always targets your own account");
  }
  return c.json(startClMigration(c.get("userId"), c.req.param("jobId"), { enableRegex: options.enableRegex as boolean | undefined }), 202);
});

app.get("/jobs/:jobId/source", (c) => {
  const path = clMigrationArchivePath(c.get("userId"), c.req.param("jobId"));
  if (!path) throw new ClMigrationError(404, "not_found", "Retained source archive not found");
  return new Response(Bun.file(path), { headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="character-library-source.zip"', "Cache-Control": "private, no-store" } });
});

app.delete("/jobs/:jobId", (c) => {
  if (!deleteClMigrationJob(c.get("userId"), c.req.param("jobId"))) throw new ClMigrationError(404, "not_found", "Migration not found");
  return c.json({ deleted: true });
});

export { app as clMigrationRoutes };
