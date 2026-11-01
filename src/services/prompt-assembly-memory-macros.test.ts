import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";

import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { initMacros } from "../macros";
import { macrosRoutes } from "../routes/macros.routes";
import type { PromptBlock } from "../types/preset";
import { abortChatBackground } from "./chat-background.service";
import { createCharacter } from "./characters.service";
import { createChat, createMessage, updateChat } from "./chats.service";
import { refreshChatMemoryCache } from "./chat-memory-cache.service";
import { createDatabank } from "./databank";
import { clearAllDatabankCache, setCachedDatabankResult } from "./databank/retrieval-cache.service";
import { clearCortexResultCaches, getCortexCacheSnapshot, getCachedCortexResult, getCachedLinkedCortexResult, primeCortexCache, primeLinkedCortexCache, putCortexConfig, type CortexResult } from "./memory-cortex";
import { DEFAULT_CORTEX_CONFIG } from "./memory-cortex/config";
import { recordColorAttribution } from "./memory-cortex/font-attribution";
import { createPreset } from "./presets.service";
import { assemblePrompt, normalizePromptBlockText } from "./prompt-assembly.service";
import { putSetting } from "./settings.service";
import * as embeddingsSvc from "./embeddings.service";

const userId = "memory-macro-user";
const liveContent = "LIVE_USER_MESSAGE";
const workerState = globalThis as { __LUMIVERSE_ASSEMBLY_WORKER?: boolean };
let originalWorkerState: boolean | undefined;
let character: ReturnType<typeof createCharacter>;
let chat: ReturnType<typeof createChat>;
let message: ReturnType<typeof createMessage>;

function block(content: string, overrides: Partial<PromptBlock> = {}): PromptBlock {
  return {
    id: crypto.randomUUID(),
    name: "Context",
    enabled: true,
    role: "system",
    marker: null,
    content,
    position: "pre_history",
    depth: 0,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    ...overrides,
  };
}

function cortexResult(overrides: Partial<CortexResult> = {}): CortexResult {
  return {
    memories: [{
      source: "chunk",
      sourceId: "memory-1",
      content: "CORTEX_MEMORY",
      finalScore: 0.9,
      components: { semantic: 0.9, salience: 0.9, recency: 0.9, reinforcement: 0, emotional: 0, entity: 0 },
      emotionalTags: [],
      entityNames: ["Kael"],
      messageRange: [0, 0],
      timeRange: [0, 0],
    }],
    entityContext: [{
      id: "entity-1",
      name: "Kael",
      type: "character",
      status: "active",
      description: "A traveler",
      lastSeenAt: null,
      mentionCount: 1,
      topFacts: ["ENTITY_FACT"],
      emotionalProfile: {},
      relationships: [],
    }],
    activeRelationships: [{
      sourceName: "Kael",
      targetName: "Mira",
      type: "ally",
      label: "RELATIONSHIP_LABEL",
      strength: 0.8,
      sentiment: 0.8,
    }],
    arcContext: "ARC_CONTEXT",
    stats: {
      candidatePoolSize: 1,
      vectorSearchResults: 1,
      entitiesMatched: 1,
      scoreFusionApplied: true,
      topScore: 0.9,
      retrievalTimeMs: 0,
    },
    ...overrides,
  };
}

function enableCortex(result = cortexResult(), useChatMemoryFormatting = false): void {
  putCortexConfig(userId, { enabled: true, formatterMode: "shadow", useChatMemoryFormatting });
  primeCortexCache(chat.id, result, [message.id]);
}

function enableDatabank(): void {
  putSetting(userId, "embeddingConfig", { enabled: true });
  const bank = createDatabank(userId, { name: "References", scope: "global" });
  setCachedDatabankResult(userId, chat.id, [bank.id], liveContent, 4, {
    chunks: [{
      chunkId: "chunk-1",
      documentId: "document-1",
      databankId: bank.id,
      documentName: "Reference",
      content: "DATABANK_CONTENT",
      score: 1,
      metadata: {},
    }],
    formatted: "[Relevant reference material]\n[Source: Reference]\nDATABANK_CONTENT",
    count: 1,
  });
}

function enableCharacterColors(): void {
  getDb().query(
    "INSERT INTO memory_entities (id, chat_id, name, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
  ).run("entity-1", chat.id, "Kael");
  recordColorAttribution(chat.id, "#abcdef", "entity-1", "speech", null);
  recordColorAttribution(chat.id, "#abcdef", "entity-1", "speech", null);
}

async function assemble(blocks: PromptBlock[] = []) {
  const preset = createPreset(userId, {
    name: "Macro placement",
    provider: "openai",
    prompt_order: [...blocks, block("", { name: "History", marker: "chat_history" })],
  });
  return assemblePrompt({
    userId,
    chatId: chat.id,
    presetOverride: preset,
    generationType: "normal",
    skipPromptRegex: true,
    macroCommit: false,
  });
}

const memoryProbe = "BEGIN\n{{memoriesActive}}\n{{cortexActive}}\n{{memoriesCount}}\n{{memories}}\nRAW:{{memoriesRaw}}\nENTITY:{{entities}}\nEND";

async function expectPreviewMatchesAssembly() {
  const previewBlock = block(memoryProbe);
  const assembled = await assemble([previewBlock]);
  const expected = assembled.breakdown.find(({ blockId }) => blockId === previewBlock.id)?.content;
  expect(expected).toBeDefined();

  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
  app.route("/macros", macrosRoutes);
  const context = {
    chat_id: chat.id,
    prompt_blocks: [previewBlock],
  };
  const single = await app.request("/macros/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...context, template: memoryProbe, prompt_block_id: previewBlock.id, trim: true }),
  });
  expect(single.status).toBe(200);
  expect((await single.json()).text).toBe(expected);

  const batch = await app.request("/macros/resolve-batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...context, templates: { memory: memoryProbe }, prompt_block_ids: { memory: previewBlock.id } }),
  });
  expect(batch.status).toBe(200);
  // Batch resolution preserves whitespace; assembly normalizes each block.
  expect(normalizePromptBlockText((await batch.json()).resolved.memory)).toBe(expected!);
  return expected!;
}

async function enableBasicRecall() {
  putSetting(userId, "embeddingConfig", { enabled: true, vectorize_chat_messages: true });
  putSetting(userId, "chatMemorySettings", {
    quickMode: null,
    exclusionWindow: 5,
    memoryHeaderTemplate: "RECALL[{{memories}}]",
    chunkTemplate: "CHUNK[{{content}}]",
  });
  const insertMessage = getDb().query(
    "INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content) VALUES (?, ?, ?, ?, 'User', ?)",
  );
  for (let i = 0; i < 7; i++) {
    insertMessage.run(crypto.randomUUID(), chat.id, i + 1, i % 2 === 0 ? 1 : 0, `Recent turn ${i}`);
  }
  getDb().query(`INSERT INTO chat_chunks
    (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 4, 1, 0, 0)`)
    .run("basic-memory", chat.id, message.id, message.id, JSON.stringify([message.id]), "BASIC_MEMORY");
  // Pending vectors exercise local SQLite recall without an embedding request.
  await refreshChatMemoryCache(userId, chat.id);
}

beforeEach(async () => {
  const database = initDatabase(":memory:");
  database.run("PRAGMA foreign_keys = OFF");
  database.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  putCortexConfig(userId, DEFAULT_CORTEX_CONFIG);
  initMacros();
  originalWorkerState = workerState.__LUMIVERSE_ASSEMBLY_WORKER;
  workerState.__LUMIVERSE_ASSEMBLY_WORKER = true;
  character = createCharacter(userId, { name: "Character" });
  chat = createChat(userId, { character_id: character.id });
  message = createMessage(chat.id, { is_user: true, name: "User", content: liveContent }, userId);
});

afterEach(async () => {
  await abortChatBackground(userId, chat.id);
  if (originalWorkerState === undefined) delete workerState.__LUMIVERSE_ASSEMBLY_WORKER;
  else workerState.__LUMIVERSE_ASSEMBLY_WORKER = originalWorkerState;
  clearCortexResultCaches();
  clearAllDatabankCache();
  closeDatabase();
});

describe("memory macro placement", () => {
  test("transferred Cortex results retain expiry, chat identity and exclusions", () => {
    enableCortex();
    primeLinkedCortexCache(chat.id, { vaults: [], interlinks: [] });
    const snapshot = structuredClone(getCortexCacheSnapshot(chat.id));
    expect(getCachedCortexResult(chat.id, [message.id], snapshot)).not.toBeNull();
    expect(getCachedCortexResult(chat.id, ["another-target"], snapshot)).toBeNull();
    expect(getCachedCortexResult("another-chat", [], snapshot)).toBeNull();
    expect(getCachedLinkedCortexResult("another-chat", snapshot)).toBeNull();
    snapshot.local!.queriedAt = Date.now() - 6 * 60_000;
    snapshot.linked!.queriedAt = Date.now() - 6 * 60_000;
    expect(getCachedCortexResult(chat.id, [], snapshot)).toBeNull();
    expect(getCachedLinkedCortexResult(chat.id, snapshot)).toBeNull();
    // Rejecting a transferred snapshot must not mutate the source caches.
    expect(getCachedCortexResult(chat.id)).not.toBeNull();
    expect(getCachedLinkedCortexResult(chat.id)).not.toBeNull();
  });

  test("falls back before history when Cortex macros are absent, including with macro-only chat memory", async () => {
    enableCortex();
    const result = await assemble();
    const memoryIndex = result.messages.findIndex(({ content }) => String(content).includes("ENTITY_FACT"));
    const historyIndex = result.messages.findIndex(({ content }) => content === liveContent);
    expect(memoryIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeLessThan(historyIndex);
    expect(result.memoryStats?.injectionMethod).toBe("fallback");
  });

  test.each([false, true])("injects graph-only Cortex context with chat-memory formatting %s", async (useChatMemoryFormatting) => {
    enableCortex(cortexResult({ memories: [] }), useChatMemoryFormatting);
    putSetting(userId, "chatMemorySettings", { injectionStrategy: "fallback" });
    const result = await assemble();
    expect(result.messages.map(({ content }) => content).join("\n")).toContain("ENTITY_FACT");
    expect(result.memoryStats?.chunksRetrieved).toBe(0);
    expect(result.breakdown.filter(({ type }) => type === "long_term_memory")).toHaveLength(1);
  });

  test.each([
    ["{{entities}}", "ENTITY_FACT"],
    ["{{entityFacts::Kael}}", "ENTITY_FACT"],
    ["{{relationships}}", "RELATIONSHIP_LABEL"],
    ["{{arc}}", "ARC_CONTEXT"],
    ["{{memorySalience}}", "CORTEX_MEMORY"],
    ["{{ ENTITIES::1 }}", "ENTITY_FACT"],
  ])("Cortex macro %s owns its placement instead of also falling back", async (macro, expected) => {
    enableCortex();
    putSetting(userId, "chatMemorySettings", { injectionStrategy: "fallback" });
    const result = await assemble([block(`BEGIN ${macro} END`)]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.split(expected)).toHaveLength(2);
    expect(content).toContain("BEGIN");
    expect(result.memoryStats?.injectionMethod).toBe("macro");
    expect(result.breakdown.filter(({ type, excludeFromTotal }) => type === "long_term_memory" && !excludeFromTotal)).toHaveLength(0);
  });

  test.each([
    "{{memories}}",
    "{{memories::1}}",
    "{{memoriesRaw}}",
    "{{longTermMemory}}",
    "{{chatMemory}}",
    "{{ltm}}",
    "{{ MEMORIES }}",
    "{{#memories}}",
    "{{if {{memoriesActive}} = yes}}{{memories}}{{/if}}",
  ])("memory macro %s owns its placement", async (macro) => {
    enableCortex();
    putSetting(userId, "chatMemorySettings", { injectionStrategy: "fallback" });
    const result = await assemble([block(`BEGIN ${macro} END`)]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/CORTEX_MEMORY/g)).toHaveLength(1);
    expect(content).toContain("BEGIN");
    expect(result.memoryStats?.injectionMethod).toBe("macro");
  });

  test.each([
    "{{databank}}",
    "{{databankRaw}}",
    "{{databankRaw::1}}",
    "{{databankMemory}}",
    "{{documents}}",
    "{{knowledgeBank}}",
    "{{ DATABANKRAW }}",
    "{{#databankRaw}}",
    "{{if {{databankActive}} = yes}}{{databankRaw}}{{/if}}",
  ])("databank macro %s owns its placement without a duplicate fallback", async (macro) => {
    enableDatabank();
    const result = await assemble([block(`BEGIN ${macro} END`)]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/DATABANK_CONTENT/g)).toHaveLength(1);
    expect(content).toContain("BEGIN");
    expect(result.databankStats?.injectionMethod).toBe("macro");
    expect(result.breakdown.filter(({ type }) => type === "databank")).toHaveLength(0);
  });

  test.each([
    { enabled: false },
    { injectionTrigger: ["regenerate"] },
    { characterTagTrigger: ["other-character"] },
    { marker: "world_info_before" },
  ] satisfies Partial<PromptBlock>[])("ignored blocks do not suppress fallback: %j", async (overrides) => {
    enableCortex();
    enableDatabank();
    const result = await assemble([block("BEGIN {{entities}} {{databankRaw}} END", overrides)]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content).not.toContain("BEGIN");
    expect(content.match(/ENTITY_FACT/g)).toHaveLength(1);
    expect(content.match(/DATABANK_CONTENT/g)).toHaveLength(1);
    expect(result.memoryStats?.injectionMethod).toBe("fallback");
    expect(result.databankStats?.injectionMethod).toBe("fallback");
  });

  test.each([
    "{{#escape}}{{entities}} {{databankRaw}}{{/escape}}",
    "{{#comment}}{{entities}} {{databankRaw}}{{/comment}}",
    "{{#note}}{{entities}} {{databankRaw}}{{/note}}",
    "\\{\\{entities\\}\\} \\{\\{databankRaw\\}\\}",
    "{{memoriesUnknown}} {{databankRawUnknown}}",
    "{{cortexActive}} {{entityCount}} {{memoriesActive}} {{memoriesCount}} {{databankActive}} {{databankCount}}",
  ])("non-content references do not suppress fallback: %s", async (content) => {
    enableCortex();
    enableDatabank();
    const result = await assemble([block(content)]);
    expect(result.memoryStats?.injectionMethod).toBe("fallback");
    expect(result.databankStats?.injectionMethod).toBe("fallback");
    expect(result.messages.map(({ content }) => content).join("\n")).toContain("DATABANK_CONTENT");
  });

  test.each([false, true])("the memories macro renders graph-only context with formatting %s", async (useChatMemoryFormatting) => {
    enableCortex(cortexResult({ memories: [] }), useChatMemoryFormatting);
    const result = await assemble([block("BEGIN {{if {{memoriesActive}} = yes}}{{memories}}{{/if}} END")]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/ENTITY_FACT/g)).toHaveLength(1);
    expect(content).toContain("BEGIN");
    expect(result.memoryStats?.injectionMethod).toBe("macro");
  });

  test.each([false, true])("fallback includes character colors without chunk memories with formatting %s", async (useChatMemoryFormatting) => {
    enableCortex(cortexResult({ memories: [], entityContext: [], activeRelationships: [], arcContext: null }), useChatMemoryFormatting);
    enableCharacterColors();
    const result = await assemble();
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/#abcdef/g)).toHaveLength(1);
    expect(result.memoryStats?.injectionMethod).toBe("fallback");
  });

  test("characterColors owns its placement", async () => {
    enableCortex();
    enableCharacterColors();
    const result = await assemble([block("BEGIN {{characterColors}} END")]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/#abcdef/g)).toHaveLength(1);
    expect(content).not.toContain("ENTITY_FACT");
    expect(result.memoryStats?.injectionMethod).toBe("macro");
  });

  test("fallback includes linked Cortex even without local chunks", async () => {
    enableCortex(cortexResult({ memories: [], entityContext: [], activeRelationships: [], arcContext: null }));
    primeLinkedCortexCache(chat.id, {
      vaults: [{ vaultId: "vault-1", vaultName: "Linked", entities: cortexResult().entityContext, relations: [] }],
      interlinks: [],
    });
    const result = await assemble();
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/ENTITY_FACT/g)).toHaveLength(1);
    expect(result.memoryStats?.injectionMethod).toBe("fallback");
  });

  test("explicitly disabled memory injection does not fall back to Cortex", async () => {
    enableCortex();
    putSetting(userId, "chatMemorySettings", { injectionStrategy: "disabled" });
    const result = await assemble();
    expect(result.messages.map(({ content }) => content).join("\n")).not.toContain("ENTITY_FACT");
    expect(result.memoryStats?.injectionMethod).toBe("disabled");
  });

  test("empty retrieval does not inject a blank context message", async () => {
    enableCortex(cortexResult({ memories: [], entityContext: [], activeRelationships: [], arcContext: null }));
    const result = await assemble();
    expect(result.messages.map(({ content }) => content)).toEqual([liveContent]);
  });
});

describe("basic recall regeneration", () => {
  async function regenerate(excludeMessageId?: string) {
    const preset = createPreset(userId, {
      name: "Regeneration recall",
      provider: "openai",
      prompt_order: [block("{{memories}}"), block("", { marker: "chat_history" })],
    });
    const result = await assemblePrompt({ userId, chatId: chat.id, presetOverride: preset,
      generationType: "regenerate", excludeMessageId, skipPromptRegex: true, macroCommit: false });
    return { result, content: result.messages.map(({ content }) => content).join("\n") };
  }

  test.each([false, true])("retains old recall when the omitted target is blank: %s", async (blank) => {
    await enableBasicRecall();
    const target = getDb().query<{ id: string }, [string]>("SELECT id FROM messages WHERE chat_id = ? ORDER BY index_in_chat DESC LIMIT 1").get(chat.id)!;
    getDb().query("UPDATE messages SET is_user = 0, content = ? WHERE id = ?").run(blank ? "" : "Reply", target.id);
    const { result, content } = await regenerate(target.id);
    expect(content).toContain("BASIC_MEMORY");
    expect(result.memoryStats?.chunksRetrieved).toBe(1);
  });

  test("rejects a cache when history was actually deleted", async () => {
    await enableBasicRecall();
    const target = getDb().query<{ id: string }, [string]>("SELECT id FROM messages WHERE chat_id = ? ORDER BY index_in_chat DESC LIMIT 1").get(chat.id)!;
    getDb().query("DELETE FROM messages WHERE id = ?").run(target.id);
    const { content } = await regenerate(target.id);
    expect(content).not.toContain("BASIC_MEMORY");
  });

  test("one omitted target cannot mask an additional history deletion", async () => {
    await enableBasicRecall();
    const rows = getDb().query<{ id: string }, [string]>("SELECT id FROM messages WHERE chat_id = ? ORDER BY index_in_chat DESC LIMIT 2").all(chat.id);
    getDb().query("DELETE FROM messages WHERE id = ?").run(rows[1].id);
    const { content } = await regenerate(rows[0].id);
    expect(content).not.toContain("BASIC_MEMORY");
  });

  test("filters a cached chunk that overlaps the newly expanded live tail", async () => {
    await enableBasicRecall();
    // Index 2 is outside the last five messages normally, but moves into that
    // window when regeneration omits index 7. Its cached chunk must then go.
    const boundary = getDb().query<{ id: string }, [string]>("SELECT id FROM messages WHERE chat_id = ? AND index_in_chat = 2").get(chat.id)!;
    getDb().query(`INSERT INTO chat_chunks
      (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at)
      VALUES ('boundary-chunk', ?, ?, ?, ?, 'BOUNDARY_MEMORY', 4, 1, 0, 0)`)
      .run(chat.id, boundary.id, boundary.id, JSON.stringify([boundary.id]));
    await refreshChatMemoryCache(userId, chat.id);
    const normal = await assemble([block("{{memories}}")]);
    expect(normal.messages.map(({ content }) => content).join("\n")).toContain("BOUNDARY_MEMORY");
    const target = getDb().query<{ id: string }, [string]>("SELECT id FROM messages WHERE chat_id = ? ORDER BY index_in_chat DESC LIMIT 1").get(chat.id)!;
    const { content } = await regenerate(target.id);
    expect(content).toContain("BASIC_MEMORY");
    expect(content).not.toContain("BOUNDARY_MEMORY");
  });
});

describe("memory macro previews", () => {
  test("Cortex uses measured distance for the cutoff, independently of rank, in previews and assembly", async () => {
    const base = cortexResult().memories[0];
    const memories = [
      { ...base, content: "CLOSE_DISTANCE_LOW_RANK", vectorDistance: 0.35, finalScore: 0.2 },
      { ...base, sourceId: "far", content: "FAR_DISTANCE_HIGH_RANK", vectorDistance: 0.61, finalScore: 0.99 },
      { ...base, sourceId: "unknown", content: "UNMEASURED_CORTEX_HIT" },
    ];
    enableCortex(cortexResult({ memories }));
    putSetting(userId, "chatMemorySettings", { similarityThreshold: 0.6 });
    const text = await expectPreviewMatchesAssembly();
    expect(text).toContain("CLOSE_DISTANCE_LOW_RANK");
    expect(text).not.toContain("FAR_DISTANCE_HIGH_RANK");
    expect(text).not.toContain("UNMEASURED_CORTEX_HIT");
    // Filtering a prompt must not mutate the cached snapshot. Tightening and
    // relaxing the cutoff can safely reuse its original measured results.
    expect(getCachedCortexResult(chat.id)?.memories).toHaveLength(3);
    putSetting(userId, "chatMemorySettings", { similarityThreshold: 0.3 });
    expect(await expectPreviewMatchesAssembly()).not.toContain("CLOSE_DISTANCE_LOW_RANK");
    putSetting(userId, "chatMemorySettings", { similarityThreshold: 0 });
    expect(await expectPreviewMatchesAssembly()).toContain("FAR_DISTANCE_HIGH_RANK");
  });

  test("an active distance cutoff excludes unmeasured recency fallback", async () => {
    await enableBasicRecall();
    putSetting(userId, "chatMemorySettings", { quickMode: null, exclusionWindow: 5, similarityThreshold: 0.6 });
    await refreshChatMemoryCache(userId, chat.id);
    expect(await expectPreviewMatchesAssembly()).not.toContain("BASIC_MEMORY");
    putSetting(userId, "chatMemorySettings", { quickMode: null, exclusionWindow: 5, similarityThreshold: 0 });
    await refreshChatMemoryCache(userId, chat.id);
    expect(await expectPreviewMatchesAssembly()).toContain("BASIC_MEMORY");
  });

  test.each([0.35, 0.61])("partially indexed chats still search measured memories at distance %s", async (distance) => {
    await enableBasicRecall();
    getDb().query("UPDATE chat_chunks SET vectorized_at = 1 WHERE id = 'basic-memory'").run();
    getDb().query(`INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content,
      token_count, message_count, created_at, updated_at)
      VALUES ('pending', ?, 'unused', 'unused', '["unused"]', 'UNMEASURED_PENDING', 4, 1, 0, 0)`).run(chat.id);
    putSetting(userId, "chatMemorySettings", { quickMode: null, exclusionWindow: 5, similarityThreshold: 0.6 });
    const embedSpy = spyOn(embeddingsSvc, "embedQuery").mockResolvedValue([1, 0]);
    const searchSpy = spyOn(embeddingsSvc, "searchChatChunks").mockResolvedValue([
      { chunk_id: "basic-memory", content: "BASIC_MEMORY", score: distance, metadata: { messageIds: [message.id] } },
    ] as any);
    try {
      await refreshChatMemoryCache(userId, chat.id);
      const text = await expectPreviewMatchesAssembly();
      expect(searchSpy).toHaveBeenCalled();
      expect(text.includes("BASIC_MEMORY")).toBe(distance <= 0.6);
      expect(text).not.toContain("UNMEASURED_PENDING");
    } finally {
      embedSpy.mockRestore(); searchSpy.mockRestore();
    }
  });

  test("a new turn retains usable Cortex context in previews and the assembled prompt", async () => {
    enableCortex(cortexResult({ memories: [] }));
    createMessage(chat.id, { is_user: false, name: "Character", content: "A reply" }, userId);
    createMessage(chat.id, { is_user: true, name: "User", content: "And what happened next?" }, userId);
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nyes\nyes\n0\n");
    expect(text).toContain("ENTITY_FACT");
    const probe = await assemble([block("{{cortexActive}}")]);
    expect(probe.breakdown.find(({ type }) => type === "block")?.content).toBe("yes");
    expect(probe.messages.map(({ content }) => content).join("\n")).toContain("ENTITY_FACT");
  });

  test("saved Cortex graph data is available on a cold cache without a vector query", async () => {
    putCortexConfig(userId, { enabled: true });
    getDb().query("INSERT INTO memory_entities (id, chat_id, name, facts, created_at, updated_at) VALUES (?, ?, 'Kael', ?, 0, 0)")
      .run("saved-entity", chat.id, JSON.stringify(["PERSISTED_FACT"]));
    createMessage(chat.id, { is_user: true, name: "User", content: "What does Kael remember?" }, userId);
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nyes\nyes\n0\n");
    expect(text).toContain("PERSISTED_FACT");
  });

  test.each(["global", "chat", "injection"])("cold graph reads respect the %s opt-out", async (scope) => {
    putCortexConfig(userId, { enabled: true });
    getDb().query("INSERT INTO memory_entities (id, chat_id, name, facts, created_at, updated_at) VALUES (?, ?, 'Kael', ?, 0, 0)")
      .run("saved-entity", chat.id, JSON.stringify(["PERSISTED_FACT"]));
    createMessage(chat.id, { is_user: true, name: "User", content: "What does Kael remember?" }, userId);
    if (scope === "global") putCortexConfig(userId, { enabled: false });
    if (scope === "chat") updateChat(userId, chat.id, { metadata: { cortex_settings: { enabled: false } } });
    if (scope === "injection") putCortexConfig(userId, { retrieval: {
      ...DEFAULT_CORTEX_CONFIG.retrieval, entityContextInjection: false, relationshipInjection: false, arcInjection: false,
    } });
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nno\nno\n0\n");
    expect(text).not.toContain("PERSISTED_FACT");
  });

  test("single and batch previews include basic recall with Cortex off", async () => {
    await enableBasicRecall();
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nyes\nno\n1\n");
    expect(text).toContain("RECALL[CHUNK[BASIC_MEMORY]]");
    expect(text).toContain("RAW:CHUNK[BASIC_MEMORY]");
  });

  test.each([false, true])("previews include warm Cortex recall with chat-memory formatting %s", async (useChatMemoryFormatting) => {
    enableCortex(cortexResult(), useChatMemoryFormatting);
    putSetting(userId, "chatMemorySettings", {
      memoryHeaderTemplate: "RECALL[{{memories}}]",
      chunkTemplate: "CHUNK[{{content}}]",
    });
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nyes\nyes\n1\n");
    expect(text).toContain("CORTEX_MEMORY");
    expect(text).toContain("ENTITY_FACT");
    if (useChatMemoryFormatting) expect(text).toContain("RECALL[CHUNK[CORTEX_MEMORY]]");
  });

  test.each([false, true])("previews include graph-only Cortex context with chat-memory formatting %s", async (useChatMemoryFormatting) => {
    enableCortex(cortexResult({ memories: [] }), useChatMemoryFormatting);
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nyes\nyes\n0\n");
    expect(text).toContain("ENTITY_FACT");
  });

  test("previews include linked memory without local recall", async () => {
    enableCortex(cortexResult({ memories: [], entityContext: [], activeRelationships: [], arcContext: null }));
    primeLinkedCortexCache(chat.id, {
      vaults: [{ vaultId: "vault-1", vaultName: "Linked", entities: cortexResult().entityContext, relations: [] }],
      interlinks: [],
    });
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nyes\nno\n0\n");
    expect(text).toContain("ENTITY_FACT");
  });

  test.each([false, true])("previews include color-only Cortex context with chat-memory formatting %s", async (useChatMemoryFormatting) => {
    enableCortex(cortexResult({ memories: [], entityContext: [], activeRelationships: [], arcContext: null }), useChatMemoryFormatting);
    enableCharacterColors();
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nyes\nyes\n0\n");
    expect(text).toContain("#abcdef");
  });

  test("previews honor disabled memory injection while preserving standalone Cortex macros", async () => {
    enableCortex();
    putSetting(userId, "chatMemorySettings", { injectionStrategy: "disabled" });
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nno\nyes\n1\n\nRAW:\nENTITY:");
    expect(text).not.toContain("CORTEX_MEMORY");
    expect(text).toContain("ENTITY_FACT");
  });

  test("previews honor per-chat basic-memory opt-out", async () => {
    await enableBasicRecall();
    updateChat(userId, chat.id, { metadata: { memory_settings: { enabled: false } } });
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nno\nno\n0\n");
    expect(text).not.toContain("BASIC_MEMORY");
  });

  test("previews ignore warm Cortex results when the chat opts out", async () => {
    await enableBasicRecall();
    enableCortex();
    updateChat(userId, chat.id, { metadata: { cortex_settings: { enabled: false } } });
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nyes\nno\n1\n");
    expect(text).toContain("BASIC_MEMORY");
    expect(text).not.toContain("CORTEX_MEMORY");
  });

  test("previews omit unverified cached chunks while retaining graph context and basic recall", async () => {
    await enableBasicRecall();
    enableCortex();
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nyes\nyes\n1\n");
    expect(text).toContain("BASIC_MEMORY");
    expect(text).toContain("ENTITY_FACT");
    expect(text).not.toContain("CORTEX_MEMORY");
  });

  test("cold Cortex previews use available basic recall", async () => {
    await enableBasicRecall();
    putCortexConfig(userId, { enabled: true });
    const text = await expectPreviewMatchesAssembly();
    expect(text).toStartWith("BEGIN\nyes\nno\n1\n");
    expect(text).toContain("BASIC_MEMORY");
  });
});
