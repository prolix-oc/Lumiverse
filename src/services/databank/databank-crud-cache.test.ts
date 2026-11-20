import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import {
  deleteDocument,
  updateDatabank,
  updateDocumentStatus,
} from "./databank-crud.service";
import {
  getCachedDatabankResult,
  resetDatabankCacheForTests,
  setCachedDatabankResult,
} from "./retrieval-cache.service";
import type { DatabankRetrievalResult } from "./types";

const cachedResult: DatabankRetrievalResult = {
  chunks: [],
  formatted: "deleted document content",
  count: 1,
};

function seedBankAndDocument(): void {
  const db = getDb();
  db.run(`INSERT INTO databanks
    (id, user_id, name, description, scope, scope_id, enabled, metadata, created_at, updated_at)
    VALUES ('bank-1', 'user-1', 'Bank', '', 'chat', 'chat-1', 1, '{}', 1, 1)`);
  db.run(`INSERT INTO databank_documents
    (id, databank_id, user_id, name, slug, file_path, mime_type, file_size, content_hash,
     total_chunks, status, error_message, metadata, created_at, updated_at)
    VALUES ('doc-1', 'bank-1', 'user-1', 'Doc', 'doc', 'missing.txt', 'text/plain', 1, 'hash',
            1, 'ready', NULL, '{}', 1, 1)`);
}

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
  resetDatabankCacheForTests();
  seedBankAndDocument();
});

afterEach(() => {
  resetDatabankCacheForTests();
  closeDatabase();
});

function prime(): void {
  setCachedDatabankResult("user-1", "chat-1", ["bank-1"], "same query", 4, cachedResult);
}

function cached(): DatabankRetrievalResult | null {
  return getCachedDatabankResult("user-1", "chat-1", ["bank-1"], "same query", 4);
}

describe("databank mutations invalidate retrieval results", () => {
  test("disabling a databank drops its cached chunks", () => {
    prime();

    updateDatabank("user-1", "bank-1", { enabled: false });

    expect(cached()).toBeNull();
  });

  test("deleting the last document drops content cached for the now-empty bank", async () => {
    prime();

    expect(await deleteDocument("user-1", "doc-1")).toBe(true);

    expect(cached()).toBeNull();
  });

  test("reprocessing status changes drop content from the previous document version", () => {
    prime();

    updateDocumentStatus("doc-1", "processing");

    expect(cached()).toBeNull();
  });
});
