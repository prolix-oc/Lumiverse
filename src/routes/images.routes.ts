import { Hono } from "hono";
import * as svc from "../services/images.service";
import { parseRangeHeader } from "./http-range";

const app = new Hono();

const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

function resolveImageContentType(filepath: string, fallbackMimeType: string): string | null {
  if (filepath.endsWith(".webp")) return "image/webp";
  return fallbackMimeType || null;
}

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

  const row = svc.getImage(userId, id);
  if (!row) return c.json({ error: "Not found" }, 404);

  const filepath = await svc.getImageFilePath(userId, id, tier);
  if (!filepath) return c.json({ error: "Not found" }, 404);

  const file = Bun.file(filepath);
  const totalSize = file.size;
  const contentType = resolveImageContentType(filepath, row.mime_type);

  const baseHeaders: Record<string, string> = {
    "Cache-Control": "public, max-age=31536000, immutable, no-transform",
    // Block MIME sniffing — without this, an uploaded `.svg` would render with
    // Content-Type: image/svg+xml and execute embedded scripts in the user's
    // origin (stored XSS).
    "X-Content-Type-Options": "nosniff",
    // Video wallpapers need byte-range responses for Safari/WebKit media
    // playback, and advertising support is harmless for static images too.
    "Accept-Ranges": "bytes",
    // nginx-family proxies can buffer upstream file responses and delay time to
    // first byte. Media seeks work best when the proxy streams immediately.
    "X-Accel-Buffering": "no",
  };
  if (contentType) baseHeaders["Content-Type"] = contentType;

  const parsed = parseRangeHeader(c.req.header("range"), totalSize);

  if (parsed === "invalid") {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: {
        "Content-Range": `bytes */${totalSize}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (parsed === null) {
    return new Response(file, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(totalSize) },
    });
  }

  const { start, end } = parsed;
  const chunkLength = end - start + 1;
  // Serve range replies as fixed bytes instead of a lazy BunFile slice.
  // Some host/proxy paths have been observed to forward the 206 headers but
  // stall before the first body byte on lazy file slices, especially on Safari.
  // Materializing only the requested range keeps the response length explicit
  // while avoiding whole-file buffering.
  const chunkBytes = new Uint8Array(await file.slice(start, end + 1).arrayBuffer());

  return new Response(chunkBytes, {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      "Content-Length": String(chunkLength),
    },
  });
});

app.post("/rebuild-thumbnails", async (c) => {
  const userId = c.get("userId");
  const wantsStream = c.req.header("accept")?.includes("text/event-stream");

  if (wantsStream) {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const send = (event: string, data: any) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // Client disconnected; stop pushing progress instead of letting
            // the AbortError surface as an untagged DOMException.
            closed = true;
          }
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
        try {
          controller.close();
        } catch {
          /* already closed */
        }
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
  const id = c.req.param("id");
  const deleted = c.req.query("unused") === "true"
    ? svc.deleteImageIfUnreferenced(userId, id)
    : svc.deleteImage(userId, id);
  if (!deleted && c.req.query("unused") === "true") {
    return c.json({ success: true, deleted: false });
  }
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true, deleted: true });
});

export { app as imagesRoutes };
