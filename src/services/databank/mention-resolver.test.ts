import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import {
  __mentionResolveCacheTest,
  clearAllResolveCache,
  extractMentionSlugs,
  lookupSlugsInScope,
  stripMentions,
} from "./mention-resolver.service";
import type { DatabankScope, DocumentStatus } from "./types";

describe("extractMentionSlugs", () => {
  test("extracts a basic slug", () => {
    const slugs = extractMentionSlugs("please read #foo and respond");
    expect(slugs.has("foo")).toBe(true);
    expect(slugs.size).toBe(1);
  });

  test("returns empty set when message has no '#' character", () => {
    expect(extractMentionSlugs("nothing to see here").size).toBe(0);
  });

  test("dedupes repeated slugs in the same message", () => {
    const slugs = extractMentionSlugs("#foo and #foo and #foo again");
    expect(slugs.size).toBe(1);
    expect(slugs.has("foo")).toBe(true);
  });

  test("captures multiple distinct slugs", () => {
    const slugs = extractMentionSlugs("compare #alpha-doc with #beta and #gamma-3");
    expect(slugs.size).toBe(3);
    expect(slugs.has("alpha-doc")).toBe(true);
    expect(slugs.has("beta")).toBe(true);
    expect(slugs.has("gamma-3")).toBe(true);
  });

  test("matches at start of string", () => {
    const slugs = extractMentionSlugs("#first-thing then talk");
    expect(slugs.has("first-thing")).toBe(true);
  });

  test("ignores hash characters not preceded by whitespace", () => {
    // "C#" or "abc#foo" are not mentions
    const slugs = extractMentionSlugs("I love C#programming and abc#foo");
    expect(slugs.size).toBe(0);
  });

  test("lowercases captured slugs", () => {
    const slugs = extractMentionSlugs("look at #FooBar");
    expect(slugs.has("foobar")).toBe(true);
  });
});

describe("stripMentions", () => {
  test("removes resolved slug while preserving surrounding text", () => {
    const out = stripMentions("please read #foo and respond", new Set(["foo"]));
    expect(out).toBe("please read and respond");
  });

  test("leaves unresolved slugs alone", () => {
    const out = stripMentions("read #foo but not #bar", new Set(["foo"]));
    expect(out).toBe("read but not #bar");
  });

  test("removes multiple instances of the same slug", () => {
    const out = stripMentions("#foo and #foo again", new Set(["foo"]));
    expect(out).toBe("and again");
  });

  test("returns input unchanged when no '#' is present", () => {
    const out = stripMentions("nothing here", new Set(["foo"]));
    expect(out).toBe("nothing here");
  });

  test("returns input unchanged when validSlugs is empty", () => {
    const out = stripMentions("read #foo please", new Set());
    expect(out).toBe("read #foo please");
  });

  test("strips longer slug exactly when present in validSlugs", () => {
    const out = stripMentions("read #foo-bar please", new Set(["foo-bar"]));
    expect(out).toBe("read please");
  });
});

interface BankSeed {
  id: string;
  userId?: string;
  enabled?: boolean;
  scope?: DatabankScope;
  scopeId?: string | null;
}

interface DocumentSeed {
  id: string;
  databankId: string;
  slug: string;
  userId?: string;
  status?: DocumentStatus;
  totalChunks?: number;
  withChunk?: boolean;
}

function seedBank({
  id,
  userId = "user-1",
  enabled = true,
  scope = "chat",
  scopeId = "chat-1",
}: BankSeed): void {
  getDb().run(
    `INSERT INTO databanks
      (id, user_id, name, description, scope, scope_id, enabled, metadata, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?, '{}', 1, 1)`,
    [id, userId, id, scope, scopeId, enabled ? 1 : 0],
  );
}

function seedDocument({
  id,
  databankId,
  slug,
  userId = "user-1",
  status = "ready",
  totalChunks = 1,
  withChunk = true,
}: DocumentSeed): void {
  const db = getDb();
  db.run(
    `INSERT INTO databank_documents
      (id, databank_id, user_id, name, slug, file_path, mime_type, file_size, content_hash,
       total_chunks, status, error_message, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'text/plain', 1, ?, ?, ?, NULL, '{}', 1, 1)`,
    [id, databankId, userId, id, slug, `${id}.txt`, `${id}-hash`, totalChunks, status],
  );
  if (withChunk) {
    db.run(
      `INSERT INTO databank_chunks
        (id, document_id, databank_id, user_id, chunk_index, content, token_count,
         vectorized_at, vector_model, metadata, created_at)
       VALUES (?, ?, ?, ?, 0, 'chunk content', 2, NULL, NULL, '{}', 1)`,
      [`${id}-chunk`, id, databankId, userId],
    );
  }
}

describe("lookupSlugsInScope", () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(":memory:");
    const db = getDb();
    db.run(`CREATE TABLE databanks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT,
      enabled INTEGER NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE databank_documents (
      id TEXT PRIMARY KEY, databank_id TEXT NOT NULL, user_id TEXT NOT NULL,
      name TEXT NOT NULL, slug TEXT NOT NULL, file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL, file_size INTEGER NOT NULL, content_hash TEXT NOT NULL,
      total_chunks INTEGER NOT NULL, status TEXT NOT NULL, error_message TEXT,
      metadata TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE databank_chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, databank_id TEXT NOT NULL,
      user_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
      token_count INTEGER NOT NULL, vectorized_at INTEGER, vector_model TEXT,
      metadata TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
  });

  afterEach(() => {
    closeDatabase();
  });

  test("resolves a cross-scoped chat bank when its authoritative active ID is supplied", () => {
    seedBank({ id: "attached-bank", scope: "chat", scopeId: "different-chat" });
    seedDocument({ id: "attached-doc", databankId: "attached-bank", slug: "attached-doc" });

    const result = lookupSlugsInScope("user-1", ["attached-doc"], ["attached-bank"]);

    expect(result.validSlugs).toEqual(new Set(["attached-doc"]));
    expect(result.docs.get("attached-doc")?.databankId).toBe("attached-bank");
  });

  test("rejects a disabled bank even when its ID is supplied", () => {
    seedBank({ id: "disabled-bank", enabled: false });
    seedDocument({ id: "disabled-doc", databankId: "disabled-bank", slug: "disabled-doc" });

    const result = lookupSlugsInScope("user-1", ["disabled-doc"], ["disabled-bank"]);

    expect(result.validSlugs.size).toBe(0);
    expect(result.docs.size).toBe(0);
  });

  test("rejects a bank owned by another user even when its ID is supplied", () => {
    seedBank({ id: "foreign-bank", userId: "user-2" });
    seedDocument({
      id: "foreign-doc",
      databankId: "foreign-bank",
      slug: "foreign-doc",
      userId: "user-2",
    });

    const result = lookupSlugsInScope("user-1", ["foreign-doc"], ["foreign-bank"]);

    expect(result.validSlugs.size).toBe(0);
    expect(result.docs.size).toBe(0);
  });

  test("rejects a document that is not ready", () => {
    seedBank({ id: "active-bank" });
    seedDocument({
      id: "processing-doc",
      databankId: "active-bank",
      slug: "processing-doc",
      status: "processing",
    });

    const result = lookupSlugsInScope("user-1", ["processing-doc"], ["active-bank"]);

    expect(result.validSlugs.size).toBe(0);
    expect(result.docs.size).toBe(0);
  });

  test("rejects a ready document without a persisted chunk", () => {
    seedBank({ id: "active-bank" });
    seedDocument({
      id: "empty-doc",
      databankId: "active-bank",
      slug: "empty-doc",
      withChunk: false,
    });

    const result = lookupSlugsInScope("user-1", ["empty-doc"], ["active-bank"]);

    expect(result.validSlugs.size).toBe(0);
    expect(result.docs.size).toBe(0);
});

describe("mention resolution cache", () => {
  test("caps retained results and clears them under memory pressure", () => {
    clearAllResolveCache();
    for (let index = 0; index <= 256; index++) {
      __mentionResolveCacheTest.set(`test-user:chat-${index}:key-${index}`, [{
        slug: `doc-${index}`,
        documentName: `Document ${index}`,
        content: "content",
        truncated: false,
      }]);
    }

    expect(__mentionResolveCacheTest.size()).toBe(256);
    expect(__mentionResolveCacheTest.keys()).not.toContain("test-user:chat-0:key-0");

    clearAllResolveCache();
    expect(__mentionResolveCacheTest.size()).toBe(0);
  });
  });
});
