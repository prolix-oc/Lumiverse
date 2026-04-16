import { Hono } from "hono";
import * as svc from "../services/images.service";

const app = new Hono();

const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

app.post("/", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  if (!file) return c.json({ error: "image file is required" }, 400);

  // Bound the upload to keep a single request from filling memory or disk.
  // The 10 MB API-wide bodyLimit middleware skips this route to allow chunkier
  // image uploads, so the cap has to live here.
  if (typeof file.size === "number" && file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return c.json({ error: "Image too large", maxBytes: MAX_IMAGE_UPLOAD_BYTES }, 413);
  }

  const image = await svc.uploadImage(userId, file);
  return c.json(image, 201);
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const sizeParam = c.req.query("size") as svc.ThumbTier | undefined;
  const tier = sizeParam === "sm" || sizeParam === "lg" ? sizeParam : undefined;

  const filepath = await svc.getImageFilePath(userId, id, tier);
  if (!filepath) return c.json({ error: "Not found" }, 404);

  const response = new Response(Bun.file(filepath));
  response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  // Block MIME sniffing — without this, an uploaded `.svg` would render with
  // Content-Type: image/svg+xml and execute embedded scripts in the user's
  // origin (stored XSS).
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
});

app.post("/rebuild-thumbnails", async (c) => {
  const userId = c.get("userId");
  const wantsStream = c.req.header("accept")?.includes("text/event-stream");

  if (wantsStream) {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: any) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        send("progress", { total: 0, current: 0, generated: 0, skipped: 0, failed: 0 });

        try {
          const result = await svc.rebuildAllThumbnails(userId, {
            onProgress: (p) => send("progress", p),
          });
          send("done", { success: true, ...result });
        } catch (err: any) {
          send("error", { error: err.message || "Rebuild failed" });
        }
        controller.close();
      },
    });

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

  const result = await svc.rebuildAllThumbnails(userId);
  return c.json({ success: true, ...result });
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteImage(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as imagesRoutes };
