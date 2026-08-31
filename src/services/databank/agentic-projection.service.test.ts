import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import type { DatabankRetrievalResult } from "./types";

const retrievalQueries: string[] = [];

mock.module("../embeddings.service", () => ({
  getEmbeddingConfig: async () => ({ enabled: true }),
}));

mock.module("./retrieval.service", () => ({
  getCachedDatabankResult: () => null,
  searchDatabanks: async (
    _userId: string,
    _chatId: string,
    _databankIds: string[],
    queryText: string,
  ): Promise<DatabankRetrievalResult> => {
    retrievalQueries.push(queryText);
    return { chunks: [], formatted: "", count: 0 };
  },
}));

// Bun dependency fakes must be registered before these modules are evaluated.
const { resolveAgenticDatabankProjection } = await import("./agentic-projection.service");
const { clearAllResolveCache } = await import("./mention-resolver.service");

const USER_ID = "projection-user";
const CHAT_ID = "projection-chat";
const BANK_ID = "projection-bank";

function createSchema(): void {
  getDb().run(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      character_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      user_id TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      index_in_chat INTEGER NOT NULL,
      is_user INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      swipe_id INTEGER NOT NULL DEFAULT 0,
      swipes TEXT NOT NULL DEFAULT '[]',
      extra TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE settings (
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0,
      user_id TEXT NOT NULL,
      PRIMARY KEY (key, user_id)
    );
    CREATE TABLE databanks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL,
      scope_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE databank_documents (
      id TEXT PRIMARY KEY,
      databank_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '',
      total_chunks INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error_message TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE databank_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      databank_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      vectorized_at INTEGER,
      vector_model TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `);
}

function seedMessage(input: {
  id: string;
  index: number;
  content: string;
  isUser?: boolean;
  extra?: Record<string, unknown>;
}): void {
  getDb().query(
    `INSERT INTO messages
      (id, chat_id, index_in_chat, is_user, content, swipe_id, swipes, extra)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    input.id,
    CHAT_ID,
    input.index,
    input.isUser === false ? 0 : 1,
    input.content,
    JSON.stringify([input.content]),
    JSON.stringify(input.extra ?? {}),
  );
}

function seedDocument(slug: string, content: string): void {
  const documentId = `document-${slug}`;
  getDb().query(
    `INSERT INTO databank_documents
      (id, databank_id, user_id, name, slug, file_path, mime_type, file_size,
       content_hash, total_chunks, status, error_message, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'text/plain', ?, ?, 1, 'ready', NULL, '{}', 1, 1)`,
  ).run(
    documentId,
    BANK_ID,
    USER_ID,
    `${slug}.txt`,
    slug,
    `${slug}.txt`,
    content.length,
    `hash-${slug}`,
  );
  getDb().query(
    `INSERT INTO databank_chunks
      (id, document_id, databank_id, user_id, chunk_index, content, token_count,
       vectorized_at, vector_model, metadata, created_at)
     VALUES (?, ?, ?, ?, 0, ?, 2, 1, 'test', '{}', 1)`,
  ).run(`chunk-${slug}`, documentId, BANK_ID, USER_ID, content);
}

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  createSchema();
  getDb().query(
    "INSERT INTO chats (id, character_id, metadata, user_id) VALUES (?, NULL, '{}', ?)",
  ).run(CHAT_ID, USER_ID);
  getDb().query(
    `INSERT INTO databanks
      (id, user_id, name, description, scope, scope_id, enabled, metadata, created_at, updated_at)
     VALUES (?, ?, 'Projection bank', '', 'chat', ?, 1, '{}', 1, 1)`,
  ).run(BANK_ID, USER_ID, CHAT_ID);
  retrievalQueries.length = 0;
  clearAllResolveCache();
});

afterEach(() => {
  clearAllResolveCache();
  closeDatabase();
});

describe("agentic Databank projection hidden-message parity", () => {
  test("falls back to the latest visible user message without resolving a hidden #slug", async () => {
    seedDocument("hidden-reference", "private reference text");
    seedMessage({ id: "visible-user", index: 0, content: "visible persisted request" });
    seedMessage({
      id: "hidden-user",
      index: 1,
      content: "private draft #hidden-reference",
      extra: { hidden: true },
    });

    const projection = await resolveAgenticDatabankProjection({
      userId: USER_ID,
      chatId: CHAT_ID,
    });

    expect(projection.strippedUserInput).toBe("visible persisted request");
    expect(projection.mentions).toEqual([]);
    expect(projection.mentionAppendix).toBe("");
    expect(retrievalQueries).toEqual(["visible persisted request"]);
  });

  test("builds the six-message retrieval query from visible history before applying its limit", async () => {
    seedDocument("visible-reference", "visible reference text");
    seedDocument("hidden-reference", "private reference text");
    seedMessage({ id: "visible-0", index: 0, content: "visible zero", isUser: false });
    seedMessage({ id: "visible-1", index: 1, content: "visible one" });
    seedMessage({
      id: "hidden-2",
      index: 2,
      content: "private two #hidden-reference",
      extra: { hidden: true },
    });
    seedMessage({ id: "visible-3", index: 3, content: "visible two", isUser: false });
    seedMessage({
      id: "hidden-4",
      index: 4,
      content: "private four",
      isUser: false,
      extra: { hidden: true },
    });
    seedMessage({ id: "visible-5", index: 5, content: "visible three" });
    seedMessage({ id: "visible-6", index: 6, content: "visible four", isUser: false });
    seedMessage({
      id: "hidden-7",
      index: 7,
      content: "private seven #hidden-reference",
      extra: { hidden: 1 },
    });
    seedMessage({ id: "visible-8", index: 8, content: "visible five" });
    seedMessage({
      id: "hidden-9",
      index: 9,
      content: "private nine",
      isUser: false,
      extra: { hidden: true },
    });

    const projection = await resolveAgenticDatabankProjection({
      userId: USER_ID,
      chatId: CHAT_ID,
      userInput: "current #visible-reference",
    });

    expect(retrievalQueries).toEqual([
      "visible zero visible one visible two visible three visible four visible five current #visible-reference",
    ]);
    expect(retrievalQueries[0]).not.toContain("private");
    expect(retrievalQueries[0]).not.toContain("#hidden-reference");
    expect(projection.strippedUserInput).toBe("current");
    expect(projection.mentions.map((mention) => mention.slug)).toEqual(["visible-reference"]);
    expect(projection.mentionAppendix).toContain("visible reference text");
    expect(projection.mentionAppendix).not.toContain("private reference text");
  });
});
