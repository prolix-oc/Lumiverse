import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { getProvider } from "../llm/registry";
import type { GenerationRequest, LlmMessage } from "../llm/types";
import { chatsRoutes } from "../routes/chats.routes";
import type { Chat } from "../types/chat";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as chats from "./chats.service";
import * as connections from "./connections.service";
import * as pool from "./generation-pool.service";
import * as presets from "./presets.service";
import * as secrets from "./secrets.service";
import * as settings from "./settings.service";
import * as assemblyWorker from "./prompt-assembly-worker-client";
import { dryRunGeneration, startGeneration, stopAllGenerations, stopGenerationSweep } from "./generate.service";

const USER = "no-preset-generation-test";
const SYSTEM_MARKER = "PRESET_SYSTEM_MUST_NOT_LEAK";
const POSTFIX_MARKER = "PRESET_POSTFIX_MUST_NOT_LEAK";
const requests: Pick<GenerationRequest, "messages" | "parameters">[] = [];
const ended: any[] = [];
const spies: Array<{ mockRestore(): void }> = [];
let connectionId: string;
let presetId: string;

beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  spies.push(spyOn(secrets, "getSecret").mockResolvedValue("test-key"));
  // Exercise real prefetch/assembly against this test's in-memory database.
  spies.push(spyOn(assemblyWorker, "canUsePromptAssemblyWorker").mockReturnValue(false));
  spies.push(spyOn(eventBus, "emit").mockImplementation((type, payload) => {
    if (type === EventType.GENERATION_ENDED) ended.push(payload);
  }));
  spies.push(spyOn(getProvider("openai")!, "generateStream").mockImplementation(async function* (_key, _url, request) {
    requests.push(structuredClone({ messages: request.messages, parameters: request.parameters }));
    yield { token: "Reply.", finish_reason: "stop" };
  }));

  const preset = presets.createPreset(USER, {
    name: "Globally selected and connection-bound preset",
    provider: "openai",
    parameters: { samplerOverrides: { enabled: true, temperature: 0.123 } },
    prompts: { completionSettings: { continuePostfix: POSTFIX_MARKER } },
    prompt_order: [{
      id: "main", name: "Main", content: SYSTEM_MARKER, role: "system", enabled: true,
      position: "pre_history", depth: 0, marker: null, isLocked: false, color: null,
      injectionTrigger: [], group: null,
    }, {
      id: "history", name: "Chat History", content: "", role: "system", enabled: true,
      position: "pre_history", depth: 0, marker: "chat_history", isLocked: false,
      color: null, injectionTrigger: [], group: null,
    }],
  });
  presetId = preset.id;
  settings.putSetting(USER, "activeLoomPresetId", presetId);
  connectionId = (await connections.createConnection(USER, {
    name: "Test connection", provider: "openai", model: "test-model",
    api_url: "https://example.test", preset_id: presetId,
  })).id;
});

afterAll(async () => {
  stopAllGenerations();
  await Bun.sleep(10);
  stopGenerationSweep();
  pool.stopPoolSweep();
  pool.clearAllPoolEntries();
  for (const spy of spies.reverse()) spy.mockRestore();
  closeDatabase();
});

async function createChat(noPreset = true): Promise<Chat> {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", USER); await next(); });
  app.route("/chats", chatsRoutes);
  const response = await app.request("/chats/temporary", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ no_preset: noPreset }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function generate(chatId: string, generationType: "normal" | "continue" | "regenerate" | "swipe" = "normal", explicitMessages = false) {
  const result = await startGeneration({
    userId: USER, chat_id: chatId, connection_id: connectionId, generation_type: generationType,
    // Stale clients can still submit the globally selected preset explicitly.
    preset_id: presetId, force_preset_id: true,
    ...(explicitMessages ? { messages: [{ role: "user" as const, content: "Explicit request." }] } : {}),
  });
  const deadline = Date.now() + 3000;
  while (!ended.some((event) => event.generationId === result.generationId) && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  const event = ended.find((event) => event.generationId === result.generationId);
  expect(event).toBeDefined();
  expect(event.error).toBeUndefined();
  return chats.getMessage(USER, event.messageId)!;
}

test("No Preset stays raw across later messages, regenerate, swipe, and Continue", async () => {
  const chat = await createChat();
  const firstRequest = requests.length;
  for (const content of ["First message", "Second message"]) {
    chats.createMessage(chat.id, { is_user: true, name: "User", content }, USER);
    await generate(chat.id);
  }
  await generate(chat.id, "regenerate");
  await generate(chat.id, "swipe");
  const continued = await generate(chat.id, "continue");

  expect(continued.content).toBe("Reply.Reply.");
  expect(chats.getChat(USER, chat.id)?.metadata).toMatchObject({ temporary: true, no_preset: true });
  const captured = requests.slice(firstRequest);
  expect(captured).toHaveLength(5);
  expect(JSON.stringify(captured[1].messages)).toContain("First message");
  expect(JSON.stringify(captured[1].messages)).toContain("Second message");
  for (const request of captured) {
    expect(JSON.stringify(request.messages)).not.toContain(SYSTEM_MARKER);
    expect(JSON.stringify(request.messages)).not.toContain(POSTFIX_MARKER);
    expect(request.parameters?.temperature).toBeUndefined();
  }

  const preview = await dryRunGeneration({
    userId: USER, chat_id: chat.id, connection_id: connectionId,
    preset_id: presetId, force_preset_id: true, generation_type: "continue",
  });
  expect(JSON.stringify(preview.messages)).not.toContain(SYSTEM_MARKER);
  expect(JSON.stringify(preview.messages)).not.toContain(POSTFIX_MARKER);
  expect(preview.parameters.temperature).toBeUndefined();
});

test("No Preset explicit-message generations do not record a connection preset", async () => {
  const chat = await createChat();
  const message = await generate(chat.id, "normal", true);
  // Metrics are persisted by post-generation work after the terminal event.
  const deadline = Date.now() + 3000;
  while (!chats.getMessage(USER, message.id)?.extra.generationMetrics && Date.now() < deadline) await Bun.sleep(5);
  const metrics = chats.getMessage(USER, message.id)?.extra.generationMetrics;
  expect(metrics).toBeDefined();
  expect(metrics.presetId).toBeUndefined();
  expect(metrics.presetName).toBeUndefined();
});

test("temporary chats with a preset still apply its blocks, sampler, and Continue postfix", async () => {
  const chat = await createChat(false);
  chats.createMessage(chat.id, { is_user: true, name: "User", content: "First message" }, USER);
  await generate(chat.id);
  const request = requests.at(-1)!;
  expect(JSON.stringify(request.messages)).toContain(SYSTEM_MARKER);
  expect(request.parameters?.temperature).toBe(0.123);
  const continued = await generate(chat.id, "continue");
  expect(continued.content).toBe(`Reply.${POSTFIX_MARKER}Reply.`);
});

test("dry runs omit disabled penalty overrides while preserving enabled values", async () => {
  const chat = await createChat();
  for (const repetitionPenalty of [0, 1]) {
    const parameters = { repetition_penalty: repetitionPenalty, frequency_penalty: 0, presence_penalty: 1, seed: 0 };
    const preview = await dryRunGeneration({
      userId: USER, chat_id: chat.id, connection_id: connectionId,
      messages: [{ role: "user", content: "Hello" }],
      parameters,
    });

    expect(preview.parameters).not.toHaveProperty("repetition_penalty");
    expect(preview.parameters).not.toHaveProperty("frequency_penalty");
    expect(preview.parameters.presence_penalty).toBe(1);
    expect(preview.parameters.seed).toBe(0);
    expect(parameters.repetition_penalty).toBe(repetitionPenalty);
  }
});

test("dry runs preserve media, tool parts and reasoning only when opted in", async () => {
  const chat = await createChat();
  const messages: LlmMessage[] = [{
    role: "assistant",
    content: [
      { type: "text", text: "Answer", thought_signature: "text-signature" },
      { type: "image", data: "aW1hZ2U=", mime_type: "image/png" },
      { type: "audio", data: "YXVkaW8=", mime_type: "audio/wav" },
      { type: "video", data: "dmlkZW8=", mime_type: "video/mp4" },
      { type: "tool_use", id: "call", name: "lookup", input: { query: "test" } },
    ],
    reasoning_content: "Thought",
    thinking_blocks: [{ type: "thinking", thinking: "Thought", signature: "signature" }],
    reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }],
    thought_signature: "message-signature",
  }, {
    role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "Found" }],
  }];
  const original = structuredClone(messages);
  const input = { userId: USER, chat_id: chat.id, connection_id: connectionId, messages };
  const requestCount = requests.length;
  const preview = await dryRunGeneration({ ...input, include_request_messages: true });
  expect(preview.request_messages).toEqual(original);
  expect(preview.messages[0].content).toContain("[image: image/png]");
  expect(preview.messages[0].content).toContain("[tool_call: lookup");
  expect(typeof preview.messages[0].content).toBe("string");
  for (const optIn of [undefined, false]) {
    const displayOnly = await dryRunGeneration({ ...input, include_request_messages: optIn });
    expect(Object.hasOwn(displayOnly, "request_messages")).toBe(false);
    expect(displayOnly.messages).toEqual(preview.messages);
  }
  expect(messages).toEqual(original);
  expect(requests.length).toBe(requestCount);
});

test("dry runs retain the assembled assistant prefix and native partial marker", async () => {
  const chat = await createChat(false);
  const preset = presets.createPreset(USER, {
    name: "Prepared prefix", provider: "openai",
    prompts: { completionSettings: { assistantPrefill: "Prefix" } },
    prompt_order: presets.getPreset(USER, presetId)!.prompt_order,
  });
  chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello" }, USER);
  const preview = await dryRunGeneration({
    userId: USER, chat_id: chat.id, connection_id: connectionId,
    preset_id: preset.id, force_preset_id: true, include_request_messages: true,
  });
  expect(preview.request_messages?.at(-1)).toMatchObject({ role: "assistant", content: "Prefix", partial: true });
  expect(preview.assistantPrefill).toBe("Prefix");
});

test("dry runs reject non-boolean request-message opt-ins before assembly", async () => {
  for (const value of [null, "true", 1, {}, []]) {
    await expect(dryRunGeneration({
      userId: USER, chat_id: "missing", include_request_messages: value as boolean,
    })).rejects.toThrow("include_request_messages must be a boolean");
  }
});
