import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { __test__ } from "./import.service";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "archive-user:chat_chunk:chunk-1:0",
    user_id: "archive-user",
    source_type: "chat_chunk",
    source_id: "chunk-1",
    owner_id: "chat-1",
    chunk_index: 0,
    content: "bounded content",
    vector: [0.25, -0.5],
    metadata_json: "{}",
    updated_at: 1,
    ...overrides,
  };
}

const context = {
  userId: "importing-user",
  sourceOwner: "archive-user",
  expectedDimension: 2,
};

describe("archive vector validation", () => {
  test("requires a source-owner-bound composite ID and rejects foreign rows", () => {
    expect(() => __test__.validateVectorArchiveRowShape(
      row({ user_id: "other-user" }),
      context,
    )).toThrow(/owned by another user/);
    expect(() => __test__.validateVectorArchiveRowShape(
      row({ id: "other-user:chat_chunk:chunk-1:0" }),
      context,
    )).toThrow(/does not match/);
  });
  test("requires source IDs to resolve to staged owner-bound canonical rows", () => {
    const stage = new Database(":memory:");
    stage.run("CREATE TABLE world_books (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)");
    stage.run("CREATE TABLE world_book_entries (id TEXT PRIMARY KEY, world_book_id TEXT NOT NULL)");
    stage.run("INSERT INTO world_books (id, user_id) VALUES ('book-1', 'archive-user')");
    stage.run("INSERT INTO world_book_entries (id, world_book_id) VALUES ('entry-1', 'book-1')");

    expect(() => __test__.assertVectorCanonicalSource(
      stage,
      "world_book_entry",
      "entry-1",
      "book-1",
    )).not.toThrow();
    expect(() => __test__.assertVectorCanonicalSource(
      stage,
      "world_book_entry",
      "missing-entry",
      "book-1",
    )).toThrow(/source ID/);
    expect(() => __test__.assertVectorCanonicalSource(
      stage,
      "world_book_entry",
      "entry-1",
      "other-book",
    )).toThrow(/owner/);
    stage.run("INSERT INTO world_books (id, user_id) VALUES ('book-foreign', 'other-user')");
    stage.run("INSERT INTO world_book_entries (id, world_book_id) VALUES ('entry-foreign', 'book-foreign')");
    expect(() => __test__.assertVectorCanonicalSource(
      stage,
      "world_book_entry",
      "entry-foreign",
      "book-foreign",
      "archive-user",
    )).toThrow(/archive user/);
    stage.close();
  });


  test("rejects duplicate IDs, NaN/Infinity, and dimension cap plus one", () => {
    const seen = new Set<string>();
    __test__.validateVectorArchiveRowShape(row(), context, seen);
    expect(() => __test__.validateVectorArchiveRowShape(row(), context, seen)).toThrow(/duplicate/);
    expect(() => __test__.validateVectorArchiveRowShape(row({ vector: [Number.NaN, 0] }), context)).toThrow(/non-finite/);
    const oversized = new Array(__test__.maxVectorDimension + 1).fill(0);
    expect(() => __test__.validateVectorArchiveRowShape(row({ vector: oversized }), {
      ...context,
      expectedDimension: null,
    })).toThrow(/dimension/);
  });
  test("rejects a serialized row at the row byte cap", () => {
    expect(() => __test__.validateVectorArchiveRowShape(row({
      padding: "x".repeat(__test__.maxVectorRowBytes),
    }), context)).toThrow(/row exceeds byte cap|batch byte cap/);
  });

  test("rejects a row at the per-batch byte cap plus one", () => {
    expect(() => __test__.validateVectorArchiveRowShape(row({
      padding: "x".repeat(__test__.maxVectorBatchBytes),
    }), context)).toThrow(/batch byte cap/);
  });

  test("requires valid finite metadata and embedding identity", () => {
    expect(() => __test__.validateVectorArchiveRowShape(row({ metadata_json: "[]" }), context)).toThrow(/metadata/);
    expect(() => __test__.validateVectorArchiveRowShape(row({ metadata_json: "{" }), context)).toThrow(/metadata/);
    expect(() => __test__.validateVectorArchiveRowShape(row({ vector: [0.1] }), context)).toThrow(/dimension/);
    expect(() => __test__.validateVectorArchiveIdentity({
      schemaVersion: 3,
      embeddingConfig: { provider: "unsupported", model: "model", dimension: 2 },
    } as any, true)).toThrow(/unsupported/);
  });
  test("accepts only bounded legacy vector_b64 rows and never treats them as bound V2 rows", () => {
    const bytes = new Uint8Array(new Float32Array([0.25, -0.5]).buffer);
    const legacy = {
      id: "archive-user:chat_chunk:chunk-1:0",
      source_type: "chat_chunk",
      source_id: "chunk-1",
      owner_id: "chat-1",
      chunk_index: 0,
      content: "legacy",
      metadata_json: "{}",
      vector_b64: Buffer.from(bytes).toString("base64"),
    };
    expect(__test__.validateLegacyVectorArchiveRow(legacy, 2)).toEqual({
      dimension: 2,
      decodedBytes: bytes.byteLength,
    });
    expect(() => __test__.validateVectorArchiveRowShape(legacy, context)).toThrow(/user_id/);
    expect(() => __test__.validateLegacyVectorArchiveRow({ ...legacy, vector_b64: "%%%%" }, 2))
      .toThrow(/base64/);
    const oversizedBytes = new Uint8Array((__test__.maxVectorDimension + 1) * Float32Array.BYTES_PER_ELEMENT);
    expect(() => __test__.validateLegacyVectorArchiveRow({
      ...legacy,
      vector_b64: Buffer.from(oversizedBytes).toString("base64"),
    }, null)).toThrow(/dimension|cap/);
  });

  test("rejects identity and index values at their cap plus one", () => {
    const oversizedId = "c".repeat(__test__.maxVectorIdBytes + 1);
    expect(() => __test__.validateVectorArchiveRowShape(row({
      source_id: oversizedId,
      id: `archive-user:chat_chunk:${oversizedId}:0`,
    }), context)).toThrow(/source_id exceeds/);
    expect(() => __test__.validateVectorArchiveRowShape(row({
      chunk_index: __test__.maxVectorDimension + 1,
      id: `archive-user:chat_chunk:chunk-1:${__test__.maxVectorDimension + 1}`,
    }), context)).toThrow(/chunk_index is out of range/);
  });

  test("never accepts an ID minted for the importing tenant instead of the archive owner", () => {
    expect(() => __test__.validateVectorArchiveRowShape(
      row({ id: "importing-user:chat_chunk:chunk-1:0" }),
      context,
    )).toThrow(/does not match/);
  });

  test("binds databank and memory vectors to same-tenant staged canonical rows", () => {
    const stage = new Database(":memory:");
    stage.run("CREATE TABLE databanks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)");
    stage.run("CREATE TABLE databank_chunks (id TEXT PRIMARY KEY, databank_id TEXT NOT NULL)");
    stage.run("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)");
    stage.run("CREATE TABLE memory_consolidations (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL)");
    stage.run("INSERT INTO databanks (id, user_id) VALUES ('bank-1', 'archive-user')");
    stage.run("INSERT INTO databanks (id, user_id) VALUES ('bank-2', 'archive-user')");
    stage.run("INSERT INTO databanks (id, user_id) VALUES ('bank-foreign', 'other-user')");
    stage.run("INSERT INTO databank_chunks (id, databank_id) VALUES ('chunk-1', 'bank-1')");
    stage.run("INSERT INTO databank_chunks (id, databank_id) VALUES ('chunk-foreign', 'bank-foreign')");
    stage.run("INSERT INTO chats (id, user_id) VALUES ('chat-1', 'archive-user')");
    stage.run("INSERT INTO chats (id, user_id) VALUES ('chat-foreign', 'other-user')");
    stage.run("INSERT INTO memory_consolidations (id, chat_id) VALUES ('mc-1', 'chat-1')");
    stage.run("INSERT INTO memory_consolidations (id, chat_id) VALUES ('mc-foreign', 'chat-foreign')");

    expect(() => __test__.assertVectorCanonicalSource(stage, "databank", "chunk-1", "bank-1", "archive-user")).not.toThrow();
    expect(() => __test__.assertVectorCanonicalSource(stage, "databank", "chunk-1", "bank-2", "archive-user"))
      .toThrow(/source ID/);
    expect(() => __test__.assertVectorCanonicalSource(stage, "databank", "chunk-foreign", "bank-foreign", "archive-user"))
      .toThrow(/archive user/);
    expect(() => __test__.assertVectorCanonicalSource(stage, "memory_consolidation", "mc-1", "chat-1", "archive-user")).not.toThrow();
    expect(() => __test__.assertVectorCanonicalSource(stage, "memory_vector", "mc-foreign", "chat-foreign", "archive-user"))
      .toThrow(/archive user/);
    stage.close();
  });
});
