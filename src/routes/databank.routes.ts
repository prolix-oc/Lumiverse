import { Hono } from "hono";
import * as databank from "../services/databank";
import { parsePagination } from "../services/pagination";
import * as filesSvc from "../services/files.service";
import type { DatabankScope } from "../services/databank/types";
import { createHash } from "crypto";
import { env } from "../env";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

const app = new Hono();

// ─── Banks ────────────────────────────────────────────────────

// GET / — List databanks
app.get("/", (c) => {
  const userId = c.get("userId");
  const { limit, offset } = parsePagination(
    c.req.query("limit"),
    c.req.query("offset"),
  );
  const scope = c.req.query("scope") as DatabankScope | undefined;
  const scopeId = c.req.query("scope_id");

  const result = databank.listDatabanks(userId, { limit, offset }, { scope, scopeId });
  return c.json(result);
});

// POST / — Create databank
app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { name, description, scope, scope_id } = body;

  if (!name || typeof name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  if (!scope || !["global", "character", "chat"].includes(scope)) {
    return c.json({ error: "scope must be 'global', 'character', or 'chat'" }, 400);
  }
  if (scope !== "global" && !scope_id) {
    return c.json({ error: "scope_id is required for character and chat scope" }, 400);
  }

  const bank = databank.createDatabank(userId, {
    name,
    description,
    scope,
    scopeId: scope_id ?? null,
  });
  return c.json(bank, 201);
});

// GET /:id — Get databank
app.get("/:id", (c) => {
  const userId = c.get("userId");
  const bank = databank.getDatabank(userId, c.req.param("id"));
  if (!bank) return c.json({ error: "Not found" }, 404);
  return c.json(bank);
});

// PUT /:id — Update databank
app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const bank = databank.updateDatabank(userId, c.req.param("id"), {
    name: body.name,
    description: body.description,
    enabled: body.enabled,
  });
  if (!bank) return c.json({ error: "Not found" }, 404);
  return c.json(bank);
});

// DELETE /:id — Delete databank
app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  databank.abortDatabankProcessing(id);

  // Delete vectors from LanceDB
  await databank.deleteDatabankVectors(userId, id);

  const deleted = await databank.deleteDatabank(userId, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

// ─── Documents ────────────────────────────────────────────────

// GET /:id/documents — List documents
app.get("/:id/documents", (c) => {
  const userId = c.get("userId");
  const { limit, offset } = parsePagination(
    c.req.query("limit"),
    c.req.query("offset"),
  );
  const result = databank.listDocuments(userId, c.req.param("id"), { limit, offset });
  return c.json(result);
});

// POST /:id/documents — Upload document
app.post("/:id/documents", async (c) => {
  const userId = c.get("userId");
  const databankId = c.req.param("id");

  // Verify bank exists
  const bank = databank.getDatabank(userId, databankId);
  if (!bank) return c.json({ error: "Databank not found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "No file provided" }, 400);

  // Validate format
  if (!databank.isSupportedFormat(file.name)) {
    return c.json({
      error: `Unsupported file format. Supported: ${databank.getSupportedExtensions().join(", ")}`,
    }, 400);
  }

  // Size limit: 10MB
  if (file.size > 10 * 1024 * 1024) {
    return c.json({ error: "File too large. Maximum 10MB." }, 400);
  }

  // Save file to disk
  const filename = await filesSvc.saveUpload(file, userId, "databank");

  // Compute content hash
  const buffer = await file.arrayBuffer();
  const hash = createHash("sha256").update(new Uint8Array(buffer)).digest("hex");

  // Create document record — strip extension from display name
  const displayName = file.name.replace(/\.[^.]+$/, "");
  const doc = databank.createDocument(userId, databankId, displayName, filename, file.type || "", file.size, hash);

  // Kick off async processing (parse → chunk → vectorize)
  databank.processDocument(userId, doc.id).catch((err) => {
    console.error(`[databank] Background processing failed for ${doc.id}:`, err);
  });

  return c.json(doc, 201);
});

// POST /:id/documents/scrape — Scrape a URL and create a document
// NOTE: Must be registered BEFORE /:id/documents/:docId to avoid param collision
app.post("/:id/documents/scrape", async (c) => {
  const userId = c.get("userId");
  const databankId = c.req.param("id");

  const bank = databank.getDatabank(userId, databankId);
  if (!bank) return c.json({ error: "Databank not found" }, 404);

  const body = await c.req.json();
  const { url } = body;
  if (!url || typeof url !== "string") {
    return c.json({ error: "url is required" }, 400);
  }

  try {
    // Scrape the URL
    const scraped = await databank.scrapeUrl(url);

    // Write scraped content to a file
    const dir = join(env.dataDir, "databank", userId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const ext = scraped.sourceType === "wiki" ? ".md" : ".txt";
    const filename = `${crypto.randomUUID()}${ext}`;
    const filepath = join(dir, filename);

    // Format with title header
    const fileContent = `# ${scraped.title}\n\nSource: ${scraped.url}\n\n${scraped.content}`;
    await Bun.write(filepath, fileContent);

    // Compute content hash
    const hash = createHash("sha256").update(fileContent).digest("hex");

    // Create document record — no extension in display name
    const docName = scraped.title || new URL(url).hostname;
    const doc = databank.createDocument(
      userId,
      databankId,
      docName,
      filename,
      `text/${ext === ".md" ? "markdown" : "plain"}`,
      Buffer.byteLength(fileContent),
      hash,
    );

    // Kick off async processing (chunk → vectorize)
    databank.processDocument(userId, doc.id).catch((err) => {
      console.error(`[databank] Processing scraped document failed for ${doc.id}:`, err);
    });

    return c.json({ ...doc, scraped: { title: scraped.title, sourceType: scraped.sourceType, contentLength: scraped.contentLength } }, 201);
  } catch (err: any) {
    if (err instanceof databank.ScrapeError) {
      const status = err.type === "not_found" ? 404
        : err.type === "forbidden" || err.type === "ssrf_blocked" ? 403
        : err.type === "rate_limited" ? 429
        : err.type === "invalid_url" ? 400
        : 502;
      return c.json({ error: err.message, type: err.type }, status);
    }
    return c.json({ error: err.message || "Failed to scrape URL" }, 502);
  }
});

// PATCH /:id/documents/:docId — Rename document
app.patch("/:id/documents/:docId", async (c) => {
  const userId = c.get("userId");
  const docId = c.req.param("docId");
  const body = await c.req.json();
  const { name } = body;
  if (!name || typeof name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  const doc = databank.renameDocument(userId, docId, name.trim());
  if (!doc) return c.json({ error: "Not found" }, 404);
  return c.json(doc);
});

// GET /:id/documents/:docId — Get document details
app.get("/:id/documents/:docId", (c) => {
  const userId = c.get("userId");
  const doc = databank.getDocument(userId, c.req.param("docId"));
  if (!doc) return c.json({ error: "Not found" }, 404);
  return c.json(doc);
});

// GET /:id/documents/:docId/content — Get parsed document content
app.get("/:id/documents/:docId/content", (c) => {
  const userId = c.get("userId");
  const content = databank.getDocumentContent(userId, c.req.param("docId"));
  if (content === null) return c.json({ error: "Not found or not yet processed" }, 404);
  return c.json({ content });
});

// DELETE /:id/documents/:docId — Delete document
app.delete("/:id/documents/:docId", async (c) => {
  const userId = c.get("userId");
  const docId = c.req.param("docId");

  databank.abortDocumentProcessing(docId);

  // Delete vectors from LanceDB
  await databank.deleteDocumentVectors(userId, docId);

  const deleted = await databank.deleteDocument(userId, docId);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

// POST /:id/documents/:docId/reprocess — Re-parse and re-vectorize
app.post("/:id/documents/:docId/reprocess", async (c) => {
  const userId = c.get("userId");
  const docId = c.req.param("docId");

  const doc = databank.getDocument(userId, docId);
  if (!doc) return c.json({ error: "Not found" }, 404);

  // Delete old vectors
  await databank.deleteDocumentVectors(userId, docId);

  // Reset status and reprocess
  databank.updateDocumentStatus(docId, "pending");
  databank.processDocument(userId, docId).catch((err) => {
    console.error(`[databank] Reprocessing failed for ${docId}:`, err);
  });

  return c.json({ success: true, status: "processing" });
});

// ─── Chat Attachment ──────────────────────────────────────────

// POST /attach-to-chat — Upload a document to a chat's databank (auto-creates if needed)
app.post("/attach-to-chat", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const chatId = formData.get("chat_id") as string | null;
  const chatName = formData.get("chat_name") as string | null;

  if (!file) return c.json({ error: "No file provided" }, 400);
  if (!chatId) return c.json({ error: "chat_id is required" }, 400);

  if (!databank.isSupportedFormat(file.name)) {
    return c.json({ error: `Unsupported file format. Supported: ${databank.getSupportedExtensions().join(", ")}` }, 400);
  }
  if (file.size > 10 * 1024 * 1024) {
    return c.json({ error: "File too large. Maximum 10MB." }, 400);
  }

  // Find or create a chat-scoped databank
  const bank = databank.ensureChatDatabank(userId, chatId, chatName || "Chat Documents");

  // Save file to disk
  const filename = await filesSvc.saveUpload(file, userId, "databank");
  const buffer = await file.arrayBuffer();
  const hash = createHash("sha256").update(new Uint8Array(buffer)).digest("hex");

  // Create document (no extension in display name)
  const displayName = file.name.replace(/\.[^.]+$/, "");
  const doc = databank.createDocument(userId, bank.id, displayName, filename, file.type || "", file.size, hash);

  // Kick off async processing
  databank.processDocument(userId, doc.id).catch((err) => {
    console.error(`[databank] Processing chat-attached document failed for ${doc.id}:`, err);
  });

  return c.json({ document: doc, databank: bank }, 201);
});

// ─── Search & Mentions ────────────────────────────────────────

// POST /search — Vector search across active databanks
app.post("/search", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { query, chatId, characterId, limit } = body;

  if (!query || typeof query !== "string") {
    return c.json({ error: "query is required" }, 400);
  }

  const characterIds = characterId
    ? Array.isArray(characterId) ? characterId : [characterId]
    : [];
  const activeBankIds = databank.resolveActiveDatabankIds(userId, chatId || "", characterIds);
  const defaultLimit = databank.loadDatabankSettings(userId).retrievalTopK;
  const results = await databank.searchDirect(userId, activeBankIds, query, limit || defaultLimit);
  return c.json({ data: results });
});

// GET /mentions/autocomplete — Autocomplete for # mentions
app.get("/mentions/autocomplete", (c) => {
  const userId = c.get("userId");
  const q = c.req.query("q") || "";
  const chatId = c.req.query("chatId") || "";
  const characterId = c.req.query("characterId") || "";

  const characterIds = characterId ? [characterId] : [];
  const activeBankIds = databank.resolveActiveDatabankIds(userId, chatId, characterIds);
  const results = databank.searchDocumentsBySlug(userId, q, activeBankIds, 10);
  return c.json({ data: results });
});

// POST /mentions/resolve — Resolve a #slug to content
app.post("/mentions/resolve", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { slug, chatId, characterId, maxTokens } = body;

  if (!slug) return c.json({ error: "slug is required" }, 400);

  const doc = databank.getDocumentBySlug(userId, slug);
  if (!doc) return c.json({ error: "Document not found" }, 404);

  const content = databank.getFullDocumentText(userId, doc.id);
  if (!content) return c.json({ error: "Document has no content" }, 404);

  // Clamp maxTokens to a sane range. Without this, negative values turn the
  // slice into a tail-strip ("0, -4000" → "" on small docs) and very large
  // values let a caller request a huge buffer allocation. Treat anything
  // unparseable as "use the default" rather than failing the request.
  const MAX_RESOLVE_TOKENS = 100_000;
  let effectiveMax = 2000;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    effectiveMax = Math.min(Math.floor(maxTokens), MAX_RESOLVE_TOKENS);
  }
  const limit = effectiveMax * 4;
  const truncated = content.length > limit;
  const resultContent = truncated ? content.slice(0, limit) : content;

  return c.json({
    slug: doc.slug,
    documentName: doc.name,
    content: resultContent,
    truncated,
  });
});

export { app as databankRoutes };
