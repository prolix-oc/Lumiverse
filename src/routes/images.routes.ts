import { Hono } from "hono";
import * as svc from "../services/images.service";
import { parsePagination } from "../services/pagination";
import { parseRangeHeader } from "./http-range";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { safeFetch, SSRFError } from "../utils/safe-fetch";
import {
  detectImageContentType,
  isSupportedProxyImageContentType,
  normalizeImageContentType,
  validateImageMagicBytes,
} from "../utils/image-signature";
import { extractRemoteImageUrlFromHtml } from "../utils/remote-image-page";

const app = new Hono();

const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_WALLPAPER_UPLOAD_BYTES = 250 * 1024 * 1024; // 250 MB
const REMOTE_IMAGE_PROXY_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const REMOTE_IMAGE_PROXY_MAX_HTML_BYTES = 1 * 1024 * 1024; // 1 MB
const REMOTE_IMAGE_PROXY_MAX_RESOLUTION_DEPTH = 1;
type WallpaperVideoCodec = "h264" | "hevc";
type WallpaperUploadProgressId = string;

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function parseWallpaperVideoCodec(value: string | undefined): WallpaperVideoCodec | null | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "h264" || normalized === "hevc") return normalized;
  return null;
}

function parseWallpaperUploadProgressId(value: string | undefined): WallpaperUploadProgressId | null | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) return null;
  return normalized;
}

function resolveImageContentType(filepath: string, fallbackMimeType: string): string | null {
  if (filepath.endsWith(".webp")) return "image/webp";
  if (filepath.endsWith(".mp4")) return "video/mp4";
  if (filepath.endsWith(".webm")) return "video/webm";
  if (filepath.endsWith(".mov")) return "video/quicktime";
  return fallbackMimeType || null;
}

async function readResponseBodyBinaryCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`Remote image exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readResponseBodyTextCapped(response: Response, maxBytes: number): Promise<string> {
  const bytes = await readResponseBodyBinaryCapped(response, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function isHtmlContentType(contentType: string): boolean {
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}

async function fetchRemoteImageAsset(
  rawUrl: string,
  depth = 0,
): Promise<{ data: Uint8Array; contentType: string }> {
  const response = await safeFetch(rawUrl, {
    maxBytes: REMOTE_IMAGE_PROXY_MAX_BYTES,
    timeoutMs: 30_000,
  });

  if (!response.ok) {
    const err = new Error(`Remote image request failed with status ${response.status}`);
    (err as Error & { statusCode?: number }).statusCode = response.status;
    throw err;
  }

  const declaredContentType = normalizeImageContentType(response.headers.get("content-type"));

  if (isHtmlContentType(declaredContentType)) {
    if (depth >= REMOTE_IMAGE_PROXY_MAX_RESOLUTION_DEPTH) {
      throw new Error("Remote image page did not resolve to a raster asset");
    }

    const html = await readResponseBodyTextCapped(response, REMOTE_IMAGE_PROXY_MAX_HTML_BYTES);
    const resolvedImageUrl = extractRemoteImageUrlFromHtml(rawUrl, html);
    if (!resolvedImageUrl) {
      throw new Error("Remote image page did not expose a usable image");
    }
    if (resolvedImageUrl === rawUrl) {
      throw new Error("Remote image page resolved back to itself");
    }

    return fetchRemoteImageAsset(resolvedImageUrl, depth + 1);
  }

  const binary = await readResponseBodyBinaryCapped(response, REMOTE_IMAGE_PROXY_MAX_BYTES);
  const inferredContentType = detectImageContentType(binary);
  const effectiveContentType = isSupportedProxyImageContentType(declaredContentType)
    ? (validateImageMagicBytes(binary, declaredContentType) ? declaredContentType : inferredContentType)
    : inferredContentType;

  if (!effectiveContentType || !isSupportedProxyImageContentType(effectiveContentType)) {
    throw new Error("Unsupported remote image content type");
  }
  if (!validateImageMagicBytes(binary, effectiveContentType)) {
    throw new Error("Remote image bytes do not match the declared content type");
  }

  return {
    data: binary,
    contentType: effectiveContentType,
  };
}

app.get("/wallpapers", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listImages(userId, {
    ...pagination,
    owner_extension_identifier: svc.WALLPAPER_LIBRARY_OWNER,
  }));
});

app.post("/wallpapers", async (c) => {
  const userId = c.get("userId");
  const uploadId = parseWallpaperUploadProgressId(c.req.query("upload_id"));
  if (uploadId === null) {
    return c.json({ error: "Invalid upload progress id" }, 400);
  }
  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  if (!file) return c.json({ error: "image file is required" }, 400);
  const stripAudio = isTruthyFlag(c.req.query("strip_audio"));
  const videoCodec = parseWallpaperVideoCodec(c.req.query("video_codec"));
  if (videoCodec === null) {
    return c.json({ error: "Unsupported video codec. Use h264 or hevc." }, 400);
  }
  const primaryVideoCodec: WallpaperVideoCodec = videoCodec ?? "h264";

  if (typeof file.size === "number" && file.size > MAX_WALLPAPER_UPLOAD_BYTES) {
    return c.json({ error: "Wallpaper too large", maxBytes: MAX_WALLPAPER_UPLOAD_BYTES }, 413);
  }

  const image = await svc.uploadImage(userId, file, {
    strip_audio: stripAudio,
    transcode_video_codec: primaryVideoCodec,
    sidecar_video_codecs: [primaryVideoCodec === "hevc" ? "h264" : "hevc"],
    owner_extension_identifier: svc.WALLPAPER_LIBRARY_OWNER,
    on_progress: uploadId
      ? (progress) => {
          eventBus.emit(
            EventType.WALLPAPER_UPLOAD_PROGRESS,
            {
              uploadId,
              ...progress,
            },
            userId,
          );
        }
      : undefined,
  });
  return c.json(image, 201);
});

app.delete("/wallpapers/:id", (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const deleted = svc.deleteWallpaperLibraryImage(userId, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true, deleted: true });
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  if (!file) return c.json({ error: "image file is required" }, 400);
  const stripAudio = isTruthyFlag(c.req.query("strip_audio"));

  // Bound the upload to keep a single request from filling memory or disk.
  // The 10 MB API-wide bodyLimit middleware skips this route to allow chunkier
  // image uploads, so the cap has to live here.
  if (typeof file.size === "number" && file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return c.json({ error: "Image too large", maxBytes: MAX_IMAGE_UPLOAD_BYTES }, 413);
  }

  const image = await svc.uploadImage(userId, file, { strip_audio: stripAudio });
  return c.json(image, 201);
});

app.get("/remote", async (c) => {
  const rawUrl = c.req.query("url");
  if (!rawUrl) return c.json({ error: "url is required" }, 400);

  let remoteUrl: URL;
  try {
    remoteUrl = new URL(rawUrl);
  } catch {
    return c.json({ error: "Invalid remote image URL" }, 400);
  }

  if (remoteUrl.protocol !== "http:" && remoteUrl.protocol !== "https:") {
    return c.json({ error: "Only http:// and https:// remote image URLs are allowed" }, 400);
  }
  if (remoteUrl.username || remoteUrl.password) {
    return c.json({ error: "Remote image URLs cannot include credentials" }, 400);
  }

  try {
    const asset = await fetchRemoteImageAsset(remoteUrl.toString());

    const body = new ArrayBuffer(asset.data.byteLength);
    new Uint8Array(body).set(asset.data);

    return new Response(body, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=3600, no-transform",
        "Content-Length": String(asset.data.byteLength),
        "Content-Type": asset.contentType,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err: any) {
    const message = err?.message || "Remote image proxy failed";
    const statusCode = typeof err?.statusCode === "number" ? err.statusCode : 0;
    const status = err instanceof SSRFError
      ? 400
      : statusCode === 404
        ? 404
        : message.includes("Unsupported remote image content type") || message.includes("did not expose a usable image")
          ? 415
          : 502;
    return c.json({ error: message }, status);
  }
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const sizeParam = c.req.query("size") as svc.ThumbTier | undefined;
  const tier = sizeParam === "sm" || sizeParam === "lg" ? sizeParam : undefined;
  const requestedCodec = parseWallpaperVideoCodec(c.req.query("codec"));
  if (requestedCodec === null) {
    return c.json({ error: "Unsupported video codec. Use h264 or hevc." }, 400);
  }

  const row = svc.getImage(userId, id);
  if (!row) return c.json({ error: "Not found" }, 404);

  const filepath = await svc.getImageFilePath(userId, id, tier, requestedCodec ?? undefined);
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
