import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as chats from "./chats.service";
import * as connections from "./connections.service";
import * as secrets from "./secrets.service";
import * as pool from "./generation-pool.service";
import { startGeneration, stopAllGenerations, stopGenerationSweep } from "./generate.service";

const userId = "anthropic-stream-test";
const ended: any[] = [];
let connectionId: string;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let secretSpy: ReturnType<typeof spyOn>;
let eventSpy: ReturnType<typeof spyOn>;
const thinking = [
  { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "A thought." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque" } },
  { type: "content_block_stop", index: 0 },
];
const stop = { type: "message_stop" };

beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("test-key");
  eventSpy = spyOn(eventBus, "emit").mockImplementation((type, payload) => {
    if (type === EventType.GENERATION_ENDED) ended.push(payload);
  });
  connectionId = (await connections.createConnection(userId, {
    name: "Anthropic mock", provider: "anthropic", api_url: "https://example.test",
    model: "claude-fable-5-1", is_default: true,
  })).id;
});

afterEach(async () => {
  // Let the generation's finally block finish before restoring the transport.
  await Bun.sleep(5);
  fetchSpy?.mockRestore();
});
afterAll(() => {
  stopAllGenerations();
  stopGenerationSweep();
  pool.stopPoolSweep();
  pool.clearAllPoolEntries();
  secretSpy.mockRestore();
  eventSpy.mockRestore();
  closeDatabase();
});

async function run(events: object[], options: { nonStreaming?: boolean; reason?: string; details?: unknown } = {}) {
  const chat = chats.createChat(userId, {
    character_id: null, name: "Test", metadata: { temporary: true, no_preset: true },
  });
  chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello." }, userId);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    const request = JSON.parse(init?.body as string);
    expect(request.model).toBe("claude-fable-5-1");
    expect(request.stream).toBe(!options.nonStreaming);
    if (options.nonStreaming) return Response.json({
      content: [{ type: "thinking", thinking: "A thought.", signature: "opaque" }],
      stop_reason: options.reason, stop_details: options.details,
      usage: { input_tokens: 10, output_tokens: 4096 },
    });
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  }) as typeof fetch);
  const result = await startGeneration({
    userId, chat_id: chat.id, connection_id: connectionId, generation_type: "normal",
    ...(options.nonStreaming ? { parameters: { _streaming: false } } : {}),
  });
  const deadline = Date.now() + 3000;
  while (!ended.some(e => e.generationId === result.generationId) && Date.now() < deadline) await Bun.sleep(5);
  const event = ended.find(e => e.generationId === result.generationId);
  expect(event).toBeDefined();
  return { event, chatId: chat.id, generationId: result.generationId };
}

describe("Anthropic chat outcomes", () => {
  for (const reason of ["max_tokens", "refusal"]) {
    test(`surfaces ${reason} and persists a reasoning-only response with its diagnostics`, async () => {
      const details = reason === "refusal" ? { type: "refusal", category: "general_harms", explanation: "Request declined." } : null;
      const { event, generationId } = await run([
        ...thinking,
        { type: "message_delta", delta: { stop_reason: reason, stop_details: details }, usage: { output_tokens: 4096 } }, stop,
      ]);
      expect(event.finish_reason).toBe(reason);
      expect(event.stop_details).toEqual(details);
      expect(event.error).toContain(reason === "refusal" ? "Request declined." : "output token limit");
      expect(pool.getPoolEntry(generationId)?.status).toBe("error");
      const saved = chats.getMessage(userId, event.messageId)!;
      expect(saved.content).toBe("");
      expect(saved.extra.reasoning).toBe("A thought.");
      expect(saved.extra.generationOutcome).toMatchObject({ finish_reason: reason, stop_details: details, error: event.error });
      expect(saved.extra.usage.completion_tokens).toBe(4096);
      expect(fetchSpy!.mock.calls).toHaveLength(1);
    });
  }

  for (const failure of ["overloaded_error", "incomplete_stream"]) {
    test(`surfaces ${failure} after thinking without retrying`, async () => {
      const { event, generationId } = await run([
        ...thinking,
        ...(failure === "overloaded_error" ? [{ type: "error", error: { type: failure, message: "Overloaded" } }] : []),
      ]);
      expect(event.error).toContain(failure === "overloaded_error" ? "Overloaded" : "missing message_stop");
      expect(event.finish_reason).toBeUndefined();
      expect(pool.getPoolEntry(generationId)?.status).toBe("error");
      expect(chats.getMessage(userId, event.messageId)?.extra.reasoning).toBe("A thought.");
      expect(fetchSpy!.mock.calls).toHaveLength(1);
    });
  }

  test("non-streaming refusal uses the same error UI and nullable details", async () => {
    const details = { type: "refusal", category: null, explanation: null };
    const { event } = await run([], { nonStreaming: true, reason: "refusal", details });
    expect(event.error).toContain("No explanation was provided");
    expect(event.stop_details).toEqual(details);
    expect(chats.getMessage(userId, event.messageId)?.extra.generationOutcome.stop_details).toEqual(details);
  });

  test("normal completion preserves custom stop diagnostics without reporting an error", async () => {
    const { event, generationId } = await run([
      ...thinking,
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "stop_sequence", stop_sequence: "END", stop_details: null }, usage: { output_tokens: 25 } }, stop,
    ]);
    expect(event.error).toBeUndefined();
    expect(event.finish_reason).toBe("stop_sequence");
    expect(pool.getPoolEntry(generationId)?.status).toBe("completed");
    expect(chats.getMessage(userId, event.messageId)?.extra.generationOutcome).toEqual({
      finish_reason: "stop_sequence", stop_sequence: "END", stop_details: null,
    });
  });
});
