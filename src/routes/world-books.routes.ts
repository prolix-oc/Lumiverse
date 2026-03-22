import { Hono } from "hono";
import * as svc from "../services/world-books.service";
import * as charSvc from "../services/characters.service";
import { parsePagination } from "../services/pagination";
import { safeFetch, SSRFError } from "../utils/safe-fetch";

const MAX_IMPORT_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

const app = new Hono();

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listWorldBooks(userId, pagination));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  return c.json(svc.createWorldBook(userId, body), 201);
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const book = svc.getWorldBook(userId, c.req.param("id"));
  if (!book) return c.json({ error: "Not found" }, 404);
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const entries = svc.listEntriesPaginated(userId, book.id, pagination);
  return c.json({ ...book, entries });
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const book = svc.updateWorldBook(userId, c.req.param("id"), body);
  if (!book) return c.json({ error: "Not found" }, 404);
  return c.json(book);
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteWorldBook(userId, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

// --- World Book Import ---

app.post("/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    const result = svc.importWorldBook(userId, body);
    return c.json({ world_book: result.worldBook, entry_count: result.entryCount }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Import failed" }, 400);
  }
});

app.post("/import-url", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.url) return c.json({ error: "url is required" }, 400);

  let payload: any;
  try {
    const res = await safeFetch(body.url, {
      maxBytes: MAX_IMPORT_RESPONSE_BYTES,
      timeoutMs: 10_000,
    });
    if (!res.ok) return c.json({ error: `Failed to fetch URL: ${res.status}` }, 400);

    const text = await res.text();
    if (text.length > MAX_IMPORT_RESPONSE_BYTES) {
      return c.json({ error: "Response too large" }, 400);
    }
    payload = JSON.parse(text);
  } catch (err: any) {
    if (err instanceof SSRFError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: "Failed to fetch or parse URL" }, 400);
  }

  try {
    const result = svc.importWorldBook(userId, payload);
    return c.json({ world_book: result.worldBook, entry_count: result.entryCount }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Import failed" }, 400);
  }
});

// --- Character Book Import ---

app.post("/import-character-book", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { characterId } = body;
  if (!characterId) return c.json({ error: "characterId is required" }, 400);

  const character = charSvc.getCharacter(userId, characterId);
  if (!character) return c.json({ error: "Character not found" }, 404);

  const characterBook = character.extensions?.character_book;
  if (!characterBook?.entries?.length) {
    return c.json({ error: "No embedded character book found" }, 400);
  }

  const result = svc.importCharacterBook(userId, characterId, character.name, characterBook);
  await charSvc.updateCharacter(userId, characterId, {
    extensions: {
      ...(character.extensions || {}),
      world_book_id: result.worldBook.id,
    },
  });
  return c.json({ world_book: result.worldBook, entry_count: result.entryCount }, 201);
});

// --- Entry endpoints ---

app.get("/:id/entries", (c) => {
  const userId = c.get("userId");
  const book = svc.getWorldBook(userId, c.req.param("id"));
  if (!book) return c.json({ error: "World book not found" }, 404);
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listEntriesPaginated(userId, book.id, pagination));
});

app.post("/:id/entries", async (c) => {
  const userId = c.get("userId");
  const book = svc.getWorldBook(userId, c.req.param("id"));
  if (!book) return c.json({ error: "World book not found" }, 404);
  const body = await c.req.json();
  const entry = svc.createEntry(userId, book.id, body);
  if (!entry) return c.json({ error: "World book not found" }, 404);
  return c.json(entry, 201);
});

app.put("/:id/entries/:eid", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const entry = svc.updateEntry(userId, c.req.param("eid"), body);
  if (!entry) return c.json({ error: "Not found" }, 404);
  return c.json(entry);
});

app.delete("/:id/entries/:eid", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteEntry(userId, c.req.param("eid"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as worldBooksRoutes };
