import { Hono } from "hono";
import * as svc from "../services/audio.service";

const app = new Hono();

/**
 * Parse a single-range HTTP `Range: bytes=...` header against a known file
 * size. Returns the resolved {start, end} (inclusive, zero-indexed), or
 * "invalid" for syntactically wrong / out-of-bounds requests (caller should
 * 416), or null when the header is absent / malformed in a way we'd rather
 * just serve the full file for (e.g. multipart ranges).
 *
 * Three forms accepted:
 *   bytes=START-END   closed range
 *   bytes=START-      from START to end of file
 *   bytes=-N          last N bytes (suffix range)
 */
function parseRangeHeader(
  header: string | undefined | null,
  totalSize: number,
): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null; // multipart or malformed — fall back to 200

  const startStr = match[1];
  const endStr = match[2];

  let start: number;
  let end: number;

  if (startStr === "" && endStr !== "") {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else if (startStr !== "") {
    start = Number.parseInt(startStr, 10);
    end = endStr !== "" ? Number.parseInt(endStr, 10) : totalSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  } else {
    return "invalid";
  }

  // Clamp end so callers don't have to special-case the last byte.
  if (end >= totalSize) end = totalSize - 1;

  if (start > end || start < 0 || start >= totalSize) return "invalid";

  return { start, end };
}

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const filepath = svc.getAudioFilePath(userId, id);
  if (!filepath) return c.json({ error: "Not found" }, 404);

  const row = svc.getAudio(userId, id)!;
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
  // BunFile.slice() returns a streaming slice — no full-file read into memory.
  // The end index is exclusive per Blob.slice(), so add 1 to include `end`.
  const sliced = file.slice(start, end + 1);

  return new Response(sliced, {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      "Content-Length": String(chunkLength),
    },
  });
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const deleted = svc.deleteAudio(userId, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true, deleted: true });
});

export { app as audioRoutes };
