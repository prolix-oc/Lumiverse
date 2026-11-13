import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { buildEnv, initMacros } from "../macros";
import * as chats from "../services/chats.service";
import { createCharacter } from "../services/characters.service";
import { createPreset } from "../services/presets.service";
import { createRegexScript, toggleRegexScript } from "../services/regex-scripts.service";
import { readVariableValues } from "../utils/variable-checkpoint";
import * as active from "../services/generation/active-generation-registry";
import * as pool from "../services/generation-pool.service";
import { eventBus } from "../ws/bus";
import { MessageGenerations } from "./message-generation";
import { WorkerHost } from "./worker-host";

const owners: MessageGenerations[] = [];
let events: Array<{ type: string; payload: any }>;
let emit: ReturnType<typeof spyOn>;
beforeEach(async () => {
  initMacros();
  closeDatabase(); initDatabase(":memory:"); getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  getDb().run("DROP TABLE chat_chunks");
  events = []; emit = spyOn(eventBus, "emit").mockImplementation((type, payload) => { events.push({ type, payload }); });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.dispose();
  active.stopAllGenerations(); pool.clearAllPoolEntries(); emit.mockRestore();
  await Bun.sleep(0); closeDatabase();
});

function fixture(count = 2, pause?: () => Promise<string>) {
  const user = "user";
  const character = createCharacter(user, { name: "Character" });
  const chat = chats.createChatRaw(user, { character_id: character.id, metadata: { chat_variables: { baseline: "keep" } } });
  const owner = new MessageGenerations("extension"); owners.push(owner);
  const presets = Array.from({ length: count }, (_, i) => createPreset(user, { name: `Preset ${i}`, provider: "custom" }));
  const contexts = presets.map((preset, index) => {
    const env = buildEnv({ character, persona: null, chat, messages: [], generationType: "normal", userId: user, commit: false,
      ...(pause ? { dynamicMacros: { pause } } : {}) });
    env.variables.local.set("tone", `T${index}`);
    return { id: owner.remember(user, chat.id, { env, presetId: preset.id, before: readVariableValues(chat.metadata), revision: null,
      model: `prepared-model-${index}`, prefill: "", reasoningPrefill: "", trimIncompleteWords: false }),
      preset: { preset_id: preset.id, variables: { local: { tone: `T${index}` }, global: {}, chat: { baseline: "keep" } } } };
  });
  const message = chats.createMessage(chat.id, { is_user: false, name: character.name, content: "",
    extra: { spindle_metadata: { preset_contexts: contexts.map(c => c.preset) } } }, user);
  chats.updateMessage(user, message.id, { swipes: Array(count).fill(""),
    extra: { spindle_metadata: { preset_contexts: contexts.map(c => c.preset) } }, skipChunkRebuild: true });
  const input = { chatId: chat.id, messageId: message.id, responseContextIds: contexts.map(c => c.id) };
  const begin = () => owner.begin(user, input).id;
  const save = (index: number, content: string, reasoning = "") => {
    const current = chats.getMessage(user, message.id)!;
    chats.updateMessage(user, message.id, { content, contentSwipeId: index, skipChunkRebuild: true });
    chats.setSwipeScopedExtra(user, message.id, index, { reasoning, reasoningDuration: 20 });
    return current;
  };
  return { user, owner, chat, message, presets, contexts, input, begin, save, read: () => chats.getMessage(user, message.id)! };
}

test("message sessions include the prepared model in lifecycle events and recovery", () => {
  const f = fixture();
  const id = f.begin();
  for (const type of ["GENERATION_STARTED", "GENERATION_IN_PROGRESS"]) {
    expect(events.find(event => event.type === type)?.payload).toMatchObject({ generationId: id, model: "prepared-model-0" });
  }
  expect(pool.getPoolEntry(id)?.model).toBe("prepared-model-0");
});

test("completion applies each preset's response rules, native carriers and variables before one selected-reply event", async () => {
  const f = fixture();
  for (const [index, preset] of f.presets.entries()) {
    const script = createRegexScript(f.user, { name: "Response rule", preset_id: preset.id, find_regex: "RAW", replace_string: `P${index}:{{getvar::tone}}`,
      substitute_macros: "after", placement: ["ai_output", "reasoning"], target: ["response"] }, { activePresetId: preset.id });
    if (typeof script === "string") throw new Error(script);
    toggleRegexScript(f.user, script.id, false, { activePresetId: preset.id });
  }
  const id = f.begin();
  for (const index of [0, 1]) {
    const stream = f.owner.bind(f.user, id, index);
    const content = `RAW {{setchatvar::reply::R${index}}}{{getchatvar::reply}}`;
    stream.native({ token: content, reasoning: "native", thinking_blocks: [{ type: "thinking", thinking: "native", signature: `signed-${index}` }], finish_reason: "stop" });
    stream.observe({ token: content, reasoning: "RAW" }); f.save(index, content, "RAW"); stream.end(true);
  }
  chats.cycleSwipe(f.user, f.message.id, "right");
  const [a, b] = await Promise.all([f.owner.finish(id), f.owner.finish(id)]);
  expect(a).toEqual(b); expect(a.completed).toBe(true);
  expect(f.read().swipes).toEqual(["P0:T0 R0", "P1:T1 R1"]);
  expect(f.read().extra.reasoningBySwipe).toEqual(["P0:T0", "P1:T1"]);
  expect(f.read().extra.reasoningCarrierBySwipe[0].blocks[0].signature).toBe("signed-0");
  expect(chats.getChat(f.user, f.chat.id)!.metadata.chat_variables.reply).toBe("R1");
  chats.cycleSwipe(f.user, f.message.id, "left");
  expect(chats.getChat(f.user, f.chat.id)!.metadata.chat_variables.reply).toBe("R0");
  const ended = events.filter(event => event.type === "GENERATION_ENDED");
  expect(ended).toHaveLength(1); expect(ended[0]!.payload.content).toBe("P1:T1 R1");
  expect(active.getActiveChatGeneration(f.user, f.chat.id)).toBeUndefined();
  expect(await f.owner.finish(id)).toEqual(a);
});

test("public message updates save reasoning for parallel swipes without changing selection", async () => {
  const f = fixture(), id = f.begin();
  const host = new WorkerHost("generation-test", { identifier: "generation-test", name: "Generation test" } as any, {
    id: "generation-test", identifier: "generation-test", name: "Generation test", version: "0.0.0",
    permissions: ["chat_mutation"], granted_permissions: ["chat_mutation"], enabled: true,
    metadata: { install_scope: "user", installed_by_user_id: f.user },
  } as any);
  const internal = host as any;
  internal.hasPermission = (permission: string) => permission === "chat_mutation";
  const swipes = ["first", "second"];
  for (const index of [0, 1]) {
    const stream = f.owner.bind(f.user, id, index);
    stream.observe({ token: swipes[index], reasoning: `thought ${index}` });
    stream.end(true);
  }
  try {
    const saved = await new Promise<any>(resolve => {
      internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
      internal.handleMessage({ type: "chat_update_message", requestId: "save", chatId: f.chat.id, messageId: f.message.id,
        patch: { swipes, swipe_reasoning: [{ text: "thought 0" }, { text: "thought 1" }], skipChunkRebuild: true } });
    });
    expect(saved).toMatchObject({ result: true });
    expect(f.read().swipe_id).toBe(0);
    expect((await f.owner.finish(id)).completed).toBe(true);
    expect(f.read().extra.reasoningBySwipe).toEqual(["thought 0", "thought 1"]);
    expect(events.filter(event => event.type === "GENERATION_ENDED")).toHaveLength(1);
  } finally { internal.messageGenerations.dispose(); }
});

test("native Stop cancels every bound stream and waits for their teardown without reporting successful completion", async () => {
  const f = fixture(), id = f.begin();
  const streams = [0, 1].map(index => f.owner.bind(f.user, id, index));
  const completion = active.getActiveGeneration(id)!.completion;
  let settled = false; void completion.then(() => { settled = true; });
  expect(active.stopGeneration(f.user, id)).toBe(true);
  expect(streams.every(stream => stream.signal.aborted)).toBe(true);
  streams[0]!.observe({ token: "", reasoning: "late prefill" });
  expect(pool.getPoolEntry(id)!.status).toBe("stopped");
  await Bun.sleep(0); expect(settled).toBe(false);
  for (const [index, stream] of streams.entries()) { stream.observe({ token: "partial" }); f.save(index, "partial"); stream.end(false); }
  await completion; expect(settled).toBe(true);
  expect((await f.owner.finish(id)).completed).toBe(false);
  expect(events.filter(event => event.type === "GENERATION_STOPPED")).toHaveLength(1);
  expect(events.filter(event => event.type === "GENERATION_ENDED")).toHaveLength(0);
});

test("a failed selected swipe does not trigger completion tools for a successful sibling", async () => {
  const f = fixture(), id = f.begin();
  for (const index of [0, 1]) { const stream = f.owner.bind(f.user, id, index); stream.observe({ token: "text" }); f.save(index, "text"); stream.end(index === 1); }
  expect((await f.owner.finish(id)).completed).toBe(false);
  expect(events.filter(event => event.type === "GENERATION_ENDED")).toHaveLength(0);
});

test("response macros delete owned variables and switching restores the sibling's values", async () => {
  const f = fixture(), id = f.begin();
  for (const [index, content] of ["{{deletechatvar::baseline}}cleared", "unchanged"].entries()) {
    const stream = f.owner.bind(f.user, id, index); stream.observe({ token: content }); f.save(index, content); stream.end(true);
  }
  expect((await f.owner.finish(id)).completed).toBe(true);
  expect(chats.getChat(f.user, f.chat.id)!.metadata.chat_variables.baseline).toBeUndefined();
  chats.cycleSwipe(f.user, f.message.id, "right");
  expect(chats.getChat(f.user, f.chat.id)!.metadata.chat_variables.baseline).toBe("keep");
});

test("worker disposal stops bound requests and releases the native generation after teardown", async () => {
  const f = fixture(), id = f.begin(), stream = f.owner.bind(f.user, id, 0);
  const completion = active.getActiveGeneration(id)!.completion;
  f.owner.dispose(); expect(stream.signal.aborted).toBe(true);
  stream.end(false); await completion;
  expect(active.getActiveChatGeneration(f.user, f.chat.id)).toBeUndefined();
  expect(events.filter(event => event.type === "GENERATION_STOPPED")).toHaveLength(1);
  expect(events.filter(event => event.type === "GENERATION_ENDED")).toHaveLength(0);
});

test("session handles cannot be reused across workers, chats or users", () => {
  const f = fixture();
  expect(() => f.owner.begin("other", f.input)).toThrow();
  const other = new MessageGenerations("other"); owners.push(other);
  expect(() => other.begin(f.user, f.input)).toThrow("expired");
  const id = f.begin();
  expect(() => f.owner.begin(f.user, f.input)).toThrow("already generating");
  expect(() => f.owner.bind("other", id, 0)).toThrow("unavailable");
  expect(() => f.owner.bind(f.user, id, -1)).toThrow();
  const stream = f.owner.bind(f.user, id, 0);
  expect(() => f.owner.bind(f.user, id, 0)).toThrow("already");
  stream.end(false);
});

test.each([false, true])("asynchronous finalization preserves concurrent edits (content edit: %s)", async editContent => {
  let resume!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(1, async () => { entered(); await new Promise<void>(resolve => { resume = resolve; }); return "resolved"; });
  const id = f.begin(), stream = f.owner.bind(f.user, id, 0), content = "{{pause}}{{setchatvar::reply::new}}";
  stream.observe({ token: content }); f.save(0, content); stream.end(true);
  const work = f.owner.finish(id); const observed = work.then(value => ({ value }), error => ({ error }));
  await waiting;
  const message = f.read();
  chats.updateMessage(f.user, message.id, { ...(editContent ? { content: "user edit" } : {}),
    extra: { ...message.extra, spindle_metadata: { ...message.extra.spindle_metadata, other_extension: "keep" } }, skipChunkRebuild: true });
  resume(); const result = await observed;
  expect(f.read().extra.spindle_metadata.other_extension).toBe("keep");
  if (editContent) {
    expect("error" in result).toBe(true); expect(f.read().content).toBe("user edit");
    expect(chats.getChat(f.user, f.chat.id)!.metadata.chat_variables.reply).toBeUndefined();
    await expect(f.owner.finish(id)).rejects.toThrow("changed during response processing");
  } else { expect("value" in result && result.value.completed).toBe(true); expect(f.read().content).toBe("resolved"); }
});

test("editing the already-finalized selected swipe during a sibling's processing prevents completion tools", async () => {
  let resume!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(2, async () => { entered(); await new Promise<void>(resolve => { resume = resolve; }); return "second"; });
  const id = f.begin();
  for (const [index, content] of ["first", "{{pause}}"].entries()) {
    const stream = f.owner.bind(f.user, id, index); stream.observe({ token: content }); f.save(index, content); stream.end(true);
  }
  const work = f.owner.finish(id); await waiting;
  chats.updateMessage(f.user, f.message.id, { content: "user edit", contentSwipeId: 0, skipChunkRebuild: true });
  resume(); expect((await work).completed).toBe(false);
  expect(f.read().swipes).toEqual(["user edit", "second"]);
  expect(events.filter(event => event.type === "GENERATION_ENDED")).toHaveLength(0);
});
