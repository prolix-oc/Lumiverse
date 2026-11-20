import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import * as connections from "../connections.service";
import * as secrets from "../secrets.service";
import { stopAllGenerations, stopGenerationSweep } from "../generate.service";
import { clearAllPoolEntries, stopPoolSweep } from "../generation-pool.service";
import { DEFAULT_CORTEX_CONFIG, type MemoryCortexConfig } from "./config";
import { generateConsolidationSummary } from "./consolidation";
import { extractBatchWithSidecar, getExtractionTools } from "./salience-sidecar";
import { createCortexSidecarGenerateRawAdapter } from "./sidecar-adapter";
import { CortexActivityTracker, getCortexActivity, withCortexBatch, type CortexRequestPhase } from "./activity";

const userId = "cortex-reasoning-budget-test";
let connectionId: string;
let secretSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("test-credential");
  connectionId = (await connections.createConnection(userId, {
    name: "DeepSeek Cortex",
    provider: "deepseek",
    model: "deepseek-flash",
    api_url: "https://example.test",
    metadata: { reasoningBindings: { settings: { apiReasoning: true, reasoningEffort: "high" } } },
  })).id;
});

afterEach(() => {
  fetchSpy?.mockRestore();
});

afterAll(() => {
  stopAllGenerations();
  stopGenerationSweep();
  stopPoolSweep();
  clearAllPoolEntries();
  secretSpy.mockRestore();
  closeDatabase();
});

function config(maxTokens: number): MemoryCortexConfig {
  return {
    ...DEFAULT_CORTEX_CONFIG,
    sidecar: { ...DEFAULT_CORTEX_CONFIG.sidecar, connectionProfileId: connectionId, model: "deepseek-flash", maxTokens, requestsPerMinute: 0 },
    queryGeneration: { primary: { connectionProfileId: connectionId, model: "deepseek-flash" }, secondary: null },
    memorySummarization: { primary: { connectionProfileId: connectionId, model: "deepseek-flash" }, secondary: null },
  };
}

function adapter(cortexConfig: MemoryCortexConfig) {
  return createCortexSidecarGenerateRawAdapter({ userId, sidecarProvider: "deepseek", cortexConfig });
}

function mockProvider(reply: (body: any) => Response): any[] {
  const sent: any[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    return reply(body);
  }) as typeof fetch);
  return sent;
}

function truncatedResponse(body: any): Response {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: body.max_tokens,
    total_tokens: 1000 + body.max_tokens,
    completion_tokens_details: { reasoning_tokens: body.max_tokens },
  };
  const reasoning_content = "Thinking used the entire generation budget.";
  if (body.stream) {
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content }, finish_reason: "length" }], usage })}\n\ndata: [DONE]\n\n`);
  }
  return Response.json({ choices: [{ message: { content: "", reasoning_content }, finish_reason: "length" }], usage });
}

describe("Cortex thinking responses", () => {
  test("surfaces thinking and streamed tool arguments before EOF while retaining the full result", async () => {
    const chatId = crypto.randomUUID();
    const tracker = new CortexActivityTracker(userId, chatId, "rebuild");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    let fetched!: () => void;
    const started = new Promise<void>((resolve) => { fetched = resolve; });
    const sent = mockProvider(() => { fetched(); return new Response(body); });
    const send = (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
    const waitForPhase = async (phase: CortexRequestPhase) => {
      for (let i = 0; i < 100 && getCortexActivity(chatId).runs[0].requests[0]?.phase !== phase; i++) {
        await Bun.sleep(2);
      }
      expect(getCortexActivity(chatId).runs[0].requests[0]?.phase).toBe(phase);
    };
    let settled = false;
    try {
      const pending = tracker.run(() => withCortexBatch(1, 5, () => adapter(config(4096))({
        connectionId, requestPurpose: "extraction", messages: [{ role: "user", content: "Analyze the passage." }],
        parameters: {}, tools: getExtractionTools(),
      })));
      pending.then(() => { settled = true; }, () => { settled = true; });
      await started;
      expect(sent[0].stream).toBe(true);
      send({ choices: [{ delta: { reasoning_content: "Private provider reasoning." } }] });
      await waitForPhase("thinking");
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "analyze_passage", arguments: '{"importance":' } }] } }] });
      await waitForPhase("responding");
      expect(settled).toBe(false);
      expect(JSON.stringify(getCortexActivity(chatId))).not.toContain("Private provider reasoning");
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '5}' } }] }, finish_reason: "tool_calls" }] });
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
      const result = await pending;
      expect(result.tool_calls).toMatchObject([{ name: "analyze_passage", args: { importance: 5 } }]);
      expect(getCortexActivity(chatId).runs[0].requests).toEqual([]);
    } finally { tracker.finish(); }
  });

  test("aborting streamed partial JSON rejects the result and clears request activity", async () => {
    const chatId = crypto.randomUUID();
    const tracker = new CortexActivityTracker(userId, chatId, "ingestion");
    const abort = new AbortController();
    let fetched!: () => void;
    const started = new Promise<void>((resolve) => { fetched = resolve; });
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"title":"partial' } }] })}\n\n`));
    } });
    mockProvider(() => { fetched(); return new Response(body); });
    try {
      const pending = tracker.run(() => adapter(config(4096))({ connectionId,
        messages: [{ role: "user", content: "Summarize." }], parameters: {}, signal: abort.signal }));
      const outcome = pending.then(() => ({ resolved: true }), (error) => ({ resolved: false, error }));
      await started;
      abort.abort();
      expect((await outcome).resolved).toBe(false);
      expect(getCortexActivity(chatId).runs[0].requests).toEqual([]);
    } finally { tracker.finish("cancelled"); }
  });

  test("consolidation preserves the configured generation budget and the smaller summary target", async () => {
    const sent = mockProvider((body) => body.max_tokens < 1024
      ? truncatedResponse(body)
      : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ title: "The Missing Map", summary: "Mara learned that Tovin had sold the map and promised to recover it." }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
    const cortexConfig = config(16384);
    const decision = await generateConsolidationSummary(
      [{ content: "Tovin admitted selling the map. Mara promised to recover it." }],
      adapter(cortexConfig),
      connectionId,
      300,
      { max_tokens: cortexConfig.sidecar.maxTokens },
      undefined,
      { memorySummarization: cortexConfig.memorySummarization },
    );

    expect(decision.status).toBe("ok");
    expect(decision.result?.summary).toContain("Mara");
    expect(sent).toHaveLength(1);
    expect(sent[0].max_tokens).toBe(16384);
    expect(sent[0].thinking).toEqual({ type: "enabled" });
    expect(sent[0].messages[1].content).toContain("300 tokens");
  });

  for (const tools of [undefined, getExtractionTools()]) {
    test(`reports thinking-only token exhaustion for ${tools ? "streamed extraction" : "consolidation"}`, async () => {
      const sent = mockProvider(truncatedResponse);
      await expect(adapter(config(4096))({
        connectionId,
        requestPurpose: tools ? "extraction" : "memory summarization",
        messages: [{ role: "user", content: "Analyze the passage." }],
        parameters: {},
        tools,
      })).rejects.toThrow("finish_reason=length, max_tokens=4096, completion_tokens=4096, reasoning_tokens=4096");
      expect(sent).toHaveLength(1);
    });
  }

  test("a twelve-passage batch uses the configured budget and preserves tool results", async () => {
    const results = Array.from({ length: 12 }, (_, index) => ({ index, importance: 5, key_facts: [`Mara found map ${index}`], entities_present: [], emotional_tones: [], narrative_flags: [], relationships_shown: [], status_changes: [], color_attributions: [], discovered_aliases: [] }));
    const sent = mockProvider((body) => body.max_tokens < 8192
      ? truncatedResponse(body)
      : new Response(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Analyzed the passages." } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "batch-call", type: "function", function: { name: "analyze_passage_batch", arguments: JSON.stringify({ results }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`));
    const extracted = await extractBatchWithSidecar(
      results.map(({ index }) => ({ index, content: `Mara found map ${index}.` })),
      adapter(config(16384)),
      connectionId,
    );

    expect(extracted).toHaveLength(12);
    expect(extracted.every((result) => result?.score === 0.5)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].max_tokens).toBe(16384);
    expect(sent[0].thinking).toEqual({ type: "enabled" });
    expect(sent[0].tool_choice).toBe("auto");
  });
});
