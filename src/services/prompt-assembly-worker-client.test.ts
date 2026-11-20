import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AssemblyContext, AssemblyResult } from "../llm/types";
import type { AssemblyWorkerRequest, AssemblyWorkerResponse } from "./prompt-assembly-worker-protocol";
import type { CortexCacheSnapshot } from "./memory-cortex/types";
import type { CortexWarmJob } from "./cortex-warm-worker";

const listeners: Array<(id: string | null) => void> = [];
const releasedOwners: string[] = [];
let snapshot: CortexCacheSnapshot = { chatId: "chat", local: null, linked: null };
const scheduledWarmJobs: CortexWarmJob[] = [];
mock.module("./memory-cortex", () => ({ getCortexCacheSnapshot: (chatId: string) => ({ ...snapshot, chatId }) }));
mock.module("./cortex-prompt-warm.service", () => ({ scheduleCortexPromptWarm: (_user: string, _chat: string, job: CortexWarmJob) => { scheduledWarmJobs.push(job); } }));
mock.module("./tokenizer-resource-cache", () => ({ releaseTokenizerResourceLocks: async (owner: string) => { releasedOwners.push(owner); } }));
mock.module("../macros", () => ({ registry: { getAllMacros: () => [] } }));
mock.module("../spindle/macro-interceptor", () => ({ macroInterceptorChain: { count: 0 } }));
mock.module("../spindle/world-info-interceptor", () => ({ worldInfoInterceptorChain: { count: 0 } }));
mock.module("./connections.service", () => ({ resolveConnection: (_user: string, id: string) => ({ model: id }) }));
mock.module("./tokenizer.service", () => ({ getTokenizerIdForModel: (model: string) => model || null, onTokenizerInvalidation: (listener: (id: string | null) => void) => listeners.push(listener) }));

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<AssemblyWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: AssemblyWorkerRequest[] = [];
  terminated = false;
  constructor() { FakeWorker.all.push(this); }
  postMessage(request: AssemblyWorkerRequest) { this.requests.push(request); }
  terminate() { this.terminated = true; }
  respond(request: AssemblyWorkerRequest, tokenizerIds: string[]) {
    if (request.type === "invalidate-tokenizer") return;
    const data: AssemblyWorkerResponse = request.type === "warm-tokenizer"
      ? { type: "tokenizer-warmed", requestId: request.requestId, tokenizerRevision: request.tokenizerRevision, tokenizerIds }
      : { type: "result", requestId: request.requestId, tokenizerRevision: request.tokenizerRevision, tokenizerIds, result: { messages: [], breakdown: [], parameters: {} } as AssemblyResult };
    this.onmessage?.({ data } as MessageEvent<AssemblyWorkerResponse>);
  }
}
const originalWorker = globalThis.Worker;
const originalWorkers = process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKERS;
const originalDisabled = process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKERS = "2";
delete process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
globalThis.Worker = FakeWorker as unknown as typeof Worker;
const client = await import("./prompt-assembly-worker-client");
const ctx = (connectionId: string, chatId = "chat"): AssemblyContext => ({ userId: "user", connectionId, chatId, generationType: "normal" } as AssemblyContext);
beforeEach(() => {
  FakeWorker.all = [];
  snapshot = { chatId: "chat", local: null, linked: null };
  scheduledWarmJobs.length = 0;
});
afterEach(() => client.releaseIdlePromptAssemblyWorkers());
afterAll(() => {
  globalThis.Worker = originalWorker;
  if (originalWorkers === undefined) delete process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKERS;
  else process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKERS = originalWorkers;
  if (originalDisabled === undefined) delete process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
  else process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER = originalDisabled;
});

describe("assembly tokenizer warmup", () => {
  test("captures Cortex caches at dispatch and returns warm work to the host", async () => {
    const a = client.assemblePromptInWorker(ctx("a", "chat-a"));
    const b = client.assemblePromptInWorker(ctx("b", "chat-b"));
    const queued = client.assemblePromptInWorker(ctx("a", "chat-a"));
    snapshot = { chatId: "chat-a", local: null, linked: { result: { vaults: [], interlinks: [] }, queriedAt: 42 } };
    const [workerA, workerB] = FakeWorker.all;
    workerA.respond(workerA.requests[0], ["a"]);
    expect(workerA.requests[1]).toMatchObject({ ctx: { cortexCache: snapshot } });
    const request = workerA.requests[1];
    if (request.type !== "assemble") throw new Error("Expected assembly request");
    const job = { chatId: "chat-a", userId: "user" } as CortexWarmJob;
    workerA.onmessage?.(new MessageEvent<AssemblyWorkerResponse>("message", { data: {
      type: "result", requestId: request.requestId, tokenizerRevision: request.tokenizerRevision,
      tokenizerIds: ["a"], result: { messages: [], breakdown: [], parameters: {}, deferredCortexWarmJob: job },
    } }));
    const result = await queued;
    expect(scheduledWarmJobs).toEqual([job]);
    expect(result).not.toHaveProperty("deferredCortexWarmJob");
    workerB.respond(workerB.requests[0], ["b"]);
    await Promise.all([a, b]);
  });

  test("carries the main process MCP inventory into the assembly worker", async () => {
    const mcpTools = [{ name: "mcp_lookup", description: "Find references", parameters: {} }];
    const generation = client.assemblePromptInWorker({ ...ctx("a"), mcpTools });
    const worker = FakeWorker.all[0];
    const request = worker.requests[0];
    expect(request).toMatchObject({ type: "assemble", ctx: { mcpTools } });
    worker.respond(request, ["a"]);
    await generation;
  });

  test("generation can join a warming worker and warmup completion does not settle its job", async () => {
    client.warmPromptAssemblyTokenizer("b", "chat");
    const worker = FakeWorker.all[0];
    const warmup = worker.requests[0];
    const generation = client.assemblePromptInWorker(ctx("b"));
    expect(FakeWorker.all).toHaveLength(1);
    let settled = false;
    void generation.then(() => { settled = true; });
    worker.respond(warmup, ["b"]);
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.respond(worker.requests[1], ["b"]);
    await generation;
    client.warmPromptAssemblyTokenizer("b", "chat");
    expect(worker.requests).toHaveLength(2);
  });

  test("routes a switched model to the worker holding its tokenizer", async () => {
    const a = client.assemblePromptInWorker(ctx("a", "chat-a"));
    const b = client.assemblePromptInWorker(ctx("b", "chat-b"));
    const [workerA, workerB] = FakeWorker.all;
    workerA.respond(workerA.requests[0], ["a"]);
    workerB.respond(workerB.requests[0], ["b"]);
    await Promise.all([a, b]);
    const switched = client.assemblePromptInWorker(ctx("b", "chat-a"));
    expect(workerA.requests).toHaveLength(1);
    expect(workerB.requests).toHaveLength(2);
    workerB.respond(workerB.requests[1], ["b"]);
    await switched;
  });

  test("forwards invalidation and ignores warmup state from an older revision", () => {
    client.warmPromptAssemblyTokenizer("a", null);
    const worker = FakeWorker.all[0];
    const oldWarmup = worker.requests[0];
    listeners[0]("a");
    expect(worker.requests[1]).toEqual({ type: "invalidate-tokenizer", tokenizerId: "a" });
    worker.respond(oldWarmup, ["a"]);
    client.warmPromptAssemblyTokenizer("a", null);
    expect(worker.requests[2].type).toBe("warm-tokenizer");
    worker.respond(worker.requests[2], ["a"]);
  });

  test("cancellation terminates the active worker and rejects the generation", async () => {
    const abort = new AbortController();
    const generation = client.assemblePromptInWorker({ ...ctx("a"), signal: abort.signal });
    abort.abort();
    await expect(generation).rejects.toThrow();
    expect(FakeWorker.all[0].terminated).toBe(true);
    const request = FakeWorker.all[0].requests[0];
    if (request.type !== "invalidate-tokenizer") expect(releasedOwners).toContain(request.resourceOwner);
  });
});
