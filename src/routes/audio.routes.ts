import { Hono } from "hono";
import * as svc from "../services/audio.service";
import { parseRangeHeader } from "./http-range";

const app = new Hono();
const MAX_AUDIO_UPLOAD_BYTES = 20 * 1024 * 1024;

app.post("/", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const file = formData.get("audio") as File | null;
  if (!file) return c.json({ error: "audio file is required" }, 400);
  if (file.size <= 0) return c.json({ error: "audio file is empty" }, 400);
  if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
    return c.json({ error: "Audio file too large", maxBytes: MAX_AUDIO_UPLOAD_BYTES }, 413);
  }

  const mimeType = svc.normalizeSupportedAudioMimeType(file.type, file.name);
  if (!mimeType) {
    return c.json({
      error: "Unsupported audio format. Use WAV, MP3, AIFF, AAC, OGG, or FLAC.",
    }, 415);
  }

  const audio = await svc.saveAudio(userId, {
    data: new Uint8Array(await file.arrayBuffer()),
    mime_type: mimeType,
    original_filename: file.name,
  });
  return c.json(audio, 201);
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const filepath = await svc.getAudioFilePathAsync(userId, id);
  if (!filepath) return c.json({ error: "Not found" }, 404);

  const row = await svc.getAudioAsync(userId, id);
  if (!row) return c.json({ error: "Not found" }, 404);
  const file = Bun.file(filepath);
  const totalSize = file.size;

  const baseHeaders: Record<string, string> = {
    "Cache-Control": "public, max-age=31536000, immutable",
    // Block MIME sniffing — without this, a misclassified blob could execute
    // as a different content type inside the user's origin (stored XSS).
    "X-Content-Type-Options": "nosniff",
    // Advertise range support so the audio element knows it can seek.
    "Accept-Ranges": "bytes",
  };
  if (row.mime_type) baseHeaders["Content-Type"] = row.mime_type;

  const parsed = parseRangeHeader(c.req.header("range"), totalSize);

  if (parsed === "invalid") {
    // RFC 7233: include Content-Range with the total size so the client
    // can re-form a valid request.
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: {
        "Content-Range": `bytes */${totalSize}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (parsed === null) {
    // No Range header (or one we don't handle specially) — full content.
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

app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const deleted = await svc.deleteAudioAsync(userId, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true, deleted: true });
});

export { app as audioRoutes };
