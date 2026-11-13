import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import type { FileSystem } from "../file-connections/types";
import { scanSTData } from "./st-reader";
import { importSTConnections } from "./st-migration.service";

const root = "/st-data";
const secretValue = "never-return-this-secret";

function makeFs(
  withSecrets = true,
  profiles: Array<Record<string, unknown>> = [
    { id: "profile-1", name: "Primary", api: "openai", "api-url": "https://api.openai.com/v1", model: "gpt-test", "secret-id": "key-1" },
    { id: "profile-tc", name: "TC", mode: "tc", api: "openai", "api-url": "https://api.openai.com/v1" },
  ],
  proxies: Array<Record<string, unknown>> = [
    { name: "Reverse", url: "https://proxy.example/v1", password: withSecrets ? secretValue : undefined },
  ],
  onRead?: (path: string) => void,
): FileSystem {
  const files = new Map<string, string>([
    [`${root}/settings.json`, JSON.stringify({
      extension_settings: { connectionManager: { profiles } },
      proxies,
    })],
    ...(withSecrets ? [[`${root}/secrets.json`, JSON.stringify({ api_key_openai: [{ id: "key-1", value: secretValue, active: true }] })] as [string, string]] : []),
  ]);
  return {
    type: "memory",
    connect: async () => {}, disconnect: async () => {},
    exists: async (path) => files.has(path) || path === root,
    stat: async (path) => ({ isDirectory: path === root, isFile: files.has(path), size: files.get(path)?.length ?? 0 }),
    readdir: async () => [], readFile: async (path) => { onRead?.(path); return Buffer.from(files.get(path) ?? ""); },
    readText: async (path) => { onRead?.(path); return files.get(path) ?? ""; },
    join: (...parts) => parts.join("/").replace(/\/+/g, "/"),
    dirname: (path) => path.slice(0, path.lastIndexOf("/")) || "/",
    basename: (path, ext = "") => path.slice(path.lastIndexOf("/") + 1).replace(new RegExp(`${ext}$`), ""),
    extname: (path) => path.slice(path.lastIndexOf(".")),
  };
}

const logger = { info() {}, warn() {}, error() {}, progress() {} };

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL,
    api_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', preset_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0, has_api_key INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  getDb().run(`CREATE TABLE secrets (
    key TEXT NOT NULL, encrypted_value TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL,
    user_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, user_id)
  )`);
}

beforeEach(initTestDb);
afterEach(() => closeDatabase());

describe("SillyTavern connection migration", () => {
  test("counts connection rows without including secret content", async () => {
    const counts = await scanSTData(root, makeFs());
    expect(counts.connections).toBe(2);
    expect(counts.proxies).toBe(1);
    expect(JSON.stringify(counts)).not.toContain(secretValue);
  });

  test("dry run is owner-scoped, skips TC, and redacts resolved secrets", async () => {
    const result = await importSTConnections("owner-a", root, { dryRun: true }, logger, makeFs());
    expect(result).toEqual({ imported: 2, repaired: 0, skipped: 1, failed: 0, dry_run: true });
    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(getDb().query("SELECT count(*) AS count FROM connection_profiles").get()).toEqual({ count: 0 });
  });

  test("confines reads to the selected directory and fixed migration files", async () => {
    const reads: string[] = [];
    await importSTConnections("owner-a", root, { dryRun: true }, logger, makeFs(true, undefined, undefined, path => reads.push(path)));
    expect([...new Set(reads)].sort()).toEqual([`${root}/secrets.json`, `${root}/settings.json`]);
    expect(reads.every(path => path.startsWith(`${root}/`))).toBe(true);
  });

  test("keeps resolved secrets out of results and migration logs", async () => {
    const messages: string[] = [];
    const captureLogger = {
      info: (message: string) => messages.push(message),
      warn: (message: string) => messages.push(message),
      error: (message: string) => messages.push(message),
      progress: (message: string) => messages.push(message),
    };
    getDb().run(`CREATE TRIGGER reject_primary_redaction BEFORE INSERT ON connection_profiles
      WHEN NEW.name = 'Primary' BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
    await expect(importSTConnections("owner-a", root, {}, captureLogger, makeFs())).rejects.toThrow("Connection migration failed");
    expect(JSON.stringify(messages)).not.toContain(secretValue);
  });

  test("imports once, then is idempotent for the same owner", async () => {
    const fs = makeFs(false);
    const first = await importSTConnections("owner-a", root, {}, logger, fs);
    const second = await importSTConnections("owner-a", root, {}, logger, fs);
    expect(first).toMatchObject({ imported: 2, skipped: 1, dry_run: false });
    expect(second).toMatchObject({ imported: 0, skipped: 3, dry_run: false });
    expect(getDb().query("SELECT count(*) AS count FROM connection_profiles WHERE user_id = ?").get("owner-a")).toEqual({ count: 2 });
    const otherOwner = await importSTConnections("owner-b", root, {}, logger, fs);
    expect(otherOwner).toMatchObject({ imported: 2, skipped: 1 });
    expect(getDb().query("SELECT count(*) AS count FROM connection_profiles WHERE user_id = ?").get("owner-b")).toEqual({ count: 2 });
  });

  test("repairs an existing ST profile only for the target owner", async () => {
    getDb().query(`INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, created_at, updated_at)
      VALUES ('existing', 'owner-a', 'Old', 'custom', 'https://old.example', '', NULL, 0, 0, ?, 1, 1)`).run(JSON.stringify({ source: "sillytavern", source_kind: "connection_profile", st_profile_id: "profile-1" }));
    getDb().query(`INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, created_at, updated_at)
      VALUES ('foreign', 'owner-b', 'Foreign', 'custom', 'https://foreign.example', 'foreign-model', NULL, 0, 0, ?, 1, 1)`).run(JSON.stringify({ source: "sillytavern", source_kind: "connection_profile", st_profile_id: "profile-1" }));
    const result = await importSTConnections("owner-a", root, { repairExisting: true }, logger, makeFs(false));
    expect(result).toMatchObject({ imported: 1, repaired: 1, dry_run: false });
    const repaired = getDb().query("SELECT name, provider, api_url, model FROM connection_profiles WHERE id = 'existing'").get();
    expect(repaired).toEqual({ name: "Primary", provider: "openai", api_url: "https://api.openai.com/v1", model: "gpt-test" });
    expect(getDb().query("SELECT name, provider, api_url, model FROM connection_profiles WHERE id = 'foreign'").get()).toEqual({
      name: "Foreign", provider: "custom", api_url: "https://foreign.example", model: "foreign-model",
    });
  });

  test("infers providers from API aliases and endpoint hosts", async () => {
    const profiles = [
      { id: "claude", name: "Claude", api: "claude", "api-url": "https://example.test" },
      { id: "google", name: "Google", api: "makersuite", "api-url": "https://example.test" },
      { id: "vertex", name: "Vertex", api: "vertexai", "api-url": "https://example.test" },
      { id: "openrouter", name: "Router", api: "custom", "api-url": "https://openrouter.ai/api/v1" },
      { id: "custom", name: "Custom", api: "openai", "api-url": "https://custom.example/v1" },
    ];
    const fs = makeFs(false, profiles, [{ name: "Groq", url: "https://api.groq.com/openai/v1" }]);
    expect(await importSTConnections("owner-a", root, {}, logger, fs)).toMatchObject({ imported: 6, skipped: 0 });
    const rows = getDb().query("SELECT name, provider FROM connection_profiles WHERE user_id = ? ORDER BY name").all("owner-a");
    expect(rows).toEqual([
      { name: "Claude", provider: "anthropic" },
      { name: "Custom", provider: "custom" },
      { name: "Google", provider: "google" },
      { name: "Proxy: Groq", provider: "groq" },
      { name: "Router", provider: "openrouter" },
      { name: "Vertex", provider: "google_vertex" },
    ]);
  });

  test("deduplicates equivalent source candidates in one import", async () => {
    const profiles = [
      { id: "first", name: " Same  Name ", api: "openai", "api-url": "https://api.openai.com/v1/", model: "GPT-X" },
      { id: "second", name: "same name", api: "openai", "api-url": "HTTPS://API.OPENAI.COM/V1", model: "gpt-x" },
    ];
    const result = await importSTConnections("owner-a", root, {}, logger, makeFs(false, profiles, []));
    expect(result).toMatchObject({ imported: 1, skipped: 1 });
    expect(getDb().query("SELECT count(*) AS count FROM connection_profiles WHERE user_id = ?").get("owner-a")).toEqual({ count: 1 });
  });

  test("rolls back all connection writes when a later import fails", async () => {
    getDb().run(`CREATE TRIGGER reject_proxy BEFORE INSERT ON connection_profiles
      WHEN NEW.name = 'Proxy: Reverse' BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
    await expect(importSTConnections("owner-a", root, {}, logger, makeFs(false))).rejects.toThrow("Connection migration failed");
    expect(getDb().query("SELECT count(*) AS count FROM connection_profiles WHERE user_id = ?").get("owner-a")).toEqual({ count: 0 });
  });

  test("removes a persisted secret when its profile insert fails", async () => {
    getDb().run(`CREATE TRIGGER reject_primary BEFORE INSERT ON connection_profiles
      WHEN NEW.name = 'Primary' BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
    await expect(importSTConnections("owner-a", root, {}, logger, makeFs())).rejects.toThrow("Connection migration failed");
    expect(getDb().query("SELECT count(*) AS count FROM connection_profiles WHERE user_id = ?").get("owner-a")).toEqual({ count: 0 });
    expect(getDb().query("SELECT count(*) AS count FROM secrets WHERE user_id = ?").get("owner-a")).toEqual({ count: 0 });
  });

  test("restores repaired fields when a later connection fails", async () => {
    getDb().query(`INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, created_at, updated_at)
      VALUES ('existing', 'owner-a', 'Old', 'custom', 'https://old.example', 'old-model', NULL, 0, 0, ?, 1, 1)`).run(JSON.stringify({ source: "sillytavern", source_kind: "connection_profile", st_profile_id: "profile-1" }));
    getDb().run(`CREATE TRIGGER reject_proxy BEFORE INSERT ON connection_profiles
      WHEN NEW.name = 'Proxy: Reverse' BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
    await expect(importSTConnections("owner-a", root, { repairExisting: true }, logger, makeFs())).rejects.toThrow("Connection migration failed");
    expect(getDb().query("SELECT name, provider, api_url, model FROM connection_profiles WHERE id = 'existing'").get()).toEqual({ name: "Old", provider: "custom", api_url: "https://old.example", model: "old-model" });
  });
});
