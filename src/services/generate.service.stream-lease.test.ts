import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as chats from "./chats.service";
import * as connections from "./connections.service";
import * as secrets from "./secrets.service";
import * as pool from "./generation-pool.service";
import { startGeneration, stopAllGenerations, stopGeneration, stopGenerationSweep } from "./generate.service";
import { getActiveGeneration, sweepInactiveGenerations } from "./generation/active-generation-registry";
import { DEFAULT_INFERENCE_SCHEDULER_CONFIG } from "./inference-scheduler/config";
import { __test__ as schedulerTest, getInferenceSchedulerStatus, withInferenceLease } from "./inference-scheduler/scheduler";

const userId = "stream-lease-test";
const ended: any[] = [];
let connectionId: string;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let secretSpy: ReturnType<typeof spyOn>;
let eventSpy: ReturnType<typeof spyOn>;

const LOCAL_ENDPOINT = "http://127.0.0.1:5999";

beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("test-key");
  eventSpy = spyOn(eventBus, "emit").mockImplementation((type, payload) => {
    if (type === EventType.GENERATION_ENDED || type === EventType.GENERATION_STOPPED) ended.push(payload);
  });
  connectionId = (await connections.createConnection(userId, {
    name: "Local mock",
    provider: "anthropic",
    api_url: LOCAL_ENDPOINT,
    model: "claude-local-mock",
    is_default: true,
  })).id;
});

afterEach(async () => {
  await Bun.sleep(5);
  fetchSpy?.mockRestore();
  schedulerTest.reset();
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

function sseStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      push({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } });
      push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      let emitted = 0;
      timer = setInterval(() => {
        push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } });
        emitted += 1;
        if (emitted >= 500) {
          if (timer) clearInterval(timer);
          push({ type: "content_block_stop", index: 0 });
          push({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: emitted } });
          push({ type: "message_stop" });
          controller.close();
        }
      }, 2);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(5);
}

function hasActiveChatLease(): boolean {
  return getInferenceSchedulerStatus(userId).resources
    .some((resource) => resource.active.some((lease) => lease.purpose === "chat"));
}

describe("chat stream admission lease", () => {
  test("queue time does not consume the provider inactivity budget", async () => {
    schedulerTest.setHost(true);
    schedulerTest.setConfig({ ...DEFAULT_INFERENCE_SCHEDULER_CONFIG, enabled: true, preemptBackground: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withInferenceLease(
      { userId, endpoint: LOCAL_ENDPOINT, requestClass: "background" },
      async () => gate,
    );
    const chat = chats.createChat(userId, {
      character_id: null,
      name: "Queued lease test",
      metadata: { temporary: true, no_preset: true },
    });
    chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello." }, userId);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => (
      new Response(sseStream(), { headers: { "content-type": "text/event-stream" } })
    )) as unknown as typeof fetch);
    const { generationId } = await startGeneration({
      userId, chat_id: chat.id, connection_id: connectionId, generation_type: "normal",
    });
    try {
      await waitFor(() => getInferenceSchedulerStatus(userId).resources.some((resource) => resource.waiting.length > 0));
      const entry = getActiveGeneration(generationId)!;
      expect(entry).toBeDefined();
      sweepInactiveGenerations(entry.lastTokenAt + 11 * 60_000);
      expect(entry.controller.signal.aborted).toBe(false);
      release();
      await holder;
      await waitFor(hasActiveChatLease);
      // Once admitted, a provider that stops sending tokens must still time out.
      sweepInactiveGenerations(entry.lastTokenAt + 11 * 60_000);
      expect(entry.controller.signal.aborted).toBe(true);
    } finally {
      release();
      await holder;
      stopGeneration(userId, generationId);
      await waitFor(() => getActiveGeneration(generationId) === undefined);
    }
  });

  test("stopping a generation releases the interactive lease", async () => {
    schedulerTest.setHost(true);
    schedulerTest.setConfig({
      ...DEFAULT_INFERENCE_SCHEDULER_CONFIG,
      enabled: true,
      unifiedLocalPool: true,
      concurrency: 1,
      preemptBackground: false,
    });

    const chat = chats.createChat(userId, {
      character_id: null,
      name: "Lease test",
      metadata: { temporary: true, no_preset: true },
    });
    chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello." }, userId);

    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => (
      new Response(sseStream(), { headers: { "content-type": "text/event-stream" } })
    )) as unknown as typeof fetch);

    const result = await startGeneration({
      userId,
      chat_id: chat.id,
      connection_id: connectionId,
      generation_type: "normal",
    });

    await waitFor(() => hasActiveChatLease());
    expect(hasActiveChatLease()).toBe(true);

    expect(stopGeneration(userId, result.generationId)).toBe(true);
    await waitFor(() => ended.some((event) => event.generationId === result.generationId));
    await waitFor(() => getActiveGeneration(result.generationId) === undefined);

    // The stream consumer throws while Stop is in flight (inside the
    // cooperative yielder). Without a finally around the loop the iterator is
    // abandoned and this lease stays active forever.
    await waitFor(() => !hasActiveChatLease(), 2_000);
    expect(hasActiveChatLease()).toBe(false);
  }, 15_000);
});
