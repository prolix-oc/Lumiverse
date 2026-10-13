import { Hono } from "hono";
import { getStagedFile, pinStagedFile } from "../spindle/files";

const app = new Hono();

// A native browser/WebView download streams from disk. Session authentication
// is supplied by app.ts; the file's owner is checked again at this boundary.
app.on(["GET", "HEAD"], "/:identifier/:id", c => {
  const rec = getStagedFile(c.req.param("id"));
  if (!rec || !rec.complete || rec.identifier !== c.req.param("identifier") || rec.userId !== c.get("userId")) {
    return c.json({ error: "File not found" }, 404);
  }
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(rec.size),
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(rec.fileName).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (c.req.method === "HEAD") return new Response(null, { headers });
  if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
  const release = pinStagedFile(rec);
  const reader = Bun.file(rec.path).stream().getReader();
  const abort = () => { void reader.cancel().catch(() => {}).finally(release); };
  c.req.raw.signal.addEventListener("abort", abort, { once: true });
  const cleanup = () => {
    c.req.raw.signal.removeEventListener("abort", abort);
    release();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { cleanup(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { cleanup(); controller.error(error); }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { cleanup(); }
    },
  });
  return new Response(stream, { headers });
});

export { app as spindleFilesRoutes };
