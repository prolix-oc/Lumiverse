import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildGenerationAssemblySnapshot,
  SnapshotLimitError,
  type GenerationAssemblySnapshotV1,
} from "./prompt-assembly-snapshot.service";
import { compareUtf8 } from "../utils/utf8-order";
import {
  AssemblyPlanValidationError,
  compileAgentAssemblyPlan,
  materializeAssemblyPlan,
  parseCompileAgentAssemblyRequest,
  validateAssemblyPlanAgainstSnapshotV1,
  validateAssemblyPlanV1,
  validateAssemblySnapshotDataV1,
  SNAPSHOT_DATA_MAX_DEPTH_V1,
  SNAPSHOT_DATA_MAX_NODES_V1,
  type AssemblyMessageSegmentV1,
  type AssemblyPlanV1,
} from "./agentic-assembly-compiler";
import { parseAgenticPreprocessingResponseV1 } from "./agentic-preprocessing-worker-client";
import type { ActiveIsolateJob } from "./isolate-pool";
import { freezeCognitionGraph, inspectLoomPromptPolicies } from "./agent-cognition.service";
import { encodeCanonicalPlainData } from "../utils/canonical-plain-data";
import { AGENT_CHILD_TASK_MAX_BYTES } from "./agent-runtime-accounting";

function schema(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, character_id TEXT, name TEXT NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, generation_revision INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, index_in_chat INTEGER NOT NULL, is_user INTEGER NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, send_date INTEGER NOT NULL, swipe_id INTEGER NOT NULL, swipes TEXT NOT NULL, swipe_dates TEXT NOT NULL, extra TEXT NOT NULL, parent_message_id TEXT, branch_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, generation_revision INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE presets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, engine TEXT NOT NULL, parameters TEXT NOT NULL, prompt_order TEXT NOT NULL, metadata TEXT NOT NULL, prompts TEXT NOT NULL, updated_at INTEGER NOT NULL, cache_revision INTEGER NOT NULL)");
  db.run("CREATE TABLE characters (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, personality TEXT NOT NULL, scenario TEXT NOT NULL, first_mes TEXT NOT NULL, mes_example TEXT NOT NULL, system_prompt TEXT NOT NULL, post_history_instructions TEXT NOT NULL, extensions TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE personas (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, subjective_pronoun TEXT NOT NULL, objective_pronoun TEXT NOT NULL, possessive_pronoun TEXT NOT NULL, reflexive_pronoun TEXT NOT NULL, possessive_pronoun_standalone TEXT NOT NULL, attached_world_book_id TEXT, is_narrator INTEGER NOT NULL, is_default INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE settings (key TEXT NOT NULL, value TEXT NOT NULL, user_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, user_id))");
  db.run("CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, api_url TEXT NOT NULL, model TEXT NOT NULL, preset_id TEXT, is_default INTEGER NOT NULL, has_api_key INTEGER NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE regex_scripts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, find_regex TEXT NOT NULL, replace_string TEXT NOT NULL, actions TEXT NOT NULL, flags TEXT NOT NULL, placement TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT, target TEXT NOT NULL, trim_strings TEXT NOT NULL, disabled INTEGER NOT NULL, sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE world_books (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE world_book_entries (id TEXT PRIMARY KEY, world_book_id TEXT NOT NULL, key TEXT NOT NULL, keysecondary TEXT NOT NULL, content TEXT NOT NULL, comment TEXT NOT NULL, position INTEGER NOT NULL, depth INTEGER NOT NULL, role TEXT, order_value INTEGER NOT NULL, disabled INTEGER NOT NULL, constant INTEGER NOT NULL, sticky INTEGER NOT NULL, cooldown INTEGER NOT NULL, delay INTEGER NOT NULL, vector_index_status TEXT NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)");
  return db;
}

function config(): Record<string, unknown> {
  return {
    version: 2,
    agentsEnabled: true,
    allowedModes: ["response", "agentic"],
    defaultMode: "agentic",
    maxInvocations: 4,
    maxToolCalls: 4,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles: [{
      id: "writer",
      name: "Writer",
      systemPrompt: "",
      connectionRef: { kind: "inherit_main" },
      toolIds: [],
      loreScope: "active",
      allowMainDelegation: false,
      failurePolicy: "required",
      streamActivity: false,
      maxOutputTokens: 64,
      timeoutMs: 5000,
    }],
    connectionSlots: [],
  };
}
function nestedData(depth: number): Record<string, unknown> {
  // The helper's scalar leaf is one value below its container chain. When
  // placed under a field, the test root and field value add two more levels.
  // Keep those offsets explicit so maxDepth/cap-plus-one exercise the
  // canonical value-frame convention rather than an accidental fixture depth.
  let value: Record<string, unknown> = { leaf: "ok" };
  for (let index = 0; index < depth; index += 1) value = { next: value };
  return value;
}

function seed(db: Database): void {
  const blocks = [
    { id: "producer", name: "Producer", content: "{{agent::writer::as=facts}}Find facts{{/agent}}", role: "user", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
    { id: "consumer", name: "Consumer", content: "Facts: {{agentResult::facts}}", role: "user", enabled: true, position: "post_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
  ];
  db.query("INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("chat-1", "user-1", "char-1", "Chat", JSON.stringify({ chat_world_book_ids: ["book-2"], active_world_info_entry_ids: ["entry-2"], chat_variables: { mood: "calm" } }), 1, 1, 1);
  db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("message-1", "chat-1", 0, 1, "User", "hello", 1, 0, JSON.stringify(["hello"]), JSON.stringify([1]), "{}", null, null, 1, 1, 1);
  db.query("INSERT INTO characters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("char-1", "user-1", "Aria", "desc", "personality", "scenario", "hello", "example", "", "", JSON.stringify({ world_book_ids: ["book-1"] }), 2);
  db.query("INSERT INTO personas VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("persona-1", "user-1", "Me", "", "", "I", "me", "my", "myself", "mine", null, 0, 1, 1);
  db.query("INSERT INTO presets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("preset-1", "user-1", "Preset", "loom", "classic", "{}", JSON.stringify(blocks), "{}", "{}", 3, 7);
  db.query("INSERT INTO connection_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("connection-1", "user-1", "Main", "openai", "http://provider", "model", "preset-1", 1, 1, "{}", 4);
  db.query("INSERT INTO settings VALUES (?, ?, ?, ?)").run("globalWorldBooks", JSON.stringify(["book-1"]), "user-1", 5);
  db.query("INSERT INTO world_books VALUES (?, ?, ?, ?, ?, ?)").run("book-1", "user-1", "Character lore", "", "{}", 2);
  db.query("INSERT INTO world_books VALUES (?, ?, ?, ?, ?, ?)").run("book-2", "user-1", "Chat lore", "", "{}", 2);
  db.query("INSERT INTO world_book_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("entry-1", "book-1", JSON.stringify(["one"]), "[]", "one", "One", 0, 4, "system", 2, 0, 0, 0, 0, 0, "not_enabled", 1, 1);
  db.query("INSERT INTO world_book_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("entry-2", "book-2", JSON.stringify(["two"]), "[]", "two", "Two", 0, 4, "system", 1, 0, 1, 0, 0, 0, "not_enabled", 1, 1);
  db.query("INSERT INTO regex_scripts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("regex-1", "user-1", "safe", "foo", "bar", "[]", "gi", JSON.stringify(["ai_output"]), "global", null, JSON.stringify(["prompt"]), "[]", 0, 0, 1, 1);
  db.query("INSERT INTO regex_scripts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("regex-invalid", "user-1", "invalid", "[", "", "[]", "gi", JSON.stringify(["ai_output"]), "global", null, JSON.stringify(["prompt"]), "[]", 0, 1, 1, 1);


}
describe("GenerationAssemblySnapshotV1", () => {
  test("captures one bounded view, complete revisions, deterministic lore, and no extension data", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", connectionId: "connection-1", agentConfig: config(), db });
    expect(snapshot.assemblySurface).toBe("WORK");
    db.query("UPDATE messages SET content = ? WHERE id = ?").run("changed after snapshot", "message-1");
    expect(snapshot.messages[0]?.content).toBe("hello");
    expect(snapshot.worldInfo.entries.map((entry) => entry.id)).toEqual(["entry-1", "entry-2"]);
    expect(snapshot.regexScripts.map((script) => script.id)).toEqual(["regex-1"]);
    expect(snapshot.extensionData).toBeNull();
    expect(snapshot.ambientSpindleData).toBeNull();
    expect(snapshot.agentCognition).toMatchObject({
      schema: "present",
      loomPolicy: {
        version: 1,
        workPolicy: [],
        workspaceUsage: [],
        completionCriteria: [],
        renderPolicy: [],
      },
      cognitionGraph: null,
      cognitionSource: null,
    });
    expect(snapshot.inputRevisionSet.entries.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "target", "chat", "message", "preset", "preset_block", "config", "slot_binding", "connection", "endpoint", "credential",
      "persona", "character", "world_lore", "settings", "macro_variables", "regex", "cognition_policy", "runtime_epoch", "readiness",
    ]));
    db.close();
  });

  test("lowers test caps and rejects oversized input before strict preparation", async () => {
    const db = schema();
    seed(db);
    expect(() => buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), db, limits: { inputBytes: 2 } })).toThrow(SnapshotLimitError);
    db.close();
  });

  test("reads profile bindings from the supplied in-memory db, not getDb()", () => {
    const db = schema();
    seed(db);
    const blocks = [
      { id: "producer", name: "Producer", content: "p", role: "user", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null, variables: [{ id: "fn_collaboration", name: "fn_collaboration", label: "Collaboration", type: "switch", defaultValue: 1 }] },
      { id: "consumer", name: "Consumer", content: "c", role: "user", enabled: true, position: "post_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null, variables: [{ id: "fn_require_child", name: "fn_require_child", label: "Required child", type: "switch", defaultValue: 0 }] },
    ];
    db.query("UPDATE presets SET prompt_order = ?, metadata = ? WHERE id = ?").run(
      JSON.stringify(blocks),
      JSON.stringify({ promptVariables: { producer: { fn_collaboration: 0 }, consumer: { fn_require_child: 0 } } }),
      "preset-1",
    );
    db.query("INSERT INTO settings VALUES (?, ?, ?, ?)").run(
      "presetProfile:chat:chat-1",
      JSON.stringify({ preset_id: "preset-1", block_states: { producer: false, consumer: true }, captured_at: 1 }),
      "user-1",
      1,
    );
    db.query("INSERT INTO settings VALUES (?, ?, ?, ?)").run(
      "presetProfileVariables:chat:chat-1",
      JSON.stringify({ consumer: { fn_require_child: 1 } }),
      "user-1",
      1,
    );
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      connectionId: "connection-1",
      agentConfig: config(),
      db,
    });
    expect(snapshot.blocks.find((block) => block.id === "producer")?.enabled).toBe(false);
    expect(snapshot.blocks.find((block) => block.id === "consumer")?.enabled).toBe(true);
    expect(snapshot.variables.profile).toEqual({ consumer: { fn_require_child: 1 } });
    expect(snapshot.variables.effective?.values).toEqual({ fn_require_child: 1 });
    expect(snapshot.variables.effective?.byBlock.consumer?.fn_require_child).toBe(1);
    expect(snapshot.variables.effective?.byBlock.producer).toBeUndefined();
    expect(snapshot.variables.effective?.defaults.fn_require_child).toBe(0);
    db.close();
  });

  test("snapshot identity changes when binding values or block states change", () => {
    const db = schema();
    seed(db);
    const blocks = [
      { id: "producer", name: "Producer", content: "p", role: "user", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null, variables: [{ id: "fn_require_child", name: "fn_require_child", label: "Required child", type: "switch", defaultValue: 0 }] },
      { id: "consumer", name: "Consumer", content: "c", role: "user", enabled: true, position: "post_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
    ];
    db.query("UPDATE presets SET prompt_order = ?, metadata = ? WHERE id = ?").run(
      JSON.stringify(blocks),
      JSON.stringify({ promptVariables: { producer: { fn_require_child: 0 } } }),
      "preset-1",
    );
    const writeBinding = (blockStates: Record<string, boolean>, promptVariables: Record<string, Record<string, number>>) => {
      db.query("INSERT OR REPLACE INTO settings VALUES (?, ?, ?, ?)").run(
        "presetProfile:chat:chat-1",
        JSON.stringify({ preset_id: "preset-1", block_states: blockStates, captured_at: 1 }),
        "user-1",
        1,
      );
      db.query("INSERT OR REPLACE INTO settings VALUES (?, ?, ?, ?)").run(
        "presetProfileVariables:chat:chat-1",
        JSON.stringify(promptVariables),
        "user-1",
        1,
      );
    };
    writeBinding({ producer: true, consumer: true }, { producer: { fn_require_child: 0 } });
    const baseline = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", connectionId: "connection-1", agentConfig: config(), db });
    writeBinding({ producer: true, consumer: true }, { producer: { fn_require_child: 1 } });
    const valuesChanged = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", connectionId: "connection-1", agentConfig: config(), db });
    writeBinding({ producer: false, consumer: true }, { producer: { fn_require_child: 1 } });
    const blocksChanged = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", connectionId: "connection-1", agentConfig: config(), db });
    expect(valuesChanged.snapshotId).not.toBe(baseline.snapshotId);
    expect(valuesChanged.variables.revision).not.toBe(baseline.variables.revision);
    expect(valuesChanged.inputRevisionSet.digest).not.toBe(baseline.inputRevisionSet.digest);
    expect(blocksChanged.snapshotId).not.toBe(valuesChanged.snapshotId);
    expect(blocksChanged.variables.revision).not.toBe(valuesChanged.variables.revision);
    expect(blocksChanged.blocks.find((block) => block.id === "producer")?.enabled).toBe(false);
    expect(blocksChanged.variables.effective?.values.fn_require_child).toBeUndefined();
    db.close();
  });

  test("forcePresetId ignores an active chat binding on initial snapshot and rebuild", () => {
    const db = schema();
    seed(db);
    const blocks = [
      { id: "producer", name: "Producer", content: "p", role: "user", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null, variables: [{ id: "fn_require_child", name: "fn_require_child", label: "Required child", type: "switch", defaultValue: 0 }] },
      { id: "consumer", name: "Consumer", content: "c", role: "user", enabled: true, position: "post_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
    ];
    db.query("UPDATE presets SET prompt_order = ?, metadata = ? WHERE id = ?").run(
      JSON.stringify(blocks),
      JSON.stringify({ promptVariables: { producer: { fn_require_child: 0 } } }),
      "preset-1",
    );
    db.query("INSERT INTO settings VALUES (?, ?, ?, ?)").run(
      "presetProfile:chat:chat-1",
      JSON.stringify({ preset_id: "preset-1", block_states: { producer: false, consumer: true }, captured_at: 1 }),
      "user-1",
      1,
    );
    db.query("INSERT INTO settings VALUES (?, ?, ?, ?)").run(
      "presetProfileVariables:chat:chat-1",
      JSON.stringify({ producer: { fn_require_child: 1 } }),
      "user-1",
      1,
    );
    const snapshotInput = {
      assemblySurface: "WORK" as const,
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      forcePresetId: true,
      connectionId: "connection-1",
      agentConfig: config(),
      db,
    };
    const bound = buildGenerationAssemblySnapshot({ ...snapshotInput, forcePresetId: false });
    expect(bound.blocks.find((block) => block.id === "producer")?.enabled).toBe(false);
    expect(bound.variables.profile).toEqual({ producer: { fn_require_child: 1 } });
    expect(bound.variables.effective?.values.fn_require_child).toBeUndefined();
    const initial = buildGenerationAssemblySnapshot(snapshotInput);
    const rebuilt = buildGenerationAssemblySnapshot({ ...snapshotInput, db });
    expect(initial.blocks.find((block) => block.id === "producer")?.enabled).toBe(true);
    expect(rebuilt.blocks.find((block) => block.id === "producer")?.enabled).toBe(true);
    expect(initial.variables.profile).toBeNull();
    expect(rebuilt.variables.profile).toBeNull();
    expect(initial.variables.effective?.values.fn_require_child).toBe(0);
    expect(rebuilt.variables.effective?.values.fn_require_child).toBe(0);
    expect(initial.variables.revision).not.toBe(bound.variables.revision);
    expect(rebuilt.snapshotId).toBe(initial.snapshotId);
    db.close();
  });

  test("temporary chats ignore persona and default bindings; non-temporary chats keep them", () => {
    const db = schema();
    seed(db);
    const blocks = [
      { id: "producer", name: "Producer", content: "p", role: "user", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null, variables: [{ id: "fn_require_child", name: "fn_require_child", label: "Required child", type: "switch", defaultValue: 0 }] },
      { id: "consumer", name: "Consumer", content: "c", role: "user", enabled: true, position: "post_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
    ];
    db.query("UPDATE presets SET prompt_order = ?, metadata = ? WHERE id = ?").run(
      JSON.stringify(blocks),
      JSON.stringify({ promptVariables: { producer: { fn_require_child: 0 } } }),
      "preset-1",
    );
    db.query("INSERT INTO settings VALUES (?, ?, ?, ?)").run(
      "presetProfile:persona:persona-1",
      JSON.stringify({ preset_id: "preset-1", block_states: { producer: false, consumer: true }, captured_at: 1 }),
      "user-1",
      1,
    );
    db.query("INSERT INTO settings VALUES (?, ?, ?, ?)").run(
      "presetProfileVariables:persona:persona-1",
      JSON.stringify({ producer: { fn_require_child: 1 } }),
      "user-1",
      1,
    );
    db.query("UPDATE chats SET metadata = ? WHERE id = ?").run(JSON.stringify({ temporary: true }), "chat-1");
    const temporary = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      connectionId: "connection-1",
      personaId: "persona-1",
      agentConfig: config(),
      db,
    });
    expect(temporary.participants.persona).toBeNull();
    expect(temporary.blocks.find((block) => block.id === "producer")?.enabled).toBe(true);
    expect(temporary.variables.profile).toBeNull();
    expect(temporary.variables.effective?.values.fn_require_child).toBe(0);
    db.query("UPDATE chats SET metadata = ? WHERE id = ?").run("{}", "chat-1");
    const lasting = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      connectionId: "connection-1",
      agentConfig: config(),
      db,
    });
    expect(lasting.participants.persona).not.toBeNull();
    expect(lasting.blocks.find((block) => block.id === "producer")?.enabled).toBe(false);
    expect(lasting.variables.profile).toEqual({ producer: { fn_require_child: 1 } });
    expect(lasting.variables.effective?.values.fn_require_child).toBeUndefined();
    expect(lasting.variables.revision).not.toBe(temporary.variables.revision);
    db.close();
  });

  test("attached World Books complete snapshot preflight with UTF-8 book scan order", () => {
    const db = schema();
    seed(db);
    db.query("INSERT INTO world_books VALUES (?, ?, ?, ?, ?, ?)").run("wb-b", "user-1", "Later lore", "", "{}", 2);
    db.query("INSERT INTO world_books VALUES (?, ?, ?, ?, ?, ?)").run("wb-a", "user-1", "Earlier lore", "", "{}", 2);
    db.query("INSERT INTO world_book_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "entry-b", "wb-b", JSON.stringify(["b"]), "[]", "b", "B", 0, 4, "system", 1, 0, 0, 0, 0, 0, "not_enabled", 1, 1,
    );
    db.query("INSERT INTO world_book_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "entry-a", "wb-a", JSON.stringify(["a"]), "[]", "a", "A", 0, 4, "system", 1, 0, 0, 0, 0, 0, "not_enabled", 1, 1,
    );
    db.query("UPDATE characters SET extensions = ? WHERE id = ?").run(JSON.stringify({ world_book_ids: ["wb-b"] }), "char-1");
    db.query("UPDATE chats SET metadata = ? WHERE id = ?").run(JSON.stringify({ chat_world_book_ids: ["wb-a"] }), "chat-1");
    db.query("UPDATE settings SET value = ? WHERE key = ? AND user_id = ?").run(JSON.stringify([]), "globalWorldBooks", "user-1");
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      connectionId: "connection-1",
      agentConfig: config(),
      db,
    });
    const attachedBookIds = ["wb-b", "wb-a"];
    const utf8BookIds = [...attachedBookIds].sort(compareUtf8);
    expect(utf8BookIds).toEqual(["wb-a", "wb-b"]);
    expect(snapshot.worldInfo.books.map((book) => book.id)).toEqual(attachedBookIds);
    expect(snapshot.worldInfo.entries.map((entry) => entry.bookId)).toEqual(utf8BookIds);
    expect(snapshot.worldInfo.entries.map((entry) => entry.id)).toEqual(["entry-a", "entry-b"]);
    expect(snapshot.inputRevisionSet.worldLore.length).toBeGreaterThan(0);
    expect(snapshot.inputRevisionSet.readiness).toHaveLength(1);
    expect(snapshot.inputRevisionSet.digest.length).toBeGreaterThan(0);
    db.close();
  });
  test("projects exact structural markers and only anchored visible typed-media history", async () => {
    const db = schema();
    seed(db);
    const structuralBlocks = [
      { id: "description", name: "Description", content: "authored placeholder", role: "system", enabled: true, position: "pre_history", depth: 0, marker: "char_description", isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "history", name: "History", content: "", role: "system", enabled: true, position: "pre_history", depth: 0, marker: "chat_history", isLocked: false, color: null, injectionTrigger: [], group: null },
    ];
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(structuralBlocks), "preset-1");
    db.query("UPDATE chats SET metadata = ? WHERE id = ?").run(JSON.stringify({ context_history_anchor_message_id: "message-1" }), "chat-1");
    db.query("UPDATE messages SET content = ?, swipes = ?, extra = ? WHERE id = ?").run("hello (attached)", JSON.stringify(["hello (attached)"]), "{}", "message-1");
    const insertMessage = db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertMessage.run("before", "chat-1", -1, 0, "Aria", "before anchor", 1, 0, JSON.stringify(["before anchor"]), JSON.stringify([1]), "{}", null, null, 1, 1, 1);
    insertMessage.run("hidden", "chat-1", 1, 0, "Aria", "hidden after", 1, 0, JSON.stringify(["hidden after"]), JSON.stringify([1]), JSON.stringify({ hidden: 1 }), null, null, 1, 1, 1);
    insertMessage.run("after", "chat-1", 2, 0, "Aria", "visible after", 1, 0, JSON.stringify(["visible after"]), JSON.stringify([1]), "{}", null, null, 1, 1, 1);

    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      structuralBlockValues: { description: "exact composed description" },
      mediaPartsByMessageId: {
        "message-1": [{ kind: "media", mediaType: "image", mediaId: "image-1", mimeType: "image/png", byteLength: 8, sha256: "a".repeat(64) }],
      },
      db,
    });
    expect(snapshot.messages.map((message) => message.id)).toEqual(["message-1", "after"]);
    const plan = await compileAgentAssemblyPlan(snapshot);
    const description = plan.providerMessages.find((message) => message.blockId === "description");
    expect(description?.segments).toHaveLength(1);
    const descriptionSegment = description?.segments[0];
    expect(descriptionSegment?.kind).toBe("literal");
    if (descriptionSegment?.kind !== "literal") throw new Error("description projection was not literal");
    expect(descriptionSegment.text).toBe("exact composed description");
    expect(descriptionSegment.bytes).toBe(26);
    const anchored = plan.providerMessages.find((message) => message.provenance.kind === "history" && message.provenance.sourceId === "message-1");
    expect(anchored?.segments.map((segment) => segment.kind)).toEqual(["literal", "media"]);
    expect(anchored?.segments.filter((segment) => segment.kind === "literal").map((segment) => segment.text).join("")).toBe("hello");
    expect(JSON.stringify(plan.providerMessages)).not.toContain("(attached)");
    const materialized = materializeAssemblyPlan(plan, [], plan.limits);
    expect(materialized.find((message) => message.provenance.kind === "history" && message.provenance.sourceId === "message-1")?.segments.at(-1))
      .toMatchObject({ kind: "media", mediaType: "image", mediaId: "image-1", mimeType: "image/png", byteLength: 8, bytes: 0 });
    await validateAssemblyPlanAgainstSnapshotV1(plan, snapshot);
    db.close();
  });
  test("preserves native fixed, explicit-marker, depth, and runtime World Info placement", async () => {
    const db = schema();
    seed(db);
    const blocks = [
      { id: "pre", name: "Pre", content: "pre", role: "system", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "wi-before", name: "WI Before", content: "LEAKED-EXCLUDED-WI-MARKER", role: "system", enabled: true, position: "pre_history", depth: 0, marker: "world_info_before", isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "history", name: "History", content: "", role: "system", enabled: true, position: "in_history", depth: 0, marker: "chat_history", isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "post", name: "Post", content: "post", role: "system", enabled: true, position: "post_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
    ];
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(blocks), "preset-1");
    const base = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), db });
    const activationEvidence = [{
      kind: "world_info", entryId: "entry-1", uid: base.worldInfo.entries.find((entry) => entry.id === "entry-1")!.uid,
      activated: true, origin: "vector", keyword: null, vectorScore: 0.91,
      vectorDisposition: { code: "accepted", conflictingEntryId: null, conflictingSource: null },
      state: { active: false, stickyLeft: 0, cooldownLeft: 0, delayCount: 0 },
    }];
    const nativeWorldInfo: typeof base.worldInfo = {
      ...base.worldInfo,
      native: {
        activatedEntryIds: ["entry-1"],
        cache: {
          before: [{ content: "before", role: "system", entryLabel: "Before" }],
          after: [{ content: "after", role: "system", entryLabel: "After" }],
          anBefore: [{ content: "an-before", role: "system", entryLabel: "AN before" }],
          anAfter: [{ content: "an-after", role: "system", entryLabel: "AN after" }],
          depth: [{ content: "depth", role: "system", depth: 1, entryLabel: "Depth" }],
          emBefore: [{ content: "em-before", role: "system", entryLabel: "EM before" }],
          emAfter: [{ content: "em-after", role: "system", entryLabel: "EM after" }],
          atMarker: [], pinnedMarkers: [],
        },
        runtimePlacements: [
          { id: "runtime", content: "runtime", entryLabel: "Runtime", orderValue: 0, placement: { role: "system", direction: "from_start", depth: 0 } },
          { id: "runtime-2", content: "runtime-2", entryLabel: "Runtime 2", orderValue: 1, placement: { role: "system", direction: "from_start", depth: 1 } },
        ],
        stateAfter: {}, activationEvidence,
        vectorDispositions: { "entry-1": { code: "accepted", conflictingEntryId: null, conflictingSource: null } },
        stats: { keywordActivated: 0, vectorActivated: 1, totalActivated: 1 },
      },
    };
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1",
      agentConfig: config(), structuralBlockValues: { "wi-before": "before" }, nativeWorldInfo, db,
    });
    const plan = await compileAgentAssemblyPlan(snapshot);
    const texts = plan.providerMessages.flatMap((message) =>
      message.segments.filter((segment) => segment.kind === "literal").map((segment) => segment.text)
    );
    expect(texts).toEqual(["pre", "before", "an-before", "em-before", "em-after", "runtime", "runtime-2", "hello", "an-after", "after", "depth", "post"]);
    expect(texts.filter((text) => text === "before")).toHaveLength(1);
    expect(plan.privateEvidence.activation.filter((item) => item.kind === "world_info")).toEqual(activationEvidence);
    await validateAssemblyPlanAgainstSnapshotV1(plan, snapshot);
    const excludedSnapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1",
      agentConfig: config(), structuralBlockValues: {}, nativeWorldInfo, db,
    });
    const excludedPlan = await compileAgentAssemblyPlan(excludedSnapshot);
    const excludedTexts = excludedPlan.providerMessages.flatMap((message) =>
      message.segments.filter((segment) => segment.kind === "literal").map((segment) => segment.text)
    );
    expect(excludedTexts).not.toContain("LEAKED-EXCLUDED-WI-MARKER");
    expect(excludedTexts.filter((text) => text === "before")).toHaveLength(1);
    await validateAssemblyPlanAgainstSnapshotV1(excludedPlan, excludedSnapshot);
    db.close();
  });

});
async function compiledAssemblyPlan(): Promise<AssemblyPlanV1> {
  const db = schema();
  seed(db);
  const snapshot = buildGenerationAssemblySnapshot({
    assemblySurface: "WORK",
    userId: "user-1",
    chatId: "chat-1",
    presetId: "preset-1",
    agentConfig: config(),
    db,
  });
  const plan = await compileAgentAssemblyPlan(snapshot);
  db.close();
  return plan;
}
async function compiledAssemblyFixture(): Promise<{ snapshot: GenerationAssemblySnapshotV1; plan: AssemblyPlanV1 }> {
  const db = schema();
  seed(db);
  const snapshot = buildGenerationAssemblySnapshot({
    assemblySurface: "WORK",
    userId: "user-1",
    chatId: "chat-1",
    presetId: "preset-1",
    agentConfig: config(),
    db,
  });
  const plan = await compileAgentAssemblyPlan(snapshot);
  db.close();
  return { snapshot, plan };
}
function policyEntry(blockId: string, blockIndex = 0): AssemblyPlanV1["loomPolicy"]["workPolicy"][number] {
  return {
    version: 1,
    id: `fixture-${blockId}`,
    source: {
      kind: "loom_block",
      blockId,
      presetRevision: 1,
      blockRevision: 1,
      promptOrder: blockIndex,
    },
    destination: "root_work",
    checkpoint: "WORK",
    required: false,
    visibility: "work_only",
  };
}
function withWorkPolicyEntries(
  plan: AssemblyPlanV1,
  entries: readonly AssemblyPlanV1["loomPolicy"]["workPolicy"][number][],
): AssemblyPlanV1 {
  return {
    ...plan,
    loomPolicy: {
      ...plan.loomPolicy,
      workPolicy: entries,
    },
  };
}
function literalSegment(text: string): AssemblyMessageSegmentV1 {
  const segment: AssemblyMessageSegmentV1 = {
    kind: "literal",
    text,
    bytes: new TextEncoder().encode(text).byteLength,
  };
  return segment;
}
function policyMessage(blockId: string, blockIndex = 0): AssemblyPlanV1["workPolicyMessages"][number] {
  const text = `policy-${blockId}`;
  const entry = policyEntry(blockId, blockIndex);
  return {
    role: "system",
    blockId,
    blockIndex,
    contentKind: "segments",
    provenance: {
      kind: "cognition",
      sourceId: blockId,
      sourceRevision: "1",
      sourceIndex: blockIndex,
      loom: {
        entryId: entry.id,
        bucket: "workPolicy",
        destination: entry.destination,
        checkpoint: entry.checkpoint,
        source: entry.source,
        effectiveText: text,
      },
    },
    segments: [literalSegment(text)],
  };
}

describe("strict assembly input boundaries", () => {
  test("accepts only closed AgentConfig V2 and never treats legacy enabled as authority", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      db,
    });
    await expect(compileAgentAssemblyPlan({
      snapshot,
      agentConfig: {
        version: 1,
        enabled: true,
        maxInvocations: 4,
        maxToolCalls: 4,
        mainToolIds: [],
        mainLoreScope: "active",
        profiles: [],
      },
    })).rejects.toThrow(AssemblyPlanValidationError);
    await expect(compileAgentAssemblyPlan({
      snapshot,
      agentConfig: { ...config(), unknown: true },
    })).rejects.toThrow(AssemblyPlanValidationError);
    expect((await compileAgentAssemblyPlan(snapshot)).children).toHaveLength(1);
    db.close();
  });

  test("rejects cap-plus-one depth and node data iteratively across snapshot fields", async () => {
    const exactCapDepth = SNAPSHOT_DATA_MAX_DEPTH_V1 - 2;
    const capPlusOneDepth = exactCapDepth + 1;
    for (const field of ["metadata", "extra", "variables"] as const) {
      expect(() => validateAssemblySnapshotDataV1({
        [field]: nestedData(exactCapDepth),
      })).not.toThrow();
      expect(() => validateAssemblySnapshotDataV1({
        [field]: nestedData(capPlusOneDepth),
      })).toThrow(/depth/i);
    }
    expect(() => validateAssemblySnapshotDataV1(
      { metadata: { value: "ok" } },
      { maxNodes: 5 },
    )).not.toThrow();
    expect(() => validateAssemblySnapshotDataV1(
      { metadata: { value: "ok", extra: "cap-plus-one" } },
      { maxNodes: 5 },
    )).toThrow(/nodes/i);
    expect(SNAPSHOT_DATA_MAX_NODES_V1).toBeGreaterThan(5);
  });
  test("uses deterministic key order for canonical snapshot data", async () => {
    expect(encodeCanonicalPlainData({ z: 1, a: { d: 4, b: 2 }, m: [3, 1] })).toBe("{\"a\":{\"b\":2,\"d\":4},\"m\":[3,1],\"z\":1}");
    expect(encodeCanonicalPlainData({ a: 1, z: 2 })).toBe(encodeCanonicalPlainData({ z: 2, a: 1 }));
  });

  test("fails closed when an active regex row carries a repair code", async () => {
    const db = schema();
    seed(db);
    db.run("ALTER TABLE regex_scripts ADD COLUMN validation_error_code TEXT");
    db.query("UPDATE regex_scripts SET validation_error_code = ? WHERE id = ?").run("pattern_too_large", "regex-1");
    expect(() => buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      db,
    })).toThrow(/requires_response_mode.*repair/i);
    db.close();
  });
});
describe("strict assembly plan", () => {
  test("enforces the canonical 32 KiB UTF-8 boundary for authored child tasks", async () => {
    const compileTask = async (task: string): Promise<AssemblyPlanV1> => {
      const db = schema();
      seed(db);
      const row = db.query("SELECT prompt_order FROM presets WHERE id = ?").get("preset-1") as { prompt_order: string };
      const blocks = JSON.parse(row.prompt_order) as Array<Record<string, unknown>>;
      const producer = blocks[0];
      if (!producer) throw new Error("Missing producer fixture");
      blocks[0] = { ...producer, content: `{{agent::writer::as=facts}}${task}{{/agent}}` };
      db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(blocks), "preset-1");
      try {
        const snapshot = buildGenerationAssemblySnapshot({
          assemblySurface: "WORK",
          userId: "user-1",
          chatId: "chat-1",
          presetId: "preset-1",
          agentConfig: config(),
          db,
        });
        return await compileAgentAssemblyPlan(snapshot);
      } finally {
        db.close();
      }
    };
    const asciiBoundary = "a".repeat(AGENT_CHILD_TASK_MAX_BYTES);
    const multibyteBoundary = "é".repeat(AGENT_CHILD_TASK_MAX_BYTES / 2);
    const oneByteOver = `${multibyteBoundary}a`;

    expect(Buffer.byteLength(asciiBoundary, "utf8")).toBe(32_768);
    expect(Buffer.byteLength(multibyteBoundary, "utf8")).toBe(32_768);
    expect(Buffer.byteLength(oneByteOver, "utf8")).toBe(32_769);
    for (const task of [asciiBoundary, multibyteBoundary]) {
      const plan = await compileTask(task);
      expect(plan.children).toHaveLength(1);
      expect(plan.children[0]).toMatchObject({ task, taskBytes: AGENT_CHILD_TASK_MAX_BYTES });
    }
    try {
      await compileTask(oneByteOver);
      throw new Error("Expected child task compilation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AssemblyPlanValidationError);
      expect(error).toMatchObject({
        code: "limit_exceeded",
        blockIndex: 0,
        blockId: "producer",
        message: "Child task exceeds 32 KiB UTF-8 limit",
      });
    }
  });

  test("orders children, emits direct slots, and substitutes child output once as literal bytes", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      db,
    });
    const plan = await compileAgentAssemblyPlan(snapshot);
    expect(plan.assemblySurface).toBe("WORK");
    const wireSnapshot = JSON.parse(JSON.stringify(snapshot)) as GenerationAssemblySnapshotV1;
    expect((await compileAgentAssemblyPlan(wireSnapshot)).children.map((child) => child.slotIndex)).toEqual([0]);
    expect(plan.children.map((child) => child.slotIndex)).toEqual([0]);
    expect(plan.children[0]?.maxOutputTokens).toBe(64);
    expect(plan.resultSlots[0]?.slotIndex).toBe(0);
    const materialized = materializeAssemblyPlan(plan, ["{{regex_should_not_run}}"], plan.limits);
    const segments = materialized.flatMap((message) => message.segments);
    expect(segments.some((segment) => segment.kind === "literal" && segment.text === "{{regex_should_not_run}}" && segment.text.includes("{{"))).toBe(true);
    db.close();
  });
  test("binds duplicate-ID cognition provenance by Loom prompt order", async () => {
    const db = schema();
    seed(db);
    db.run("ALTER TABLE world_book_entries ADD COLUMN extensions TEXT NOT NULL DEFAULT '{}'");
    db.query("UPDATE world_book_entries SET content = ?, extensions = ? WHERE id = ?").run(
      "ASSEMBLY_OUTLET_CONTEXT",
      JSON.stringify({ outlet_name: "policy_context" }),
      "entry-2",
    );
    const blockId = "shared-policy-block";
    const promptBlock = (id: string, content: string, revision = 1) => ({
      id,
      name: id,
      content,
      role: "user" as const,
      enabled: id === blockId,
      position: "pre_history" as const,
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      group: null,
      revision,
    });
    const promptBlocks = [
      promptBlock("filler-0", ""),
      promptBlock("filler-1", ""),
      promptBlock("filler-2", ""),
      promptBlock(blockId, "Occurrence three {{outlet::policy_context}}.", 1),
      promptBlock("filler-4", ""),
      promptBlock("filler-5", ""),
      promptBlock("filler-6", ""),
      promptBlock(blockId, "Occurrence seven compiled policy.", 2),
    ];
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(promptBlocks), "preset-1");
    const cognitionSource = {
      presetRevision: 7,
      blocks: [
        { blockId, revision: 1, promptOrder: 3 },
        { blockId, revision: 2, promptOrder: 7 },
      ],
    };
    const cognitionGraph = freezeCognitionGraph({
      version: 1,
      policies: { workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
      templates: [],
    }, cognitionSource);
    const policyEntry = (id: string, promptOrder: number, blockRevision: number, required: boolean) => ({
      version: 1 as const,
      id,
      source: {
        kind: "loom_block" as const,
        blockId,
        presetRevision: 7,
        blockRevision,
        promptOrder,
      },
      destination: "root_work" as const,
      checkpoint: "WORK" as const,
      required,
      visibility: "work_only" as const,
    });
    const loomPolicy = {
      version: 1 as const,
      workPolicy: [policyEntry("policy-three", 3, 1, true), policyEntry("policy-seven", 7, 2, false)],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    };
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      cognitionGraph,
      cognitionSource,
      loomPolicy,
      db,
    });
    const plan = await compileAgentAssemblyPlan(snapshot);
    const inspection = inspectLoomPromptPolicies(plan.loomPolicy, {
      surface: "WORK",
      checkpoint: "WORK",
      blocks: plan.loomBlocks,
    });
    expect(inspection.effectiveEntryIds).toEqual(["policy-three", "policy-seven"]);
    expect(inspection.items[0]?.effectiveText).toBe("Occurrence three ASSEMBLY_OUTLET_CONTEXT.");
    expect(inspection.items.map((item) => [item.required, item.outcome.status])).toEqual([
      [true, "included"],
      [false, "included"],
    ]);
    expect(plan.workPolicyMessages.map((message) =>
      message.segments.map((segment) => segment.kind === "literal" ? segment.text : "").join(""),
    )).toEqual(["Occurrence three ASSEMBLY_OUTLET_CONTEXT.", "Occurrence seven compiled policy."]);
    expect(plan.workPolicyMessages.map((message) => [
      message.provenance.sourceIndex,
      message.provenance.loom.source.promptOrder,
      message.provenance.sourceRevision,
      message.blockIndex,
    ])).toEqual([
      [0, 3, "1", 3],
      [1, 7, "2", 7],
    ]);
    expect(plan.workPolicyMessages[0]).toMatchObject({
      blockIndex: 3,
      provenance: {
        kind: "cognition",
        sourceIndex: 0,
        loom: {
          entryId: "policy-three",
          bucket: "workPolicy",
          destination: "root_work",
          checkpoint: "WORK",
          effectiveText: "Occurrence three ASSEMBLY_OUTLET_CONTEXT.",
          source: { promptOrder: 3 },
        },
      },
    });
    expect(plan.loomBlocks.map((entry) => [entry.source.promptOrder, entry.source.blockRevision, entry.content])).toEqual([
      [3, 1, "Occurrence three ASSEMBLY_OUTLET_CONTEXT."],
      [7, 2, "Occurrence seven compiled policy."],
    ]);
    await expect(validateAssemblyPlanAgainstSnapshotV1(plan, snapshot)).resolves.toBeUndefined();

    const first = plan.workPolicyMessages[0]!;
    const firstLoom = first.provenance.loom!;
    const forgedMessage = ({
      sourceId = first.provenance.sourceId,
      sourceRevision = first.provenance.sourceRevision,
      sourceIndex = first.provenance.sourceIndex,
      promptOrder = firstLoom.source.promptOrder,
      blockRevision = firstLoom.source.blockRevision,
      loomBlockId = firstLoom.source.blockId,
      messageBlockId = first.blockId,
      messageBlockIndex = first.blockIndex,
    }: {
      sourceId?: string;
      sourceRevision?: string;
      sourceIndex?: number;
      promptOrder?: number;
      blockRevision?: number;
      loomBlockId?: string;
      messageBlockId?: string;
      messageBlockIndex?: number;
    }): AssemblyPlanV1["workPolicyMessages"][number] => ({
      ...first,
      blockId: messageBlockId,
      blockIndex: messageBlockIndex,
      provenance: {
        ...first.provenance,
        sourceId,
        sourceRevision,
        sourceIndex,
        loom: {
          ...firstLoom,
          source: { ...firstLoom.source, blockId: loomBlockId, blockRevision, promptOrder },
        },
      },
    });
    const forgedPlan = (message: AssemblyPlanV1["workPolicyMessages"][number]): AssemblyPlanV1 => ({
      ...plan,
      workPolicyMessages: [message, plan.workPolicyMessages[1]!],
    });
    const siblingOccurrence = forgedPlan(forgedMessage({
      sourceRevision: "2",
      promptOrder: 7,
      blockRevision: 2,
      messageBlockIndex: 7,
    }));
    await expect(validateAssemblyPlanAgainstSnapshotV1(siblingOccurrence, snapshot)).rejects.toThrow(/source|provenance|projection/i);
    await expect(validateAssemblyPlanAgainstSnapshotV1(forgedPlan(forgedMessage({ sourceRevision: "2" })), snapshot)).rejects.toThrow(/source|provenance|projection/i);
    await expect(validateAssemblyPlanAgainstSnapshotV1(forgedPlan(forgedMessage({ sourceId: "forged-id" })), snapshot)).rejects.toThrow(/source|provenance|projection/i);
    await expect(validateAssemblyPlanAgainstSnapshotV1(forgedPlan(forgedMessage({ loomBlockId: "forged-id" })), snapshot)).rejects.toThrow(/source|provenance|projection/i);
    for (const promptOrder of [8, 3.5, -1]) {
      await expect(validateAssemblyPlanAgainstSnapshotV1(forgedPlan(forgedMessage({ promptOrder })), snapshot)).rejects.toThrow(/source|provenance|projection|invalid/i);
    }
    for (const sourceIndex of [1, 2]) {
      expect(() => validateAssemblyPlanV1(forgedPlan(forgedMessage({ sourceIndex })), plan.limits))
        .toThrow("Cognition policy message provenance is not source-bound");
    }
    for (const sourceIndex of [0.5, -1]) {
      expect(() => validateAssemblyPlanV1(forgedPlan(forgedMessage({ sourceIndex })), plan.limits))
        .toThrow("Invalid cognition policy message provenance");
    }
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(
      JSON.stringify(promptBlocks.map((block, promptOrder) => promptOrder === 7 ? { ...block, marker: "category" } : block)),
      "preset-1",
    );
    const categorySnapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      cognitionGraph,
      cognitionSource,
      loomPolicy,
      db,
    });
    await expect(compileAgentAssemblyPlan(categorySnapshot)).rejects.toThrow(/category marker/i);
    db.close();
  });
  test("rejects a Response snapshot at the strict compiler boundary", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      db,
    });
    await expect(compileAgentAssemblyPlan({
      ...snapshot,
      assemblySurface: "RESPONSE",
    })).rejects.toThrow(/WORK surface/i);
    db.close();
  });
  test("places in-history blocks at their frozen depth between history boundaries", async () => {
    const db = schema();
    seed(db);
    const initial = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), db });
    const producer = initial.blocks.find((block) => block.id === "producer")!;
    const consumer = initial.blocks.find((block) => block.id === "consumer")!;
    const inHistory = { ...producer, id: "in-history", name: "In history", content: "Between history", position: "in_history" as const, depth: 0 };
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify([producer, inHistory, consumer]), "preset-1");
    const snapshot = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), db });
    const plan = await compileAgentAssemblyPlan(snapshot);
    expect(plan.providerMessages.map((message) => message.blockId ?? "history")).toEqual(["producer", "history", "history", "in-history", "consumer"]);
    db.close();
  });

  test("rejects transformed, recursive, and out-of-order result references", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), db });
    const transformed = {
      ...snapshot,
      blocks: snapshot.blocks.map((block) => block.id === "consumer"
        ? { ...block, content: "{{upper::{{agentResult::facts}}}}" }
        : block),
    };
    await expect(compileAgentAssemblyPlan(transformed)).rejects.toThrow(AssemblyPlanValidationError);
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify([...snapshot.blocks].reverse()), "preset-1");

    const reversed = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), db });
    await expect(compileAgentAssemblyPlan(reversed)).rejects.toThrow(/forward|precede|order/i);
    const recursiveBlocks = snapshot.blocks.map((block) => block.id === "producer"
      ? { ...block, content: "{{agent::writer::as=facts}}{{agentResult::facts}}{{/agent}}" }
      : block);
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(recursiveBlocks), "preset-1");
    const recursive = buildGenerationAssemblySnapshot({ assemblySurface: "WORK", userId: "user-1", chatId: "chat-1", presetId: "preset-1", agentConfig: config(), db });
    await expect(compileAgentAssemblyPlan(recursive)).rejects.toThrow(/recursive|result reference|nested_intrinsic/i);
    db.close();
  });
  test("round-trips closed cognition evidence and rejects public text", async () => {
    const plan = await compiledAssemblyPlan();
    const wire = JSON.parse(JSON.stringify(plan)) as AssemblyPlanV1;
    expect(() => validateAssemblyPlanV1(wire, plan.limits)).not.toThrow();
    expect(wire.privateEvidence.cognition).toEqual([]);
    const cognition = {
      kind: "cognition_phase" as const,
      phase: "WORK" as const,
      section: "workPolicy" as const,
      blockId: "policy",
      expectedPresetRevision: 1,
      expectedBlockRevision: 1,
      actualPresetRevision: 1,
      actualBlockRevision: 1,
      order: 0,
      promptOrder: 0,
      decision: "selected" as const,
      ruleSourceRevision: "1:1",
      tokenCost: 1,
      byteCost: 0,
    };
    const forged = {
      ...wire,
      privateEvidence: {
        ...wire.privateEvidence,
        cognition: [{ ...cognition, text: "must-not-cross-wire" }],
      },
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/private cognition|private assembly|cognition activation/i);
  });
  test("rejects escaped macros that restore protected child markers", async () => {
    const db = schema();
    seed(db);
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      db,
    });
    const escapedBlocks = snapshot.blocks.map((block) => block.id === "consumer"
      ? { ...block, content: "\\{\\{agent::writer::as=facts\\}\\}generated\\{\\{/agent\\}\\} {{name}}" }
      : block);
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(escapedBlocks), "preset-1");
    const escapedSnapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      db,
    });
    await expect(compileAgentAssemblyPlan(escapedSnapshot)).rejects.toThrow(/generated|result reference|agent marker/i);
    db.close();
  });
  test("rejects prompt regex replacements that generate protected result markers", async () => {
    const db = schema();
    seed(db);
    db.query("UPDATE regex_scripts SET replace_string = ?, placement = ? WHERE id = ?").run("{{agentResult::facts}}", JSON.stringify(["user_input"]), "regex-1");
    const row = db.query<{ prompt_order: string }, ["preset-1"]>("SELECT prompt_order FROM presets WHERE id = ?").get("preset-1");
    const blocks = JSON.parse(row?.prompt_order ?? "[]") as Array<Record<string, unknown>>;
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(blocks.map((block) => block.id === "consumer" ? { ...block, content: "foo" } : block)), "preset-1");
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      db,
    });
    await expect(compileAgentAssemblyPlan(snapshot)).rejects.toThrow(/generated_result_reference|generated.*result marker/i);
    db.close();
  });
  test("accepts a transformed block that becomes empty", async () => {
    const db = schema();
    seed(db);
    db.query("UPDATE regex_scripts SET replace_string = ?, placement = ? WHERE id = ?").run("", JSON.stringify(["user_input"]), "regex-1");
    const row = db.query<{ prompt_order: string }, ["preset-1"]>("SELECT prompt_order FROM presets WHERE id = ?").get("preset-1");
    const blocks = JSON.parse(row?.prompt_order ?? "[]") as Array<Record<string, unknown>>;
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(blocks.map((block) => block.id === "consumer" ? { ...block, content: "foo" } : block)), "preset-1");
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      db,
    });
    const plan = await compileAgentAssemblyPlan(snapshot);
    expect(plan.providerMessages.some((message) => message.blockId === "consumer")).toBe(false);
    await expect(validateAssemblyPlanAgainstSnapshotV1(plan, snapshot)).resolves.toBeUndefined();
    db.close();
  });
  test("emits one prompt regex action when a script transforms multiple blocks", async () => {
    const db = schema();
    seed(db);
    db.query("UPDATE regex_scripts SET placement = ? WHERE id = ?").run(JSON.stringify(["user_input"]), "regex-1");
    db.query("INSERT INTO regex_scripts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "regex-2", "user-1", "nonmatching", "nope", "bar", "[]", "gi", JSON.stringify(["user_input"]), "global", null,
      JSON.stringify(["prompt"]), "[]", 0, 0, 1, 1,
    );
    const row = db.query<{ prompt_order: string }, ["preset-1"]>("SELECT prompt_order FROM presets WHERE id = ?").get("preset-1");
    const blocks = JSON.parse(row?.prompt_order ?? "[]") as Array<Record<string, unknown>>;
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify(
      blocks.map((block) => ({ ...block, content: "foo", role: "user" })),
    ), "preset-1");
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      db,
    });
    const plan = await compileAgentAssemblyPlan(snapshot);
    const regexDeltas = plan.deltas.filter((delta) => delta.kind === "regex_action");
    expect(regexDeltas).toHaveLength(1);
    expect(regexDeltas[0]).toMatchObject({ scriptId: "regex-1", operation: "apply" });
    db.close();
  });
  test("persists a world-info cooldown transition when it reaches zero", async () => {
    const db = schema();
    seed(db);
    const metadata = {
      chat_world_book_ids: ["book-2"],
      active_world_info_entry_ids: ["entry-2"],
      chat_variables: { mood: "calm" },
      wi_state: {
        "entry-1": { active: false, stickyLeft: 0, cooldownLeft: 1, delayCount: 0 },
      },
    };
    db.query("UPDATE chats SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), "chat-1");
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: config(),
      db,
    });
    const plan = await compileAgentAssemblyPlan(snapshot);
    const delta = plan.deltas.find((candidate) => candidate.kind === "world_info_state" && candidate.entryId === "entry-1");
    expect(delta).toMatchObject({
      operation: "set_cooldown",
      state: "cooldown",
      afterState: { active: false, stickyLeft: 0, cooldownLeft: 0, delayCount: 0 },
    });
    db.close();
  });

  test("requires trusted snapshot limits for plans received from an isolate", async () => {
    const plan = await compiledAssemblyPlan();
    const trusted = { ...plan.limits, maxInputBytes: 1024 };
    const widened = { ...plan, limits: { ...plan.limits, maxInputBytes: 2048 } };
    expect(() => validateAssemblyPlanV1(widened, trusted)).toThrow(/trusted|limit/i);
  });

  test("binds profile output ceilings to the authenticated snapshot", async () => {
    const { snapshot, plan } = await compiledAssemblyFixture();
    expect(plan.profileOutputLimits).toEqual([{ profileId: "writer", maxOutputTokens: 64 }]);
    const forged = {
      ...plan,
      profileOutputLimits: plan.profileOutputLimits.map((limit) => ({
        ...limit,
        maxOutputTokens: limit.maxOutputTokens + 1,
      })),
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).not.toThrow();
    await expect(validateAssemblyPlanAgainstSnapshotV1(forged, snapshot)).rejects.toThrow(/profile output limits|snapshot/i);
  });

  test("requires one-to-one cognition evidence with exact message accounting", async () => {
    const plan = await compiledAssemblyPlan();
    const message = policyMessage("policy");
    const byteCost = message.segments.reduce((total, segment) => total + (segment.kind === "literal" ? new TextEncoder().encode(segment.text).byteLength : 0), 0);
    const evidence = {
      kind: "cognition_phase" as const,
      phase: "WORK" as const,
      section: "workPolicy" as const,
      blockId: "policy",
      expectedPresetRevision: 1,
      expectedBlockRevision: 1,
      actualPresetRevision: 1,
      actualBlockRevision: 1,
      order: 0,
      promptOrder: 0,
      decision: "selected" as const,
      ruleSourceRevision: "1:1",
      tokenCost: Math.max(1, Math.ceil(byteCost / 4)),
      byteCost,
    };
    const valid = {
      ...withWorkPolicyEntries(plan, [policyEntry("policy")]),
      workPolicyMessages: [message],
      privateEvidence: { ...plan.privateEvidence, cognition: [evidence] },
    };
    expect(() => validateAssemblyPlanV1(valid, plan.limits)).not.toThrow();
    expect(() => validateAssemblyPlanV1({ ...valid, privateEvidence: { ...valid.privateEvidence, cognition: [] } }, plan.limits)).toThrow(/cognition evidence/i);
    expect(() => validateAssemblyPlanV1({
      ...valid,
      privateEvidence: { ...valid.privateEvidence, cognition: [{ ...evidence, byteCost: byteCost + 1 }] },
    }, plan.limits)).toThrow(/cognition evidence|accounting/i);
  });

  test("snapshots unversioned Loom blocks at authoring revision 1 and compiles empty phase policy messages", async () => {
    const db = schema();
    seed(db);
    const policyBlocks = [
      { id: "policy-work", name: "Work", content: "work-policy", role: "system", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "policy-usage", name: "Usage", content: "usage-policy", role: "system", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "policy-complete", name: "Complete", content: "{{loomSummary}}", role: "system", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "policy-render", name: "Render", content: "render-policy", role: "system", enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
    ];
    const row = db.query<{ prompt_order: string }, ["preset-1"]>("SELECT prompt_order FROM presets WHERE id = ?").get("preset-1");
    const existing = JSON.parse(row?.prompt_order ?? "[]") as Array<Record<string, unknown>>;
    db.query("UPDATE presets SET prompt_order = ? WHERE id = ?").run(JSON.stringify([...existing, ...policyBlocks]), "preset-1");
    const source = {
      presetRevision: 7,
      blocks: policyBlocks.map((block, promptOrder) => ({ blockId: block.id, revision: 1, promptOrder: existing.length + promptOrder })),
    };
    const policyEntryFor = (
      bucket: "workPolicy" | "workspaceUsage" | "completionCriteria" | "renderPolicy",
      blockId: string,
      destination: "root_work" | "completion_handoff" | "render",
      checkpoint: "WORK" | "PREPARE_COMMIT" | "RENDER",
      promptOrder: number,
    ) => ({
      version: 1 as const,
      id: `unversioned-${bucket}`,
      source: {
        kind: "loom_block" as const,
        blockId,
        presetRevision: 7,
        blockRevision: 1,
        promptOrder,
      },
      destination,
      checkpoint,
      required: false,
      visibility: "work_only" as const,
    });
    const canonicalWorkPolicy = policyEntryFor("workPolicy", "policy-work", "root_work", "WORK", existing.length);
    const staleOptionalWorkPolicy = {
      ...canonicalWorkPolicy,
      id: "zzz-stale-workPolicy",
      source: { ...canonicalWorkPolicy.source, blockId: "stale-policy-work", promptOrder: existing.length + 100 },
    };
    const cognitionPolicy = {
      version: 1 as const,
      workPolicy: [canonicalWorkPolicy, staleOptionalWorkPolicy],
      workspaceUsage: [policyEntryFor("workspaceUsage", "policy-usage", "root_work", "WORK", existing.length + 1)],
      completionCriteria: [policyEntryFor("completionCriteria", "policy-complete", "completion_handoff", "PREPARE_COMMIT", existing.length + 2)],
      renderPolicy: [policyEntryFor("renderPolicy", "policy-render", "render", "RENDER", existing.length + 3)],
    };
    const graph = freezeCognitionGraph({
      version: 1,
      policies: { workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
      templates: [],
    }, source);
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      agentConfig: {
        ...config(),
        runtimePolicy: {
          version: 1,
          authority: "loom",
          scope: "preset",
          defaultMode: "agentic",
          loomPolicy: cognitionPolicy,
          phases: [],
        },
      },
      cognitionGraph: graph,
      cognitionSource: source,
      db,
    });
    expect(snapshot.blocks.filter((block) => block.id.startsWith("policy-")).map((block) => block.revision)).toEqual(["1", "1", "1", "1"]);
    const plan = await compileAgentAssemblyPlan(snapshot);
    expect(plan.loomPolicy).toMatchObject({
      version: 1,
      workPolicy: [{
        destination: "root_work",
        checkpoint: "WORK",
        source: {
          kind: "loom_block",
          blockId: "policy-work",
          presetRevision: 7,
          blockRevision: 1,
          promptOrder: existing.length,
        },
      }, {
        id: "zzz-stale-workPolicy",
        destination: "root_work",
        checkpoint: "WORK",
        source: {
          kind: "loom_block",
          blockId: "stale-policy-work",
          presetRevision: 7,
          blockRevision: 1,
          promptOrder: existing.length + 100,
        },
      }],
      workspaceUsage: [{
        destination: "root_work",
        checkpoint: "WORK",
      }],
      completionCriteria: [{
        destination: "completion_handoff",
        checkpoint: "PREPARE_COMMIT",
      }],
      renderPolicy: [{
        destination: "render",
        checkpoint: "RENDER",
      }],
    });
    expect(plan.loomPolicy.workPolicy).toHaveLength(2);
    expect(plan.loomBlocks.map((block) => block.source.blockId)).toEqual([
      "policy-work",
      "policy-usage",
      "policy-complete",
      "policy-render",
    ]);
    expect(plan.loomBlocks.filter((block) => block.source.blockId === "policy-work")).toHaveLength(1);
    expect(plan.workPolicyMessages).toHaveLength(1);
    expect(plan.workPolicyMessages[0]?.provenance).toMatchObject({
      loom: { entryId: canonicalWorkPolicy.id, source: canonicalWorkPolicy.source },
    });
    expect(plan.workspaceUsageMessages).toHaveLength(1);
    expect(plan.completionCriteriaMessages).toHaveLength(1);
    expect(plan.renderPolicyMessages).toHaveLength(1);
    expect(plan.completionCriteriaMessages[0]?.segments).toMatchObject([{ kind: "literal", text: "" }]);
    expect(plan.completionCriteriaMessages[0]?.provenance).toMatchObject({
      kind: "cognition",
      sourceId: "policy-complete",
      sourceRevision: "1",
      sourceIndex: 0,
    });
    expect(plan.privateEvidence.cognition.filter((entry) => entry.section === "completionCriteria")).toEqual([
      expect.objectContaining({ phase: "PREPARE_COMMIT" }),
    ]);
    const forgedCompletionPhase = {
      ...plan,
      privateEvidence: {
        ...plan.privateEvidence,
        cognition: plan.privateEvidence.cognition.map((entry) => entry.section === "completionCriteria"
          ? { ...entry, phase: "WORK" as const }
          : entry),
      },
    };
    expect(() => validateAssemblyPlanV1(forgedCompletionPhase, plan.limits)).toThrow(/Cognition evidence/i);
    await expect(validateAssemblyPlanAgainstSnapshotV1(forgedCompletionPhase, snapshot)).rejects.toThrow(/Cognition evidence does not match phase message order or accounting/i);
    expect(() => validateAssemblyPlanV1(plan, plan.limits)).not.toThrow();
    await expect(validateAssemblyPlanAgainstSnapshotV1(plan, snapshot)).resolves.toBeUndefined();
    db.close();
  });

  test("binds result slots to child coordinates and seals as a closed record", async () => {
    const plan = await compiledAssemblyPlan();
    const child = plan.children[0]!;
    const slot = plan.resultSlots[0]!;
    const forgedChild = { ...child, blockIndex: child.blockIndex + 1, producerSeal: "forged" };
    const forgedSlot = { ...slot, producerBlockIndex: slot.producerBlockIndex + 1, producerBlockId: "forged-block", seal: "forged" };
    const forged = {
      ...plan,
      children: [forgedChild],
      childDescriptors: [forgedChild],
      resultSlots: [forgedSlot],
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/child|slot|seal/i);
    expect(() => validateAssemblyPlanV1({
      ...plan,
      resultSlots: [{ ...slot, unexpected: true }],
    }, plan.limits)).toThrow(/result slot|unknown|invalid/i);
  });

  test("rejects protected markers in ordinary provider literals", async () => {
    const plan = await compiledAssemblyPlan();
    const targetIndex = plan.providerMessages.findIndex((message) => message.segments.every((segment) => segment.kind === "literal"));
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const forgedText = "{{agent::forged::as=facts}}{{/agent}}";
    const forgedMessages = plan.providerMessages.map((message, index) => index === targetIndex
      ? {
        ...message,
        segments: [literalSegment(forgedText)],
      }
      : message);
    const forged = { ...plan, messages: forgedMessages, providerMessages: forgedMessages };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/literal|agent marker/i);
  });
  test("rejects combined provider and phase message cap plus one", async () => {
    const plan = await compiledAssemblyPlan();
    const policies = Array.from({ length: 13 }, (_, index) => policyMessage(`cap-${index}`, 100 + index));
    const forged = {
      ...withWorkPolicyEntries(plan, policies.map((_, index) => policyEntry(`cap-${index}`, 100 + index))),
      limits: { ...plan.limits, maxPromptBlocks: 1 },
      workPolicyMessages: policies,
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/message limit/i);
  });

  test("rejects combined provider and phase byte cap plus one", async () => {
    const plan = await compiledAssemblyPlan();
    const providerBytes = plan.providerMessages.reduce((total, message) => total + message.segments.reduce((sum, segment) => sum + (segment.kind === "literal" ? new TextEncoder().encode(segment.text).byteLength : 0), 0), 0);
    const forged = {
      ...withWorkPolicyEntries(plan, [policyEntry("byte-cap")]),
      limits: { ...plan.limits, maxInputBytes: providerBytes },
      workPolicyMessages: [policyMessage("byte-cap")],
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/bytes|limit/i);
  });

  test("binds isolate plans to exact source literals and child coordinates", async () => {
    const { snapshot, plan } = await compiledAssemblyFixture();
    await expect(validateAssemblyPlanAgainstSnapshotV1(plan, snapshot)).resolves.toBeUndefined();
    const blockMessageIndex = plan.providerMessages.findIndex((message) => message.blockIndex !== undefined);
    expect(blockMessageIndex).toBeGreaterThanOrEqual(0);
    const original = plan.providerMessages[blockMessageIndex]!;
    const firstLiteral = original.segments.find((segment) => segment.kind === "literal");
    const forgedText = `${firstLiteral?.text ?? ""} forged literal`;
    const forgedMessages = plan.providerMessages.map((message, index) => index === blockMessageIndex
      ? { ...message, segments: [literalSegment(forgedText)] }
      : message);
    await expect(validateAssemblyPlanAgainstSnapshotV1({ ...plan, messages: forgedMessages, providerMessages: forgedMessages }, snapshot)).rejects.toThrow(/literal|source-bound|seal/i);
    const omitted = plan.providerMessages.filter((_, index) => index !== blockMessageIndex);
    await expect(validateAssemblyPlanAgainstSnapshotV1({ ...plan, messages: omitted, providerMessages: omitted }, snapshot)).rejects.toThrow(/order|source-bound|seal/i);
    if (plan.children.length > 0) {
      const child = plan.children[0]!;
      const forgedChild = { ...child, profileId: `${child.profileId}_forged` };
      const forgedPlan = {
        ...plan,
        children: [forgedChild, ...plan.children.slice(1)],
        childDescriptors: [forgedChild, ...plan.childDescriptors.slice(1)],
        activationEvidence: plan.activationEvidence.map((evidence, index) => index === 0 ? { ...evidence, profileId: forgedChild.profileId } : evidence),
        tokenEvidence: plan.tokenEvidence.map((evidence, index) => index === 0 ? { ...evidence, profileId: forgedChild.profileId } : evidence),
      } as unknown as Parameters<typeof validateAssemblyPlanAgainstSnapshotV1>[0];
      await expect(validateAssemblyPlanAgainstSnapshotV1(forgedPlan, snapshot)).rejects.toThrow(/child|source-bound/i);
    }
  });
  test("binds provider provenance sources and rejects forged provenance", async () => {
    const { snapshot, plan } = await compiledAssemblyFixture();
    const kinds = new Set(plan.providerMessages.map((message) => message.provenance.kind));
    expect(kinds).toEqual(new Set(["block", "history", "world_info"]));
    const withProviderMessages = (providerMessages: typeof plan.providerMessages) => ({
      ...plan,
      messages: providerMessages,
      providerMessages,
    });
    for (const kind of ["block", "history", "world_info"] as const) {
      const index = plan.providerMessages.findIndex((message) => message.provenance.kind === kind);
      expect(index).toBeGreaterThanOrEqual(0);
      const message = plan.providerMessages[index]!;
      const forged = {
        ...message,
        provenance: { ...message.provenance, sourceRevision: `${message.provenance.sourceRevision}-forged` },
      } as typeof message;
      const forgedMessages = plan.providerMessages.map((candidate, candidateIndex) => candidateIndex === index ? forged : candidate);
      await expect(validateAssemblyPlanAgainstSnapshotV1(withProviderMessages(forgedMessages), snapshot)).rejects.toThrow(/source-bound|messages/i);
    }
    const roleIndex = plan.providerMessages.findIndex((message) => message.provenance.kind === "history");
    const roleForged = plan.providerMessages.map((message, candidateIndex) => candidateIndex === roleIndex
      ? { ...message, role: message.role === "user" ? "assistant" as const : "user" as const }
      : message);
    await expect(validateAssemblyPlanAgainstSnapshotV1(withProviderMessages(roleForged), snapshot)).rejects.toThrow(/source-bound|messages|role/i);
    const sourceIndexForged = plan.providerMessages.map((message, candidateIndex) => candidateIndex === roleIndex
      ? ({ ...message, provenance: { ...message.provenance, sourceIndex: message.provenance.sourceIndex + 1 } } as typeof message)
      : message);
    await expect(validateAssemblyPlanAgainstSnapshotV1(withProviderMessages(sourceIndexForged), snapshot)).rejects.toThrow(/source-bound|messages|index/i);
  });
  test("rejects coerced nested snapshot records before preprocessing", async () => {
    const { snapshot } = await compiledAssemblyFixture();
    const forgedMessage = JSON.parse(JSON.stringify(snapshot)) as GenerationAssemblySnapshotV1;
    const forgedMessageRecord = forgedMessage.messages[0] as unknown as Record<string, unknown>;
    forgedMessageRecord.is_user = "false";
    await expect(compileAgentAssemblyPlan(forgedMessage)).rejects.toThrow(/message\[0\]\.is_user/i);
    const forgedBlock = JSON.parse(JSON.stringify(snapshot)) as GenerationAssemblySnapshotV1;
    const forgedBlockRecord = forgedBlock.blocks[0] as unknown as Record<string, unknown>;
    forgedBlockRecord.enabled = "false";
    await expect(compileAgentAssemblyPlan(forgedBlock)).rejects.toThrow(/block\[0\]\.enabled/i);
  });

  test("worker response validation binds a compiled plan to its requested snapshot", async () => {
    const { snapshot, plan } = await compiledAssemblyFixture();
    const job: ActiveIsolateJob<unknown, unknown> = {
      userId: "user-1",
      operation: "compile_agent_assembly",
      payload: { snapshot },
      requestId: "worker-request",
      timeoutMs: 60_000,
      deadlineAt: Date.now() + 60_000,
      resolve: () => undefined,
      reject: () => undefined,
      settled: false,
    };
    const result = { ...plan, version: 1 as const, operation: "compile_agent_assembly" as const, requestId: job.requestId };
    const response = { version: 1 as const, type: "result" as const, requestId: job.requestId, result };
    const malformedMessages = result.providerMessages.map((message) => message.blockId === "consumer"
      ? {
        ...message,
        segments: message.segments.map((segment) => segment.kind === "literal"
          ? { ...segment, text: "forged", bytes: 6 }
          : segment),
      }
      : message);
    const malformed = { ...result, providerMessages: malformedMessages, messages: malformedMessages };
    await expect(parseAgenticPreprocessingResponseV1({ ...response, result: malformed }, job)).rejects.toThrow(/worker_malformed|assembly plan/i);
  });

  test("rejects duplicate phase block references across policy sections", async () => {
    const plan = await compiledAssemblyPlan();
    const entry = policyEntry("duplicate");
    const forged = {
      ...plan,
      loomPolicy: { ...plan.loomPolicy, workPolicy: [entry], workspaceUsage: [entry] },
    };
    expect(() => validateAssemblyPlanV1(forged, plan.limits)).toThrow(/Assembly Loom policy is invalid/i);
  });
  test("rejects malformed worker requests before compile dispatch", async () => {
    expect(() => parseCompileAgentAssemblyRequest({
      version: 1,
      operation: "compile_agent_assembly",
      requestId: "request-1",
      snapshot: {},
      unexpected: true,
    })).toThrow(AssemblyPlanValidationError);
    expect(() => parseCompileAgentAssemblyRequest({
      version: 1,
      operation: "prepare_agent_render",
      requestId: "request-1",
      snapshot: {},
    })).toThrow(AssemblyPlanValidationError);
  });
});
