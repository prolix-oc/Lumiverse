import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { initDatabase, closeDatabase, getDb } from "../db/connection";
import { regexScriptsRoutes } from "./regex-scripts.routes";

const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", "user"); await next(); });
app.route("/", regexScriptsRoutes);
beforeAll(() => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE presets (id TEXT PRIMARY KEY, user_id TEXT, prompt_order TEXT, metadata TEXT DEFAULT '{}', parameters TEXT DEFAULT '{}', prompts TEXT DEFAULT '{}')`);
  getDb().run("INSERT INTO presets (id, user_id, prompt_order) VALUES ('preset', 'user', '[{\"id\":\"rules\"}]')");
  getDb().run(`CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT, character_id TEXT, metadata TEXT)`);
  getDb().run(`CREATE TABLE characters (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, tags TEXT DEFAULT '[]', alternate_greetings TEXT DEFAULT '[]', extensions TEXT DEFAULT '{}')`);
  getDb().run(`CREATE TABLE personas (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, is_default INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}')`);
  getDb().run(`CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, user_id TEXT, is_default INTEGER DEFAULT 0)`);
  getDb().run(`CREATE TABLE settings (key TEXT, user_id TEXT, value TEXT, updated_at INTEGER DEFAULT 0, PRIMARY KEY (key, user_id))`);
  getDb().run(`INSERT INTO characters (id, user_id, name, extensions) VALUES ('char', 'user', 'Original', '{"alternate_character_name":"A.*"}')`);
  getDb().run(`INSERT INTO personas (id, user_id, name, is_default) VALUES ('persona', 'user', 'U+$', 1), ('private', 'other', 'Private', 0)`);
  getDb().run(`INSERT INTO chats VALUES ('chat', 'user', 'char', '{"chat_variables":{"mode":"combat"}}'), ('private', 'other', NULL, '{"chat_variables":{"mode":"secret"}}')`);
  getDb().query("INSERT INTO presets (id, user_id, prompt_order) VALUES (?, ?, ?)").run("templated", "user", JSON.stringify([
    { id: "rules", enabled: false, variables: [{ id: "mode-id", name: "mode", type: "text", defaultValue: "combat" }] },
  ]));
});
beforeEach(() => { getDb().run("DELETE FROM settings"); });
afterAll(closeDatabase);

function prepare(patterns: unknown, context: Record<string, unknown> = {}) {
  return app.request('http://localhost/activation-patterns', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset_id: 'templated', chat_id: 'chat', patterns, ...context }),
  });
}

describe('activation pattern preparation', () => {
  test('prepares saved literal inputs and profile values without matching or writing state', async () => {
    getDb().query("INSERT INTO settings (key, user_id, value) VALUES (?, 'user', ?)").run(
      'presetProfile:chat:chat', JSON.stringify({ preset_id: 'templated', prompt_variables: { rules: { mode: 'peace.*' } } }),
    );
    const before = getDb().query('SELECT * FROM settings').all();
    const response = await prepare(['^{{char}}/{{user}}:{{getchatvar::mode}}$', '^{{presetvar::rules::mode-id}}$', '(a+)+$']);
    expect(response.status).toBe(200);
    const rows = (await response.json()).patterns;
    expect(new RegExp(rows[0].resolved).test('A.*/U+$:combat')).toBe(true);
    expect(new RegExp(rows[0].resolved).test('Anything/User:combat')).toBe(false);
    expect(new RegExp(rows[1].resolved).test('peace.*')).toBe(true);
    expect(rows[2].resolved).toBe('(a+)+$');
    expect(getDb().query('SELECT * FROM settings').all()).toEqual(before);
  });

  test('returns explicit per-pattern errors while retaining valid prepared patterns', async () => {
    const response = await prepare(['{{char}}', '{{getchatvar::missing}}', '[{{user}}]', '{{setvar::x::bad}}']);
    const rows = (await response.json()).patterns;
    expect(rows[0].resolved).toBeString();
    expect(rows.slice(1).every((row: any) => typeof row.error === 'string' && row.resolved === undefined)).toBe(true);
  });

  test('rejects foreign entities and bounded request violations', async () => {
    for (const context of [{chat_id:'private'}, {persona_id:'private'}, {preset_id:'missing'}, {character_id:'missing'}, {chat_id:123}]) {
      expect((await prepare(['{{char}}'], context)).status).toBe(400);
    }
    for (const patterns of [[], [1], ['x'.repeat(10001)], Array(101).fill('x'), Array(11).fill('x'.repeat(10000))]) {
      expect((await prepare(patterns)).status).toBe(400);
    }
  });
});

function preview(overrides: Record<string, unknown> = {}) {
  return app.request("http://localhost/test-activation", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset_id: "preset", find_regex: "\\b(?<mode>combat)\\b", flags: "gi", content: "Enter COMBAT.",
      prompt_activation: { source: "user_input", lifetime: "latest", mappings: [{ capture: "mode", value: "combat", block_ids: ["rules"], enabled: true }] }, ...overrides }),
  });
}

describe("prompt activation preview", () => {
  test("previews value alternatives and rejects invalid lists", async () => {
    const mapping = { capture: "mode", value: ["combat", "fight", "FIGHT"], block_ids: ["rules"], enabled: false };
    const input = { find_regex: "\\b(?<mode>combat|fight)\\b", content: "FIGHT",
      prompt_activation: { source: "user_input", lifetime: "latest", mappings: [mapping] } };
    const response = await preview(input);
    expect(response.status).toBe(200);
    expect((await response.json()).matches).toEqual([{ mapping_index: 0, value: "FIGHT", index: 0 }]);
    for (const value of [[], ["combat", null], Array(65).fill("combat")]) {
      expect((await preview({ ...input, prompt_activation: { ...input.prompt_activation, mappings: [{ ...mapping, value }] } })).status).toBe(400);
    }
  });

  test("previews capture mappings without changing the preset", async () => {
    const response = await preview();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matches: [{ mapping_index: 0, value: "COMBAT", index: 6 }] });
    expect(getDb().query("SELECT prompt_order FROM presets").get()).toEqual({ prompt_order: '[{"id":"rules"}]' });
  });
  test("rejects unlinked previews, unknown presets, and oversized input", async () => {
    expect((await preview({ preset_id: null })).status).toBe(400);
    expect((await preview({ preset_id: "missing" })).status).toBe(400);
    expect((await preview({ content: "x".repeat(500001) })).status).toBe(413);
  });
  test("reports invalid patterns without crashing", async () => {
    const response = await preview({ find_regex: "[" });
    expect(response.status).toBe(200);
    expect((await response.json()).error).toBeString();
  });

  test("uses owned saved names and chat keys, escaping pattern metacharacters", async () => {
    const response = await preview({ chat_id: "chat", find_regex: "{{char}}/{{user}}:(?<mode>{{getchatvar::mode}})", content: "A.*/U+$:combat", flags: "u" });
    const result = await response.json();
    expect(result.error).toBeUndefined();
    expect(result.matches).toEqual([{ mapping_index: 0, value: "combat", index: 0 }]);
    expect(result.resolved_find_regex).toBeString();
    const miss = await preview({ chat_id: "chat", find_regex: "{{char}}:(?<mode>{{getchatvar::mode}})", content: "Anything:combat" });
    expect((await miss.json()).matches).toEqual([]);
  });

  test("fails closed without chat input and for foreign or malformed context IDs", async () => {
    for (const context of [{}, { chat_id: "private" }, { persona_id: "private" }, { character_id: "missing" }, { chat_id: 123 }]) {
      const result = await (await preview({ ...context, find_regex: "(?<mode>{{getchatvar::mode}})|combat" })).json();
      expect(result.matches).toEqual([]);
      expect(result.error).toBeString();
    }
    expect((await preview({ find_regex: "{{setchatvar::mode::combat}}" })).status).toBe(400);
    expect((await preview({ find_regex: "{{presetvar::foreign::mode-id}}" })).status).toBe(400);
  });

  test("reads closed-block defaults and matching profile overrides without writing state", async () => {
    const input = { preset_id: "templated", find_regex: "(?<mode>{{presetvar::rules::mode-id}})", content: "combat" };
    expect((await (await preview(input)).json()).matches).toHaveLength(1);
    const binding = { preset_id: "templated", block_states: {}, prompt_variables: { rules: { mode: "peace" } } };
    getDb().query("INSERT INTO settings (key, user_id, value) VALUES (?, 'user', ?)").run("presetProfile:chat:chat", JSON.stringify(binding));
    const before = getDb().query("SELECT * FROM settings").all();
    expect((await (await preview({ ...input, chat_id: "chat" })).json()).matches).toEqual([]);
    const peace = await (await preview({ ...input, chat_id: "chat", content: "peace", prompt_activation: {
      source: "user_input", lifetime: "latest", mappings: [{ capture: "mode", value: "peace", block_ids: ["rules"], enabled: true }],
    } })).json();
    expect(peace.matches).toHaveLength(1);
    expect(getDb().query("SELECT * FROM settings").all()).toEqual(before);
    expect(JSON.parse((getDb().query("SELECT prompt_order FROM presets WHERE id = 'templated'").get() as any).prompt_order)[0].enabled).toBe(false);
  });

  test("does not clean up stale profile settings during preview", async () => {
    getDb().query("INSERT INTO settings (key, user_id, value) VALUES (?, 'user', ?)").run("presetProfile:chat:chat", JSON.stringify({ preset_id: "deleted" }));
    const result = await (await preview({ preset_id: "templated", chat_id: "chat", find_regex: "(?<mode>{{presetvar::rules::mode-id}})", content: "combat" })).json();
    expect(result.matches).toHaveLength(1);
    expect(getDb().query("SELECT * FROM settings").all()).toHaveLength(1);
  });
});
