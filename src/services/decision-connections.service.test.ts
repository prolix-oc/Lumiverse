import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createConnection, deleteConnection, duplicateConnection, evaluate, getConnection, getDefaultConnection, isDecisionConnectionSecretKey, listConnections, previewModels, updateConnection } from "./decision-connections.service";

beforeEach(() => {
  initDatabase(":memory:");
  getDb().exec('CREATE TABLE "user" (id TEXT PRIMARY KEY); CREATE TABLE secrets (key TEXT, user_id TEXT, value TEXT);');
  getDb().exec(readFileSync(new URL("../db/migrations/122_decision_connections.sql", import.meta.url), "utf8"));
  getDb().query('INSERT INTO "user" (id) VALUES (?), (?)').run("alice", "bob");
});
afterEach(() => closeDatabase());

describe("decision connections", () => {
  test("identifies decision credentials excluded from backup and import", () => {
    expect(isDecisionConnectionSecretKey("decision_connection_123_api_key")).toBe(true);
    expect(isDecisionConnectionSecretKey("connection_123_api_key")).toBe(false);
  });
  test("isolates CRUD and defaults by user", async () => {
    const alice = await createConnection("alice", { name: "Alice Jev", gateway: "typesafe" });
    const bob = await createConnection("bob", { name: "Bob Jev", gateway: "openrouter" });
    expect(alice.is_default).toBe(true);
    expect(bob.is_default).toBe(true);
    expect(getConnection("bob", alice.id)).toBeNull();
    expect(await updateConnection("bob", alice.id, { name: "stolen" })).toBeNull();
    expect(await duplicateConnection("bob", alice.id)).toBeNull();
    expect(deleteConnection("bob", alice.id)).toBe(false);
    expect(getDefaultConnection("alice")?.id).toBe(alice.id);
    expect(listConnections("bob").map((item) => item.id)).toEqual([bob.id]);

    const copy = await duplicateConnection("alice", alice.id);
    expect(copy?.is_default).toBe(false);
    await updateConnection("alice", copy!.id, { is_default: true });
    expect(getDefaultConnection("alice")?.id).toBe(copy!.id);
    expect(deleteConnection("alice", copy!.id)).toBe(true);
    expect(getDefaultConnection("alice")?.id).toBe(alice.id);
  });

  test("requires an explicit custom protocol and keeps credentials out of profiles", async () => {
    await expect(createConnection("alice", { name: "Custom", gateway: "custom", api_url: "https://example.com/decisions", model: "jev" })).rejects.toThrow(/protocol/);
    const connection = await createConnection("alice", { name: "Custom", gateway: "custom", protocol: "typesafe", api_url: "https://example.com/decisions", model: "jev" });
    expect(connection).not.toHaveProperty("api_key");
    expect(connection.protocol).toBe("typesafe");
    await expect(updateConnection("alice", connection.id, { gateway: "typesafe" })).resolves.toMatchObject({ protocol: "typesafe" });
    await expect(updateConnection("alice", connection.id, { gateway: "custom", api_url: "https://example.com/decisions", model: "jev" })).rejects.toThrow(/protocol/);
  });

  test("an imported connection cannot evaluate until a new key is entered", async () => {
    const connection = await createConnection("alice", { name: "Imported Jev", gateway: "typesafe" });
    const request = { state: "Hello", questions: { yes: { type: "noul" as const, instructions: "Is this a greeting?" } } };
    await expect(evaluate("alice", { ...request, connectionId: connection.id })).rejects.toThrow(/API key/);
    await expect(evaluate("bob", { ...request, connectionId: connection.id })).rejects.toThrow(/not found/);
    await expect(evaluate("alice", { ...request, userId: "bob" } as any)).rejects.toThrow(/cannot specify a user ID/);
  });

  test("model lookup respects ownership and returns decision models", async () => {
    const connection = await createConnection("alice", { name: "Jev", gateway: "typesafe" });
    const result = await previewModels("alice", { connection_id: connection.id });
    expect(result.models).toContain("jev-1.13.0");
    await expect(previewModels("bob", { connection_id: connection.id })).rejects.toThrow(/not found/);
    await expect(previewModels("alice", { connection_id: connection.id, user_id: "bob" } as any)).rejects.toThrow(/Invalid/);
  });
});
