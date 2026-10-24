import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";

import * as realStreamUtils from "../llm/stream-utils";

// Force the consumer to throw *between* iterator pulls, which previously left
// the leased stream iterator open and permanently held the admission slot.
mock.module("../llm/stream-utils", () => ({
  ...realStreamUtils,
  createCooperativeYielder: () => async () => {
    throw new Error("consumer threw between chunks");
  },
}));

const { closeDatabase, getDb, initDatabase } = await import("../db/connection");
const { eventBus } = await import("../ws/bus");
const { EventType } = await import("../ws/events");
const chats = await import("./chats.service");
const connections = await import("./connections.service");
const secrets = await import("./secrets.service");
const pool = await import("./generation-pool.service");
const { startGeneration, stopAllGenerations, stopGenerationSweep } = await import("./generate.service");
const { getActiveGeneration } = await import("./generation/active-generation-registry");
const { DEFAULT_INFERENCE_SCHEDULER_CONFIG } = await import("./inference-scheduler/config");
const { __test__: schedulerTest, getInferenceSchedulerStatus } = await import("./inference-scheduler/scheduler");

const userId = "stream-lease-consumer-throw";
const LOCAL_ENDPOINT = "http://127.0.0.1:5997";
const ended: any[] = [];
let connectionId: string;
let secretSpy: ReturnType<typeof spyOn>;
let eventSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

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

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
}

test("a consumer throw between chunks still releases the chat lease", async () => {
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
    name: "Lease throw test",
    metadata: { temporary: true, no_preset: true },
  });
  chats.createMessage(chat.id, { is_user: true, name: "User", content: "Hello." }, userId);

  const sse = [
    { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => (
    new Response(sse, { headers: { "content-type": "text/event-stream" } })
  )) as unknown as typeof fetch);

  const result = await startGeneration({
    userId,
    chat_id: chat.id,
    connection_id: connectionId,
    generation_type: "normal",
  });

  await waitFor(() => ended.some((event) => event.generationId === result.generationId));
  await waitFor(() => getActiveGeneration(result.generationId) === undefined);
  await waitFor(() => !getInferenceSchedulerStatus(userId).resources
    .some((resource) => resource.active.some((lease) => lease.purpose === "chat")), 2_000);

  const activeChatLeases = getInferenceSchedulerStatus(userId).resources
    .flatMap((resource) => resource.active)
    .filter((lease) => lease.purpose === "chat");
  expect(activeChatLeases).toHaveLength(0);
  expect(ended.find((event) => event.generationId === result.generationId)?.error)
    .toContain("consumer threw between chunks");
}, 15_000);
