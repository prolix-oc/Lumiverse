import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { startDatabaseExecution, stopDatabaseExecution } from "../db/execution";
import { env } from "../env";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { PresetRevisionConflictError, type PromptBlock } from "../types/preset";
import { WORLD_BOOK_VECTOR_SETTINGS_KEY } from "./world-book-vector-constants";
import * as settings from "./settings.service";
import * as personas from "./personas.service";
import * as addons from "./global-addons.service";
import * as presets from "./presets.service";
import * as stash from "./prompt-stash.service";
import * as regex from "./regex-scripts.service";
import * as chats from "./chats.service";
import * as images from "./images.service";
import * as audio from "./audio.service";

let directory: string;
const originalDataDir = env.dataDir;

async function expectDatabaseRejection(pending: Promise<unknown>, message: string): Promise<void> {
  // Bun 1.4.2's .rejects matcher waits in a nested native event loop, which can
  // stall Windows IPC. Let the operation settle through a normal await first.
  const error = await pending.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ message: expect.stringContaining(message), code: "SQLITE_CONSTRAINT_TRIGGER", outcome: "rolled-back" });
}

beforeEach(async () => {
  await stopDatabaseExecution();
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "lumiverse-async-callers-"));
  env.dataDir = directory;
  const db = initDatabase(join(directory, "database.db"));
  const baseline = await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text();
  db.transaction(() => {
    db.exec(baseline);
    for (const user of ["user", "other"]) db.query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').run(user, user, `${user}@example.com`);
  })();
});
afterEach(async () => {
  await stopDatabaseExecution();
  closeDatabase();
  env.dataDir = originalDataDir;
  rmSync(directory, { recursive: true, force: true });
});

describe("async database callers with a real subprocess", () => {
  test("converted CRUD and reads never execute SQL on the backend connection", async () => {
    getDb().query("INSERT INTO chats (id, user_id) VALUES ('chat', 'user')").run();
    await startDatabaseExecution();
    const query = spyOn(getDb(), "query").mockImplementation(() => { throw new Error("SQL ran on the backend thread"); });
    try {
      await settings.putManyAsync("user", { activeChatId: "chat", example: 42 });
      expect((await settings.getSettingAsync("user", "example"))?.value).toBe(42);
      const persona = await personas.createPersonaAsync("user", { name: "Persona", is_default: true });
      await personas.updatePersonaAsync("user", persona.id, { title: "Updated" });
      expect((await personas.listPersonasAsync("user", { limit: 1, offset: 0 })).total).toBe(1);
      const addon = await addons.createGlobalAddonAsync("user", { label: "Addon" });
      await addons.updateGlobalAddonAsync("user", addon.id, { content: "Text" });
      await addons.reorderGlobalAddonsAsync("user", [addon.id]);
      await addons.deleteGlobalAddonAsync("user", addon.id);
      const preset = await presets.createPresetAsync("user", { name: "Preset", provider: "loom" });
      await presets.updatePresetAsync("user", preset.id, { name: "Updated", expected_cache_revision: 0 });
      expect((await presets.listPresetRegistryAsync("user", { limit: 1, offset: 0 })).total).toBe(1);
      const script = await regex.createRegexScriptAsync("user", { name: "Script", find_regex: "x", preset_id: preset.id }, { activePresetId: preset.id });
      if (typeof script === "string") throw new Error(script);
      await regex.updateRegexScriptAsync("user", script.id, { name: "Updated script" }, { activePresetId: preset.id });
      await regex.toggleRegexScriptsByIdsAsync("user", [script.id], true, { activePresetId: preset.id });
      expect((await regex.getRegexScriptAsync("user", script.id))?.disabled).toBe(true);
      expect((await regex.listRegexScriptsAsync("user", { limit: 1, offset: 0 })).data).toHaveLength(1);
      const duplicate = await regex.duplicateRegexScriptAsync("user", script.id);
      expect(duplicate?.preset_id).toBeNull();
      await regex.deleteRegexScriptAsync("user", duplicate!.id);
      expect(await presets.deletePresetAsync("user", preset.id)).toBe(true);
      await chats.mergeChatMetadataAsync("user", "chat", { example: 42 });
      expect((await chats.getChatAsync("user", "chat"))?.metadata.example).toBe(42);
      const saved = await audio.saveAudio("user", { data: new Uint8Array([1]), mime_type: "audio/wav" });
      expect(await audio.deleteAudioAsync("user", saved.id)).toBe(true);
      expect(await images.findReferencedImageIdsAsync("user", new Set([crypto.randomUUID()]))).toEqual(new Set());
      expect(query).not.toHaveBeenCalled();
    } finally { query.mockRestore(); }
  });

  test("concurrent defaults, narrator toggles, and add-on avatars preserve current state", async () => {
    const [first, second] = await Promise.all(["first", "second"].map((name) => personas.createPersonaAsync("user", { name, is_default: true, metadata: { addons: [{ id: "one" }, { id: "two" }] } })));
    expect(getDb().query("SELECT id FROM personas WHERE is_default = 1 AND user_id = 'user'").all()).toHaveLength(1);
    await Promise.all([1, 2].map(() => personas.bulkUpdatePersonasAsync("user", [first.id], { toggle_narrator: true })));
    expect((await personas.getPersonaAsync("user", first.id))?.is_narrator).toBe(false);
    await Promise.all(["one", "two"].map((id) => personas.setPersonaAddonAvatarAsync("user", first.id, id, { image_id: `image-${id}` })));
    expect((await personas.getPersonaAsync("user", first.id))?.metadata.addons.map((addon: any) => addon.avatar_image_id)).toEqual(["image-one", "image-two"]);
    expect(await personas.updatePersonaAsync("other", second.id, { is_default: true })).toBeNull();
    expect(getDb().query("SELECT id FROM personas WHERE is_default = 1 AND user_id = 'user'").all()).toHaveLength(1);
  });

  test("add-on deletion rolls back both the row and persona references before emitting events", async () => {
    const addon = await addons.createGlobalAddonAsync("user", { label: "Shared" });
    const persona = await personas.createPersonaAsync("user", { name: "Persona", metadata: { attached_global_addons: [{ id: addon.id, enabled: true }] } });
    getDb().exec("CREATE TRIGGER reject_persona_update BEFORE UPDATE ON personas BEGIN SELECT RAISE(ABORT, 'blocked persona update'); END");
    const emit = spyOn(eventBus, "emit");
    try {
      await expectDatabaseRejection(addons.deleteGlobalAddonAsync("user", addon.id), "blocked persona update");
      expect(await addons.getGlobalAddonAsync("user", addon.id)).not.toBeNull();
      expect((await personas.getPersonaAsync("user", persona.id))?.metadata.attached_global_addons).toHaveLength(1);
      expect(emit.mock.calls.filter(([type]) => type === EventType.GLOBAL_ADDON_DELETED)).toHaveLength(0);
      getDb().exec("DROP TRIGGER reject_persona_update");
      expect(await addons.deleteGlobalAddonAsync("other", addon.id)).toBe(false);
      expect(await addons.deleteGlobalAddonAsync("user", addon.id)).toBe(true);
      expect((await personas.getPersonaAsync("user", persona.id))?.metadata.attached_global_addons).toEqual([]);
    } finally { emit.mockRestore(); }
  });

  test("settings and vector invalidation commit together and retain validation errors", async () => {
    const db = getDb();
    for (const user of ["user", "other"]) {
      db.query("INSERT INTO world_books (id, user_id, name) VALUES (?, ?, 'Book')").run(`book-${user}`, user);
      db.query("INSERT INTO world_book_entries (id, world_book_id, uid, vectorized, content, vector_index_status) VALUES (?, ?, 1, 1, 'Text', 'indexed')").run(`entry-${user}`, `book-${user}`);
    }
    db.exec("CREATE TRIGGER reject_vector_invalidation BEFORE UPDATE ON world_book_entries BEGIN SELECT RAISE(ABORT, 'blocked invalidation'); END");
    await expectDatabaseRejection(settings.putManyAsync("user", { example: 42, [WORLD_BOOK_VECTOR_SETTINGS_KEY]: { presetMode: "lean" } }), "blocked invalidation");
    expect(await settings.getSettingAsync("user", "example")).toBeNull();
    db.exec("DROP TRIGGER reject_vector_invalidation");
    await settings.putSettingAsync("user", WORLD_BOOK_VECTOR_SETTINGS_KEY, { presetMode: "lean" });
    expect(db.query("SELECT vector_index_status FROM world_book_entries WHERE id = 'entry-user'").get()).toEqual({ vector_index_status: "pending" });
    expect(db.query("SELECT vector_index_status FROM world_book_entries WHERE id = 'entry-other'").get()).toEqual({ vector_index_status: "indexed" });
    const invalid = await settings.putManyAsync("user", { valid: true, "bad key": true }).catch((error) => error);
    expect(invalid).toBeInstanceOf(settings.InvalidSettingError);
    expect(await settings.getSettingAsync("user", "valid")).toBeNull();
  });

  test("concurrent preset revision checks admit one writer and preserve conflict details", async () => {
    const preset = await presets.createPresetAsync("user", { name: "Preset", provider: "loom" });
    const results = await Promise.allSettled(["first", "second"].map((name) => presets.updatePresetAsync("user", preset.id, { name, expected_cache_revision: 0 })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(PresetRevisionConflictError);
    expect(failed.reason.expectedCacheRevision).toBe(0);
    expect(failed.reason.actualCacheRevision).toBe(1);
  });

  test("stash propagation rolls back the entire preset save on a linked update failure", async () => {
    const block = { id: "block", name: "Block", content: "Original", enabled: true, marker: null, group: null } as PromptBlock;
    const stashed = await stash.addPromptBlockToStashAsync("user", block);
    const linked = { ...block, stashId: stashed.id };
    const first = await presets.createPresetAsync("user", { name: "First", provider: "loom", prompt_order: [linked] });
    const second = await presets.createPresetAsync("user", { name: "Second", provider: "loom", prompt_order: [{ ...linked, enabled: false, group: "local" }] });
    getDb().exec(`CREATE TRIGGER reject_linked_update BEFORE UPDATE ON presets WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'blocked linked update'); END`);
    await expectDatabaseRejection(presets.updatePresetAsync("user", first.id, { prompt_order: [{ ...linked, content: "Edited" }], expected_cache_revision: 0 }), "blocked linked update");
    expect((await presets.getPresetAsync("user", first.id))?.cache_revision).toBe(0);
    expect((await stash.listPromptStashAsync("user"))[0].block.content).toBe("Original");
    getDb().exec("DROP TRIGGER reject_linked_update");
    await presets.updatePresetAsync("user", first.id, { prompt_order: [{ ...linked, content: "Edited" }], expected_cache_revision: 0 });
    expect((await presets.getPresetAsync("user", second.id))?.prompt_order[0]).toMatchObject({ content: "Edited", enabled: false, group: "local" });
    expect(await stash.removePromptBlockFromStashAsync("user", stashed.id)).toBe(true);
    expect((await presets.getPresetAsync("user", second.id))?.prompt_order[0].stashId).toBeUndefined();
  });

  test("preset deletion repairs selections, regex and connection references only for its owner", async () => {
    const first = await presets.createPresetAsync("user", { name: "First", provider: "loom" });
    const second = await presets.createPresetAsync("user", { name: "Second", provider: "loom" });
    await settings.putManyAsync("user", { activeLoomPresetId: first.id, "presetProfile:character:character": { preset_id: first.id }, [`presetRegexEnabled:${first.id}`]: ["script"] });
    const db = getDb();
    db.query("INSERT INTO regex_scripts (id, user_id, preset_id, name, find_regex) VALUES ('script', 'user', ?, 'Script', 'x')").run(first.id);
    db.query("INSERT INTO connection_profiles (id, user_id, name, provider, preset_id) VALUES ('connection', 'user', 'Connection', 'openai', ?)").run(first.id);
    expect(await presets.deletePresetAsync("other", first.id)).toBe(false);
    expect(await presets.deletePresetAsync("user", first.id)).toBe(true);
    expect((await settings.getSettingAsync("user", "activeLoomPresetId"))?.value).toBe(second.id);
    expect(await settings.getSettingAsync("user", "presetProfile:character:character")).toBeNull();
    expect(await settings.getSettingAsync("user", `presetRegexEnabled:${first.id}`)).toBeNull();
    expect(db.query("SELECT id FROM regex_scripts WHERE id = 'script'").get()).toBeNull();
    expect(db.query("SELECT preset_id FROM connection_profiles WHERE id = 'connection'").get()).toEqual({ preset_id: null });
  });

  test("regex deletion enforces extension ownership and updates restore lists atomically", async () => {
    const preset = await presets.createPresetAsync("user", { name: "Preset", provider: "loom" });
    const db = getDb();
    for (const [id, owner] of [["host", null], ["extension", "plugin"], ["foreign", null]]) db.query("INSERT INTO regex_scripts (id, user_id, preset_id, name, find_regex, owner_extension_identifier) VALUES (?, ?, ?, 'Script', 'x', ?)").run(id, id === "foreign" ? "other" : "user", preset.id, owner);
    await settings.putSettingAsync("user", `presetRegexEnabled:${preset.id}`, ["host", "extension"]);
    expect(await regex.deleteRegexScriptAsync("user", "host", { extensionIdentifier: "plugin" })).toBe("Regex script is not an unbound script owned by this extension");
    expect(await regex.deleteRegexScriptAsync("user", "extension", { extensionIdentifier: "plugin" })).toBe(true);
    expect((await settings.getSettingAsync("user", `presetRegexEnabled:${preset.id}`))?.value).toEqual(["host", "extension"]);
    expect(await regex.deleteRegexScriptsAsync("user", ["host", "foreign", "host"])).toEqual(["host"]);
    expect((await settings.getSettingAsync("user", `presetRegexEnabled:${preset.id}`))?.value).toEqual(["extension"]);
  });

  test("concurrent metadata merges preserve keys and explicit undefined deletions", async () => {
    getDb().query("INSERT INTO chats (id, user_id, metadata) VALUES ('chat', 'user', '{\"remove\":true}')").run();
    await Promise.all(["one", "two"].map((key) => chats.mergeChatMetadataAsync("user", "chat", { [key]: true })));
    await chats.mergeChatMetadataAsync("user", "chat", { remove: undefined });
    expect((await chats.getChatAsync("user", "chat"))?.metadata).toEqual({ one: true, two: true });
    expect(await chats.mergeChatMetadataAsync("other", "chat", { one: false })).toBeNull();
    await Promise.all(["first", "second"].map((key) => chats.mergeChatMetadataAsync("user", "chat", { chat_variables: { [key]: true } }, { mergeObjectPaths: [["chat_variables"]] })));
    expect((await chats.getChatAsync("user", "chat"))?.metadata.chat_variables).toEqual({ first: true, second: true });
    await chats.mergeChatMetadataAsync("user", "chat", { macro_variables: { custom: "kept", global: { existing: "kept" } } });
    await Promise.all(["first", "second"].map((key) => chats.mergeChatMetadataAsync("user", "chat", { macro_variables: { global: { [key]: true } } }, { mergeObjectPaths: [["macro_variables", "global"]] })));
    expect((await chats.getChatAsync("user", "chat"))?.metadata.macro_variables).toEqual({ custom: "kept", global: { existing: "kept", first: true, second: true } });
  });

  test("a contended persona write keeps backend timers running until the lock is released", async () => {
    const persona = await personas.createPersonaAsync("user", { name: "Persona" });
    const writer = new Database(join(directory, "database.db"));
    // The subprocess may be committing a bounded background index batch.
    writer.exec("PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE");
    let beats = 0;
    const heartbeat = setInterval(() => beats++, 10);
    const release = setTimeout(() => writer.exec("ROLLBACK"), 300);
    try {
      expect((await personas.updatePersonaAsync("user", persona.id, { name: "Updated" }))?.name).toBe("Updated");
      expect(beats).toBeGreaterThan(10);
    } finally {
      clearTimeout(release);
      clearInterval(heartbeat);
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
    }
  });
});
