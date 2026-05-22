import { Hono } from "hono";
import * as svc from "../services/theme-assets.service";

const app = new Hono();

const MAX_THEME_ASSET_UPLOAD_BYTES = 50 * 1024 * 1024;

function parseTags(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {}
  return raw.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function applyAssetHeaders(response: Response, mimeType: string, filename: string): void {
  response.headers.set("Cache-Control", "private, max-age=3600");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Content-Type", mimeType || "application/octet-stream");
  response.headers.set("Content-Disposition", `inline; filename="${filename.replace(/\"/g, "")}"`);
  if (mimeType === "image/svg+xml") {
    response.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
}

app.get("/", (c) => {
  const userId = c.get("userId");
  const bundleId = c.req.query("bundle_id");
  if (!bundleId) return c.json({ error: "bundle_id query param is required" }, 400);
  try {
    return c.json(svc.listThemeAssets(userId, bundleId));
  } catch (err: any) {
    return c.json({ error: err.message || "Invalid bundle_id" }, 400);
  }
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const file = formData.get("asset") as File | null;
  const bundleId = formData.get("bundle_id");
  const slug = formData.get("slug");
  const metadataRaw = formData.get("metadata");
  if (!file) return c.json({ error: "asset file is required" }, 400);
  if (typeof file.size === "number" && file.size > MAX_THEME_ASSET_UPLOAD_BYTES) {
    return c.json({ error: "Asset too large", maxBytes: MAX_THEME_ASSET_UPLOAD_BYTES }, 413);
  }
  if (typeof bundleId !== "string" || !bundleId.trim()) {
    return c.json({ error: "bundle_id is required" }, 400);
  }

  let metadata: Record<string, unknown> | undefined;
  if (typeof metadataRaw === "string" && metadataRaw.trim()) {
    try {
      const parsed = JSON.parse(metadataRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      return c.json({ error: "metadata must be valid JSON" }, 400);
    }
  }

  try {
    const asset = await svc.createThemeAsset(userId, {
      bundleId,
      file,
      slug: typeof slug === "string" ? slug : undefined,
      tags: parseTags(formData.get("tags")),
      metadata,
    });
    return c.json(asset, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to upload theme asset" }, 400);
  }
});

app.get("/bundles/:bundleId/*", async (c) => {
  const userId = c.get("userId");
  const bundleId = c.req.param("bundleId");
  const routePrefix = `/api/v1/theme-assets/bundles/${bundleId}/`;
  const slug = c.req.path.startsWith(routePrefix)
    ? decodeURIComponent(c.req.path.slice(routePrefix.length))
    : "";
  if (!slug) return c.json({ error: "Asset slug is required" }, 400);
  try {
    const content = await svc.getThemeAssetContentBySlug(userId, bundleId, slug);
    if (!content) return c.json({ error: "Not found" }, 404);
    const response = new Response(Bun.file(content.filepath));
    applyAssetHeaders(response, content.asset.mime_type, content.asset.original_filename);
    return response;
  } catch (err: any) {
    return c.json({ error: err.message || "Invalid asset slug" }, 400);
  }
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const asset = svc.getThemeAsset(userId, c.req.param("id"));
  if (!asset) return c.json({ error: "Not found" }, 404);
  return c.json(asset);
});

app.get("/:id/content", async (c) => {
  const userId = c.get("userId");
  const content = await svc.getThemeAssetContentById(userId, c.req.param("id"));
  if (!content) return c.json({ error: "Not found" }, 404);
  const response = new Response(Bun.file(content.filepath));
  applyAssetHeaders(response, content.asset.mime_type, content.asset.original_filename);
  return response;
});

app.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid request body" }, 400);
  try {
    const asset = svc.updateThemeAsset(userId, c.req.param("id"), body);
    if (!asset) return c.json({ error: "Not found" }, 404);
    return c.json(asset);
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to update theme asset" }, 400);
  }
});

app.post("/:id/optimize-webp", async (c) => {
  const userId = c.get("userId");
  try {
    const asset = await svc.optimizeThemeAssetToWebp(userId, c.req.param("id"));
    if (!asset) return c.json({ error: "Not found" }, 404);
    return c.json(asset);
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to optimize theme asset" }, 400);
  }
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteThemeAsset(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as themeAssetsRoutes };
