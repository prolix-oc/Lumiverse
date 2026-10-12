import { registerFrontendSession } from "../spindle/frontend-session";
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { contextHandlerChain } from '../spindle/context-handler';
import { interceptorPipeline } from '../spindle/interceptor-pipeline';
import { INTERNAL_PRESET_METADATA_KEY } from '../spindle/preset-metadata-context';
import * as chats from "./chats.service";
import * as connections from "./connections.service";
import * as secrets from "./secrets.service";
import * as settings from "./settings.service";
import * as pool from "./generation-pool.service";
import * as presets from "./presets.service";
import * as tokenizer from "./tokenizer.service";
import * as regexScripts from "./regex-scripts.service";
import { dryRunGeneration, startGeneration, stopAllGenerations, stopGenerationSweep } from "./generate.service";

const userId = "provider-outcomes-test";
const ended: any[] = [];
const metricsReady: any[] = [];
const origins: Array<{ chatId: string; phase: string; session: unknown }> = [];
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let secretSpy: ReturnType<typeof spyOn>;
let eventSpy: ReturnType<typeof spyOn>;
let removeFrontend: () => void;
beforeAll(async () => {
  removeFrontend = registerFrontendSession(userId, "0123456789abcdef0123456789abcdef", { send() {}, close() {}, closed() {} });
  contextHandlerChain.register({ extensionId: 'origin-test', priority: 100, handler: async (context: any) => {
    origins.push({ chatId: context.chatId, phase: 'context', session: context.frontendSessionId }); return context;
  } });
  interceptorPipeline.register({ extensionId: 'origin-test', priority: 100, handler: async (messages, context: any) => {
    origins.push({ chatId: context.chatId, phase: 'interceptor', session: context.frontendSessionId }); return { messages };
  } });
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("test-key");
  eventSpy = spyOn(eventBus, "emit").mockImplementation((type, payload) => {
    if (type === EventType.GENERATION_ENDED) ended.push(payload);
    if (type === EventType.GENERATION_METRICS_READY) metricsReady.push(payload);
  });
});
afterEach(async () => {
  await Bun.sleep(5);
  fetchSpy?.mockRestore();
  secretSpy.mockResolvedValue('test-key');
  settings.deleteSetting(userId, "reasoningSettings");
});
afterAll(() => {
  removeFrontend();
  contextHandlerChain.unregisterByExtension('origin-test'); interceptorPipeline.unregisterByExtension('origin-test');
  stopAllGenerations(); stopGenerationSweep(); pool.stopPoolSweep(); pool.clearAllPoolEntries();
  secretSpy.mockRestore(); eventSpy.mockRestore(); closeDatabase();
});

async function run(provider: string, body: object[], options: { responses?: boolean; nonStreaming?: boolean; presetName?: string; presetMetadata?: Record<string, unknown>; chunkDelayMs?: number; assistantPrefill?: string } = {}) {
  const connection = await connections.createConnection(userId, {
    name: "Mock", provider, model: "test-model", api_url: "https://example.test",
  });
  const preset = options.presetName
    ? presets.createPreset(userId, {
        name: options.presetName,
        provider,
        prompt_order: options.assistantPrefill ? [{
          id: "main", name: "Main", content: "Be brief.", role: "system", enabled: true, position: "pre_history",
          depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null,
        }] : [],
        ...(options.assistantPrefill ? { prompts: { completionSettings: { assistantPrefill: options.assistantPrefill } } } : {}),
        ...(options.presetMetadata ? { metadata: options.presetMetadata } : {}),
      })
    : null;
  const chat = chats.createChat(userId, {
    character_id: null,
    name: "Test",
    metadata: { temporary: true, ...(preset ? {} : { no_preset: true }) },
  });
  chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello." }, userId);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => options.nonStreaming
    ? Response.json(body[0])
    : options.chunkDelayMs
      ? new Response(new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            for (const [index, chunk] of body.entries()) {
              if (index > 0 && options.chunkDelayMs) await Bun.sleep(options.chunkDelayMs);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.close();
          },
        }))
      : new Response(body.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""))) as unknown as typeof fetch);
  const result = await startGeneration({
    userId, chat_id: chat.id, connection_id: connection.id, generation_type: "normal",
    ...(preset ? { preset_id: preset.id } : {}),
    parameters: { ...(options.responses ? { use_responses_api: true } : {}), ...(options.nonStreaming ? { _streaming: false } : {}) },
  });
  const deadline = Date.now() + 3000;
  while (!ended.some(e => e.generationId === result.generationId) && Date.now() < deadline) await Bun.sleep(5);
  const event = ended.find(e => e.generationId === result.generationId);
  expect(event).toBeDefined();
  expect(event.frontendSessionId).toBe('0123456789abcdef0123456789abcdef');
  expect(origins.filter(value => value.chatId === chat.id)).toEqual([
    { chatId: chat.id, phase: 'context', session: '0123456789abcdef0123456789abcdef' },
    { chatId: chat.id, phase: 'interceptor', session: '0123456789abcdef0123456789abcdef' },
  ]);
  return { event, generationId: result.generationId, preset };
}
const chatThought = { choices: [{ delta: { reasoning_content: "A thought." } }] };

for (const { streaming, setupFailure } of [
  { streaming: true, setupFailure: false }, { streaming: false, setupFailure: false },
  { streaming: true, setupFailure: true }, { streaming: false, setupFailure: true },
]) {
  test(`configured fallback completes one generation across providers (streaming: ${streaming}, missing key: ${setupFailure})`, async () => {
    const fallback = await connections.createConnection(userId, {
      name: 'Backup Gemini', provider: 'google', model: 'backup-model', api_url: 'https://backup.test',
    });
    const primary = await connections.createConnection(userId, {
      name: 'Primary', provider: 'openai', model: 'primary-model', api_url: 'https://primary.test',
      metadata: { fallback_connection_id: fallback.id, use_responses_api: true },
    });
    if (setupFailure) secretSpy.mockImplementation(async (_user: string, key: string) => key === connections.connectionSecretKey(primary.id) ? null : 'test-key');
    const chat = chats.createChat(userId, { character_id: null, name: 'Fallback', metadata: { temporary: true, no_preset: true } });
    chats.createMessage(chat.id, { is_user: true, name: 'User', content: 'Hello.' }, userId);
    const body = { candidates: [{ content: { parts: [{ text: 'Backup answer.' }] }, finishReason: 'STOP' }] };
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url: any) => {
      if (String(url).includes('primary.test')) return Response.json({ error: { message: 'Unavailable' } }, { status: 503 });
      return streaming ? new Response(`data: ${JSON.stringify(body)}\n\n`) : Response.json(body);
    }) as typeof fetch);
    const { generationId } = await startGeneration({ userId, chat_id: chat.id, connection_id: primary.id, parameters: { _streaming: streaming } });
    const deadline = Date.now() + 3000;
    while (!ended.some((e) => e.generationId === generationId) && Date.now() < deadline) await Bun.sleep(5);
    const event = ended.find((e) => e.generationId === generationId);
    expect(event?.error).toBeUndefined();
    expect(event?.content).toBe('Backup answer.');
    expect(pool.getPoolEntry(generationId)).toMatchObject({ status: 'completed', model: 'backup-model', connectionName: 'Backup Gemini' });
    expect(chats.getMessage(userId, event.messageId)?.content).toBe('Backup answer.');
    expect(fetchSpy.mock.calls).toHaveLength(setupFailure ? 1 : 2);
    const fallbackRequest = fetchSpy.mock.calls.at(-1)!;
    expect(String(fallbackRequest[0])).toContain('backup-model');
    expect(String(fallbackRequest[0])).toContain('backup.test');
    expect(JSON.parse(String(fallbackRequest[1]?.body)).use_responses_api).toBeUndefined();
    expect(connections.getConnection(userId, primary.id)?.metadata.fallback_connection_id).toBe(fallback.id);
  });
}
const responseThought = { type: "response.reasoning_summary_text.delta", delta: "A thought." };
const googleThought = { candidates: [{ content: { parts: [{ thought: true, text: "A thought." }] } }] };

const cases = [
  { name: "Chat Completions token limit", provider: "openai", reason: "length", error: "output token limit", body: [chatThought, { choices: [{ delta: {}, finish_reason: "length" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 128, total_tokens: 138 } }] },
  { name: "Chat Completions filter", provider: "openai", reason: "content_filter", error: "content filter", body: [chatThought, { choices: [{ delta: { content: "Partial answer." }, finish_reason: "content_filter" }] }] },
  { name: "Responses token limit", provider: "openai", responses: true, reason: "max_output_tokens", error: "output token limit", body: [responseThought, { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }] },
  { name: "Responses failure", provider: "openai", responses: true, reason: "failed", error: "Upstream failed", body: [responseThought, { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "Upstream failed" } } }] },
  { name: "Gemini token limit", provider: "google", reason: "MAX_TOKENS", error: "output token limit", body: [googleThought, { candidates: [{ finishReason: "MAX_TOKENS" }] }] },
  { name: "Gemini filter", provider: "google", reason: "SAFETY", error: "Provider explanation", body: [googleThought, { candidates: [{ content: { parts: [{ text: "Partial answer." }] }, finishReason: "SAFETY", finishMessage: "Provider explanation" }] }] },
  { name: "Gemini tool error", provider: "google", reason: "MALFORMED_FUNCTION_CALL", error: "tool call", body: [googleThought, { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: {} } }] }, finishReason: "MALFORMED_FUNCTION_CALL" }] }] },
];
for (const fixture of cases) {
  test(`${fixture.name} reaches the error UI and saves partial output with diagnostics`, async () => {
    const { event, generationId } = await run(fixture.provider, fixture.body, fixture);
    expect(event.finish_reason).toBe(fixture.reason);
    expect(event.error).toContain(fixture.error);
    expect(event.errorMessage).toBe(event.error);
    expect(event.connectionName).toBe("Mock");
    expect(event.errorCode).toBe(
      fixture.name === "Responses failure" ? "server_error" : fixture.reason,
    );
    expect(pool.getPoolEntry(generationId)?.status).toBe("error");
    const saved = chats.getMessage(userId, event.messageId)!;
    expect(saved.extra.reasoning).toBe("A thought.");
    expect(saved.extra.generationOutcome).toMatchObject({ finish_reason: fixture.reason, error: event.error });
    if (event.stop_details) expect(saved.extra.generationOutcome.stop_details).toEqual(event.stop_details);
    if (fixture.name === "Chat Completions token limit") expect(saved.extra.usage.completion_tokens).toBe(128);
    expect(fetchSpy!.mock.calls).toHaveLength(1);
  });
}
for (const provider of ["openai", "google"]) {
  test(`${provider} non-streaming token limit uses the same error path`, async () => {
    const body = provider === "openai"
      ? { choices: [{ message: { reasoning_content: "A thought." }, finish_reason: "length" }] }
      : { candidates: [{ content: { parts: [{ thought: true, text: "A thought." }] }, finishReason: "MAX_TOKENS" }] };
    const { event } = await run(provider, [body], { nonStreaming: true });
    expect(event.error).toContain("output token limit");
    expect(chats.getMessage(userId, event.messageId)?.extra.reasoning).toBe("A thought.");
  });
}
test("Gemini prompt blocks with no candidate produce a clear error and diagnostics", async () => {
  const { event, generationId } = await run("google", [{ promptFeedback: { blockReason: "SAFETY" } }]);
  expect(event.error).toContain("blocked the prompt");
  expect(event.finish_reason).toBe("SAFETY");
  expect(event.stop_details.type).toBe("blocked_prompt");
  expect(pool.getPoolEntry(generationId)?.status).toBe("error");
});
test("OpenAI refusal fields are surfaced even when finish_reason is stop", async () => {
  const { event } = await run("openai", [{ choices: [{ delta: { refusal: "Cannot answer." }, finish_reason: "stop" }] }]);
  expect(event.error).toContain("Cannot answer.");
  expect(event.finish_reason).toBe("stop");
  expect(event.stop_details.type).toBe("refusal");
  expect(chats.getMessage(userId, event.messageId)?.content).toBe("Cannot answer.");
});
for (const fixture of [
  { provider: "openai", body: [chatThought] },
  { provider: "openai", responses: true, body: [responseThought] },
  { provider: "google", body: [googleThought] },
]) {
  test(`${fixture.provider}${fixture.responses ? " Responses" : ""} EOF after reasoning is an error without replaying the request`, async () => {
    const { event } = await run(fixture.provider, fixture.body, fixture);
    expect(event.error).toContain("terminal response");
    expect(chats.getMessage(userId, event.messageId)?.extra.reasoning).toBe("A thought.");
    expect(fetchSpy!.mock.calls).toHaveLength(1);
  });
}

test("generation metrics retain the preset used for the generated swipe", async () => {
  const { generationId, preset } = await run(
    "openai",
    [{ choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] }],
    { presetName: "Raven" },
  );
  const deadline = Date.now() + 3000;
  while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  const metricsEvent = metricsReady.find((event) => event.generationId === generationId);
  expect(metricsEvent?.generationMetrics).toMatchObject({
    presetId: preset!.id,
    presetName: "Raven",
  });
  expect(chats.getMessage(userId, metricsEvent.messageId)?.extra.generationMetrics).toMatchObject({
    presetId: preset!.id,
    presetName: "Raven",
  });
});
test("generation meta token count falls back to visible response tokenization", async () => {
  const tokenizerSpy = spyOn(tokenizer, "countForModel").mockResolvedValue(4);
  try {
    const { generationId } = await run("openai", [
      chatThought,
      { choices: [{ delta: { content: "Visible answer." }, finish_reason: "stop" }] },
    ]);
    const deadline = Date.now() + 3000;
    while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    const metricsEvent = metricsReady.find((event) => event.generationId === generationId);
    expect(tokenizerSpy).toHaveBeenCalledWith("test-model", "Visible answer.");
    expect(metricsEvent?.tokenCount).toBe(4);
  } finally {
    tokenizerSpy.mockRestore();
  }
});
test("generation meta token count uses provider usage without local tokenization", async () => {
  const tokenizerSpy = spyOn(tokenizer, "countForModel").mockResolvedValue(4);
  try {
    const { generationId } = await run("openai", [
      { choices: [{ delta: { content: "Visible answer." }, finish_reason: "stop" }] },
      {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 128, total_tokens: 138 },
      },
    ]);
    const deadline = Date.now() + 3000;
    while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    const metricsEvent = metricsReady.find((event) => event.generationId === generationId);
    expect(tokenizerSpy).not.toHaveBeenCalled();
    expect(metricsEvent?.tokenCount).toBe(128);
  } finally {
    tokenizerSpy.mockRestore();
  }
});
test("whitespace during native reasoning does not start the response TPS timer", async () => {
  const tokenizerSpy = spyOn(tokenizer, "countForModel").mockResolvedValue(4);
  try {
    const { generationId } = await run("openai", [
      { choices: [{ delta: { content: "\n", reasoning_content: "A thought." } }] },
      chatThought,
      { choices: [{ delta: { content: "Visible answer." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 128, total_tokens: 138 } },
    ], { chunkDelayMs: 30 });
    const deadline = Date.now() + 3000;
    while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    const entry = pool.getPoolEntry(generationId)!;
    const metricsEvent = metricsReady.find((event) => event.generationId === generationId);
    expect(entry.firstContentTokenAt! - entry.firstTokenAt!).toBeGreaterThanOrEqual(50);
    expect(tokenizerSpy).toHaveBeenCalledWith("test-model", "\nVisible answer.");
    expect(metricsEvent?.tokenCount).toBe(128);
    expect(metricsEvent?.generationMetrics.tps).toBe(
      Math.round(40_000 / (entry.responseStoppedAt! - entry.firstContentTokenAt!)) / 10,
    );
    expect(chats.getMessage(userId, metricsEvent.messageId)?.extra.generationMetrics).toEqual(metricsEvent.generationMetrics);
  } finally {
    tokenizerSpy.mockRestore();
  }
});
test("reasoning with whitespace-only content does not report response TPS", async () => {
  const { generationId } = await run("openai", [
    { choices: [{ delta: { content: "\n", reasoning_content: "A thought." } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 128, total_tokens: 138 } },
  ], { chunkDelayMs: 30 });
  const deadline = Date.now() + 3000;
  while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(pool.getPoolEntry(generationId)?.firstContentTokenAt).toBeUndefined();
  expect(metricsReady.find((event) => event.generationId === generationId)?.generationMetrics.tps).toBeUndefined();
});
test("TPS excludes guided reasoning split across content chunks", async () => {
  settings.putSetting(userId, "reasoningSettings", { autoParse: true, prefix: "<think>", suffix: "</think>" });
  const tokenizerSpy = spyOn(tokenizer, "countForModel").mockResolvedValue(4);
  try {
    const { generationId } = await run("openai", [
      { choices: [{ delta: { content: "<thi" } }] },
      { choices: [{ delta: { content: "nk>A thought.</thi" } }] },
      { choices: [{ delta: { content: "nk>\n" } }] },
      { choices: [{ delta: { content: "Visible answer." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 128, total_tokens: 138, completion_tokens_details: { reasoning_tokens: 0 } } },
    ], { chunkDelayMs: 30 });
    const deadline = Date.now() + 3000;
    while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    const entry = pool.getPoolEntry(generationId)!;
    const metricsEvent = metricsReady.find((event) => event.generationId === generationId);
    expect(entry.firstContentTokenAt! - entry.firstTokenAt!).toBeGreaterThanOrEqual(80);
    expect(tokenizerSpy).toHaveBeenCalledWith("test-model", "Visible answer.");
    expect(metricsEvent?.tokenCount).toBe(128);
    expect(metricsEvent?.generationMetrics.tps).toBe(
      Math.round(40_000 / (entry.responseStoppedAt! - entry.firstContentTokenAt!)) / 10,
    );
    expect(chats.getMessage(userId, metricsEvent.messageId)?.extra.reasoning).toBe("A thought.");
  } finally {
    tokenizerSpy.mockRestore();
  }
});
test.each([false, true])("TPS uses reported reasoning usage without local tokenization (Responses API: %s)", async (responses) => {
  const tokenizerSpy = spyOn(tokenizer, "countForModel").mockResolvedValue(4);
  try {
    const { generationId } = await run("openai", responses ? [
      { type: "response.output_text.delta", delta: "Visible answer." },
      { type: "response.completed", response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 128, total_tokens: 138, output_tokens_details: { reasoning_tokens: 108 } },
      } },
    ] : [
      chatThought,
      { choices: [{ delta: { content: "Visible answer." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 128, total_tokens: 138, completion_tokens_details: { reasoning_tokens: 108 } } },
    ], { responses, chunkDelayMs: 30 });
    const deadline = Date.now() + 3000;
    while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    const entry = pool.getPoolEntry(generationId)!;
    const metricsEvent = metricsReady.find((event) => event.generationId === generationId);
    expect(tokenizerSpy).not.toHaveBeenCalled();
    expect(metricsEvent?.tokenCount).toBe(128);
    expect(metricsEvent?.generationMetrics.tps).toBe(
      Math.round(200_000 / (entry.responseStoppedAt! - entry.firstContentTokenAt!)) / 10,
    );
  } finally {
    tokenizerSpy.mockRestore();
  }
});
test.each([true, false])("reported token count preserves provider or finalized-message totals while TPS excludes prefill and edits (provider usage: %s)", async (providerUsage) => {
  const script = regexScripts.createRegexScript(userId, {
    name: "Response rewrite",
    find_regex: "Visible answer\\.",
    replace_string: "Rewritten answer with additional text.",
    placement: ["ai_output"],
    target: ["response"],
  });
  if (typeof script === "string") throw new Error(script);
  const tokenizerSpy = spyOn(tokenizer, "countForModel").mockImplementation(async (_model, text) =>
    text === "Visible answer." ? 4 : 12,
  );
  try {
    const { generationId } = await run("openai", [
      chatThought,
      { choices: [{ delta: { content: "Visible answer." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      ...(providerUsage ? [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 128, total_tokens: 138 } }] : []),
    ], { presetName: "Prefill metrics", assistantPrefill: "Prefill. ", chunkDelayMs: 30 });
    const deadline = Date.now() + 3000;
    while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    const entry = pool.getPoolEntry(generationId)!;
    const metricsEvent = metricsReady.find((event) => event.generationId === generationId);
    const saved = chats.getMessage(userId, metricsEvent.messageId)!;
    expect(saved.content).toBe("Prefill. Rewritten answer with additional text.");
    expect(metricsEvent?.tokenCount).toBe(providerUsage ? 128 : 12);
    expect(saved.extra.tokenCount).toBe(providerUsage ? 128 : 12);
    if (!providerUsage) expect(tokenizerSpy).toHaveBeenCalledWith("test-model", saved.content);
    expect(entry.firstContentTokenAt).toBeGreaterThan(entry.firstTokenAt!);
    expect(tokenizerSpy).toHaveBeenCalledWith("test-model", "Visible answer.");
    expect(metricsEvent?.generationMetrics.tps).toBe(
      Math.round(40_000 / (entry.responseStoppedAt! - entry.firstContentTokenAt!)) / 10,
    );
  } finally {
    tokenizerSpy.mockRestore();
    regexScripts.deleteRegexScript(userId, script.id);
  }
});
test("non-streaming generation metrics retain identity without TTFT or TPS", async () => {
  const { generationId } = await run("openai", [{
    choices: [{ message: { content: "Visible answer." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }], { nonStreaming: true });
  const deadline = Date.now() + 3000;
  while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  const metricsEvent = metricsReady.find((event) => event.generationId === generationId);
  expect(metricsEvent?.generationMetrics).toMatchObject({ wasStreaming: false, model: "test-model" });
  expect(metricsEvent?.generationMetrics.ttft).toBeUndefined();
  expect(metricsEvent?.generationMetrics.tps).toBeUndefined();
  expect(chats.getMessage(userId, metricsEvent.messageId)?.extra.generationMetrics).toEqual(metricsEvent.generationMetrics);
});
test("TPS is measured between provider content and stop, before message completion", async () => {
  const { generationId } = await run("openai", [
    { choices: [{ delta: { content: "Visible answer." }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    {
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
  ], { chunkDelayMs: 30 });
  const deadline = Date.now() + 3000;
  while (!metricsReady.some((event) => event.generationId === generationId) && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  const entry = pool.getPoolEntry(generationId)!;
  const metrics = metricsReady.find((event) => event.generationId === generationId)?.generationMetrics;
  expect(entry.firstTokenAt).toBeGreaterThanOrEqual(entry.streamingStartedAt!);
  expect(entry.firstContentTokenAt).toBeGreaterThanOrEqual(entry.firstTokenAt!);
  expect(entry.responseStoppedAt).toBeGreaterThan(entry.firstContentTokenAt!);
  expect(entry.completedAt! - entry.responseStoppedAt!).toBeGreaterThanOrEqual(15);
  expect(metrics?.tps).toBe(Math.round(200_000 / (entry.responseStoppedAt! - entry.firstContentTokenAt!)) / 10);
});
for (const fixture of [
  { provider: "openai", body: [{ choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] }] },
  { provider: "google", body: [{ candidates: [{ content: { parts: [{ text: "Hello." }] }, finishReason: "STOP" }] }] },
]) {
  test(`${fixture.provider} normal stop remains successful`, async () => {
    const { event, generationId } = await run(fixture.provider, fixture.body);
    expect(event.error).toBeUndefined();
    expect(pool.getPoolEntry(generationId)?.status).toBe("completed");
    expect(chats.getMessage(userId, event.messageId)?.content).toBe("Hello.");
  });
}

test.each(["backend", "http"])("%s prompt previews select the active frontend without caller routing", async (mode) => {
  const connection = await connections.createConnection(userId, { name: "Preview", provider: "openai", model: "test-model", api_url: "https://example.test" });
  const chat = chats.createChat(userId, { character_id: null, name: "Preview", metadata: { no_preset: true } });
  chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello." }, userId);
  const preset = presets.createPreset(userId, { name: "Preview", provider: "openai", prompt_order: [] });
  const input = { userId, chat_id: chat.id, connection_id: connection.id, preset_id: preset.id };
  if (mode === "backend") await dryRunGeneration(input);
  else {
    const { Hono } = await import("hono");
    const { generateRoutes } = await import("../routes/generate.routes");
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
    app.route("/generate", generateRoutes);
    const response = await app.request("/generate/dry-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
  }
  expect(origins.filter(value => value.chatId === chat.id)).toEqual([
    { chatId: chat.id, phase: "context", session: "0123456789abcdef0123456789abcdef" },
    { chatId: chat.id, phase: "interceptor", session: "0123456789abcdef0123456789abcdef" },
  ]);
});

test("live and dry-run interceptors receive the resolved preset id and its internal metadata", async () => {
  const contexts: any[] = [];
  const remove = interceptorPipeline.register({ extensionId: "preset-context-test", priority: 200, handler: async (messages, context: any) => {
    contexts.push({ presetId: context.presetId, metadata: context[INTERNAL_PRESET_METADATA_KEY], shared: context.presetMetadata });
    return { messages };
  } });
  try {
    const presetMetadata = { lumirealm: { chatRanges: [{ start: -4, end: 0 }] }, other_ext: { secret: "other" } };
    const { preset } = await run("openai", [{ choices: [{ delta: { content: "Hi." }, finish_reason: "stop" }] }], { presetName: "Ranges", presetMetadata });
    await run("openai", [{ choices: [{ delta: { content: "Hi." }, finish_reason: "stop" }] }]);

    const connection = await connections.createConnection(userId, { name: "Dry", provider: "openai", model: "test-model", api_url: "https://example.test" });
    const chat = chats.createChat(userId, { character_id: null, name: "Dry", metadata: { temporary: true } });
    chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello." }, userId);
    // A block preset takes the Loom assembly path; the live preset above has no blocks.
    const blockPreset = presets.createPreset(userId, { name: "Blocks", provider: "openai", metadata: presetMetadata, prompt_order: [{
      id: "main", name: "Main", content: "Be brief.", role: "system", enabled: true, position: "pre_history",
      depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null,
    }] });
    const input = { userId, chat_id: chat.id, connection_id: connection.id, preset_id: blockPreset.id };
    expect((await dryRunGeneration(input)).breakdown.some((entry) => entry.name === "Main")).toBe(true);
    await dryRunGeneration({ ...input, messages: [{ role: "user", content: "Explicit." }] });

    expect(contexts).toEqual([
      { presetId: preset!.id, metadata: presetMetadata, shared: undefined },
      { presetId: null, metadata: undefined, shared: undefined },
      { presetId: blockPreset.id, metadata: presetMetadata, shared: undefined },
      { presetId: null, metadata: undefined, shared: undefined },
    ]);
  } finally { remove(); }
});

test("takeover and context replacement cannot retarget a generation already started", async () => {
  let removeReplacement: (() => void) | undefined;
  const removeHandler = contextHandlerChain.register({ extensionId: "takeover", priority: 200, handler: async (ctx: any) => {
    removeReplacement = registerFrontendSession(userId, "f".repeat(32), { send() {}, close() {}, closed() {} });
    return { ...ctx, frontendSessionId: "f".repeat(32) };
  } });
  try {
    await run("openai", [{ choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] }]);
  } finally { removeHandler(); removeReplacement?.(); }
});
