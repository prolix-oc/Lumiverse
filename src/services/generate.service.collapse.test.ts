import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { LlmMessage } from "../llm/types";
import type { PromptBlock } from "../types/preset";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { interceptorPipeline } from "../spindle/interceptor-pipeline";
import { getSourceIndexInChat, getSourceMessageId, isChatHistoryMessage } from "./prompt-assembly.service";
import { dryRunGeneration, stopGenerationSweep } from "./generate.service";
import * as assemblyWorker from "./prompt-assembly-worker-client";
import * as characters from "./characters.service";
import * as chats from "./chats.service";
import * as connections from "./connections.service";
import * as presets from "./presets.service";

const userId = "collapse-interceptor-test";
const extensionId = "collapse-interceptor";
let workerSpy: ReturnType<typeof spyOn>;
let connectionId: string;

beforeAll(async () => {
  workerSpy = spyOn(assemblyWorker, "canUsePromptAssemblyWorker").mockReturnValue(false);
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  connectionId = (await connections.createConnection(userId, {
    name: "Collapse fixture", provider: "custom", model: "test-model", api_url: "https://example.test",
  })).id;
});

afterEach(() => interceptorPipeline.unregisterByExtension(extensionId));
afterAll(() => { workerSpy.mockRestore(); stopGenerationSweep(); closeDatabase(); });

function block(overrides: Partial<PromptBlock>): PromptBlock {
  return { id: crypto.randomUUID(), name: "Block", content: "", role: "system", enabled: true,
    position: "pre_history", depth: 0, marker: null, isLocked: false, color: null,
    injectionTrigger: [], group: null, ...overrides };
}

function fixture(collapseMessages: boolean) {
  const character = characters.createCharacter(userId, { name: "Fixture" });
  const chat = chats.createChat(userId, { character_id: character.id });
  const old = chats.createMessage(chat.id, { is_user: false, name: "Fixture", content: "OLD_RAW" }, userId);
  const recent = chats.createMessage(chat.id, { is_user: true, name: "User", content: "RECENT_RAW" }, userId);
  const preset = presets.createPreset(userId, {
    name: "Collapse fixture", provider: "custom",
    parameters: { samplerOverrides: { enabled: true, contextSize: 8192, maxTokens: 200 } },
    prompts: { advancedSettings: { collapseMessages } },
    prompt_order: [block({ content: "INSTRUCTIONS" }), block({ name: "History", marker: "chat_history" })],
  });
  return { old, recent, chat, preset, input: { userId, chat_id: chat.id, connection_id: connectionId,
    preset_id: preset.id, force_preset_id: true } };
}

for (const collapse of [false, true]) test(`interceptors replace identified history before collapse=${collapse}`, async () => {
  const { old, recent, input } = fixture(collapse);
  let calls = 0;
  interceptorPipeline.register({ extensionId, priority: 90, handler: async (messages) => {
    calls++;
    const history = (messages as LlmMessage[]).filter(isChatHistoryMessage);
    expect(history.map(getSourceMessageId)).toEqual([old.id, recent.id]);
    expect(history.map(getSourceIndexInChat)).toEqual([old.index_in_chat, recent.index_in_chat]);
    const out = messages.map(message => getSourceMessageId(message as LlmMessage) === old.id
      ? { role: "assistant" as const, content: "SUMMARY" } : message);
    out.push({ role: "system", content: "EXTENSION_TAIL" });
    return { messages: out, breakdown: [{ messageIndex: 1, name: "Saved chapter", role: "assistant",
      content: "SUMMARY", extensionId, extensionName: "Fixture" }] };
  } });
  const result = await dryRunGeneration(input);
  expect(calls).toBe(1);
  const contents = ["INSTRUCTIONS", "SUMMARY", "RECENT_RAW", "EXTENSION_TAIL"];
  expect(result.messages.map(message => message.content)).toEqual(collapse ? [contents.join("\n\n")] : contents);
  expect(result.messages.map(message => message.role)).toEqual(collapse ? ["user"] : ["system", "assistant", "user", "system"]);
  expect(result.breakdown.some(entry => entry.name === "Saved chapter" && entry.content === "SUMMARY")).toBe(true);
  expect(chats.getMessage(userId, old.id)?.content).toBe("OLD_RAW");
});

test("collapse preserves multimodal parts and edits made by the last interceptor", async () => {
  const { input } = fixture(true);
  const image = { type: "image" as const, mime_type: "image/png", data: "fixture-image" };
  interceptorPipeline.register({ extensionId, priority: 200, handler: async messages => ({
    messages: [...messages, { role: "user", content: [{ type: "text", text: "IMAGE_CAPTION" }, image] }],
  }) });
  const result = await dryRunGeneration(input);
  expect(result.messages).toEqual([{ role: "user",
    content: "INSTRUCTIONS\n\nOLD_RAW\n\nRECENT_RAW\n\nIMAGE_CAPTION\n[image: image/png]",
    contentParts: [{ type: "image", count: 1 }],
  }]);
});

test("explicit message callers do not inherit the preset collapse option", async () => {
  const { input } = fixture(true);
  const messages = [{ role: "system", content: "Explicit system" }, { role: "user", content: "Explicit user" }] satisfies LlmMessage[];
  expect((await dryRunGeneration({ ...input, messages })).messages).toEqual(messages);
});

for (const generationType of ["continue", "regenerate"] as const) test(`collapse preserves ${generationType} history selection`, async () => {
  const { chat, old, recent, input } = fixture(true);
  const target = chats.createMessage(chat.id, { is_user: false, name: "Fixture", content: "CONTINUATION_TARGET" }, userId);
  let called = false;
  interceptorPipeline.register({ extensionId, priority: 90, handler: async messages => {
    called = true;
    expect((messages as LlmMessage[]).filter(isChatHistoryMessage).map(getSourceMessageId)).toEqual([old.id, recent.id]);
    return { messages };
  } });
  const result = await dryRunGeneration({ ...input, generation_type: generationType, exclude_message_id: generationType === "regenerate" ? target.id : undefined });
  expect(called).toBe(true);
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0].role).toBe("user");
  expect(result.messages[0].content.split("CONTINUATION_TARGET").length - 1).toBe(generationType === "continue" ? 1 : 0);
});
