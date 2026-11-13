import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { regexScriptsRoutes } from "../routes/regex-scripts.routes";
import { WorkerHost } from "./worker-host";

beforeAll(() => {
  initDatabase(":memory:");
  getDb().run("CREATE TABLE presets (id TEXT PRIMARY KEY, user_id TEXT, prompt_order TEXT, metadata TEXT DEFAULT '{}', parameters TEXT DEFAULT '{}', prompts TEXT DEFAULT '{}')");
  getDb().run("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT, character_id TEXT, metadata TEXT)");
  getDb().run("CREATE TABLE characters (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, tags TEXT DEFAULT '[]', alternate_greetings TEXT DEFAULT '[]', extensions TEXT DEFAULT '{}')");
  getDb().run("CREATE TABLE personas (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, is_default INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}')");
  getDb().run("CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, user_id TEXT, is_default INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}')");
  getDb().run("CREATE TABLE settings (key TEXT, user_id TEXT, value TEXT, updated_at INTEGER DEFAULT 0, PRIMARY KEY (key, user_id))");
  for (const user of ["alice", "bob"]) {
    getDb().run("INSERT INTO presets (id, user_id, prompt_order) VALUES (?, ?, ?)", [`preset-${user}`, user, JSON.stringify([{ id: "rules", variables: [{ id: "mode", name: "mode", type: "text", defaultValue: "default" }] }])]);
    getDb().run("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)", [`char-${user}`, user, `${user}.*`]);
    getDb().run("INSERT INTO personas (id, user_id, name, is_default) VALUES (?, ?, ?, 1)", [`persona-${user}`, user, `${user}+$`]);
    getDb().run("INSERT INTO chats VALUES (?, ?, ?, ?)", [`chat-${user}`, user, `char-${user}`, JSON.stringify({ chat_variables: { mode: "combat.*" } })]);
    getDb().run("INSERT INTO connection_profiles (id, user_id, is_default) VALUES (?, ?, 1)", [`connection-${user}`, user]);
  }
  getDb().run("INSERT INTO settings (key, user_id, value) VALUES (?, ?, ?)", ["presetProfile:chat:chat-alice", "alice", JSON.stringify({ preset_id: "preset-alice", prompt_variables: { rules: { mode: "peace.*" } } })]);
});
afterAll(closeDatabase);

function invoke(options: any, scope: "user" | "operator" = "user", permitted = true): Promise<any> {
  const host = new WorkerHost("activation-test", {
    identifier: "activation-test", name: "Activation test",
  } as SpindleManifest, {
    id: "activation-test", identifier: "activation-test", name: "Activation test",
    version: "0.0.0", author: "", description: "", github: "", homepage: "",
    permissions: [], granted_permissions: [], enabled: true, installed_at: 0, updated_at: 0,
    has_frontend: false, has_backend: false, status: "stopped",
    metadata: { install_scope: scope, installed_by_user_id: "alice" },
  } satisfies ExtensionInfo);
  const internal = host as unknown as {
    hasPermission(permission: string): boolean;
    handleMessage(message: unknown): void;
    runtime: { mode: string; pid: null; postMessage(message: unknown): void; terminate(): void };
  };
  internal.hasPermission = permission => permitted && permission === "regex_scripts";
  return new Promise(resolve => {
    internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
    internal.handleMessage({ type: "regex_scripts_prepare_activation_patterns", requestId: "request", options });
  });
}

const options = { presetId: "preset-alice", chatId: "chat-alice", personaId: "persona-alice", patterns: ["^{{char}}/{{user}}:{{getchatvar::mode}}$", "^{{presetvar::rules::mode}}$", "{{setvar::x::bad}}", "[{{user}}]"] };

test("Spindle activation preparation matches HTTP escaping, profiles, and per-pattern errors", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "alice"); await next(); });
  app.route("/", regexScriptsRoutes);
  const before = getDb().query("SELECT * FROM settings").all();
  const http = await app.request("http://localhost/activation-patterns", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ preset_id: options.presetId, chat_id: options.chatId, persona_id: options.personaId, patterns: options.patterns }),
  });
  const response = await invoke(options);
  expect(response.error).toBeUndefined();
  expect(response.result).toEqual(await http.json());
  expect(new RegExp(response.result.patterns[0].resolved).test("alice.*/alice+$:combat.*")).toBe(true);
  expect(new RegExp(response.result.patterns[0].resolved).test("aliceANY/alice:combatANY")).toBe(false);
  expect(new RegExp(response.result.patterns[1].resolved).test("peace.*")).toBe(true);
  expect(response.result.patterns[2].error).toBeString();
  expect(response.result.patterns[3].error).toBeString();
  expect(getDb().query("SELECT * FROM settings").all()).toEqual(before);
});

test("Spindle activation preparation checks permissions and scopes every referenced entity", async () => {
  expect((await invoke(options, "user", false)).error).toContain("regex_scripts");
  expect((await invoke(options, "operator")).error).toContain("userId is required");
  expect((await invoke({ ...options, userId: "alice" }, "operator")).result).toBeDefined();
  for (const [key, value] of Object.entries({ presetId: "preset-bob", chatId: "chat-bob", characterId: "char-bob", personaId: "persona-bob", connectionId: "connection-bob" })) {
    expect((await invoke({ ...options, [key]: value, userId: "bob" })).error).toContain("not found");
  }
});

test("Spindle activation preparation rejects malformed and unbounded requests", async () => {
  for (const input of [null, {}, { ...options, chatId: 3 }, ...[[], [1], ["x".repeat(10001)], Array(101).fill("x"), Array(11).fill("x".repeat(10000))].map(patterns => ({ ...options, patterns }))]) {
    expect((await invoke(input)).error).toBeString();
  }
});
