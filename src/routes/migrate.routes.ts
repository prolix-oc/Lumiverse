import { Hono } from "hono";
import * as chatsSvc from "../services/chats.service";
import * as charactersSvc from "../services/characters.service";
import * as personasSvc from "../services/personas.service";
import * as worldBooksSvc from "../services/world-books.service";
import type { ChatImportRequest, ChatImportResult, PersonaImportRequest, PersonaImportResult, WorldBookBulkImportRequest, WorldBookBulkImportResult } from "../types/migrate";

const app = new Hono();

// POST /chats — Bulk import chats with messages for a character
app.post("/chats", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<ChatImportRequest>();

  if (!body.chats || !Array.isArray(body.chats)) {
    return c.json({ error: "chats array is required" }, 400);
  }

  // Resolve character
  let characterId = body.character_id;
  if (!characterId) {
    if (!body.character_name) {
      return c.json({ error: "character_name or character_id is required" }, 400);
    }
    const matches = charactersSvc.findCharactersByName(userId, body.character_name);
    if (matches.length === 0) {
      return c.json({ error: `Character not found: ${body.character_name}` }, 404);
    }
    characterId = matches[0].id;
  } else {
    const char = charactersSvc.getCharacter(userId, characterId);
    if (!char) {
      return c.json({ error: `Character not found: ${characterId}` }, 404);
    }
  }

  const result: ChatImportResult = {
    results: [],
    summary: { total: body.chats.length, imported: 0, failed: 0 },
  };

  // Apply persona_map: inject persona_id into user message extras before insert
  const personaMap = body.persona_map;
  if (personaMap && Object.keys(personaMap).length > 0) {
    for (const chatInput of body.chats) {
      for (const msg of chatInput.messages || []) {
        if (msg.is_user && msg.name && personaMap[msg.name] && !msg.extra?.persona_id) {
          msg.extra = { ...(msg.extra || {}), persona_id: personaMap[msg.name] };
        }
      }
    }
  }

  for (const chatInput of body.chats) {
    const chatName = chatInput.name || `Imported Chat`;
    try {
      const chat = chatsSvc.createChatRaw(userId, {
        character_id: characterId!,
        name: chatName,
        metadata: chatInput.metadata || {},
        created_at: chatInput.created_at,
      });

      const msgCount = chatsSvc.bulkInsertMessages(chat.id, chatInput.messages || [], userId);

      result.results.push({
        chat_name: chatName,
        success: true,
        chat_id: chat.id,
        message_count: msgCount,
      });
      result.summary.imported++;
    } catch (err: any) {
      result.results.push({
        chat_name: chatName,
        success: false,
        error: err.message || String(err),
      });
      result.summary.failed++;
    }
  }

  return c.json(result, 201);
});

// POST /personas — Bulk import personas
app.post("/personas", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<PersonaImportRequest>();

  if (!body.personas || !Array.isArray(body.personas)) {
    return c.json({ error: "personas array is required" }, 400);
  }

  const result: PersonaImportResult = {
    results: [],
    summary: { total: body.personas.length, imported: 0, failed: 0 },
  };

  for (const input of body.personas) {
    try {
      if (!input.name) {
        result.results.push({ name: "(unnamed)", success: false, error: "name is required" });
        result.summary.failed++;
        continue;
      }

      const persona = personasSvc.createPersona(userId, {
        name: input.name,
        title: input.title,
        description: input.description,
        folder: input.folder,
        is_default: input.is_default,
        attached_world_book_id: input.attached_world_book_id,
        metadata: input.metadata,
      });

      result.results.push({
        name: input.name,
        success: true,
        persona_id: persona.id,
      });
      result.summary.imported++;
    } catch (err: any) {
      result.results.push({
        name: input.name || "(unnamed)",
        success: false,
        error: err.message || String(err),
      });
      result.summary.failed++;
    }
  }

  return c.json(result, 201);
});

// POST /world-books — Bulk import world books
app.post("/world-books", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<WorldBookBulkImportRequest>();

  if (!body.world_books || !Array.isArray(body.world_books)) {
    return c.json({ error: "world_books array is required" }, 400);
  }

  const result: WorldBookBulkImportResult = {
    results: [],
    summary: { total: body.world_books.length, imported: 0, failed: 0 },
  };

  for (const wb of body.world_books) {
    const name = wb.name || "Imported World Book";
    try {
      const { worldBook, entryCount } = worldBooksSvc.importWorldBookBulk(userId, {
        name: wb.name,
        description: wb.description,
        entries: wb.entries,
      });

      result.results.push({
        name,
        success: true,
        world_book_id: worldBook.id,
        entry_count: entryCount,
      });
      result.summary.imported++;
    } catch (err: any) {
      result.results.push({
        name,
        success: false,
        error: err.message || String(err),
      });
      result.summary.failed++;
    }
  }

  return c.json(result, 201);
});

export { app as migrateRoutes };
