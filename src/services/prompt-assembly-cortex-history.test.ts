import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createCharacter } from "./characters.service";
import { createChat, updateChat } from "./chats.service";
import { clearCortexResultCaches, primeCortexCache, putCortexConfig } from "./memory-cortex";
import { DEFAULT_CORTEX_CONFIG, normalizeCortexConfig } from "./memory-cortex/config";
import { buildCortexHistoryPlan } from "./memory-cortex/history-replacement";
import { getMessages } from "./chats.service";
import { assemblePrompt, isChatHistoryMessage } from "./prompt-assembly.service";
import { putSetting } from "./settings.service";
import type { PromptBlock } from "../types/preset";
import { createPreset } from "./presets.service";
import { refreshChatMemoryCache } from "./chat-memory-cache.service";
import { createRegexScript } from "./regex-scripts.service";

const userId = "cortex-history";
let chat: ReturnType<typeof createChat>;
let workerState: boolean | undefined;
const globalState = globalThis as { __LUMIVERSE_ASSEMBLY_WORKER?: boolean };
const block = (marker: string | null, content = ""): PromptBlock => ({ id: crypto.randomUUID(), name: "Probe", marker,
  content, role: "system", position: "pre_history", depth: 0, enabled: true, isLocked: false,
  color: null, injectionTrigger: [], group: null });

beforeEach(async () => {
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  workerState = globalState.__LUMIVERSE_ASSEMBLY_WORKER;
  globalState.__LUMIVERSE_ASSEMBLY_WORKER = true;
  const character = createCharacter(userId, { name: "Narrator" });
  chat = createChat(userId, { character_id: character.id });
  putCortexConfig(userId, DEFAULT_CORTEX_CONFIG);
  const insert = db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content) VALUES (?, ?, ?, ?, 'Speaker', ?)");
  for (let i = 0; i < 9; i++) insert.run(`m${i}`, chat.id, i, i % 2 === 0 ? 1 : 0, `RAW_TURN_${i}`);
  for (let i = 0; i < 3; i++) {
    const ids = [`m${2 * i}`, `m${2 * i + 1}`];
    db.query(`INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content,
      token_count, message_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 4, 2, 0, 0)`)
      .run(`c${i}`, chat.id, ids[0], ids[1], JSON.stringify(ids), `RAW_CHUNK_${i}`);
    summary(`s${i}`, 1, [`c${i}`], `SCENE_${i}`);
  }
  summary("arc", 2, ["s0", "s1"], "ARC_SUMMARY");
});
afterEach(() => {
  clearCortexResultCaches();
  if (workerState === undefined) delete globalState.__LUMIVERSE_ASSEMBLY_WORKER;
  else globalState.__LUMIVERSE_ASSEMBLY_WORKER = workerState;
  closeDatabase();
});

function summary(id: string, tier: number, sources: string[], content: string) {
  getDb().query(`INSERT INTO memory_consolidations (id, chat_id, tier, summary, source_chunk_ids,
    source_consolidation_ids, message_range_start, message_range_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1700000000, 1700000100, 0, 0)`)
    .run(id, chat.id, tier, content, JSON.stringify(tier === 1 ? sources : []), JSON.stringify(tier === 2 ? sources : []));
}
function config(scenes = true, arcs = true) {
  return putCortexConfig(userId, { enabled: true, replaceConsolidatedMessagesInContext: scenes, replaceArcSummariesInContext: arcs });
}
function plan(scenes = true, arcs = true) {
  return buildCortexHistoryPlan(chat.id, getMessages(userId, chat.id), config(scenes, arcs));
}
async function assemble(options: Partial<Parameters<typeof assemblePrompt>[0]> = {}, macros = "{{memories}}\n{{arc}}") {
  return assemblePrompt({ userId, chatId: chat.id, generationType: "normal", macroCommit: false,
    presetOverride: createPreset(userId, { name: "History", provider: "openai", prompt_order: [block(null, macros), block("chat_history")] }),
    ...options });
}
const text = (result: Awaited<ReturnType<typeof assemble>>) => JSON.stringify(result.messages);

test("replacement flags default off and require explicit boolean true", () => {
  for (const value of [undefined, null, false, "true", "false", 0, 1, {}, true]) {
    const normalized = normalizeCortexConfig({ replaceConsolidatedMessagesInContext: value, replaceArcSummariesInContext: value } as any);
    expect(normalized.replaceConsolidatedMessagesInContext).toBe(value === true);
    expect(normalized.replaceArcSummariesInContext).toBe(value === true);
  }
});

test.each([[false, false, []], [true, false, ["s0", "s1", "s2"]], [false, true, ["arc"]], [true, true, ["arc", "s2"]]] as const)(
  "selects a nonoverlapping hierarchy for scenes=%s, arcs=%s", (scenes, arcs, expected) => {
    expect([...plan(scenes, arcs).replacements.values()].map((s) => s.consolidationId)).toEqual([...expected]);
  });

test("assembles ordered summaries with final source roles and preserves saved history", async () => {
  config();
  const result = await assemble();
  const history = result.messages.filter(isChatHistoryMessage);
  expect(history.map((m) => m.role)).toEqual(["assistant", "assistant", "user", "assistant", "user"]);
  expect(history[0].content).toContain("ARC_SUMMARY");
  expect(history[1].content).toContain("SCENE_2");
  expect(history.slice(2).map((m) => m.content)).toEqual(["RAW_TURN_6", "RAW_TURN_7", "RAW_TURN_8"]);
  expect(text(result)).not.toContain("SCENE_0");
  expect(getMessages(userId, chat.id).map((m) => m.content)).toEqual(Array.from({ length: 9 }, (_, i) => `RAW_TURN_${i}`));
});

test("a user endpoint remains a separate recap before the next user turn", async () => {
  getDb().query("UPDATE messages SET is_user = 1 WHERE id = 'm5'").run();
  config();
  const history = (await assemble()).messages.filter(isChatHistoryMessage);
  expect(history[1].role).toBe("user");
  expect(history[1].content).toContain("SCENE_2");
  expect(history[2].content).toBe("RAW_TURN_6");
});

test("summary text stays literal through macro and keep-only context filters", async () => {
  getDb().query("UPDATE memory_consolidations SET summary = 'Remember {{setvar::loop::BAD}}{{user}} <thinking>past</thinking>' WHERE id = 'arc'").run();
  putSetting(userId, "reasoningSettings", { prefix: "<thinking>", suffix: "</thinking>", keepInHistory: 0 });
  putSetting(userId, "contextFilters", { detailsBlocks: { enabled: true, keepOnly: true, keepDepth: 0 } });
  config();
  const result = await assemble();
  expect(text(result)).toContain("{{setvar::loop::BAD}}{{user}} <thinking>past</thinking>");
  expect(result.macroEnv?.variables.chat.get("loop")).toBeUndefined();
});

test("prompt regex applies to live turns while preserving recap boundaries and content", async () => {
  createRegexScript(userId, { name: "Prompt rewrite", find_regex: "ARC_SUMMARY|RAW_TURN_8", replace_string: "REGEX_TOUCHED",
    flags: "g", target: ["prompt"], placement: ["user_input", "ai_output"] });
  config();
  const result = await assemble();
  expect(text(result)).toContain("ARC_SUMMARY");
  expect(text(result)).toContain("REGEX_TOUCHED");
  expect(text(result)).not.toContain("RAW_TURN_8");
});

test.each(["missing-chunk", "missing-message", "hidden", "gap", "bad-json", "foreign", "cycle", "linked-tail"])(
  "skips incomplete provenance: %s", (kind) => {
    if (kind === "missing-chunk") getDb().query("DELETE FROM chat_chunks WHERE id = 'c0'").run();
    if (kind === "missing-message") getDb().query("DELETE FROM messages WHERE id = 'm0'").run();
    if (kind === "hidden") getDb().query("UPDATE messages SET extra = '{\"hidden\":true}' WHERE id = 'm0'").run();
    if (kind === "gap") getDb().query("UPDATE chat_chunks SET message_ids = '[\"m0\",\"m2\"]' WHERE id = 'c0'").run();
    if (kind === "bad-json") getDb().query("UPDATE chat_chunks SET message_ids = 'garbage' WHERE id = 'c0'").run();
    if (kind === "foreign") getDb().query("UPDATE chat_chunks SET chat_id = 'foreign' WHERE id = 'c0'").run();
    if (kind === "cycle") getDb().query("UPDATE memory_consolidations SET source_consolidation_ids = '[\"arc\"]' WHERE id = 'arc'").run();
    if (kind === "linked-tail") getDb().query("UPDATE chat_chunks SET consolidation_id = 's0' WHERE id = 'c2'").run();
    const replacements = [...plan().replacements.values()].map((s) => s.consolidationId);
    expect(replacements).not.toContain("arc");
    if (kind !== "cycle") expect(replacements).not.toContain("s0");
  });

test("latest turn and anchored spans cannot be replaced", async () => {
  summary("live", 1, ["live-chunk"], "LIVE_SUMMARY");
  getDb().query(`INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content,
    token_count, message_count, created_at, updated_at) VALUES ('live-chunk', ?, 'm6', 'm8', '["m6","m7","m8"]', 'live', 4, 3, 0, 0)`).run(chat.id);
  expect(plan().replacements.has("m8")).toBe(false);
  updateChat(userId, chat.id, { metadata: { context_history_anchor_message_id: "m2" } });
  const history = (await assemble()).messages.filter(isChatHistoryMessage);
  expect(history[0].content).toBe("RAW_TURN_2");
  expect(JSON.stringify(history)).not.toContain("summary");
});

test("message limits and regeneration use only complete selected spans", async () => {
  config();
  putSetting(userId, "summarization", { messageLimitEnabled: true, messageLimitCount: 6 });
  let history = (await assemble()).messages.filter(isChatHistoryMessage);
  expect(history[0].content).toBe("RAW_TURN_3");
  expect(history[1].content).toContain("SCENE_2");
  expect(JSON.stringify(history)).not.toContain("ARC_SUMMARY");
  putSetting(userId, "summarization", { messageLimitEnabled: false });
  history = (await assemble({ generationType: "regenerate", excludeMessageId: "m3" })).messages.filter(isChatHistoryMessage);
  expect(history[0].content).toContain("SCENE_0");
  expect(JSON.stringify(history)).not.toContain("ARC_SUMMARY");
  expect(JSON.stringify(history)).not.toContain("SCENE_1");
});

test("an explicit assistant continuation stays verbatim even when it is not the last stored turn", async () => {
  config();
  const result = await assemble({ generationType: "continue", continueMessageId: "m3" });
  expect(text(result)).toContain("RAW_TURN_3");
  expect(text(result)).not.toContain("ARC_SUMMARY");
  expect(text(result)).toContain("SCENE_0");
  expect(text(result)).toContain("SCENE_2");
});

test.each(["global", "chat", "temporary"])("%s opt-out keeps raw history", async (scope) => {
  config();
  if (scope === "global") putCortexConfig(userId, { enabled: false });
  else updateChat(userId, chat.id, { metadata: scope === "temporary" ? { temporary: true } : { cortex_settings: { enabled: false } } });
  const history = (await assemble()).messages.filter(isChatHistoryMessage);
  expect(history).toHaveLength(9);
  expect(JSON.stringify(history)).not.toContain("historical recap");
});

test("replacement is independent of macro/fallback injection and works without a preset", async () => {
  config();
  putSetting(userId, "chatMemorySettings", { injectionStrategy: "disabled" });
  expect(text(await assemble())).toContain("ARC_SUMMARY");
  const result = await assemble({ presetOverride: createPreset(userId, { name: "Legacy", provider: "openai", prompt_order: [] }) });
  expect(text(result)).toContain("ARC_SUMMARY");
  expect(text(result)).not.toContain("RAW_TURN_0");
});

test("local recall and arc macros do not repeat replaced sources", async () => {
  config();
  putSetting(userId, "embeddingConfig", { enabled: true, vectorize_chat_messages: true });
  await refreshChatMemoryCache(userId, chat.id);
  primeCortexCache(chat.id, { memories: [{ source: "consolidation", sourceId: "s0", content: "DUPLICATE_SCENE",
    finalScore: 1, components: { semantic: 1, salience: 0, recency: 0, reinforcement: 0, emotional: 0, entity: 0 },
    emotionalTags: [], entityNames: [], messageRange: [0, 1], timeRange: [0, 0] }],
    entityContext: [], activeRelationships: [], arcContext: "DUPLICATE_ARC",
    stats: { candidatePoolSize: 1, vectorSearchResults: 1, entitiesMatched: 0, scoreFusionApplied: true, topScore: 1, retrievalTimeMs: 0 },
  }, ["m4", "m5", "m6", "m7", "m8"]);
  const result = await assemble();
  expect(text(result)).not.toContain("DUPLICATE");
  expect(text(result)).not.toContain("RAW_CHUNK");
  expect(text(result).match(/ARC_SUMMARY/g)).toHaveLength(1);
});
