import { beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  _getCachedTokenizerIdsForTests,
  _resetForTests,
  countWithTokenizer,
  prewarm,
} from "./tokenizer.service";

function createTokenizerTables(): void {
  getDb().run(`CREATE TABLE tokenizer_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE tokenizer_model_patterns (
    id TEXT PRIMARY KEY,
    tokenizer_id TEXT NOT NULL,
    pattern TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    model TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
}

function insertApproximateTokenizer(id: string): void {
  getDb()
    .query(
      "INSERT INTO tokenizer_configs (id, name, type, config, is_built_in, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0)"
    )
    .run(id, id, "approximate", JSON.stringify({ charsPerToken: 4 }));
}

function insertPattern(id: string, tokenizerId: string, pattern: string, priority: number): void {
  getDb()
    .query(
      "INSERT INTO tokenizer_model_patterns (id, tokenizer_id, pattern, priority, is_built_in, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0)"
    )
    .run(id, tokenizerId, pattern, priority);
}

function insertConnection(input: {
  id: string;
  userId: string;
  model: string;
  isDefault?: boolean;
  updatedAt: number;
}): void {
  getDb()
    .query(
      "INSERT INTO connection_profiles (id, user_id, model, is_default, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(input.id, input.userId, input.model, input.isDefault ? 1 : 0, input.updatedAt);
}

function putSetting(userId: string, key: string, value: unknown, updatedAt: number): void {
  getDb()
    .query("INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)")
    .run(key, JSON.stringify(value), userId, updatedAt);
}

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  createTokenizerTables();
  _resetForTests();
});

describe("prewarm", () => {
  test("prefers active and default connections and caps startup warming", async () => {
    for (const id of [
      "tok-active-u1",
      "tok-active-u2",
      "tok-active-u4",
      "tok-default-u1",
      "tok-default-u2",
      "tok-fallback-u3",
    ]) {
      insertApproximateTokenizer(id);
    }

    insertPattern("pat-active-u1", "tok-active-u1", "^model-active-u1$", 100);
    insertPattern("pat-active-u2", "tok-active-u2", "^model-active-u2$", 100);
    insertPattern("pat-active-u4", "tok-active-u4", "^model-active-u4$", 100);
    insertPattern("pat-default-u1", "tok-default-u1", "^model-default-u1$", 90);
    insertPattern("pat-default-u2", "tok-default-u2", "^model-default-u2$", 90);
    insertPattern("pat-fallback-u3", "tok-fallback-u3", "^model-fallback-u3$", 80);

    insertConnection({ id: "c1", userId: "u1", model: "model-active-u1", updatedAt: 210 });
    insertConnection({ id: "c2", userId: "u1", model: "model-default-u1", isDefault: true, updatedAt: 200 });
    putSetting("u1", "activeProfileId", "c1", 300);

    insertConnection({ id: "c3", userId: "u2", model: "model-active-u2", updatedAt: 120 });
    insertConnection({ id: "c4", userId: "u2", model: "model-default-u2", isDefault: true, updatedAt: 100 });
    putSetting("u2", "activeProfileId", "c3", 250);

    insertConnection({ id: "c5", userId: "u3", model: "model-fallback-u3", updatedAt: 400 });

    insertConnection({ id: "c6", userId: "u4", model: "model-active-u4", updatedAt: 150 });
    putSetting("u4", "activeProfileId", "c6", 150);

    await prewarm();

    expect(_getCachedTokenizerIdsForTests()).toEqual([
      "tok-active-u1",
      "tok-active-u2",
      "tok-active-u4",
      "tok-default-u1",
      "tok-default-u2",
    ]);
  });
});

describe("tokenizer instance cache", () => {
  test("evicts least-recently-used tokenizers and refreshes hits", async () => {
    for (const id of ["tok-1", "tok-2", "tok-3", "tok-4", "tok-5"]) {
      insertApproximateTokenizer(id);
    }

    await countWithTokenizer("tok-1", "one");
    await countWithTokenizer("tok-2", "two");
    await countWithTokenizer("tok-3", "three");
    await countWithTokenizer("tok-4", "four");
    expect(_getCachedTokenizerIdsForTests()).toEqual(["tok-1", "tok-2", "tok-3", "tok-4"]);

    await countWithTokenizer("tok-2", "two again");
    expect(_getCachedTokenizerIdsForTests()).toEqual(["tok-1", "tok-3", "tok-4", "tok-2"]);

    await countWithTokenizer("tok-5", "five");
    expect(_getCachedTokenizerIdsForTests()).toEqual(["tok-1", "tok-3", "tok-4", "tok-2", "tok-5"]);
  });
});
