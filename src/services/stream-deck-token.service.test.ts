import { beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { authenticateToken, createToken, deleteToken, listTokens } from "./stream-deck-token.service";

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run('CREATE TABLE "user" (id TEXT PRIMARY KEY)');
  getDb().run(`CREATE TABLE stream_deck_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at INTEGER
  )`);
  getDb().run('INSERT INTO "user" (id) VALUES (\'user-1\')');
});

describe("Stream Deck integration tokens", () => {
  test("stores only a hash and authenticates the one-time plaintext token", () => {
    const created = createToken("user-1", { name: "Desk" });
    expect(created.token.startsWith("lvsd_")).toBe(true);
    expect(listTokens("user-1")[0]?.name).toBe("Desk");

    const stored = getDb().query("SELECT token_hash FROM stream_deck_tokens WHERE id = ?").get(created.id) as any;
    expect(stored.token_hash).not.toContain(created.token);
    expect(authenticateToken(created.token)).toEqual({
      userId: "user-1",
      scopes: ["characters:read", "chats:read"],
    });
  });

  test("rejects unsupported scopes and revoked tokens", () => {
    expect(() => createToken("user-1", { scopes: ["characters:read", "admin"] })).toThrow();
    const created = createToken("user-1", { scopes: ["chats:read"] });
    expect(deleteToken("user-1", created.id)).toBe(true);
    expect(authenticateToken(created.token)).toBeNull();
  });

  test("rejects expired tokens", () => {
    expect(() => createToken("user-1", { expiresAt: Math.floor(Date.now() / 1000) - 1 })).toThrow();
  });
});
