import { Hono } from "hono";
import * as uploads from "../spindle/uploads";

const TUS_VERSION = "1.0.0";

function tusHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Tus-Resumable": TUS_VERSION, ...extra };
}

function parseMetadata(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(",")) {
    const [key, value] = pair.trim().split(" ");
    if (key) out[key] = value ? Buffer.from(value, "base64").toString("utf8") : "";
  }
  return out;
}

const app = new Hono();

app.options("*", () =>
  new Response(null, {
    status: 204,
    headers: tusHeaders({
      "Tus-Version": TUS_VERSION,
      "Tus-Extension": "creation",
      "Tus-Max-Size": String(uploads.getMaxUploadBytes()),
    }),
  }),
);

app.post("/", (c) => {
  const userId = c.get("userId");
  const length = Number(c.req.header("Upload-Length"));
  if (!Number.isInteger(length) || length < 0 || length > uploads.getMaxUploadBytes()) {
    return c.json({ error: "invalid Upload-Length" }, 400);
  }
  const meta = parseMetadata(c.req.header("Upload-Metadata"));
  if (!meta.extension) return c.json({ error: "Upload-Metadata 'extension' is required" }, 400);
  let rec;
  try {
    rec = uploads.createUpload({
      ownerUserId: userId,
      extensionIdentifier: meta.extension,
      fileName: meta.filename || "upload.bin",
      declaredSize: length,
    });
  } catch (err: any) {
    console.error(`[spindle-uploads] createUpload failed: ${err?.message ?? err}`);
    return c.json({ error: "failed to create upload" }, 500);
  }
  return new Response(null, {
    status: 201,
    headers: tusHeaders({
      Location: `/api/v1/spindle-uploads/${rec.uploadId}`,
      "Upload-Offset": "0",
    }),
  });
});

app.on("HEAD", "/:id", (c) => {
  const userId = c.get("userId");
  const rec = uploads.getUpload(c.req.param("id"));
  if (!rec || rec.ownerUserId !== userId) {
    return new Response(null, { status: 404, headers: tusHeaders() });
  }
  return new Response(null, {
    status: 200,
    headers: tusHeaders({
      "Upload-Offset": String(rec.offset),
      "Upload-Length": String(rec.declaredSize),
      "Cache-Control": "no-store",
    }),
  });
});

app.patch("/:id", async (c) => {
  const userId = c.get("userId");
  if ((c.req.header("Content-Type") || "") !== "application/offset+octet-stream") {
    return c.json({ error: "invalid Content-Type" }, 415);
  }
  const rec = uploads.getUpload(c.req.param("id"));
  if (!rec || rec.ownerUserId !== userId) {
    return new Response(null, { status: 404, headers: tusHeaders() });
  }
  const offset = Number(c.req.header("Upload-Offset"));
  if (!Number.isInteger(offset) || offset !== rec.offset) {
    return new Response(null, {
      status: 409,
      headers: tusHeaders({ "Upload-Offset": String(rec.offset) }),
    });
  }
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "empty body" }, 400);
  try {
    const newOffset = await uploads.appendUpload(rec.uploadId, body, offset);
    return new Response(null, {
      status: 204,
      headers: tusHeaders({ "Upload-Offset": String(newOffset) }),
    });
  } catch (err: any) {
    return c.json({ error: err?.message || "patch failed" }, 400);
  }
});

export { app as uploadsRoutes };
