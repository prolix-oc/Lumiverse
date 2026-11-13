import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import * as generateSvc from "../services/generate.service";
import { storeBreakdown } from "../services/breakdown.service";
import * as connections from "../services/connections.service";
import * as secrets from "../services/secrets.service";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { WorkerHost } from "./worker-host";
import { providerRegistry } from "./provider-registry";

const dryRun = spyOn(generateSvc, "dryRunGeneration");
beforeAll(async () => {
  initDatabase(":memory:");
  // Real generation requests resolve connections and per-user settings.
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
});
afterAll(() => {
  dryRun.mockRestore();
  closeDatabase();
});
afterEach(() => {
  dryRun.mockReset();
  providerRegistry.reset();
  getDb().run("DELETE FROM message_breakdowns");
});

function fixture(scope: "user" | "operator" = "user", permitted = true) {
  const host = new WorkerHost("generation-api-test", {
    identifier: "generation-api-test", name: "Generation API test",
  } as SpindleManifest, {
    id: "generation-api-test", identifier: "generation-api-test", name: "Generation API test",
    version: "0.0.0", author: "", description: "", github: "", homepage: "",
    permissions: [], granted_permissions: [], enabled: true, installed_at: 0, updated_at: 0,
    has_frontend: false, has_backend: false, status: "stopped",
    metadata: { install_scope: scope, installed_by_user_id: "alice" },
  } satisfies ExtensionInfo);
  const internal = host as unknown as {
    hasPermission(permission: string): boolean;
    handleMessage(message: unknown): void;
    runtime: { mode: string; pid: null; postMessage(message: unknown): void; terminate(): void };
  };
  internal.hasPermission = permission => permitted && permission === "generation";
  const dispatch = (message: Record<string, unknown>) => new Promise<any>(resolve => {
    internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
    internal.handleMessage({ requestId: "request", ...message });
  });
  return Object.assign(dispatch, { internal });
}

const baseResult: generateSvc.DryRunResult = {
  messages: [], breakdown: [], parameters: {}, model: "test", provider: "test",
};

test("message sessions require chat read and mutation permissions in addition to generation", async () => {
  for (const type of ["message_generation_begin", "message_generation_finish", "message_generation_abort"]) {
    const response = await fixture()({ type, input: { chatId: "chat" }, sessionId: "session" });
    expect(response.error).toContain("generation, chat_mutation and chats");
  }
});

test("stopping during provider setup cannot emit a late reasoning prefill", async () => {
  const { internal } = fixture();
  internal.hasPermission = () => true;
  const messages: any[] = [];
  internal.runtime = { mode: "worker", pid: null, postMessage: message => { messages.push(message); }, terminate() {} };
  const host = internal as any;
  const controller = new AbortController();
  let observed = 0, success: boolean | undefined, ready!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const setup = new Promise<void>(resolve => { release = resolve; });
  const bind = spyOn(host.messageGenerations, "bind").mockReturnValue({ signal: controller.signal, reasoningPrefill: "prefill",
    observe() { observed++; }, native() {}, waiting() {}, end(value: boolean) { success = value; } });
  const raw = spyOn(generateSvc, "rawGenerateStream").mockImplementation(async () => {
    ready(); await setup; return (async function* () { yield { token: "late" }; })();
  });
  try {
    const work = host.handleGenerationStream("stream", { type: "raw", messages: [], sessionId: "session", swipeIndex: 0 });
    await waiting; controller.abort(); release(); await work;
    expect(observed).toBe(0); expect(success).toBe(false);
    expect(messages.some(message => message.type === "generation_stream_chunk")).toBe(false);
    expect(messages.at(-1).type).toBe("generation_stream_error");
    expect(host.generationAbortControllers.size).toBe(0);
  } finally { raw.mockRestore(); bind.mockRestore(); host.messageGenerations.dispose(); }
});

type HostMessage = { type: string; chunk?: Record<string, unknown>; error?: string };

const sse = (events: object[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const lookupTool = {
  name: "lookup", description: "Look up the weather.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const lookupCall = { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"city":"SF"}' } };
const thinkingBlocks = [
  { type: "thinking", thinking: "Look it up.", signature: "opaque-signature" },
  { type: "redacted_thinking", data: "encrypted-reasoning" },
];
const reasoningDetails = [
  { type: "reasoning.text", text: "Look it up.", signature: "opaque-signature", format: "anthropic-claude-v1", index: 0 },
  { type: "reasoning.encrypted", data: "encrypted-reasoning", format: "anthropic-claude-v1", index: 1 },
];
const reasoningRoundTrips = [{
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  field: "thinking_blocks",
  carried: thinkingBlocks,
  toolCallReply: sse([
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Look it up." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "encrypted-reasoning" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ]),
  answerReply: sse([
    { type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "72F and clear." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]),
  // Anthropic replays the blocks at the start of the assistant turn.
  sentBack: { role: "assistant", content: [...thinkingBlocks, { type: "tool_use", id: "call_1", name: "lookup", input: { city: "SF" } }] },
}, {
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.5",
  field: "reasoning_details",
  carried: reasoningDetails,
  toolCallReply: sse([
    { choices: [{ delta: { reasoning: "Look it up.", reasoning_details: [{ type: "reasoning.text", text: "Look it up.", format: "anthropic-claude-v1", index: 0 }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", signature: "opaque-signature", index: 0 }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "encrypted-reasoning", format: "anthropic-claude-v1", index: 1 }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, ...lookupCall }] }, finish_reason: "tool_calls" }] },
  ]),
  answerReply: sse([{ choices: [{ delta: { content: "72F and clear." }, finish_reason: "stop" }] }]),
  // OpenAI-compatible providers replay them on the assistant tool_calls message.
  sentBack: { role: "assistant", content: null, tool_calls: [lookupCall], reasoning_details: reasoningDetails },
}];

for (const roundTrip of reasoningRoundTrips) {
  test(`${roundTrip.provider} tool-call results carry ${roundTrip.field}, which the next request sends back in the provider's format`, async () => {
    const { id: connectionId } = await connections.createConnection("alice", {
      name: roundTrip.provider, provider: roundTrip.provider, model: roundTrip.model, api_url: "https://provider.test",
    });
    const secret = spyOn(secrets, "getSecret").mockResolvedValue("test-key");
    const sent: Array<{ messages: unknown[] }> = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body: { messages: unknown[] } = JSON.parse(String(init?.body));
      sent.push(body);
      // Only the follow-up request carries a tool result.
      return new Response(body.messages.length > 1 ? roundTrip.answerReply : roundTrip.toolCallReply);
    }) as typeof fetch);
    const send = fixture();
    const question = { role: "user", content: "Weather in SF?" };
    const request = { provider: roundTrip.provider, model: roundTrip.model, connection_id: connectionId, messages: [question], tools: [lookupTool] };
    try {
      const results: Record<string, Record<string, unknown>> = {};
      for (const type of ["raw", "quiet"]) {
        const response = await send({ type: "request_generation", input: { ...request, type } });
        expect(response.error).toBeUndefined();
        results[type] = response.result;
      }
      const streamed: HostMessage[] = [];
      const streamEnded = Promise.withResolvers<void>();
      send.internal.runtime = {
        mode: "worker", pid: null, terminate() {},
        postMessage(message) {
          // Host-to-worker protocol messages for this request.
          const event = message as HostMessage;
          streamed.push(event);
          if (event.type === "generation_stream_error" || event.chunk?.type === "done") streamEnded.resolve();
        },
      };
      send.internal.handleMessage({ type: "request_generation_stream", requestId: "stream", input: { ...request, type: "raw" } });
      await streamEnded.promise;
      expect(streamed.at(-1)).toMatchObject({ type: "generation_stream_chunk", chunk: { type: "done" } });
      results["raw stream"] = streamed.at(-1)?.chunk ?? {};
      for (const [path, result] of Object.entries(results)) {
        expect({ path, finish_reason: result.finish_reason, tool_calls: result.tool_calls, carried: result[roundTrip.field] }).toEqual({
          path, finish_reason: "tool_calls", tool_calls: [{ name: "lookup", args: { city: "SF" }, call_id: "call_1" }], carried: roundTrip.carried,
        });
      }

      const followUp = await send({ type: "request_generation", input: { ...request, type: "raw", messages: [
        question,
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { city: "SF" } }], [roundTrip.field]: results.raw[roundTrip.field] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "72F and clear" }] },
      ] } });
      expect(followUp.result.content).toBe("72F and clear.");
      expect(sent).toHaveLength(4);
      expect(sent[3].messages[1]).toEqual(roundTrip.sentBack);
    } finally {
      fetchSpy.mockRestore();
      secret.mockRestore();
    }
  });
}

test("retained response contexts return their prefill without requiring structured request output", async () => {
  const dispatch = fixture();
  const host = dispatch.internal as any;
  const remember = spyOn(host.messageGenerations, "remember").mockReturnValue("context");
  dryRun.mockImplementation(async (_input, prepared) => {
    prepared?.({ prefill: "Prefix" } as any);
    return { ...baseResult, assistantPrefill: "Prefix" };
  });
  try {
    const response = await dispatch({ type: "generate_dry_run", input: { chatId: "chat", retainResponseContext: true } });
    expect(response.result).toMatchObject({ responseContextId: "context", assistantPrefill: "Prefix" });
    expect(response.result.request_messages).toBeUndefined();
    expect(remember.mock.calls[0]).toEqual(["alice", "chat", { prefill: "Prefix" }]);
  } finally { remember.mockRestore(); host.messageGenerations.dispose(); }
});

test("dry runs opt into lossless request messages without changing the display messages", async () => {
  const requestMessages: NonNullable<generateSvc.DryRunResult["request_messages"]> = [{
    role: "assistant",
    content: [
      { type: "text", text: "Answer", thought_signature: "text-signature" },
      { type: "audio", data: "UklGRg==", mime_type: "audio/wav" },
      { type: "tool_use", id: "call", name: "lookup", input: {} },
    ],
    reasoning_content: "Thought",
    thinking_blocks: [{ type: "thinking", thinking: "Thought", signature: "signature" }],
    reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }],
  }, { role: "assistant", content: "Prefix", partial: true }];
  dryRun.mockResolvedValue({ ...baseResult, messages: [{ role: "assistant", content: "Answer [audio: audio/wav]" }], request_messages: requestMessages, assistantPrefill: "Prefix" });
  const response = await fixture()({ type: "generate_dry_run", input: { chatId: "chat", includeRequestMessages: true } });
  expect(dryRun.mock.calls[0]![0]).toMatchObject({ include_request_messages: true });
  expect(response.result.request_messages).toEqual(requestMessages);
  expect(response.result.messages[0].content).toBe("Answer [audio: audio/wav]");
  expect(response.result.assistantPrefill).toBe("Prefix");
});

test("dry run preserves context clipping statistics and a zero history-token count", async () => {
  const contextClipStats = {
    enabled: true, maxContext: 8192, maxResponseTokens: 1024, safetyMargin: 128,
    inputBudget: 7040, fixedTokens: 100, remainingHistoryBudget: 6940,
    chatHistoryTokensBefore: 8000, chatHistoryTokensAfter: 6900,
    messagesDropped: 2, tokensDropped: 1100, tokenizerUsed: "test",
  };
  dryRun.mockResolvedValue({ ...baseResult, chatHistoryTokens: 0, contextClipStats });
  const response = await fixture()({ type: "generate_dry_run", input: { chatId: "chat" } });
  expect(response).toMatchObject({ type: "response", requestId: "request", result: {
    ...baseResult, chatHistoryTokens: 0, contextClipStats,
  } });
  expect(dryRun.mock.calls[0]?.[0]).toMatchObject({ userId: "alice", chat_id: "chat" });
});

test("dry run leaves unavailable counts and clipping statistics undefined", async () => {
  dryRun.mockResolvedValue(baseResult);
  const response = await fixture()({ type: "generate_dry_run", input: { chatId: "chat" } });
  expect(response.result.chatHistoryTokens).toBeUndefined();
  expect(response.result.contextClipStats).toBeUndefined();
  expect(Object.hasOwn(response.result, "variable_state")).toBe(false);
  expect(Object.hasOwn(dryRun.mock.calls[0]![0], "force_preset_id")).toBe(false);
  expect(Object.hasOwn(response.result, "request_messages")).toBe(false);
  expect(Object.hasOwn(dryRun.mock.calls[0]![0], "include_request_messages")).toBe(false);
});

test("forced preset dry runs forward the opt-in and return captured variables", async () => {
  const variable_state = { local: { mode: "source" }, global: {}, chat: {}, prompt_selections: { choice: ["x"] } };
  dryRun.mockResolvedValue({ ...baseResult, variable_state });
  const response = await fixture()({ type: "generate_dry_run", input: { chatId: "chat", presetId: "source", forcePresetId: true } });
  expect(dryRun.mock.calls[0]?.[0]).toMatchObject({ userId: "alice", chat_id: "chat", preset_id: "source", force_preset_id: true });
  expect(response.result.variable_state).toEqual(variable_state);
  expect((await fixture("user", false)({ type: "generate_dry_run", input: { chatId: "chat", forcePresetId: true } })).error).toContain("generation");
});

test("dry run still requires generation permission and enforces user scope", async () => {
  const request = { type: "generate_dry_run", input: { chatId: "chat", includeRequestMessages: true } };
  expect((await fixture("user", false)(request)).error).toContain("generation");
  expect((await fixture("operator")(request)).error).toContain("userId is required");
  expect(dryRun).not.toHaveBeenCalled();
  dryRun.mockResolvedValue(baseResult);
  await fixture()({ ...request, userId: "bob" });
  expect(dryRun.mock.calls[0]?.[0].userId).toBe("alice");
});

const saved = {
  entries: [{ name: "System", type: "block", tokens: 10, content: "Synthetic prompt" }],
  messages: [{ role: "system", content: "Synthetic prompt" }],
  totalTokens: 30, chatHistoryTokens: 20, maxContext: 8192,
  model: "test", provider: "test", parameters: { temperature: 0.5 },
  usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
  presetName: "Test", presetId: "preset", tokenizer_name: "test",
};

test("saved breakdowns return the stored snapshot without generating a prompt", async () => {
  storeBreakdown("alice", "message", "chat", saved);
  const response = await fixture()({ type: "generate_get_breakdown", messageId: "message" });
  expect(response).toEqual({ type: "response", requestId: "request", result: saved });
  expect(dryRun).not.toHaveBeenCalled();
});

test("saved breakdown reads cannot escape the extension owner's scope", async () => {
  storeBreakdown("alice", "alice-message", "alice-chat", saved);
  storeBreakdown("bob", "bob-message", "bob-chat", { ...saved, model: "bob-private" });
  const send = fixture();
  expect((await send({ type: "generate_get_breakdown", messageId: "bob-message", userId: "bob" })).result).toBeNull();
  expect((await send({ type: "generate_get_breakdown", messageId: "alice-message", userId: "bob" })).result).toEqual(saved);
});

test("saved breakdown reads require generation permission and an operator user context", async () => {
  const request = { type: "generate_get_breakdown", messageId: "message" };
  expect((await fixture("user", false)(request)).error).toContain("generation");
  expect((await fixture("operator")(request)).error).toContain("userId is required");
  storeBreakdown("bob", "message", "chat", saved);
  expect((await fixture("operator")({ ...request, userId: "bob" })).result).toEqual(saved);
});

test("absent or unreadable snapshots return null; invalid message IDs reject", async () => {
  const send = fixture();
  storeBreakdown("alice", "corrupt", "chat", "invalid JSON");
  storeBreakdown("alice", "old", "chat", { entries: [], totalTokens: 0 });
  for (const messageId of ["missing", "corrupt"]) {
    expect((await send({ type: "generate_get_breakdown", messageId })).result).toBeNull();
  }
  expect((await send({ type: "generate_get_breakdown", messageId: "old" })).result).toEqual({ entries: [], totalTokens: 0 });
  for (const messageId of [undefined, "", "  ", 123]) {
    expect((await send({ type: "generate_get_breakdown", messageId })).error).toBe("messageId is required");
  }
});

test("extension runtime round-trips preview fields, saved snapshots, nulls and errors through the host", async () => {
  storeBreakdown("bob", "message", "chat", saved);
  const requestMessages: NonNullable<generateSvc.DryRunResult["request_messages"]> = [{
    role: "user", content: [{ type: "image", data: "aW1hZ2U=", mime_type: "image/png" }],
  }, { role: "assistant", content: "Prefix", partial: true }];
  dryRun.mockResolvedValue({ ...baseResult, chatHistoryTokens: 42, request_messages: requestMessages, assistantPrefill: "Prefix" });
  const directory = await mkdtemp(join(tmpdir(), "spindle-generation-test-"));
  const entry = join(directory, "backend.mjs");
  await Bun.write(entry, `
    const preview = await spindle.generate.dryRun({ chatId: "chat", includeRequestMessages: true }, "bob");
    const saved = await spindle.generate.getBreakdown("message", "bob");
    const missing = await spindle.generate.getBreakdown("missing", "bob");
    let error;
    try { await spindle.generate.getBreakdown("", "bob"); }
    catch (e) { error = e.message; }
    spindle.sendToFrontend({ preview, saved, missing, error });
  `);
  const dispatch = fixture("operator");
  let resolveResult!: (message: any) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<any>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const timer = setTimeout(() => rejectResult(new Error("Extension did not return generation results")), 5000);
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, "worker-runtime.ts")], {
    stdout: "ignore", stderr: "pipe",
    ipc(message: any, child) {
      if (message.type === "permissions_get_granted") {
        child.send({ type: "response", requestId: message.requestId, result: ["generation"] });
      } else if (message.type === "generate_dry_run" || message.type === "generate_get_breakdown") {
        void dispatch(message).then(response => child.send(response)).catch(rejectResult);
      } else if (message.type === "frontend_message") {
        resolveResult(message.payload);
      }
    },
  });
  try {
    worker.send({ type: "init", manifest: { identifier: "generation-test", entry_backend: pathToFileURL(entry).href }, storagePath: directory });
    const response = await result;
    expect(response.preview.chatHistoryTokens).toBe(42);
    expect(response.preview.request_messages).toEqual(requestMessages);
    expect(response.preview.assistantPrefill).toBe("Prefix");
    expect(response.saved).toEqual(saved);
    expect(response.missing).toBeNull();
    expect(response.error).toBe("messageId is required");
    expect(dryRun.mock.calls[0]?.[0].userId).toBe("bob");
    expect(dryRun.mock.calls[0]?.[0].include_request_messages).toBe(true);
  } finally {
    clearTimeout(timer);
    worker.kill();
    await worker.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
